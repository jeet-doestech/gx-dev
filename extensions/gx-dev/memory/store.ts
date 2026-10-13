/**
 * Filesystem memory store implementing MemoryCoordinator (PLAN §10.2–§10.6).
 *
 * Layout under `root` (= `<repo>/.gx-dev/memory`):
 *   index.md, log.md, SCHEMA.md (generated), core pages, and the
 *   decisions/ features/ failures/ sources/ pins/ namespaces.
 *
 * Concurrency: proposed page names are atomically reserved in index.md under
 * `## Reservations` under an exclusive directory lease (domain/lease.ts,
 * published at `.lock/owner.json`); every claim records the run id and the
 * expected page revision (hash) observed at reserve time, so reservations and
 * compare-and-swap expectations survive store restarts. The entire promote
 * transaction — revision check, page write, claim cleanup, log append — runs
 * under that lease, so competing processes can never interleave between check
 * and write. The lease is installed by atomic non-replacing rename: a LIVE
 * owner is never stolen from (age is never a takeover criterion), a crashed
 * owner is reclaimed via a retained tombstone, and corrupt or legacy lock
 * objects fail closed with manual recovery instructions. Scaffold writes are
 * exclusive-create, so racing constructors can never replace an existing page
 * or a user's edits. A conflicting create degrades to an update; conflicts
 * and cancellation (`release(runId)`) drop the run's claims. The search index
 * is derived, never authoritative.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { hashContent } from "../domain/artifacts.ts";
import { acquireFileLease, LeaseHeldError, type LeaseRelease } from "../domain/lease.ts";
import type { MemoryCoordinator, MemoryPage, MemoryProposal } from "../domain/interfaces.ts";
import { buildIndex, searchIndex } from "./indexer.ts";
import { redactSecrets } from "./redaction.ts";
import { extractLinks, isGeneratedPage, isValidPageName, MEMORY_SUBDIRS, PAGE_NAMES, pageFileName, parsePage, serializePage } from "./wiki.ts";
import { lintWiki } from "./validator.ts";

/** Wall-clock budget for waiting on a LIVE lease holder before failing closed. */
const LOCK_RETRY_MS = 5000;
/** Asynchronous backoff between lease acquisition retries (no busy waiting). */
const LOCK_RETRY_BACKOFF_MS = 25;

/**
 * Base name of the directory lease under the memory root (domain/lease.ts).
 * The whole lease namespace derives from it: the lease directory itself
 * (`.lock`), transient claim/release siblings (`.lock.<pid>.<uuid>.claim|`
 * `.release`), and retained dead-owner tombstones (`.lock.reclaimed-<token>`).
 */
const LOCK_LEASE_BASENAME = ".lock";

