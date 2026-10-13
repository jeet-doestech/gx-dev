# Review implementation status

This document supersedes the readiness conclusions in the original [REVIEW.md](REVIEW.md), which assessed commit `138862a` before these changes. The original review remains as historical context. This implementation is not a claim that every item in the original product plan has shipped.

## Implemented

### User authority and configuration

- Requirements and plan checkpoints require explicit approval, including runs with no agent questions.
- Pending decisions are persisted before presentation. Empty/dismissed questions stay waiting; resume/retry never approve them.
- Decision instances and artifact hashes prevent repeated answers from accidentally approving another revision. Amendments require fresh approval; changed approved artifacts block subsequent execution.
- User answers propagate into subsequent agent prompts. Worker and test/review gate material questions reach the user without counting as code failures.
- Research output requires nonempty observable acceptance criteria; planner output requires a nonempty verification contract.
- Blocked agent completions no longer masquerade as completed work.
- Strict config validation rejects unknown keys, invalid ranges/types, and unsupported policy values. Invalid trusted-project config cannot silently enable defaults.
- Runtime and command paths honor pi project trust before using project configuration/executables.
- Explicit model selections reach the production runner; `inherit` uses the parent's resolved model/thinking level. Active-run model changes are rejected before persistence.
- `autoCommit: false` requires a separate apply confirmation. `maxConcurrency: 1` serializes workers. Unsupported custom worktree roots and unenforceable policy switches are rejected.
- Read-only engine construction no longer scaffolds `.gx-dev/memory` as a side effect.

### Evidence and verification

- Removed fabricated agent-prose diffs. Evidence comes from real base-to-worker/staging Git diffs, including checkpointed untracked files and worker commits.
- Gates deterministically execute the mandatory verification contract plus distinct advisory commands; empty contracts fail closed.
- Removed the arbitrary ten-line minimum. One-line fixes and meaningful deletions are accepted; introduced-secret checks inspect additions rather than removed secrets.
- Content-addressed evidence and a durable manifest prevent repeated attempts from overwriting their predecessors. Evidence survives store reconstruction.
- Captured command evidence contains command/exit/truncation metadata and output; bounded redacted diagnostics feed repairs. Event logs redact credential-shaped values and tolerate interrupted records without losing later events.
- Evidence redaction occurs before hashing/storage, so recorded hashes describe the bytes actually retained.
- Final verification records the staging tree and rejects tree drift before application.
- Documentation checks cover committed and uncommitted edits plus both rename sides, not merely the current dirty status.
- Approval hashes are rechecked at phase boundaries, including after recovery.

### Lifecycle and Git

- Durable execution context includes plan tasks/contract, decisions, answers, pending questions, repair feedback, replan/failure history, documentation status, and commit intents/receipts.
- Same-instance and fresh-engine resume reopen existing validated worktrees and recover incomplete worker phases rather than silently skipping development.
- Commit recovery recognizes an already-applied result by original branch, ancestry, run provenance, and exact tree; ambiguous recovery blocks instead of reapplying.
- Fast-forward application now includes a same-tree provenance commit, allowing the same receipt/recovery checks. Fast-forward rollback follows first-parent history and skips empty commits to avoid double-reverting merged work.
- Final Git application checks both branch identity and base SHA. Preparation preserves the original anchor. Internal operational state no longer makes a fresh repository block itself as dirty; unrelated changes still block.
- Rollback guidance uses history-preserving `git revert`, not `reset --hard`/forced branch movement. Emitted merge and fast-forward rollback instructions are exercised by real-Git tests.
- Agents and commands participate in cancellation tracking; POSIX process groups are signalled and child closure is awaited. Run shutdown pauses before releasing resources. Recovery refuses to replace work that has not quiesced.
- Repository execution leases exclude competing processes. Dead-owner reclamation uses nonempty directory publication and retained tombstones rather than age-based lock stealing or timing assumptions.
- New runs discover unfinished persisted runs. Stale parked controls cannot overwrite state another owner has advanced.
- Run IDs are validated; state writes use unique temporary files and atomic rename.
- Successful runs clean up their own worktrees; failed/cancelled runs follow retention policy.

### Memory and UX

