# gx-dev readiness assessment

> Historical assessment before implementation. See [IMPLEMENTATION.md](IMPLEMENTATION.md) for fixes, current validation, and remaining limitations.

Reviewed commit: `138862a` (cloned from `https://github.com/jeet-doestech/gx-dev`).

## Verdict

**Substantial prototype, not yet a trustworthy unattended feature-delivery system.** The module boundaries, role contracts, Git integration helpers, and deterministic test scaffolding are useful foundations. However, several core promises—mandatory approval, evidence-backed gates, restart recovery, isolation, and reviewed memory—are not enforced end to end.

Prioritize correctness and integration over more agents, UI polish, or additional features. Do not treat the current `COMPLETE` state as proof that an approved feature was implemented and independently verified.

### Validation performed

- `npm ci --ignore-scripts`: succeeded. Install scripts were intentionally not executed.
- `npm test`: **159 passed**, zero failed/skipped.
- `npm run typecheck`: passed.
- `npm run sample`: passed with fake agents and real Git; created a commit and cleaned sample worktrees.
- `npm pack --dry-run`: passed; 50 packaged files.
- `npm audit --json`: **3 affected packages: 2 high, 1 moderate**, involving `brace-expansion`, `undici`, and the pi peer dependency. Audit severity is not proof of exploitability in this application.
- Additional temporary probes reproduced the failures identified below. They used disposable repositories and fake agent completions; no paid/live model workflow was run.
- Source reviewed across orchestration, persistence, gates, subprocess runner, Git, configuration/commands, memory, UI wiring, tests, and documented scope. UI behavior was inspected, not exercised interactively. Cross-platform compatibility and actual pi package installation remain unverified.

Application source was not changed. This report is the only added repository file.

## 1. Release blockers

### P0 — Approval checkpoints do not require approval

**Evidence:** `extensions/gx-dev/orchestration/engine.ts:918–1011`, `:730–762`; `extensions/gx-dev/ui/questions.ts:153–183`.

- Research and plan phases automatically record approval hashes and advance. They ask the user only if an agent supplies a material question.
- Only the first material question is handled.
- A cancelled modal or unavailable interactive UI returns an empty string. The engine records that as an answer and continues rather than parking.
- `resume()` can advance a `WAITING_FOR_USER` run without an answer. The existing restart test explicitly expects this behavior (`tests/integration/restart-recovery.test.ts`).
- Answers are written to evidence but not incorporated into requirements, plan, or subsequent worker prompts.
- Requirements are generated from a summary plus a placeholder acceptance-criteria bullet (`engine.ts:197–213`), not a real acceptance contract.

**Reproduced:** a normal run reached `COMPLETE`, recorded both approvals, and invoked the approval UI zero times. A material question answered with `""` also reached `COMPLETE`. A unique answer string never appeared in any downstream agent task.

**Complete:** introduce explicit approve/reject/edit decisions; persist the pending decision before displaying UI; treat dismissal as waiting; consume all material questions; propagate answers into versioned artifacts; invalidate approvals when artifacts change. `resume` must never mean approval.

### P0 — Worktree paths and role prompts are not security boundaries

**Evidence:** `extensions/gx-dev/agents/runner.ts:117–172`; `extensions/gx-dev/orchestration/engine.ts:108–152`, `:686–699`, `:1464–1507`; `extensions/gx-dev/gates/test-gate.ts:43–47`.

- `writableRoots` is supplied by the engine but ignored by the runner. Parsed role `tools` metadata is also ignored.
- Child processes retain ordinary filesystem/process permissions. A copied working directory does not prevent absolute-path writes, access to sibling worktrees, or writes through symlinks. Linked Git worktrees also expose shared repository metadata.
- Documentation mode runs a reviewer directly in staging. Its purported README/docs restriction is unenforced; `checkpointStaging()` commits all changes. Production/test changes can therefore be introduced after review without another adversarial review.
- The command allowlist only checks executable prefixes. `node`, `python`, `npx`, package scripts, and `make` can run arbitrary code. `execFile` avoids shell interpolation, but does not make these commands safe. Commands inherit the host environment.
- Snapshot copying excludes only `.git` and `node_modules`; it can copy `.env`, credentials, generated output, and historical evidence into agent contexts.

**Complete:** define an honest trusted-code execution policy. For a strong isolation guarantee, run workers and verification in an OS/container sandbox with explicit mounts, environment filtering, process/network restrictions, and read-only inputs. Enforce role tool policies and documentation-only diffs independently. Do not describe directory copies or an executable-prefix filter as a sandbox.

