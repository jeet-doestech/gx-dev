/**
 * Cross-process execution lease (REVIEW §1 "Make lifecycle durable": one run
 * supervisor with repository/run locks).
 *
 * A lease guards the gx-dev execution lifecycle of ONE repository across
 * INDEPENDENT engine processes: while an engine drives a run (start/resume/
 * answer), no other process may start, resume, or answer against the same
 * repository, and a parked control operation (pause/cancel on a run that is
 * not being driven by this engine) must take the lease before mutating
 * durable state.
 *
 * Protocol: ATOMIC NON-REPLACING DIRECTORY ACQUISITION.
 *
 * The lease at `lockPath` is a DIRECTORY containing exactly one fully written
 * `owner.json` record (pid, random per-acquisition token, acquisition
 * timestamp, /proc start time when available). Acquisition prepares a unique
 * sibling claim directory — owner.json complete BEFORE publication — and
 * installs it with `rename(claimDir, lockPath)`:
 *
 * - POSIX rename refuses to replace an existing NONEMPTY directory
 *   (ENOTEMPTY/EEXIST); Windows refuses to replace ANY existing directory
 *   (EPERM/EEXIST). Because the lock is nonempty from the instant it first
 *   exists, the KERNEL arbitrates every acquisition: exactly one contender's
 *   rename can ever succeed. There is no read-then-replace window, so an
 *   arbitrarily preempted process (stalled between its re-read and its write,
 *   for any duration the OS chooses) cannot overwrite a live owner. The old
 *   file-lock protocol's settle-delay re-verification — a statistical hope
 *   that preemption stays under 50ms — is gone entirely.
 *
 * Dead-owner reclaim via RETAINED TOMBSTONES:
 *
 * - A reclaimer that observes a DEAD owner moves that owner's lock directory
 *   aside with `rename(lockPath, tombstone)`, where the tombstone path is
 *   derived DETERMINISTICALLY from the dead owner's token
 *   (see reclaimedTombstonePath), and then retries the non-replacing claim
 *   rename (which the kernel may award to a competing acquirer instead).
 * - Tombstones are RETAINED PERMANENTLY. They are the tiny record that makes
 *   delayed reclaimers safe: a stale reclaimer that read dead owner D and was
 *   preempted (for any duration) resumes with `rename(lockPath, tomb(D))`.
 *   If a successor won the reclaim in the meantime, tomb(D) already exists and
 *   is nonempty, so the kernel refuses the stale rename — the successor's
 *   live lock is never moved aside or overwritten. DELETING a tombstone would
 *   reopen exactly that double-ownership window, so garbage-collect
 *   tombstones ONLY during maintenance windows in which no gx process can
 *   possibly contend (quiesced system; manual operation).
 *
 * Release: a LIVE owner cannot legitimately be reclaimed, so release first
 * verifies its own token is still the recorded owner, then renames its lock
 * to a unique `.release` sibling and removes that. A release whose token no
 * longer matches is a no-op (idempotent; never touches a successor's lock).
 *
 * Fail-closed policy:
 * - A lock path holding NO valid owner record (missing owner.json, unparseable
 *   JSON, unsafe token) is NEVER guessed to be dead, NEVER reclaimed, and
 *   NEVER deleted: acquisition throws LeaseUnusableError with actionable
 *   manual recovery instructions. The protocol cannot produce this state
 *   itself — a claim directory is fully written before its rename, so a
 *   published lock always carries a valid owner record; crashed acquirers
 *   leave unambiguous `.claim` siblings that the protocol never reads.
 * - A legacy lock FILE at the lock path (older gx-dev releases used
 *   exclusive-create lock files) is likewise refused with manual recovery
 *   instructions instead of being replaced automatically.
 *
 * Safety properties preserved from the file protocol: a live owner is refused
 * immediately (never waited out, never stolen from); age is never a TTL —
 * only owner death enables a takeover; pid reuse is detected via /proc start
 * times (Linux); a killed process leaves a reclaimable dead-owner lock.
 *
 * This module is deliberately dependency-free (node builtins only) so real
 * second processes can import it directly in tests and in the packaged CLI.
 */

import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

/** The recorded owner of a lease directory. */
export interface LeaseOwner {
  /** Process id of the acquirer. */
  pid: number;
  /** Random per-acquisition token; ownership checks compare tokens. */
  token: string;
  /** ISO timestamp of acquisition (diagnostics only — never a TTL). */
  acquiredAt: string;
  /**
   * Linux /proc/<pid>/stat starttime of the owner process, when readable:
   * a live-looking pid whose start time differs from the recorded one is a
   * reused pid, i.e. the original owner is dead.
   */
  pidStartTime?: string;
}

/** Releases the lease. Idempotent; never removes another owner's lock. */
export type LeaseRelease = () => Promise<void>;