/** Authored schema documentation written to SCHEMA.md (PLAN §10.3). */
export const SCHEMA_MD = `# gx-dev Memory Schema

Curated project memory lives under \`.gx-dev/memory/\` as Markdown. Structure is
checked deterministically by the memory lint (PLAN §10.3, §10.5); agents must
still follow these rules.

## Pages

- Fixed pages: \`index.md\`, \`log.md\`, \`project-overview.md\`, \`architecture.md\`,
  \`conventions.md\`, \`testing.md\`.
- Namespace directories: \`decisions/\`, \`features/\`, \`failures/\`, \`sources/\`,
  \`pins/\`. A page in a directory is named like \`decisions/2025-01-use-sqlite\`
  (the \`.md\` suffix is implicit).
- \`index.md\` and \`log.md\` are generated. Never hand-edit them; both are
  rebuildable from the other pages and the promotion history.

## Page structure

- Every content page starts with a delimited frontmatter block and must define:
  \`provenance\` (semicolon-separated list of run ids, agents, or sources),
  \`scope\` (where the claim applies), \`freshness\` (ISO date the claim was
  checked), \`verification\` (\`verified\` or \`NOT VERIFIED\`), \`confidence\`
  (\`low\`, \`medium\`, \`high\`), and \`updated\` (ISO date of the last edit).
- Every content page needs at least a \`## Summary\` heading.
- Cross-links use wiki syntax with double brackets around the page name. Every
  link target must exist; the lint reports broken links. Pages without any
  outbound link are flagged as orphan risks.

## Operating rules

- Durable facts must include provenance, scope, freshness, and verification
  status; citations point at evidence under \`runs/<run-id>/evidence/\`.
- \`NOT VERIFIED\` claims older than 30 days past their freshness date are
  flagged \`stale-unverified\` and must be re-checked or dropped.
- Mutable runtime values (current SHA, counts, sync times) are not copied into
  prose unless historically relevant; the lint flags SHA-40 literals and
  \`currently <n>\` patterns as copied mutable state.
- Contradictions: the same claim with opposite polarity (must/always vs
  must-not/never) across pages is flagged as a contradiction candidate for
  review, not silently resolved.
- Superseded pages are archived by setting \`archived: true\` in frontmatter;
  they stay readable but leave the active narrative.
- Human corrections are semantic pins under \`pins/\`. Regeneration must
  preserve them; contradicting a pin is escalated rather than dropped.

## Prohibited content

- Secrets are never stored in memory. API tokens (sk-…, ghp_…, AKIA…),
  assignment-style values such as password or token keys, PEM private keys,
  and long credential literals are redacted on promote when redaction is on.
- Raw transcripts and agent output belong to evidence, not to memory.

## Concurrency

- Page names are atomically reserved in \`index.md\` under \`## Reservations\`
  before promotion; each claim records the run id and the expected revision
  hash observed at reserve time (\`absent\` for new pages). Reservations are
  durable: a restarted store reloads them from \`index.md\`.
- The whole compare-and-write transaction (revision check, page write,
  reservation cleanup, log append) runs under an exclusive directory lease at
  \`.lock/\` (domain/lease.ts): installed by atomic non-replacing rename, a
  live owner is never stolen from (age is never a takeover criterion), a
  crashed owner is reclaimed via a retained tombstone, and a leftover lock
  FILE from older releases fails closed and must be removed manually. Never
  delete the lease while a gx process may be running.
- A page changed since reserve goes to the conflict list untouched, and the
  run's claim is dropped for applied and conflicted pages alike; re-reserve
  before retrying a conflict.
- Cancelling a run must call \`release(runId)\` so its reservation claims do
  not linger; \`release\` never writes or deletes pages.
- Proposed pages can be structurally previewed with the store's proposal
  lint before promotion. Promotion itself does not reject lint findings —
  structure is the reviewer's decision, not a silent failure.
- All writes are atomic (tmp + rename). The search index is derived data:
  disposable and rebuildable from Markdown.
`;

const LOG_MD = `# Memory Log

Append-only promotion history. One line per promote: \`<iso> <runId> <action> <page>\`.
`;

/** Stub content for the four curated core pages created on first use. */
const CORE_PAGE_SUMMARIES: Record<string, { summary: string; link: string }> = {
  "project-overview": {
    summary: "Placeholder. Describe the repository purpose, product scope, and main entry points.",
    link: "architecture",
  },
  architecture: {
    summary: "Placeholder. Record module layout, boundaries, and key data flows.",
    link: "project-overview",
  },
  conventions: {
    summary: "Placeholder. Record build, style, and workflow conventions the agents must follow.",
    link: "testing",
  },
  testing: {
    summary: "Placeholder. Record how to run tests and what the gates require.",
    link: "conventions",
  },
};

function g(m: RegExpExecArray, i: number): string {
  return m[i] ?? "";
}

/**
 * Asynchronous sleep: the event loop stays live while a store operation waits
 * for a live lease holder. Never Atomics.wait (that would freeze the whole
 * agent process, including the lease owner's own timers).
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function atomicWrite(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, content, null, "utf8");
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // best effort cleanup
    }
    throw err;
  }
}

/**
 * Atomically creates `file` with `content` ONLY when it does not exist
 * (exclusive create): the tmp file is fully written first and then hard-linked
 * into place — `link(2)` refuses to replace an existing target (EEXIST), so
 * two racing constructors, or a constructor racing a lease-holding promoter,
 * can never overwrite an existing page or a user's edits (a rename here would
 * be last-writer-wins). Returns true when this call created the file.
 */