### P0 — Project configuration bypasses pi trust; safety options can be ignored

**Evidence:** `extensions/gx-dev/index.ts:164–199`; `extensions/gx-dev/config.ts:120–203`; `extensions/gx-dev/commands.ts:323–350`.

The globally installed extension reads project configuration without checking `ctx.isProjectTrusted()`. Project config controls `agents.piBinary`, which is executed by the runner and doctor. Invalid configuration silently becomes defaults in `buildEngine()`. Several advertised options are not consumed by execution, notably `git.autoCommit`, `agents.maxConcurrency`, `git.worktreeRoot`, research flags, and `memory.reviewRequired`.

**Impact:** a trust refusal does not necessarily prevent project-specified executable use; `autoCommit: false` does not prevent automatic commit; invalid config can unexpectedly re-enable default behavior.

**Complete:** check project trust before honoring executable or policy configuration; fail closed on invalid config; validate all known keys/types/ranges; implement each advertised option or reject unsupported settings explicitly.

### P0 — Evidence does not reliably describe the code being promoted

**Evidence:** `extensions/gx-dev/orchestration/engine.ts:766–791`, `:1119–1134`; `extensions/gx-dev/gates/test-gate.ts:230–265`; `extensions/gx-dev/gates/final-gate.ts:37–62`; `extensions/gx-dev/domain/artifacts.ts:60–107`.

- `captureDiff()` uses `git diff HEAD`, which excludes untracked files and already committed changes. If the result is empty or Git fails, it fabricates a unified diff from agent prose/JSON.
- `combined.diff` concatenates worker artifacts rather than reading the actual integrated staging diff. Rework captures only changes since each worker's latest checkpoint, not necessarily the full base-to-staging delta.
- Revision dependencies are hashes of prose/diff artifacts, not authoritative Git tree IDs.
- Command output is hashed into `outputRef` but never archived. Failures handed back to agents generally say only which command failed and its exit code, without stderr or stack traces.
- Repeated gate attempts overwrite fixed filenames such as `test-gate-commands.json` and `review-findings.json`.
- Evidence metadata exists only in memory. Reopening `FsArtifactStore` returns an empty evidence list; restart also resets evidence sequencing.
- Captured user input, agent output, and events have no centralized secret-redaction boundary.

**Reproduced:** two writes to one evidence filename left only the second body; a new store instance reported zero records.

**Complete:** remove synthetic diff fallback; obtain complete diffs and tree IDs from Git; capture untracked additions through controlled staging/checkpointing; store immutable per-attempt output blobs and a durable manifest; bind each verdict to requirements, plan, tree, command/environment, and evidence hashes; redact before capture.

### P0 — Verification can pass without running the promised tests

**Evidence:** `extensions/gx-dev/gates/test-gate.ts:199–268`; `extensions/gx-dev/gates/final-gate.ts:32–76`; `extensions/gx-dev/domain/schemas.ts:282–310`, `:346–382`.

The test gate executes only the test-runner agent's proposed commands. The planner's verification contract is prompt text, not a required command set. Empty command arrays are accepted. Final verification executes the contract, but an empty contract is valid, including after incomplete restart hydration.

**Reproduced:** test gate passed with zero commands despite a nonempty required contract. Final gate passed an empty contract when the clean-tree check succeeded.

**Complete:** validate a nonempty, meaningful verification contract or require an explicit human-approved exception; execute required checks deterministically; allow advisory additions but not omissions. Record test discovery/counts and map acceptance criteria to tests so a zero-test run cannot masquerade as behavioral verification.

## 2. Workflow and recovery correctness

### P1 — Pause/resume and restart recovery are incomplete

**Evidence:** `extensions/gx-dev/orchestration/engine.ts:508–570`, `:615–624`, `:1018–1103`; `extensions/gx-dev/orchestration/recovery.ts:42–60`; `extensions/gx-dev/git/worktrees.ts:84–145`.

