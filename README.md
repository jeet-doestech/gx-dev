# gx-dev

An experimental, local multi-agent feature workflow for the [pi coding agent](https://github.com/earendil-works/pi-mono).

**Trusted repositories only.** Subagents and verification scripts run with your user permissions. Git worktrees separate working copies; they are **not an OS sandbox**. Do not use this extension to execute an untrusted repository.

## Status

The workflow now requires explicit requirements/plan approvals, captures real Git diffs and immutable gate evidence, persists execution context, and supports guarded restart recovery. The deterministic test harness writes real implementation/tests and integrates them through real Git.

This is not a production-readiness or autonomous-correctness guarantee. See [IMPLEMENTATION.md](IMPLEMENTATION.md) for implemented controls, remaining work, and validation limits. [PLAN.md](PLAN.md) is the original design, not a list of shipped features.

## Requirements and installation

- Node **24+** (native TypeScript execution).
- pi **1.2.x or compatible 1.x**, Git, and credentials for the models you select.
- An existing local Git repository with an initial commit and a checked-out branch.
- A trusted pi project. Execution and project-configured binaries are refused without project trust.

From a reviewed local checkout:

```bash
npm ci
npm test
npm run typecheck
pi install /absolute/path/to/gx-dev
```

Git installation is also supported by pi's package manager:

```bash
pi install https://github.com/jeet-doestech/gx-dev
```

Review and pin a commit/tag before using a remote package. Local changes are not available through the Git URL until published. Reload pi after installing. Nothing in this repository's CI publishes packages automatically.

## Quick start

```text
/gx-dev doctor
/gx-dev models show
/gx-dev models set developer inherit
/gx-dev start Add a farewell function with behavior tests
```

All seven roles have a packaged default of `zai/glm-5.3-flash:max`. Configure each role to a model actually available through your pi installation. Explicit project selections override packaged role pins. `inherit` is pinned to the parent session's model/thinking level when the engine is constructed; it is not the child's unrelated default.

Do not change model selections during a nonterminal run. Finish or cancel the run first.

## Workflow

```text
Intake / memory retrieval
  → researcher → material questions → requirements approval
  → planner → material questions → plan approval
  → developer + independent test writer in separate worktrees
  → checkpoint / integrate into staging
  → required test commands + advisory checks
  → adversarial review
  → documentation-only update
  → final verification of staging
  → apply to the original branch
  → reviewed memory proposals / cleanup
```

Requirements include a nonempty set of observable acceptance criteria. Plans include a nonempty verification contract. Agents return schema-validated JSON; schema errors get one corrective retry. A valid JSON response marked `blocked` is not task completion.

### Decisions

Requirements and plans always need an explicit decision, even when the agents have no questions:

- `approve` approves the displayed revision.
- `reject <reason>` sends it back for revision.
- `edit <amendment>` (or other free text) amends the artifact and asks for approval again. It does **not** approve it.
- Esc, empty input, and missing interactive UI leave the run waiting.

The pending question is persisted before UI display. Decisions have unique instance IDs and artifact hashes; repeated `approve` answers after replanning are distinct decisions. A changed artifact cannot reuse the approval shown for its previous revision.

Use `/gx-dev answer <text>` for a parked question. `/gx-dev resume` and `/gx-dev retry` never mean approval. Answers are preserved and included in downstream agent context. Material gate questions reach the user rather than being counted as code failures.

### Verification and repair

- Worktree changes are checkpointed before evidence capture, so new files and agent-created commits appear in actual base-to-worktree and base-to-staging diffs. There is no agent-prose fallback.
- The engine executes the planner's required verification commands, then any distinct advisory commands. An empty contract fails closed.
- Command execution uses argument parsing without shell interpolation. Quoted arguments work; shell pipelines/redirects are not a supported contract format. Put complex checks in a repository script.
- The executable-prefix filter is a routing filter, **not a sandbox**. `npm`, `node`, `python`, `make`, etc. can execute arbitrary code.
- Commands have time/output limits. Bounded, redacted diagnostics feed repair prompts; captured output and metadata are stored as evidence. Truncation is recorded—unbounded/full logs are not promised.
- Test/review failure counters drive targeted repair and replanning. Passing tests alone do not replace adversarial review.
- Documentation edits are checked across both committed and uncommitted changes, including both sides of renames. Non-documentation changes block before the documentation checkpoint.
- Final verification records the staging tree; a different tree cannot be applied as the verified result.

The system does not yet prove semantic acceptance coverage or detect every framework's zero-test success. Human review remains necessary.

## Commands

All commands are under `/gx-dev`:

| Command | Behavior |
|---|---|
| `start <request>` | Start a run; refuses another unfinished recorded run. |
| `story <file>` | Start from a nonempty readable story file. |
| `status` | Current run, or recorded-run guidance. |
| `dashboard` | TUI state/events view, refreshed from disk. |
| `answer <text>` | Answer the pending question. |
| `pause` | Stop active work and preserve a resumable checkpoint. |
| `resume [run-id]` | Recover/continue, without bypassing questions. |
| `retry [run-id]` | Retry after resolving a blocker; unanswered checkpoints stay waiting. |
| `cancel` | Stop work, release memory reservations, apply retention policy. |
| `history` | List recorded runs. |
| `evidence [run-id] [kind]` | Show evidence references and paths. |
| `cleanup <run-id>` | Non-force cleanup of a finished run; dirty/unmerged leftovers are reported. |
| `memory lint` / `memory search <query>` | Inspect existing project memory. |
| `config` | Display configuration. |
| `models [show \| set <role> <spec>]` | Inspect/select models; no changes during an active run. |
| `doctor` | Check trust, config, executables, Node, and packaged role files. |

There is **no automatic rollback command**. The result records history-preserving Git revert guidance; inspect it before use, especially if subsequent work exists. Doctor is not an exhaustive environment or sandbox audit.

## Configuration

Trusted-project configuration lives in `.gx-dev/config.json`. Unknown keys, wrong types, unsupported policy switches, and invalid ranges are errors; execution does not silently fall back to defaults.

```json
{
  "version": 1,
  "agents": {
    "maxConcurrency": 2,
    "timeoutMinutes": 30,
    "piBinary": "pi",
    "models": {
      "researcher": "inherit",
      "planner": "inherit",
      "developer": "inherit",
      "testWriter": "inherit",
      "testRunner": "inherit",
      "reviewer": "inherit",
      "committer": "inherit"
    }
  },
  "gates": {
    "maxConsecutiveFailures": 5,
    "maxTotalAttempts": 20,
    "requireCleanFinalTree": true
  },
  "research": { "webEnabled": true, "recordSources": true },
  "memory": {
    "enabled": true,
    "updateOnSuccess": true,
    "reviewRequired": true,
    "redactSecrets": true
  },
  "git": {
    "worktreeRoot": "adjacent",
    "retainFailedRuns": true,
    "autoCommit": true,
    "allowHistoryRewrite": false
  }
}
```

- `maxConcurrency: 1` serializes the two workers; larger values currently allow the two defined workers, not an arbitrary task pool.
- `autoCommit: false` requires a separate explicit confirmation before applying staging to the user's branch.
- Only the adjacent worktree layout is supported. Custom roots are rejected.
- `research.webEnabled: false` is rejected: the host-process runtime cannot guarantee network isolation. Web access depends on the child's available tools; there is no dedicated automatic research adapter.
- Source provenance and memory review cannot be disabled; `recordSources: false` and `reviewRequired: false` are rejected.
- `allowHistoryRewrite: true` is rejected. No force push is performed.
- Memory can be disabled entirely. Evidence redaction remains enabled independently of the memory-body redaction option.

## Persistence and recovery

```text
.gx-dev/
  config.json
  runs/<run-id>/
    state.json              # workflow + execution context, decisions, receipts
    events.jsonl            # redacted event audit
    requirements.md
    plan.md
    verification.json
    developer.diff
    tests.diff
    combined.diff
    result.md
    evidence/
      manifest.jsonl        # durable content-addressed evidence records
      agent-output/
      commands/
      reviews/
      user-input/
  memory/                   # reviewed Markdown wiki
```

Worktrees are adjacent to the repository at `.gx-dev-worktrees/<run-id>/{developer,tests,staging}`. Successful runs remove their worktrees. Failed/cancelled work is retained according to policy.

`.gx-dev/` is reserved operational data, excluded from the Git dirty-tree guard; unrelated changes still block. Keep it out of commits and backups shared with others as appropriate. **Operational state and working artifacts can contain user input and repository data.** Redaction is heuristic, not a guarantee that no sensitive information exists anywhere in a run. Do not place credentials in requests.

Repository execution and memory promotion use directory leases. Live owners are not displaced based on age. Dead owners can be reclaimed; retained tombstones prevent delayed reclaimers from stealing a successor's lease. Corrupt/legacy locks fail closed. Remove a lock/tombstone manually only after verifying that no gx-dev process can still contend.

Recovery restores execution inputs and reopens existing worktrees. Commit intents/receipts reconcile an already-applied result using branch, ancestry, tree, and run provenance rather than blindly merging again. Ambiguous recovery blocks for inspection. Legacy runs from before durable execution-context support are not guaranteed resumable; preserve them and start a fresh run after explicitly resolving/cancelling them.

## Security boundary

Implemented controls include project trust, explicit approvals, strict configuration, separate worktrees, role-tool selection, filtered advisory snapshots, process-group cancellation on POSIX, Git branch/base guards, documentation-scope checks, and redacted content-addressed evidence.

They **do not** provide:

- OS-level filesystem/network isolation or protection from malicious scripts;
- a guarantee that `bash` cannot write outside a worker's designated paths;
- immunity to prompt injection or secrets unknown to the redaction patterns;
- Windows process-tree termination guarantees;
- automatic empty-project initialization, deployment, or pull-request publication.

Use an external sandbox/container for stronger containment, with narrowly scoped mounts and credentials. Researcher snapshots exclude common secret files, runtime history, configuration extensions, and caches, but filtering is not access control.

## Development

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
npm run sample                 # fake agents, real Git; no paid model calls
npm pack --dry-run
npm audit
```

`node scripts/sample-workflow.mjs --live --keep` invokes paid/configured models and auto-approves fixture questions. It is an opt-in smoke experiment, **not** a safe approval policy for user projects.

The test suite covers real Git delivery, approvals, restart/commit crash windows, cancellation, model/config wiring, immutable evidence, and multi-process leases/memory promotion. CI runs deterministic tests, sample delivery, type checks, and package smoke checks on Linux/macOS with Node 24. CI being configured does not mean its remote jobs have already run.

MIT — [LICENSE](LICENSE).