function atomicCreateNew(file: string, content: string): boolean {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx");
  try {
    writeSync(fd, content, null, "utf8");
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(tmp, file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // best effort cleanup
    }
  }
}

/**
 * Lease-protocol objects are never page content and are never scanned: the
 * published lease directory, a transient `.claim`/`.release` sibling being
 * created or deleted by another process, and retained `.reclaimed-*`
 * tombstones. Recursing into them would race a concurrent release's
 * recursive delete (ENOENT from readdir mid-deletion) and could otherwise
 * observe half-removed protocol state.
 */
function isLeaseNamespace(name: string): boolean {
  return name === LOCK_LEASE_BASENAME || name.startsWith(`${LOCK_LEASE_BASENAME}.`);
}

/** Recursively lists wiki page files (skips SCHEMA.md and tmp leftovers). */
function listPageFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (isLeaseNamespace(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...listPageFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "SCHEMA.md") {
      found.push(full);
    }
  }
  return found;
}

function toPageName(root: string, file: string): string {
  return relative(root, file).split(sep).join("/").replace(/\.md$/i, "");
}

function sortByName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A reservation claim: the expected page revision hash at reserve time, or
 * `null` when the page was absent (a create). `undefined` only appears while
 * parsing legacy reservation lines that predate durable expectations; those
 * claims get no compare-and-swap check on promote.
 */
type ExpectedRevision = string | null | undefined;
/** Page -> run id -> expected revision at reserve time (durable in index.md). */
type ReservationClaims = Map<string, Map<string, ExpectedRevision>>;

const RESERVATION_LINE_RE = /^-\s+(.+?):\s*planned by\s+(.+?)(?:\s+\(expected: ([^)]*)\))?$/;

/**
 * Parses the `## Reservations` section of index.md into durable claims:
 * page -> run id -> expected revision hash (`null` = page was absent).
 * Lines written by older stores without an `(expected: …)` suffix parse
 * with an undefined expectation for backward compatibility.
 */
function parseClaims(raw: string): ReservationClaims {
  const map: ReservationClaims = new Map();
  let inSection = false;
  for (const line of raw.split(/\r?\n/)) {
    if (/^##\s+Reservations\s*$/.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^##\s/.test(line)) break;
    if (!inSection) continue;
    const m = RESERVATION_LINE_RE.exec(line);
    if (m === null) continue;
    const claims = new Map<string, ExpectedRevision>();
    for (const id of g(m, 2)
      .split(",")
      .map((id) => id.trim())) {
      if (id.length > 0) claims.set(id, undefined);
    }
    for (const pair of g(m, 3).split(",")) {
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const id = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!claims.has(id)) continue; // expectation without a live claim
      claims.set(id, value === "" || value === "absent" ? null : value);
    }
    if (claims.size > 0) map.set(g(m, 1).trim(), claims);
  }
  return map;
}

const SHA40_RE = /\b[0-9a-fA-F]{40}\b/;
const CURRENTLY_RE = /\bcurrently\s+\d+/i;