- Same-instance `resume()` without a run ID does not reset `pauseRequested` or the aborted controller. It changes the state back to a pipeline phase, but `drive()` immediately exits.
- Fresh-engine recovery loads only `RunState`; plan tasks, verification contract, story, rework feedback, replan history, documentation updates, commit result, and evidence sequence are not rehydrated.
- `ensureHandles()` recreates worktrees rather than reopening existing ones. Repeated preparation fails on existing checked-out paths/branches.
- A crash during parallel development leaves `WRITE_TESTS`; its recovery path can proceed without ensuring developer completion.
- `recoverRun()` checks a state name/history, but does not reconcile Git, validate artifact hashes, or revalidate approvals.
- Commit application and state advancement are separate operations without a persisted idempotency receipt. A crash after merge needs explicit reconciliation, not blind replay.

**Reproduced:** pause followed by no-ID resume returned `DEVELOP` without invoking the developer again. Preparing an existing run's worktrees through a new manager failed.

**Complete:** define a durable run context and per-role attempt status; persist/reload all execution inputs; reopen validated worktrees; reconcile commits and hashes; make each side-effecting phase restart-idempotent. Test process death at every phase boundary and around Git commit application.

### P1 — Agent success is confused with valid JSON; repair context is lost

**Evidence:** `extensions/gx-dev/agents/runner.ts:76–109`, `:281–307`; `extensions/gx-dev/orchestration/engine.ts:1048–1074`, `:1348–1421`; `extensions/gx-dev/orchestration/routing.ts:44–66`.

- Schema-valid `status: "blocked"` produces `ok: true`; most phases inspect only `ok`. Developer/test-writer questions are not routed as decisions.
- When both workers need repair, `rerunDeveloper()` clears the entire feedback object before the test writer reads its feedback.
- Failure ownership is proposed before actual verification execution. There is no post-failure diagnostic step using the real output.
- Infrastructure ownership maps to no workers, but the test-gate path still increments code-failure counters and cycles/replans rather than implementing the advertised separate infrastructure retry policy.

**Reproduced:** a developer completion explicitly marked `blocked` still led to `COMPLETE` in the deterministic harness.

**Complete:** separate transport/schema success from task completion; handle blocked/question outcomes for every role; preserve per-owner feedback; classify actual failures after execution; feed archived diagnostics and peer/public-contract context into targeted repairs.

### P1 — Process shutdown and run concurrency are not coordinated

**Evidence:** `extensions/gx-dev/index.ts:71–74`, `:296–303`; `extensions/gx-dev/agents/runner.ts:39–50`, `:223–247`; `extensions/gx-dev/orchestration/engine.ts:650–683`, `:573–590`.

Session shutdown drops engine references without aborting/awaiting work. Model changes reset the shared engine even when a run is active. Runner cancellation resolves before child exit; it signals only the direct child, not its process tree. Gate execution has no engine abort signal. Cleanup can race processes still writing. There is no cross-process repository/run lease or single-flight control around driving/resuming a run.

**Complete:** one run supervisor with explicit lifecycle, cancellation propagation, process-tree termination, exit acknowledgement, and repository/run locks. Queue configuration changes for the next run. Convert uncaught Git/filesystem exceptions into durable blocked/error states rather than leaving a misleading active phase.

## 3. Git and configuration integration

### P1 — Final integration can target the wrong branch

**Evidence:** `extensions/gx-dev/git/worktrees.ts:103–109`, `:245–354`.

The final guard checks HEAD SHA and cleanliness but not branch identity. If the user switches to another branch at the same SHA, the merge is applied there. Preparation also overwrites the intake base with the then-current repository tip instead of verifying the approved anchor.

**Reproduced with real Git:** switch from `main` to `other` at the original SHA, then call `commitStaged(..., "main")`: the result was merged into `other`; `main` remained unchanged.

The emitted rollback command uses `git reset --hard` plus `git branch -f`, contrary to the documented no-history-rewrite default, and would discard unrelated later work if used carelessly. It is emitted, not automatically executed.

**Complete:** persist and verify repository identity, symbolic branch, base SHA, and target ref; fail closed on changes. Use guarded, strategy-aware revert instructions by default. Require explicit authorization for destructive reset-based rollback.

### P1 — Saved model choices do not reach the production runner

**Evidence:** `extensions/gx-dev/index.ts:168–190`; `extensions/gx-dev/agents/runner.ts:117–126`; `extensions/gx-dev/config.ts:224–247`; `agents/*.md`.

The resolver supports explicit config taking precedence over role pins, and the picker displays that resolution. Production wiring uses `loadConfig()` and omits the runner's `explicitModels` map. All packaged prompts pin the default model, so they win over the user's configured model.