/** Thrown when the lease is (still) held by a live owner. */
export class LeaseHeldError extends Error {
  readonly owner: LeaseOwner | null;

  constructor(message: string, owner: LeaseOwner | null) {
    super(message);
    this.name = "LeaseHeldError";
    this.owner = owner;
  }
}

/**
 * Thrown fail-closed when the lock path exists but cannot be assessed as a
 * well-formed lease: corrupt/missing owner record, or a legacy lock FILE.
 * The caller must recover MANUALLY (verify no gx process runs, then remove
 * the path) — the library refuses to guess and refuses to delete.
 */
export class LeaseUnusableError extends Error {
  readonly lockPath: string;

  constructor(message: string, lockPath: string) {
    super(message);
    this.name = "LeaseUnusableError";
    this.lockPath = lockPath;
  }
}

export interface LeaseOptions {
  /**
   * Deprecated: accepted for call-site compatibility and IGNORED. The
   * directory protocol is atomic (the kernel refuses replacing renames), so
   * no settle re-verification exists anymore.
   */
  settleMs?: number;
  /** Bounded retries for transient races (contended claims/reclaims). */
  attempts?: number;
  /** Backoff between retries (ms). */
  backoffMs?: number;
}

const DEFAULT_ATTEMPTS = 40;
const DEFAULT_BACKOFF_MS = 25;

/** Name of the owner record inside the lock directory. */
const OWNER_FILENAME = "owner.json";

/**
 * The owner token is embedded verbatim in tombstone paths, so it must be a
 * plain safe path component. An owner record with any other token is
 * untrusted input → treated as corrupt (fail closed), never reclaimed.
 */
const SAFE_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** /proc start time of a pid (Linux only), or null when unavailable. */
function procStartTime(pid: number): string | null {
  if (process.platform !== "linux") return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) return null;
    // Fields after (comm): state is field 3 … starttime is field 22, i.e.
    // index 22 - 3 = 19 in the split remainder.
    const fields = stat.slice(closeParen + 1).trim().split(/\s+/);
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

/**
 * Liveness probe: signal 0 succeeds for a live process we may signal;
 * EPERM means the process exists (we merely lack permission); ESRCH means
 * it is gone. Any other failure is treated as ALIVE — the lease never
 * breaks a possibly-live owner on the strength of a probe error.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * True when the recorded owner can no longer hold the lease: the pid is
 * gone, was never valid, or (with /proc start times available) the pid was
 * reused by a different process. Age is deliberately irrelevant.
 */
export function ownerIsDead(owner: LeaseOwner): boolean {
  if (!Number.isInteger(owner.pid) || owner.pid <= 0) return true;
  if (!isPidAlive(owner.pid)) return true;
  if (owner.pidStartTime !== undefined) {
    const now = procStartTime(owner.pid);
    if (now !== null && now !== owner.pidStartTime) return true;
  }
  return false;
}

type LockState =
  | { kind: "owner"; owner: LeaseOwner }
  | { kind: "corrupt"; reason: string }
  | { kind: "legacyFile" }
  | { kind: "missing" };

/**
 * Inspects the lock path WITHOUT modifying anything:
 * - "owner": a directory carrying a valid owner.json record;
 * - "legacyFile": anything that is not a directory (legacy exclusive-create
 *   lock file from older releases, or a foreign object) — fail closed;
 * - "corrupt": a directory without a valid owner record — fail closed,
 *   NEVER guessed to be dead;
 * - "missing": the lock path does not exist (lock is free).
 */
function readLockState(lockPath: string): LockState {
  let isDir: boolean;
  try {
    isDir = lstatSync(lockPath).isDirectory();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "corrupt", reason: `lock path cannot be inspected (${String(e)})` };
  }
  if (!isDir) return { kind: "legacyFile" };
  let raw: string;
  try {
    raw = readFileSync(join(lockPath, OWNER_FILENAME), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      // Either the directory was moved aside between lstat and the read (a
      // concurrent reclaim/release — the lock is momentarily absent) or this
      // is a genuinely ownerless directory (tampering). Re-check to tell
      // them apart; both outcomes are safe (retry vs fail closed).
      try {
        lstatSync(lockPath);
        return { kind: "corrupt", reason: `lock directory has no ${OWNER_FILENAME} record` };
      } catch {
        return { kind: "missing" };
      }
    }
    return { kind: "corrupt", reason: `owner record unreadable (${String(e)})` };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LeaseOwner> | null;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof parsed.pid === "number" &&
      Number.isInteger(parsed.pid) &&
      typeof parsed.token === "string" &&
      SAFE_TOKEN_RE.test(parsed.token)
    ) {
      const owner: LeaseOwner = {
        pid: parsed.pid,
        token: parsed.token,
        acquiredAt: typeof parsed.acquiredAt === "string" ? parsed.acquiredAt : "",
      };
      if (typeof parsed.pidStartTime === "string") owner.pidStartTime = parsed.pidStartTime;
      return { kind: "owner", owner };
    }
    return {
      kind: "corrupt",
      reason: "owner record is not a well-formed owner (integer pid, plain-name token)",
    };
  } catch {
    return { kind: "corrupt", reason: "owner record is not parseable JSON" };
  }
}