/** Structural checks for one proposal against the post-promotion page universe. */
function lintProposal(proposal: MemoryProposal, pages: Set<string>): string[] {
  const issues: string[] = [];
  const page = proposal.page;
  if (proposal.action !== "create" && proposal.action !== "update" && proposal.action !== "archive") {
    issues.push(`${page}: unknown action '${String(proposal.action)}'`);
  }
  if (proposal.provenance.length === 0 || proposal.provenance.every((entry) => entry.trim() === "")) {
    issues.push(`${page}: provenance has no entries`);
  }
  if (proposal.scope.trim() === "") issues.push(`${page}: scope is empty`);
  if (proposal.freshness.trim() === "" || Number.isNaN(Date.parse(proposal.freshness.trim()))) {
    issues.push(`${page}: freshness is not an ISO date`);
  }
  const verification = proposal.verification.trim().toLowerCase();
  if (verification !== "verified" && verification !== "not-verified") {
    issues.push(`${page}: verification must be 'verified' or 'not-verified'`);
  }
  if (proposal.runId.trim() === "") issues.push(`${page}: runId is empty`);
  if (proposal.body.trim() === "") {
    issues.push(`${page}: body is empty`);
    return issues;
  }
  if (!/^##\s+Summary\b/m.test(proposal.body)) {
    issues.push(`${page}: missing required heading '## Summary'`);
  }
  const links = [...new Set(extractLinks(proposal.body))];
  if (links.length === 0) {
    issues.push(`${page}: orphan risk (no outbound [[link]])`);
  }
  for (const target of links) {
    if (!pages.has(target)) issues.push(`${page}: broken [[link]] target '${target}'`);
  }
  const sha = SHA40_RE.exec(proposal.body);
  if (sha !== null) issues.push(`${page}: copied mutable state (SHA-40 literal '${sha[0] ?? ""}')`);
  const currently = CURRENTLY_RE.exec(proposal.body);
  if (currently !== null) issues.push(`${page}: copied mutable state ('${currently[0] ?? ""}')`);
  if (redactSecrets(proposal.body).found > 0) {
    issues.push(`${page}: secret-like content (redacted on promote only when redaction is enabled)`);
  }
  return issues;
}

/**
 * Filesystem-backed memory coordinator. `root` is `<repo>/.gx-dev/memory`.
 * When `opts.redact` is true, promotion redacts secret-looking spans in page
 * bodies and frontmatter values (see redaction.ts); default is off.
 */
export class FsMemoryStore implements MemoryCoordinator {
  private readonly root: string;
  private readonly lockPath: string;
  private readonly lockRetryMs: number;
  private readonly logPath: string;
  private readonly indexPath: string;
  private readonly redact: boolean;

  constructor(root: string, opts?: { redact?: boolean; lockRetryMs?: number }) {
    this.root = root;
    this.lockPath = join(root, LOCK_LEASE_BASENAME); // lease DIRECTORY (domain/lease.ts)
    this.lockRetryMs = Math.max(1, opts?.lockRetryMs ?? LOCK_RETRY_MS);
    this.logPath = join(root, "log.md");
    this.indexPath = join(root, "index.md");
    this.redact = opts?.redact === true;

    mkdirSync(root, { recursive: true });
    for (const dir of MEMORY_SUBDIRS) {
      mkdirSync(join(root, dir), { recursive: true });
    }
    // Scaffolding is exclusive-create (atomicCreateNew), so a constructor
    // racing another process's construction or promotion can never replace
    // an existing page — a placeholder can never clobber a user's edits.
    this.scaffoldCorePages();
    atomicCreateNew(this.indexPath, this.renderIndex(this.listPageNames(), new Map()));
    atomicCreateNew(this.logPath, LOG_MD);
    atomicCreateNew(join(root, "SCHEMA.md"), SCHEMA_MD);
  }

  /**
   * Atomically reserves page names in index.md together with the expected
   * revision (hash) of each page at reserve time, so the compare-and-swap
   * expectation is durable across store restarts. A create whose page already
   * exists on disk or is reserved by another run degrades to an update.
   * Returns adjusted proposals; inputs are not mutated.
   */
  async reserve(proposals: MemoryProposal[]): Promise<MemoryProposal[]> {
    if (proposals.length === 0) return [];
    for (const proposal of proposals) this.assertWritablePage(proposal.page);
    return this.underLease(() => {
      const claims = this.readClaims();
      const adjusted = proposals.map((p) => ({ ...p }));
      for (const proposal of adjusted) {
        const file = this.pagePath(proposal.page);
        const exists = existsSync(file);
        const pageClaims = claims.get(proposal.page) ?? new Map<string, ExpectedRevision>();
        const claimedByOther = [...pageClaims.keys()].some((id) => id !== proposal.runId);
        if (proposal.action === "create" && (exists || claimedByOther)) {
          proposal.action = "update";
        }
        pageClaims.delete(proposal.runId);
        pageClaims.set(proposal.runId, exists ? hashContent(readFileSync(file, "utf8")) : null);
        claims.set(proposal.page, pageClaims);
      }
      atomicWrite(this.indexPath, this.renderIndex(this.listPageNames(), claims));
      return adjusted;
    });
  }