**Reproduced:** setting the developer config to `example/selected-model` produced runner arguments `--model zai/glm-5.3-flash:max` with production-equivalent construction.

`inherit` omits `--model`; that chooses a child's default, not necessarily the parent session's active model/thinking level. The final commit trailer also hardcodes a provider/model instead of recording the actual served model.

**Complete:** use `loadConfigWithSources()` in runtime construction; pass explicit selections and resolved parent-session settings; test the actual extension-to-child argument path, not only resolver/CLI helpers.

### P1 — Fresh-repository setup can dirty the repository and block itself

**Evidence:** `extensions/gx-dev/index.ts:190–197`; `extensions/gx-dev/domain/persist.ts:25–32`; `extensions/gx-dev/git/worktrees.ts:92–101`; `scripts/sample-workflow.mjs:66–69`.

Constructing the engine scaffolds `.gx-dev/memory`; starting a run writes state before Git preparation. A normal target repository that does not ignore `.gx-dev/` becomes dirty and is then rejected. The sample manually adds the ignore rule, masking this onboarding gap. Non-Git and no-commit projects are refused despite advertised empty-project support.

**Reproduced:** initializing memory in a clean fixture made worktree preparation fail with “working tree has uncommitted changes.”

**Complete:** perform intake before side effects; establish a clear internal-state ignore/storage policy without silently committing it; surface dirty/stale-base issues before expensive model calls. Implement consent-driven empty-project bootstrap, or remove it from supported scope for this release.

## 4. Memory, product completion, and quality gaps

### P1/P2 — Memory exists as a library, not a completed learning workflow

**Evidence:** `extensions/gx-dev/orchestration/engine.ts:1591–1637`; `extensions/gx-dev/memory/store.ts:249–366`.

- Engine never explicitly calls `memory.search()` or `memory.lint()`. A researcher could discover copied wiki files incidentally, but there is no deterministic index-first retrieval/pin injection.
- Promotion is an engine-generated success summary marked verified, not reviewer-proposed/reviewed knowledge. It lacks the wiki's required `## Summary` structure and outbound links.
- Core pages remain scaffold placeholders unless externally changed.
- Promotion's hash-check/write is outside the lock. Two processes can both pass checks before either rename and overwrite one another; sequential tests do not establish cross-process compare-and-swap safety.
- Reservations/revision expectations are partly in memory; cancellation does not release reservation claims. Conflict reporting does not prevent overall completion.

**Complete:** explicit retrieval and pin context; reviewer-authored, evidence-linked proposals; lint/review before promotion; lock the complete compare-and-write transaction; durable reservations and crash recovery; distinguish “feature committed, memory pending” from a failed feature delivery.

### P2 — Advertised commands and behavior exceed implemented scope

`extensions/gx-dev/commands.ts:394–463` registers 11 commands. README also advertises `story`, `evidence`, `retry`, `rollback`, `cleanup`, and `memory`; these are absent. History lists runs rather than providing the documented decision/evidence browser. Doctor does not perform the promised full trust/worktree/memory checks. The dashboard captures state/events on opening rather than subscribing to live updates.

Other gaps:

- No explicit web research adapter/source-capture pipeline; source declarations rely on agents and installed tools.
- No automatic successful-run worktree cleanup in the engine. The sample performs cleanup externally; the extension does not.
- No defined dependency bootstrap/cache strategy for fresh staging worktrees; ignored installations such as `node_modules` are not inherited.
- Arbitrary “10 meaningful lines” preflight rejects legitimate one-line fixes yet can accept substantial prose or context/removal lines.
- Command strings are split on whitespace, breaking quoted arguments. Use `{ executable, args, cwd, envPolicy }` contracts.
- No checked-in CI/release workflow, platform matrix, or state-schema migration policy.
- The Node `>=22` declaration is broader than verified native-TypeScript test support; test the precise minimum version or raise it.
- README contains stale schema/command/test-count/security assertions. The HTML documentation site was intentionally removed by the latest commit; rebuilding it is **not** a recommended backlog item.

## 5. Why green tests are insufficient

The current integration/e2e engine harness uses a fake Git coordinator that creates standalone repositories, reports successful integration/commit, and a fake runner that does not implement the requested feature. Synthetic diff fallback turns those completion reports into apparent change evidence. Tests can consequently establish state-machine traversal without establishing delivery correctness.

The fake-agent/real-Git sample is a valuable additional check, but it has favorable fixture setup, auto-approved questions, and driver-owned cleanup. It does not prove the installed extension obeys the same contracts.