function newOwner(): LeaseOwner {
  const owner: LeaseOwner = {
    pid: process.pid,
    token: randomUUID(),
    acquiredAt: new Date().toISOString(),
  };
  const start = procStartTime(process.pid);
  if (start !== null) owner.pidStartTime = start;
  return owner;
}

/**
 * Deterministic tombstone path for a dead owner's token. Two reclaimers that
 * read the SAME dead owner derive the SAME path, so the kernel's refusal to
 * rename onto the existing (nonempty, permanently retained) tombstone is what
 * serializes them — including a stale reclaimer resuming after an arbitrary
 * preemption delay. Callers must pass a validated (plain-name) token.
 */
export function reclaimedTombstonePath(lockPath: string, deadToken: string): string {
  return join(dirname(lockPath), `${basename(lockPath)}.reclaimed-${deadToken}`);
}

/**
 * Builds a unique, fully written claim directory next to the lock path. The
 * owner record is complete BEFORE the claim is ever published: publication
 * (the rename) is atomic, so a published lock directory is never empty and
 * never torn. A crash here leaves an unambiguous `.claim` sibling that the
 * protocol never reads.
 */
function buildClaimDir(lockPath: string, claim: LeaseOwner): string {
  const dir = join(
    dirname(lockPath),
    `${basename(lockPath)}.${process.pid}.${randomUUID()}.claim`,
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, OWNER_FILENAME), JSON.stringify(claim), "utf8");
  return dir;
}

/**
 * Rename error codes that mean "the target exists" (an occupied lock).
 * POSIX refuses dir→nonempty-dir with ENOTEMPTY/EEXIST; Windows refuses
 * dir→any existing directory with EPERM/EEXIST. Both refusals are exactly
 * the behavior the non-replacing protocol relies on.
 */
function isOccupiedCode(code: string | undefined): boolean {
  return (
    code === "ENOTEMPTY" ||
    code === "EEXIST" ||
    (code === "EPERM" && process.platform === "win32")
  );
}

/**
 * Non-replacing install of our claim directory: returns true only when the
 * rename placed our claim at lockPath (lock was free). Never replaces an
 * existing lock — the kernel refuses, and we report the loss to the caller.
 */
function installClaim(claimDir: string, lockPath: string): boolean {
  try {
    renameSync(claimDir, lockPath);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (isOccupiedCode(code)) return false; // someone owns the lock — never replace
    if (code === "ENOENT") {
      // The runs root vanished between attempts (concurrent cleanup):
      // recreate it; the caller re-evaluates and retries.
      mkdirSync(dirname(lockPath), { recursive: true });
      return false;
    }
    throw e;
  }
}

/**
 * Retires a DEAD owner's lock by moving it to the deterministic tombstone
 * derived from ITS token. The tombstone is never created empty and never
 * deleted: "blocked" means a tombstone for this token already exists (either
 * a competing reclaimer just won, or a stale reclaimer is arriving late) and
 * the kernel refused to touch it — the caller re-evaluates the lock path.
 */
function retireToTombstone(
  lockPath: string,
  tombstone: string,
): "moved" | "gone" | "blocked" {
  try {
    renameSync(lockPath, tombstone);
    return "moved";
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "gone"; // another reclaimer/release moved it first
    if (isOccupiedCode(code)) return "blocked"; // tombstone for this token already exists
    throw e;
  }
}

/**
 * Builds the idempotent release thunk. Release verifies that the recorded
 * owner is still OUR OWN token (a stale release never touches a successor's
 * lock — though a live owner cannot legitimately be reclaimed anyway), then
 * vacates the lock path atomically by renaming our lock to a unique `.release`
 * sibling and removing that sibling.
 */
function makeRelease(lockPath: string, token: string): LeaseRelease {
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    const state = readLockState(lockPath);
    if (state.kind !== "owner" || state.owner.token !== token) return;
    const releasePath = join(
      dirname(lockPath),
      `${basename(lockPath)}.${process.pid}.${randomUUID()}.release`,
    );
    try {
      renameSync(lockPath, releasePath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return; // already vacated
      // The owner record was verified as ours synchronously and a live
      // owner's directory cannot be moved aside by any protocol participant
      // (only DEAD owners are tombstoned), so direct removal is still ours.
      try {
        rmSync(lockPath, { recursive: true, force: true });
      } catch {
        // best effort; the lease dies with this process regardless
      }
      return;
    }
    try {
      rmSync(releasePath, { recursive: true, force: true });
    } catch {
      // residue outside the contested lock path; harmless
    }
  };
}