  /**
   * Applies reviewed proposals. The entire compare-and-write transaction runs
   * under the store's exclusive directory lease — revision check against the
   * durable reservation expectation, atomic page write, claim cleanup, and log
   * append are atomic with respect to other processes. Pages whose on-disk
   * revision changed since reserve go to the conflict list untouched, and this
   * run's claim is dropped for applied and conflicted pages alike (re-reserve
   * before retrying). Structural linting is a separate preview
   * (`lintProposals`); promote itself does not reject lint findings.
   */
  async promote(proposals: MemoryProposal[]): Promise<{ applied: string[]; conflicts: string[] }> {
    const applied: string[] = [];
    const conflicts: string[] = [];
    if (proposals.length === 0) return { applied, conflicts };
    for (const proposal of proposals) this.assertWritablePage(proposal.page);

    await this.underLease(() => {
      const claims = this.readClaims();
      const logEntries: string[] = [];
      const touched: MemoryProposal[] = [];
      let claimsChanged = false;

      for (const proposal of proposals) {
        const file = this.pagePath(proposal.page);
        const beforeRaw = existsSync(file) ? readFileSync(file, "utf8") : null;
        const beforeHash = beforeRaw === null ? null : hashContent(beforeRaw);
        // Conditional write: compare against the revision recorded when this
        // run reserved the page (durable in index.md). Under the lease this
        // check cannot interleave with another writer's compare or write.
        const expected = claims.get(proposal.page)?.get(proposal.runId);
        if (expected !== undefined && expected !== beforeHash) {
          conflicts.push(proposal.page);
          touched.push(proposal);
          continue;
        }

        const existingFm = beforeRaw === null ? {} : parsePage(beforeRaw).frontmatter;
        const verified = proposal.verification === "verified";
        const today = new Date().toISOString().slice(0, 10);
        const frontmatter: Record<string, string> = {
          ...existingFm,
          provenance: proposal.provenance.join("; "),
          scope: proposal.scope,
          freshness: proposal.freshness,
          verification: verified ? "verified" : "NOT VERIFIED",
          confidence: existingFm["confidence"] ?? (verified ? "medium" : "low"),
          updated: today,
        };
        if (proposal.action === "archive") frontmatter["archived"] = "true";
        let body = proposal.body;
        if (this.redact) {
          body = redactSecrets(body).text;
          // Frontmatter values are content too: inherited or provenance
          // values can carry credentials and must not bypass redaction.
          for (const key of Object.keys(frontmatter)) {
            frontmatter[key] = redactSecrets(frontmatter[key] ?? "").text;
          }
        }
        const content = serializePage(
          frontmatter,
          body.length === 0 || body.endsWith("\n") ? body : `${body}\n`,
        );

        atomicWrite(file, content);
        applied.push(proposal.page);
        touched.push(proposal);
        logEntries.push(
          `- ${new Date().toISOString()} ${proposal.runId} ${proposal.action} ${proposal.page}\n`,
        );
      }

      // Applied or conflicted, the reservation is spent: drop this run's
      // claims so conflicted or cancelled runs cannot squat on page names.
      for (const proposal of touched) {
        claimsChanged = this.dropClaim(claims, proposal.page, proposal.runId) || claimsChanged;
      }
      if (claimsChanged) {
        atomicWrite(this.indexPath, this.renderIndex(this.listPageNames(), claims));
      }
      if (applied.length > 0) {
        appendFileSync(this.logPath, logEntries.join(""), "utf8");
      }
    });
    return { applied, conflicts };
  }

  /**
   * Drops every reservation claim made by `runId` (run cancellation or
   * cleanup) without writing any pages. Claims from other runs are preserved;
   * releasing a run that holds no claims is a no-op.
   */
  async release(runId: string): Promise<void> {
    await this.underLease(() => {
      const claims = this.readClaims();
      let changed = false;
      for (const page of [...claims.keys()]) {
        changed = this.dropClaim(claims, page, runId) || changed;
      }
      if (changed) {
        atomicWrite(this.indexPath, this.renderIndex(this.listPageNames(), claims));
      }
    });
  }