- Research receives retrieved project-memory context explicitly.
- Proposals have wiki structure, provenance, and links; a separate reviewer checks them before promotion. Proposal lint errors/throws prevent promotion while allowing the already-delivered feature to remain complete with a recorded memory follow-up.
- Reserve/promote/release use the cross-process lease. Revision expectations survive restart; compare-and-write is one locked transaction. Applied/conflicting claims are released.
- Paths are validated; generated index/log pages cannot be overwritten by proposals. Redaction covers frontmatter as well as body.
- Scaffold creation is exclusive; concurrent constructors cannot overwrite existing pages. Lease/tombstone directories are excluded from indexing.
- Added story-file, evidence, retry, memory inspection, and guarded finished-run cleanup commands. Dashboard refreshes from persisted state/events and disposes its timer.
- README now documents actual supported commands, trust limitations, and missing capabilities rather than describing the entire original plan as complete.

### Release checks

- Updated dependency lockfile; the checked installation reports zero npm audit findings.
- Runtime requirement is now Node 24+; peer baseline is pi 1.2.0+, below 2. The TUI peer is declared explicitly. Older Node/pi combinations are not claimed as supported.
- Added `npm run test:package`: pack, extract, load the actual tarball entry point, verify packaged roles, and register lifecycle/command hooks without credentials or model calls.
- Added `npm run check` and a Linux/macOS Node 24 CI workflow. No release/publish job is enabled.

## Validation performed locally

On Linux, Node `v24.18.0`, with the locked pi peer `1.2.0`:

| Check | Result |
|---|---|
| TypeScript | Pass |
| Automated tests | **382 pass, zero failed/skipped** |
| Deterministic sample | COMPLETE; real Git commit and worktree cleanup |
| Packed entry-point smoke | Pass; no model calls |
| npm audit | **0 vulnerabilities reported** |
| `git diff --check` | Pass |

Tests include separate-process lease contention/dead-owner recovery, an intentionally delayed stale reclaimer, concurrent memory writes, branch switches, approvals/replans, commit crash windows, documentation smuggling, actual delivered behavior, evidence persistence, and stale control-state rejection.

The package smoke uses the locally installed host peers; it is not a clean-registry install test. CI configuration exists but remote Linux/macOS jobs have not been observed in this session. No paid/live-provider run, interactive terminal acceptance run, Windows certification, or publication was performed. Application changes remain uncommitted for review.

## Remaining work / deliberate limits

These are not silently claimed as finished:

1. **OS sandboxing:** processes retain host user permissions and credentials. Role tool selection, prompts, snapshots, and worktrees are defense-in-depth, not filesystem/network isolation. Untrusted-repository execution is unsupported. An external container/VM with restricted mounts/network is required for that use case.
2. **Semantic verification coverage:** required commands cannot be omitted, but no universal adapter proves acceptance-criterion coverage or detects every test framework's zero-test success. Add framework-aware test inventory/counts and coverage contracts.
3. **New-project initialization:** existing committed Git repositories only. Consent-driven empty-directory Git/framework/bootstrap workflows remain unimplemented.
4. **Environment bootstrap:** there is no general dependency/toolchain installer or lockfile-keyed dependency cache for worktrees. Project verification must arrange its own prerequisites. Avoid sharing writable dependency trees between workers.
5. **Research:** no dedicated web-fetch/source-capture subsystem or network sandbox. Research relies on the child's installed tools and structured provenance; it is not a guarantee of automatic current web research.
6. **Memory quality:** retrieval is lexical and proposals are reviewed summaries. Automatic core-page evolution, strong semantic pin preservation, contradiction resolution, and efficient incremental indexing remain work. Reviewed memory is not automatically infallible.
7. **Resource/cost optimization:** repeated filtered snapshots still cost I/O; there is no overall token/cost budget, exact-input gate cache, or general worker task scheduler. The engine remains large and should be split into typed phase services in a later behavior-preserving refactor.
8. **Compatibility and migration:** old run schemas are not migrated comprehensively. Legacy/corrupt lock files require operator inspection; never delete a live lease or tombstone while contenders may exist. Do not claim automatic recovery across arbitrary historical versions.
9. **Platform/live qualification:** verify real model providers, TUI controls, package-manager installation sources, long-running cancellation, and macOS CI results; implement/test Windows-specific process-tree termination before supporting it.
10. **Operator UX:** no automatic rollback execution, exportable full event-history browser, or memory-conflict resolution UI. Evidence and revert guidance are available for manual inspection.

The next recommended milestone is sandboxed execution plus framework-aware verification, followed by measured live-model pilots. Keep these changes in trusted, disposable or backed-up repositories until those qualifications are complete.