/**
 * Acquires the execution lease at `lockPath`. Resolves to an idempotent
 * release thunk, or throws:
 * - LeaseHeldError when a LIVE owner holds the lease (immediately, no
 *   waiting — callers surface this to the user), or when bounded retries
 *   against transient claim/reclaim races are exhausted (with the last
 *   observed owner in `.owner`);
 * - LeaseUnusableError when the lock path holds no valid owner record or a
 *   legacy lock FILE — fail closed with actionable manual recovery steps.
 */
export async function acquireFileLease(
  lockPath: string,
  opts?: LeaseOptions,
): Promise<LeaseRelease> {
  const attempts = Math.max(1, opts?.attempts ?? DEFAULT_ATTEMPTS);
  const backoffMs = opts?.backoffMs ?? DEFAULT_BACKOFF_MS;
  void opts?.settleMs; // deprecated no-op (atomic protocol needs no settle)
  mkdirSync(dirname(lockPath), { recursive: true });

  let pending: { owner: LeaseOwner; dir: string } | null = null;
  let lastOwner: LeaseOwner | null = null;
  try {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await sleep(backoffMs);
      const state = readLockState(lockPath);
      if (state.kind === "legacyFile") {
        throw new LeaseUnusableError(
          `gx-dev execution lease at ${lockPath} cannot be used: a legacy lock FILE ` +
            "(or other non-directory object) exists at this path. This version publishes " +
            "the lease as a directory and refuses to replace the file automatically. " +
            "Verify no gx engine process is running for this repository, then remove the " +
            `stale lock manually (rm ${JSON.stringify(lockPath)}) and retry.`,
          lockPath,
        );
      }
      if (state.kind === "corrupt") {
        throw new LeaseUnusableError(
          `gx-dev execution lease at ${lockPath} cannot be used: the lock directory holds ` +
            `no valid owner record (${state.reason}). Refusing to guess whether the owner is ` +
            "dead — failing closed. Verify no gx engine process is running for this " +
            "repository, then remove the stale lock directory manually " +
            `(rm -rf ${JSON.stringify(lockPath)}) and retry.`,
          lockPath,
        );
      }
      if (state.kind === "owner") {
        lastOwner = state.owner;
        if (!ownerIsDead(state.owner)) {
          throw new LeaseHeldError(
            `gx-dev execution lease at ${lockPath} is held by pid ${state.owner.pid}` +
              (state.owner.acquiredAt !== "" ? ` (acquired ${state.owner.acquiredAt})` : "") +
              "; a run may be actively driven by another engine process — " +
              "wait for it to yield or stop that process",
            state.owner,
          );
        }
        // Dead owner: move its lock to the deterministic tombstone for ITS
        // token (the tombstone is retained forever), then immediately retry
        // the non-replacing claim below — the kernel decides who wins.
        const outcome = retireToTombstone(
          lockPath,
          reclaimedTombstonePath(lockPath, state.owner.token),
        );
        if (outcome === "blocked") {
          // A tombstone for this token already exists (a competing reclaimer
          // won, or a long-preempted reclaimer is in flight). Never delete or
          // rewrite a retained tombstone; re-evaluate on the next attempt.
          continue;
        }
        // "gone": someone else vacated the lock path; the claim below decides.
      }
      // The lock path is missing (or was just vacated): install our claim
      // WITHOUT replacing anything — the rename refuses if someone won.
      if (pending === null) {
        const owner = newOwner();
        pending = { owner, dir: buildClaimDir(lockPath, owner) };
      }
      if (installClaim(pending.dir, lockPath)) {
        return makeRelease(lockPath, pending.owner.token);
      }
      // Occupied (or the parent vanished): loop and re-classify.
    }
    throw new LeaseHeldError(
      `could not acquire the gx-dev execution lease at ${lockPath} after ${attempts} attempt(s)` +
        (lastOwner !== null ? `; last owner was pid ${lastOwner.pid}` : ""),
      lastOwner,
    );
  } finally {
    // Remove an UNINSTALLED claim directory (lost races, refused acquires).
    // After a successful install the claim path no longer exists and this is
    // a no-op. Claim names are unique per acquisition, so this never touches
    // the lock, another process's claim, or a retained tombstone.
    if (pending !== null) {
      try {
        rmSync(pending.dir, { recursive: true, force: true });
      } catch {
        // residue is an unambiguous .claim sibling the protocol never reads
      }
    }
  }
}