  /**
   * Structural preview lint for reviewed proposals (PLAN §10.5): page-name
   * safety, frontmatter fields, `## Summary`, outbound links (resolved
   * against disk pages plus the proposed set), and orphan, secret, or
   * mutable-state smells. Advisory only — `promote()` deliberately does not
   * reject lint findings so callers can surface them for review without
   * breaking promotion of reviewed content.
   */
  lintProposals(proposals: MemoryProposal[]): { ok: boolean; issues: string[] } {
    const issues: string[] = [];
    const universe = new Set(this.listPageNames());
    const checkable: MemoryProposal[] = [];
    for (const proposal of proposals) {
      const name = proposal.page.replace(/\.md$/i, "");
      if (!isValidPageName(name)) {
        issues.push(`${proposal.page}: unsafe page name`);
        continue;
      }
      if (isGeneratedPage(name)) {
        issues.push(`${proposal.page}: generated page (index/log) cannot be proposed`);
      }
      universe.add(name); // a proposed page exists once promotion applies
      checkable.push(proposal);
    }
    for (const proposal of checkable) {
      issues.push(...lintProposal(proposal, universe));
    }
    return { ok: issues.length === 0, issues };
  }

  /**
   * Index-first retrieval: rebuilds the disposable index from disk, boosts
   * pages linked from index.md ×2, and returns full MemoryPage records in
   * score order (index-first, then term frequency).
   */
  async search(query: string, limit = 10): Promise<MemoryPage[]> {
    const pages = this.readPages();
    if (pages.length === 0 || query.trim() === "") return [];
    const index = buildIndex(pages);
    let indexNames: string[] = [];
    if (existsSync(this.indexPath)) {
      indexNames = extractLinks(readFileSync(this.indexPath, "utf8"));
    }
    const hits = searchIndex(index, query, limit, indexNames);
    const rawByName = new Map(pages.map((p) => [p.name, p.raw]));
    const out: MemoryPage[] = [];
    for (const hit of hits) {
      const raw = rawByName.get(hit.name);
      if (raw === undefined) continue;
      const parsed = parsePage(raw);
      out.push({
        name: hit.name,
        frontmatter: parsed.frontmatter,
        body: parsed.body,
        revision: hashContent(raw),
      });
    }
    return out;
  }

  /** Deterministic lint of the whole wiki (validator.ts). */
  async lint(): Promise<{ ok: boolean; issues: string[] }> {
    const issues = lintWiki(this.readPages());
    return { ok: issues.length === 0, issues };
  }

  private scaffoldCorePages(): void {
    const today = new Date().toISOString().slice(0, 10);
    for (const name of PAGE_NAMES) {
      if (isGeneratedPage(name)) continue;
      const stub = CORE_PAGE_SUMMARIES[name];
      if (stub === undefined) continue;
      // Exclusive create: an existing page (user edits, a racing promoter's
      // write) is never replaced by a placeholder.
      atomicCreateNew(
        join(this.root, `${name}.md`),
        serializePage(
          {
            provenance: "gx-dev:scaffold",
            scope: "global",
            freshness: today,
            verification: "NOT VERIFIED",
            confidence: "low",
            updated: today,
          },
          `## Summary\n\n${stub.summary}\n\nRelated: [[${stub.link}]].\n`,
        ),
      );
    }
  }

  /**
   * Runs `op` under the store-wide directory lease published by
   * domain/lease.ts at `<root>/.lock`: reserve, promote, and release are
   * mutually exclusive across INDEPENDENT processes, so a promote's
   * compare-and-write can never interleave with another process's. A lease
   * held by a LIVE owner is retried with asynchronous sleeps until the
   * bounded `lockRetryMs` budget is spent (never Atomics.wait, never
   * busy-spinning) and then fails closed; every other lease error — an
   * unusable lock (corrupt or ownerless directory, leftover lock FILE from
   * older releases) or exhausted retries — fails closed immediately. The old
   * age-based stale-lock takeover is gone for good: age is never a TTL, and
   * a live owner's lock is never deleted or replaced. The lease is released
   * in all outcomes.
   */
  private async underLease<T>(op: () => T): Promise<T> {
    const release = await this.acquireLease();
    try {
      return op();
    } finally {
      await release();
    }
  }

