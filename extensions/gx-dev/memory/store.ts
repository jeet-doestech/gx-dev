/**
 * Filesystem memory store implementing MemoryCoordinator (PLAN §10.2–§10.6).
 *
 * Layout under `root` (= `<repo>/.gx-dev/memory`):
 *   index.md, log.md, SCHEMA.md (generated), core pages, and the
 *   decisions/ features/ failures/ sources/ pins/ namespaces.
 *
 * Concurrency: proposed page names are atomically reserved in index.md under
 * `## Reservations` using an exclusive lock file; a conflicting create
 * degrades to an update. Promotions use conditional revision (hash) checks
 * and atomic tmp+rename writes. The search index is derived, never
 * authoritative.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, relative, sep } from "node:path";
import { hashContent } from "../domain/artifacts.ts";
import type { MemoryCoordinator, MemoryPage, MemoryProposal } from "../domain/interfaces.ts";
import { buildIndex, searchIndex } from "./indexer.ts";
import { redactSecrets } from "./redaction.ts";
import { extractLinks, isGeneratedPage, MEMORY_SUBDIRS, PAGE_NAMES, pageFileName, parsePage, serializePage } from "./wiki.ts";
import { lintWiki } from "./validator.ts";

/** Milliseconds to retry acquiring the exclusive lock before giving up. */
const LOCK_RETRY_MS = 2000;
/** A lock file older than this is considered stale and taken over. */
const STALE_LOCK_MS = 30000;

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
  before promotion; a conflicting create degrades to an update instead of
  creating a semantic duplicate.
- Final writes use conditional revision checks: a page changed since reserve
  goes to the conflict list instead of being overwritten.
- All writes are atomic (tmp + rename). Cancelling a run removes only its own
  reservation claims.
- The search index is derived data: disposable and rebuildable from Markdown.
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

function sleepMs(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      // spin: environments where Atomics.wait is unavailable
    }
  }
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

/** Recursively lists wiki page files (skips SCHEMA.md and tmp leftovers). */
function listPageFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
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

/** Parses the `## Reservations` section of index.md: page -> claimant run ids. */
function parseReservations(raw: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  let inSection = false;
  for (const line of raw.split(/\r?\n/)) {
    if (/^##\s+Reservations\s*$/.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^##\s/.test(line)) break;
    if (!inSection) continue;
    const m = /^-\s+(\S.+?):\s*planned by\s+(.+)$/.exec(line);
    if (m === null) continue;
    const runIds = g(m, 2)
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0);
    map.set(g(m, 1).trim(), runIds);
  }
  return map;
}

/**
 * Filesystem-backed memory coordinator. `root` is `<repo>/.gx-dev/memory`.
 * When `opts.redact` is true, promotion redacts secret-looking spans in page
 * bodies (see redaction.ts); default is off.
 */
export class FsMemoryStore implements MemoryCoordinator {
  private readonly root: string;
  private readonly lockPath: string;
  private readonly logPath: string;
  private readonly indexPath: string;
  private readonly redact: boolean;
  /** Page -> expected revision hash captured at reserve time (null = absent). */
  private readonly reservedRevisions = new Map<string, string | null>();

  constructor(root: string, opts?: { redact?: boolean }) {
    this.root = root;
    this.lockPath = join(root, ".lock");
    this.logPath = join(root, "log.md");
    this.indexPath = join(root, "index.md");
    this.redact = opts?.redact === true;

    mkdirSync(root, { recursive: true });
    for (const dir of MEMORY_SUBDIRS) {
      mkdirSync(join(root, dir), { recursive: true });
    }
    this.scaffoldCorePages();
    if (!existsSync(this.indexPath)) {
      atomicWrite(this.indexPath, this.renderIndex(this.listPageNames(), new Map()));
    }
    if (!existsSync(this.logPath)) {
      atomicWrite(this.logPath, LOG_MD);
    }
    const schemaPath = join(root, "SCHEMA.md");
    if (!existsSync(schemaPath)) {
      atomicWrite(schemaPath, SCHEMA_MD);
    }
  }

  /**
   * Atomically reserves page names in index.md. A create whose page already
   * exists on disk or is reserved by another run degrades to an update.
   * Returns adjusted proposals; inputs are not mutated.
   */
  async reserve(proposals: MemoryProposal[]): Promise<MemoryProposal[]> {
    if (proposals.length === 0) return [];
    this.acquireLock();
    try {
      const reservations = this.readReservations();
      const adjusted = proposals.map((p) => ({ ...p }));
      for (const proposal of adjusted) {
        const file = join(this.root, pageFileName(proposal.page));
        const exists = existsSync(file);
        const claimants = reservations.get(proposal.page) ?? [];
        const claimedByOther = claimants.some((id) => id !== proposal.runId);
        if (proposal.action === "create" && (exists || claimedByOther)) {
          proposal.action = "update";
        }
        const next = claimants.filter((id) => id !== proposal.runId);
        next.push(proposal.runId);
        reservations.set(proposal.page, next);
        this.reservedRevisions.set(
          proposal.page,
          exists ? hashContent(readFileSync(file, "utf8")) : null,
        );
      }
      atomicWrite(this.indexPath, this.renderIndex(this.listPageNames(), reservations));
      return adjusted;
    } finally {
      this.releaseLock();
    }
  }