Add these release-gating suites:

1. Actual extension construction plus fake pi executable: config/trust/model/tools/env/argv wiring.
2. Real Git, deterministic workers that write real production and test changes: assert final behavior, exact committed tree, unchanged user branch before approval, and actual gate outputs.
3. Negative delivery cases: no changes, untracked-only changes, worker-created commits, one-line fix, missing tests, zero discovered tests, weakened tests, empty contract, blocked agent, documentation touching source.
4. Approval matrix: reject/edit/Esc/empty/no-UI/multiple questions/restart; prove answers affect later prompts and unresolved decisions cannot be resumed past.
5. Kill/restart at every phase and around commit; compare with uninterrupted execution.
6. Pause/cancel/timeout/shutdown with child grandchildren; assert no surviving processes or post-cancel writes.
7. Real multi-process locking: simultaneous resume, competing final integration, simultaneous memory promotion.
8. Installation/platform matrix: packaged local/Git/npm smoke tests and supported Node/pi versions on Linux/macOS/Windows.

## 6. Recommended completion order

| Milestone | Work | Done criterion |
|---|---|---|
| A. Restore user authority | Real approvals, answer propagation, blocked outcomes, trusted/strict config, honor autoCommit | No worker or merge runs past an unanswered/rejected decision; policy tests use production wiring. |
| B. Restore evidentiary correctness | Real Git diffs/tree IDs, mandatory verification, immutable/redacted logs, docs scope enforcement | Every pass references retrievable evidence for exactly the committed tree; no-op/empty-test scenarios fail. |
| C. Make lifecycle durable | Persistent execution context, worktree reopen, commit receipts, abort supervisor, locks | Restart/pause/cancel tests pass at every phase; no duplicate commits or orphan writers. |
| D. Make onboarding and Git safe | Clean-state policy, base/branch guards, model wiring, dependency setup, safe rollback/cleanup | A normal fresh target repo completes correctly; branch movement and user edits fail safely. |
| E. Complete memory and supported UX | Retrieval/pins, reviewed proposals, transactional promotion, live status, missing commands or narrowed docs | Second run demonstrably reuses reviewed knowledge; user can diagnose/recover without editing internal files. |
| F. Release qualification | CI, package/platform matrix, dependency updates, schema/version policy, measured live pilots | Automated install/control/delivery suites pass and supported claims match tested behavior. |

Do A–D before expanding scope. Implement sandboxing before claiming strong isolation or supporting untrusted project execution. Until then, label execution as trusted-repository/full-user-permission mode.

## 7. Optimizations after correctness

1. **Avoid repeated full directory copies.** Snapshot a filtered, content-addressed tree; exclude run history, credentials, caches, and build output. Reuse immutable snapshots per tree revision and measure copy time/bytes.
2. **Cache dependencies by lockfile and toolchain.** Use isolated per-worktree writable installs backed by a shared package download cache, not uncontrolled shared writable dependency trees.
3. **Reuse gate results only against exact inputs.** Cache by tree ID, verification contract, toolchain/environment, requirements, and relevant policy. After a truly docs-only change, rerun the checks affected by those docs rather than reflexively all expensive suites.
4. **Reduce agent overhead.** Skip documentation generation when no update is required; consider deterministic commit-message generation without another model call. Make concurrency real and bounded; add overall time/token/cost budgets.
5. **Make repair prompts diagnostic.** Supply changed files, actual failing output, violated acceptance criteria, and relevant contracts; avoid resending entire repository/history. Preserve full audit data separately.
6. **Use bounded streaming and asynchronous I/O.** Cap child line/output buffers, persist logs incrementally, avoid synchronous memory-lock waits on the UI thread, and maintain an incremental search index for large wikis.
7. **Measure the right outcomes.** Phase duration, queue time, retry causes, tokens/cost across all turns, first-pass gate rate, recovery success, and post-commit acceptance results. Current streaming usage retains the latest message rather than aggregating the complete multi-turn run.
8. **Split the 1,638-line engine by durable phase handlers.** Keep transitions centralized; isolate execution, decisions, recovery, and evidence plumbing. Inject the command executor to make deterministic engine tests practical without substituting away real Git semantics.

**Bottom line:** preserve the architecture, but finish the control and evidence paths first. A smaller reliably approved, recoverable, verifiable workflow is more valuable than the currently broad v1 claims.