  /** Acquires the directory lease, retrying only while a LIVE owner holds it. */
  private async acquireLease(): Promise<LeaseRelease> {
    const deadline = Date.now() + this.lockRetryMs;
    for (;;) {
      try {
        return await acquireFileLease(this.lockPath);
      } catch (err) {
        // Only a LIVE holder is worth waiting for; everything else
        // (LeaseUnusableError, unexpected I/O failures, exhausted retries)
        // fails closed without touching the lock.
        if (!(err instanceof LeaseHeldError) || Date.now() >= deadline) throw err;
        await sleep(LOCK_RETRY_BACKOFF_MS);
      }
    }
  }

  /** Path of a page file; throws when the page name is unsafe. */
  private pagePath(page: string): string {
    return join(this.root, pageFileName(page));
  }

  /**
   * Rejects unsafe page names (path traversal, absolute paths, control
   * characters) and the generated `index`/`log` pages, which are store-owned.
   * Defense in depth: pageFileName already throws on unsafe names; the
   * resolved-path check guarantees writes stay inside the memory root.
   */
  private assertWritablePage(page: string): void {
    const name = page.replace(/\.md$/i, "");
    if (isGeneratedPage(name)) {
      throw new Error(`memory page '${page}' is generated and cannot be reserved or promoted`);
    }
    const file = this.pagePath(page); // pageFileName throws on unsafe names
    const rel = relative(this.root, file);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`unsafe memory page name: ${page}`);
    }
  }

  private readClaims(): ReservationClaims {
    const raw = existsSync(this.indexPath) ? readFileSync(this.indexPath, "utf8") : "";
    return parseClaims(raw);
  }

  /** Removes one run's claim for a page; returns true when something changed. */
  private dropClaim(claims: ReservationClaims, page: string, runId: string): boolean {
    const pageClaims = claims.get(page);
    if (pageClaims === undefined || !pageClaims.delete(runId)) return false;
    if (pageClaims.size === 0) claims.delete(page);
    return true;
  }

  private listPageNames(): string[] {
    return listPageFiles(this.root)
      .map((file) => toPageName(this.root, file))
      .sort(sortByName);
  }

  private readPages(): { name: string; raw: string }[] {
    return listPageFiles(this.root)
      .sort(sortByName)
      .map((file) => ({ name: toPageName(this.root, file), raw: readFileSync(file, "utf8") }));
  }

  private renderIndex(pages: string[], claims: ReservationClaims): string {
    const lines: string[] = [
      "# Project Memory Index",
      "",
      "Generated by gx-dev. Derived data: rebuildable from the Markdown pages listed below.",
      "The researcher reads this page first, then follows links and full-text results (PLAN §10.2).",
      "",
      "## Pages",
      "",
    ];
    const listed = pages.filter((p) => !isGeneratedPage(p));
    if (listed.length === 0) lines.push("(no pages yet)");
    for (const page of listed) lines.push(`- [[${page}]]`);
    lines.push("", "## Reservations", "");
    const entries = [...claims.entries()].sort(([a], [b]) => sortByName(a, b));
    if (entries.length === 0) lines.push("(no active reservations)");
    for (const [page, pageClaims] of entries) {
      const runIds = [...pageClaims.keys()];
      const expected = runIds
        .map((id) => ({ id, rev: pageClaims.get(id) }))
        .filter((entry) => entry.rev !== undefined)
        .map((entry) => `${entry.id}=${entry.rev === null ? "absent" : entry.rev}`);
      const suffix = expected.length > 0 ? ` (expected: ${expected.join(", ")})` : "";
      lines.push(`- ${page}: planned by ${runIds.join(", ")}${suffix}`);
    }
    return `${lines.join("\n")}\n`;
  }
}