  /**
   * Applies reviewed proposals with conditional revision checks. Pages whose
   * on-disk revision changed since reserve go to the conflict list untouched.
   */
  async promote(proposals: MemoryProposal[]): Promise<{ applied: string[]; conflicts: string[] }> {
    const applied: string[] = [];
    const conflicts: string[] = [];
    const logEntries: string[] = [];

    for (const proposal of proposals) {
      const file = join(this.root, pageFileName(proposal.page));
      const beforeRaw = existsSync(file) ? readFileSync(file, "utf8") : null;
      const beforeHash = beforeRaw === null ? null : hashContent(beforeRaw);
      if (this.reservedRevisions.has(proposal.page)) {
        const expected = this.reservedRevisions.get(proposal.page) ?? null;
        if (expected !== beforeHash) {
          conflicts.push(proposal.page);
          continue;
        }
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
      if (this.redact) body = redactSecrets(body).text;
      const content = serializePage(
        frontmatter,
        body.length === 0 || body.endsWith("\n") ? body : `${body}\n`,
      );

      // Conditional write: re-hash immediately before renaming into place.
      const recheckRaw = existsSync(file) ? readFileSync(file, "utf8") : null;
      const recheckHash = recheckRaw === null ? null : hashContent(recheckRaw);
      if (recheckHash !== beforeHash) {
        conflicts.push(proposal.page);
        continue;
      }
      atomicWrite(file, content);
      this.reservedRevisions.delete(proposal.page);
      applied.push(proposal.page);
      logEntries.push(
        `- ${new Date().toISOString()} ${proposal.runId} ${proposal.action} ${proposal.page}\n`,
      );
    }

    if (applied.length > 0) {
      this.acquireLock();
      try {
        const reservations = this.readReservations();
        for (const proposal of proposals) {
          if (!applied.includes(proposal.page)) continue;
          const claimants = reservations.get(proposal.page);
          if (claimants === undefined) continue;
          const rest = claimants.filter((id) => id !== proposal.runId);
          if (rest.length === 0) reservations.delete(proposal.page);
          else reservations.set(proposal.page, rest);
        }
        atomicWrite(this.indexPath, this.renderIndex(this.listPageNames(), reservations));
      } finally {
        this.releaseLock();
      }
      appendFileSync(this.logPath, logEntries.join(""), "utf8");
    }
    return { applied, conflicts };
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
      const file = join(this.root, `${name}.md`);
      if (existsSync(file)) continue;
      atomicWrite(
        file,
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

  private acquireLock(): void {
    const deadline = Date.now() + LOCK_RETRY_MS;
    for (;;) {
      try {
        const fd = openSync(this.lockPath, "wx");
        try {
          writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), null, "utf8");
        } finally {
          closeSync(fd);
        }
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        if (Date.now() < deadline) {
          sleepMs(25);
          continue;
        }
        let stale = false;
        try {
          stale = Date.now() - statSync(this.lockPath).mtimeMs > STALE_LOCK_MS;
        } catch {
          continue; // lock vanished; retry immediately
        }
        if (!stale) {
          throw new Error(`gx-dev memory lock is busy: ${this.lockPath}`);
        }
        try {
          unlinkSync(this.lockPath); // stale-lock takeover
        } catch {
          // another process took it first; retry the loop
        }
      }
    }
  }

  private releaseLock(): void {
    try {
      unlinkSync(this.lockPath);
    } catch {
      // already gone
    }
  }

  private readReservations(): Map<string, string[]> {
    const raw = existsSync(this.indexPath) ? readFileSync(this.indexPath, "utf8") : "";
    return parseReservations(raw);
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

  private renderIndex(pages: string[], reservations: Map<string, string[]>): string {
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
    const entries = [...reservations.entries()].sort(([a], [b]) => sortByName(a, b));
    if (entries.length === 0) lines.push("(no active reservations)");
    for (const [page, runIds] of entries) {
      lines.push(`- ${page}: planned by ${[...new Set(runIds)].join(", ")}`);
    }
    return `${lines.join("\n")}\n`;
  }
}
