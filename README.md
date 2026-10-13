# gx-dev

Deterministic, evidence-based multi-agent feature delivery for the [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).

gx-dev coordinates isolated AI subagents through a persisted workflow state machine: research → requirements approval → plan → plan approval → parallel development in isolated Git worktrees → deterministic integration → test gate → adversarial review → documentation → final verification → automatic commit → memory promotion. Agents never approve their own work; every transition is validated and persisted before the next action begins. All documentation — workflow, architecture, agents, gates, memory, TUI, configuration, security, installation, troubleshooting, and schemas — lives in this README; the original planning document is [`PLAN.md`](./PLAN.md) at the repo root.

| | |
|---|---|
| Specialized subagents | 7 (researcher, planner, developer, test writer, test runner, reviewer, committer) |
| Isolated Git worktrees | 3 (developer, tests, staging) |
| Consecutive failures before replanning | 5 |
| State machine | 1, orchestrator-controlled (application logic, not another agent) |

**Core proposition — non-deterministic work, deterministic gates.** Agents can reason creatively, but they cannot promote themselves; transitions are controlled by structured artifacts, Git state, executable verification, and review evidence:

- **Isolate** — developer and test writer start from the same approved contract in separate worktrees, reducing test-to-code collusion.
- **Verify** — exact commands, exit codes, diffs, findings, and revision hashes — not confidence — determine progress.
- **Compound** — raw captures remain evidence; only reviewed, provenance-backed conclusions become durable memory.

**Always asks the user:** clarified requirements; architecture and implementation plan; destructive or difficult-to-reverse operations; material API, security, dependency, framework, or migration decisions; ambiguity exposed after repeated failures.

**May proceed automatically:** minor reversible operational corrections; approved implementation and test tasks; mechanical verification and evidence collection; reviewer-verified documentation updates; final commit after every gate passes.

**Status:** every subagent defaults to `zai/glm-5.3-flash:max` (GLM-5.3-Flash at maximum thinking), configurable per role or via `inherit` — see [Per-subagent model selection](#per-subagent-model-selection).

## Table of contents

- [How gx-dev works](#how-gx-dev-works)
- [Workflow & parallel build](#workflow--parallel-build)
- [Gates](#gates)
- [Architecture](#architecture)
- [Agents](#agents)
- [Per-subagent model selection](#per-subagent-model-selection)
- [TUI reference](#tui-reference)
- [Configuration](#configuration)
- [Security](#security)
- [Memory system](#memory-system)
- [Installation](#installation)
- [Troubleshooting](#troubleshooting)
- [Reference](#reference)
- [Development](#development)
- [Implementation notes (v1)](#implementation-notes-v1)
- [License](#license)

## How gx-dev works

A persisted state machine coordinates creative agents without allowing any agent to approve its own work. The orchestrator is application logic assisted by constrained reasoning — not another unchecked agent — with no authority to bypass user checkpoints or evidence gates.

### Canonical path

```text
INTAKE
  ↓  capture story
RESEARCH
  ↓  repo + web, with provenance
REQUIREMENTS_APPROVAL    ← mandatory user checkpoint
  ↓
PLAN
  ↓  verification contract
PLAN_APPROVAL            ← mandatory user checkpoint
  ↓
PREPARE_WORKTREES
  ↓
DEVELOP ─────────┐
                 ├── parallel, isolated worktrees
WRITE_TESTS ─────┘
  ↓
INTEGRATE               deterministic merge into staging
  ↓
TEST_GATE ── pass ──→ REVIEW_GATE
  ├── fail → route to the responsible owner (see [Ownership routing](#ownership-routing))
  └── 5 consecutive failures → REPLAN (planner receives full history)
  ↓
REVIEW_GATE ── pass ──→ DOCUMENTATION_UPDATE
  ├── fail → route to the responsible owner
  └── 5 consecutive failures → REPLAN
  ↓
FINAL_VERIFICATION
  ↓
COMMIT                  automatic; hash + rollback recorded
  ↓
MEMORY_PROMOTION        reviewed pages only
  ↓
COMPLETE

Additional states: WAITING_FOR_USER · PAUSED · CANCELLED · BLOCKED ·
RECOVERING · ROLLING_BACK · FAILED · REPLAN
```

### Persist-first transitions

- Every transition is written to `state.json` before the next action begins, enabling safe restart and recovery.
- Transitions reference the hashes of the requirements, plan, input revisions, and evidence they depend on.
- Material ambiguity enters `WAITING_FOR_USER`; it never becomes an invented assumption.
- On resume, persisted state is reconciled against live Git before anything executes; stale captured contexts are never trusted.

### Hash-linked approvals

Approvals are bound to the exact artifacts they approved. Requirement, plan, revision, and evidence hashes are recorded at approval time in `state.json` and the event log, so stale decisions cannot be reused: if a referenced artifact changes, the workflow returns to the matching checkpoint instead of proceeding on stale authority. Every approval (question, answer, hashes) is visible in `/gx-dev history` and the evidence directory.

### User checkpoints

| Decision | User required? | Why |
|---|---|---|
| Clarified requirements | Yes | Defines what success means. |
| Architecture and plan | Yes | Controls material implementation direction. |
| Minor reversible correction | No | Orchestrator logs and resolves it. |
| Destructive, API, security, framework, or migration choice | Yes | Material or difficult to reverse. |
| Final commit after all gates pass | No | Traceable, documented, and rollback-ready. |

If the user is absent, minor reversible decisions continue; material questions move the run to `WAITING_FOR_USER`, checkpointed and resumable.

## Workflow & parallel build

### Independence model

Developer and test writer both receive the same approved contract and base commit — but not each other's uncommitted work:

```text
              Approved plan + verification contract
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
 Developer worktree     Orchestrator            Test worktree
 (implementation)       (moderated              (independent
                        questions only)         tests)
        └─────────────────────┼─────────────────────┘
                              │
                    Staging worktree
                 (deterministic integration)
```

The developer cannot inspect uncommitted independent tests; the test writer cannot inspect uncommitted implementation. Neither can see the other's worktree before the test gate.

### Moderated communication

All agent communication is routed through the orchestrator, which moderates questions, blocks collusion, and prevents false consensus.

| Interaction | Allowed? | Control |
|---|---|---|
| Developer asks about an ambiguous requirement | Yes | Orchestrator answers if minor; otherwise asks the user. |
| Test writer asks for a public contract detail | Yes | Answer comes from approved artifacts, not private code. |
| Developer asks test writer to loosen an assertion | No | Blocked and logged. |
| Test runner routes a reproducible failure | Yes | Includes evidence and ownership classification. |
| Reviewer and developer agree to ignore a finding | No | Only policy or user authority can accept material residual risk. |

**No private consensus.** Agents cannot negotiate acceptance, suppress failures, or share implementation details merely to make tests pass.

## Gates

Gates promote work on evidence, never confidence. The test gate verifies behavior; the review gate assumes green tests can still hide defects; five consecutive failures force holistic replanning.

### Test gate

Code and tests meet for the first time in the staging worktree, where verification is executed deterministically and recorded exactly.

**Preflight checks** (before anything runs):

- Meaningful implementation exists — no stub-only diffs.
- Promised tests are present and enabled.
- No constant-only or vacuous assertions.
- No secrets, conflict markers, or broad unrelated changes.
- No accidental vendor or generated files.

**Command allowlist.** Only allowlisted verification commands execute (fixed set in v1):

```text
/^(?:npm|pnpm|yarn|node|npx|python3?|pytest|make|deno|bun|git diff|git status)(?: |$)/
```

- Exact argv, environment summary, and exit code are persisted.
- Destructive and network commands are denied by default.
- Each command gets a 10-minute timeout; output is truncated at 64 KiB in the transcript and archived in full as evidence.

**Deterministic execution:**

- Developer and test branches integrate into staging; only mechanical conflicts resolve automatically.
- Project-native discovery: package scripts, Makefiles, CI steps.
- Valid tests are never weakened or deleted to obtain a pass.
- Every code-changing repair invalidates prior assurance.

### Ownership routing

The test runner compares failures against requirements and classifies ownership before anything is retried:

| Observed failure | Routed to | Counter consumed |
|---|---|---|
| Valid test fails against the implementation | Developer | `testConsecutiveFailures` |
| Missing, disabled, or invalid test coverage | Test writer | `testConsecutiveFailures` |
| Contract mismatch between code and tests | Developer + test writer | `testConsecutiveFailures` |
| Environment, tooling, network, or timeout | Orchestrator (infrastructure retry) | `infrastructureRetries` |
| Branch integration conflict that is not mechanical | Semantic conflict returned to relevant agent | `integrationConsecutiveFailures` |

Repetition is not progress: repeating the same command without a meaningful change counts as another failure on the same counter.

### Review gate

A successful test suite is necessary, not sufficient. The reviewer inspects the combined staged diff for correctness, security, data loss, performance, test quality, and hidden coupling, and returns severity-ranked findings with paths, lines, evidence, and remediation:

| Severity | Effect in v1 | Disposition |
|---|---|---|
| Blocking | Gate fails; promotion is blocked | Must be fixed. Only explicit user authority may accept material residual risk. |
| Major | Blocks in v1 | Treated as blocking: fix, or escalate the decision to the user. |
| Minor | Advisory | Recorded in evidence and batched as follow-up work. |
| Info | Advisory | Logged for context; never blocks. |

Reviewers cannot waive blocking findings; developer and reviewer may not negotiate acceptance privately. Documentation updates begin only after the review gate passes.

### Five-failure escalation

Each gate keeps its own consecutive-failure counter. A pass resets only its own counter; infrastructure retries never count as code or test failures.

| Counter | Scope | At limit |
|---|---|---|
| `testConsecutiveFailures` | Integrated test gate | Stop local repair; send full attempt history to the planner. |
| `reviewConsecutiveFailures` | Adversarial review gate | Same rule, applied independently of test failures. |
| `integrationConsecutiveFailures` | Non-mechanical merge conflicts | Semantic conflicts return to the responsible agent; repeated conflicts escalate. |
| `infrastructureRetries` | Timeouts, model errors, tooling | Retried separately; never consumes a gate's five-failure budget. |
| `maxTotalAttempts` | All attempts combined | Configurable ceiling prevents infinite loops before replanning can. |

After five consecutive failures the planner receives the complete failure record — input revision hashes, changed files, responsible agent, commands, findings, proposed root cause, action taken, resulting state — and revises the approach holistically or asks the user. History is never discarded.

### Evidence requirements

Every gate verdict cites its evidence; nothing is trusted because an agent asserted it.

On pass: exact verification commands, environment, and exit codes; integrated staging revision hash under test; review findings with severities and resolutions; documentation diff verified against actual behavior; gate verdict record with requirement, plan, and evidence hashes.

On fail: failing command, exit code, and archived output reference; minimal reproduction and the violated requirement; ownership classification (developer, test writer, both, or infrastructure); attempt record (revision hashes, changed files, responsible agent, root cause, action taken, resulting state); preserved evidence links — the causal history the planner will receive.

## Architecture

A pi extension owns orchestration; isolated pi subprocesses perform bounded specialist work against controlled Git worktrees.

### Component map

```text
┌───────────────────────────────────────────────────────────────┐
│                        User + pi TUI                          │
│            questions · approvals · /gx-dev commands           │
└──────────────────────────────┬────────────────────────────────┘
                               │
┌──────────────────────────────▼────────────────────────────────┐
│                      gx-dev orchestrator                      │
│    state machine · policy · event log · recovery · UI         │
│    (application logic — cannot bypass gates or checkpoints)   │
└────────┬─────────────────────┬─────────────────────┬──────────┘
         │                     │                     │
┌────────▼─────────┐ ┌─────────▼─────────┐ ┌─────────▼─────────┐
│ Research +       │ │ Parallel build    │ │ Assurance         │
│ planning         │ │ developer +       │ │ test runner ·     │
│ (read-oriented)  │ │ test writer       │ │ reviewer ·        │
│                  │ │                   │ │ committer         │
└────────┬─────────┘ └─────────┬─────────┘ └─────────┬─────────┘
         └─────────────────────┼─────────────────────┘
                               │
┌──────────────────────────────▼────────────────────────────────┐
│   Git worktrees · append-only evidence · reviewed memory      │
└───────────────────────────────────────────────────────────────┘
```

### Process boundaries

- Each agent runs as a separate child pi process (`pi --mode json`) with an isolated context, role-specific prompt, tools, model, and working directory.
- The extension spawns children, parses streaming events, captures usage and diagnostics, and enforces cancellation and timeouts.
- All Git operations go through a bounded command layer via `pi.exec`; the engine — never an agent — performs Git mutations.
- The package is declared in the pi manifest (`pi.extensions`); pi core modules remain peer dependencies.
- Pi APIs used: commands and custom TUI components, child pi processes in JSON mode, custom entries and session persistence, theme-aware renderers and widgets, `pi.exec`, project trust and package discovery.

### Worktrees

Three worktrees, one controlled integration:

| Worktree | Branch | Purpose |
|---|---|---|
| Developer | `gx-dev/<run-id>/developer` | Production implementation based on the approved plan. No access to uncommitted independent tests. |
| Test writer | `gx-dev/<run-id>/tests` | Behavioral tests based on requirements and public contracts. No access to uncommitted implementation. |
| Staging | `gx-dev/<run-id>/staging` | Deterministic integration, verification, adversarial review, documentation, and final commit preparation. |

```text
<repo-parent>/.gx-dev-worktrees/<run-id>/
├── developer/
├── tests/
└── staging/
```

`git.worktreeRoot: "adjacent"` uses `<repo-parent>/.gx-dev-worktrees/`; alternatively an explicit path outside the repository. Safe Git defaults: preserve unrelated user changes, avoid history rewriting, resolve only mechanical conflicts automatically, and retain failed worktrees for diagnosis.

For new or empty projects, intake determines language, framework, package manager, tooling, license, and deployment target; after user approval gx-dev may initialize Git, `.gitignore`, editor config, README, formatter/linter/test and CI baselines, a lockfile, and a secret-free environment example. Framework choice is material and is never selected silently.

### Staging integration

1. Record base branch, base commit, upstream, and dirty state before work starts.
2. Create developer and test branches from the same base commit.
3. Run developer and test writer concurrently; checkpoint branch outputs.
4. Create staging from the original base and integrate both branches deterministically.
5. Resolve only mechanical conflicts automatically; semantic conflicts go back to the responsible agent.
6. Run test and review loops in staging.
7. Apply the accepted staged result to the working branch; retain worktrees until success or explicit cleanup.

### Persistence

State survives process restarts. `state.json` is operational truth and controls resumption; the event log is append-only.

```text
.gx-dev/
├── config.json              # project-local config (honored after project trust)
├── runs/<run-id>/
│   ├── state.json           # written before every transition
│   ├── events.jsonl         # append-only
│   ├── requirements.md
│   ├── plan.md
│   ├── failure-history.md
│   ├── verification.json
│   └── evidence/            # immutable raw record (see [Evidence directory](#evidence-directory))
└── memory/                  # curated wiki (see [Memory system](#memory-system))
    ├── index.md
    ├── log.md
    ├── SCHEMA.md
    ├── decisions/
    ├── features/
    ├── failures/
    ├── sources/
    └── pins/
```

Transition integrity: persist before starting work; reference artifact hashes; use idempotent recovery; reconcile live Git state on resume; propagate shutdown to child processes; never trust stale captured contexts. Everything lives inside the project except the adjacent worktree root.

### Repository layout

```text
extensions/gx-dev/
  index.ts            pi extension entry (commands, widget, dashboard)
  commands.ts         /gx-dev command table
  config.ts           configuration model (defaults: glm-5.3-flash:max)
  domain/             frozen contracts: state machine, events, artifacts,
                      schemas, persistence, cross-layer interfaces
  agents/             child-process runtime: spawn pi --mode json, streaming
                      parse, frontmatter discovery, protocol validation
  orchestration/      engine, transitions, routing, escalation, recovery
  gates/              test gate, review gate, final gate
  git/                repository inspection, worktrees, integration, commit
  memory/             wiki store, validator, indexer, redaction
  ui/                 dashboard, workflow widget, question modal, renderers
agents/               seven role prompts (frontmatter-pinned models)
scripts/              sample-workflow.mjs (fake + --live), doctor.mjs,
                      models.mjs
tests/                unit / integration / e2e + fake-agent harness
```

### Design invariants

- The extension owns the state machine; agents cannot declare completion.
- Developer and test-writer build independently in separate Git worktrees from the same approved plan; they never see each other's uncommitted work.
- Read-only roles (researcher, planner, review-gate reviewer, test-runner advisor, committer) run in disposable snapshots so they cannot dirty the real tree. The engine — never an agent — performs Git operations.
- Gate commands run through an allowlist (`npm|pnpm|yarn|node|npx|python3?|pytest|make|deno|bun|git diff|git status`) with timeouts and truncation.
- Five consecutive test or review failures force replanning with the full failure history; separate counters; hard ceiling on total attempts.
- Approvals are hash-linked to requirements/plan/evidence revisions.
- Raw evidence is append-only; only reviewed conclusions become durable memory; human corrections are preserved as semantic pins.

## Agents

Each agent has an explicit purpose, restricted tools, structured output, and a clear prohibition against approving its own contribution. Agents speak through structured completion packets validated against a schema — no prose-only completions, no agent-selected gate results (see [Agent completion protocol](#agent-completion-protocol)). Unless overridden, every role runs on `zai/glm-5.3-flash:max` (see [Per-subagent model selection](#per-subagent-model-selection)).

### Orchestrator

Application-owned conductor and user liaison — not an unconstrained agent.

- Owns state, routing, recovery, and failure counters.
- Answers only minor reversible questions; escalates material decisions.
- May fix narrow operational issues (stale lock files, formatting-only conflicts, missing generated directories, retryable network errors, clearly incorrect command paths) and logs every intervention.
- Cannot: bypass gates, decide product scope, approve API/architecture/security changes, or silently accept material residual risk.
- Implemented by the extension itself; no model of its own.

### Researcher

Builds the repository and domain evidence base.

- Inspects project structure, languages, frameworks, conventions, CI, tests, and documentation (or an empty directory).
- Searches the web automatically, recording URL, title, retrieval date, excerpt, and confidence for every source.
- Identifies uncertainty, security concerns, compatibility risks, and stale assumptions; drafts acceptance criteria.
- Treats repository and web content as untrusted data, never instructions.
- Tools: `read`, `bash`. Cannot edit production files.

### Planner

Creates implementation and independent testing plans.

- Defines architecture, file-level tasks, and separate developer/test-writer assignments.
- Defines verification and rollback contracts; defines expected behavior without prescribing tests that merely mirror implementation.
- Receives complete five-failure histories; replans holistically or asks the user when failures reveal unresolved product questions.
- Tools: `read`. Cannot implement code or mark work complete.

### Developer

Implements production behavior in the developer worktree.

- Follows the approved implementation plan.
- Adds developer-level tests only when intrinsic to implementation (e.g. type-level or tightly coupled unit tests).
- Reports deviations and limitations; responds to test and review findings.
- Does not inspect the test writer's uncommitted tests.
- Tools: `read`, `bash`, `edit`, `write` (bounded to its worktree).

### Test writer

Independently tests requirements and public contracts in the test worktree.

- Covers positive, negative, boundary, regression, and failure-path cases.
- Prioritizes externally visible behavior; records assumptions and coverage gaps.
- Does not change production code or inspect the developer's uncommitted implementation.
- Tools: `read`, `bash`, `edit`, `write` (bounded to its worktree).

### Test runner

Gate authority for gate one — both a constrained agent and a machine-controlled command runner.

- Reviews the separate diffs for obvious defects (preflight, see [Test gate](#test-gate)).
- Integrates branches into staging and runs project-native verification commands from the allowlist.
- Records exact evidence and classifies ownership (see [Ownership routing](#ownership-routing)).
- Cannot weaken or delete legitimate tests to obtain a pass.
- Tools: `read`, `bash`.

### Adversarial reviewer

Assumes green tests may still hide defects.

- Scrutinizes correctness, requirement coverage, security, error handling, concurrency, compatibility, data loss, performance, maintainability, test quality, hidden coupling, and unnecessary complexity.
- Produces severity-ranked findings with paths, lines, evidence, and remediation (see [Review gate](#review-gate)).
- Updates affected documentation only after review succeeds, and verifies it against actual behavior.
- Proposes verified durable memory (see [Promotion policy](#promotion-policy)).
- May edit documentation and memory proposals — never production code or tests. Tools: `read`, `bash`.

### Committer

Produces the reversible, traceable final result.

- Assesses repository merge and commit conventions.
- Verifies staging contains only intended changes; reruns the final verification contract.
- Selects the safest integration strategy (fast-forward, cherry-pick, merge commit, patch application); adds only intended files.
- Records commit hash and rollback instructions; commits without final user approval because the result is traceable and rollback-ready.
- Never force-pushes, rewrites history, or discards unrelated user changes.
- Tools: `read`, `bash`.

## Per-subagent model selection

Each of the seven subagents can run on a model chosen from **your pi setup**. Resolution precedence (first match wins):

1. **Explicit selection** in `.gx-dev/config.json` → `agents.models.<role>` (written by the picker or CLI below — this always wins)
2. **Role-prompt pin** in the package's `agents/*.md` frontmatter
3. **Built-in default**: `zai/glm-5.3-flash:max`

The literal `"inherit"` delegates a role to the session's default model (child spawned without `--model`). Specs are `provider/model` with an optional `:thinking` suffix (`off|low|medium|high|xhigh|max`, applied only when the model supports reasoning).

```bash
# Interactive picker (TUI): role list → models from your pi catalog
/gx-dev models
/gx-dev models set reviewer zai/glm-5.3:max
/gx-dev models show

# Headless
node scripts/models.mjs show            # effective table + sources
node scripts/models.mjs list glm        # your available pi models
node scripts/models.mjs set researcher ollama-cloud/deepseek-v4-flash:0731:max
node scripts/models.mjs get researcher   # full precedence breakdown
node scripts/models.mjs unset researcher # back to frontmatter/default
```

Selections are validated (`provider/model[:thinking]` or `inherit`) and matched against `pi --list-models`; unmatched selections warn but never block — availability depends on your auth. Every agent result records the provider-reported `servedModel` and token usage as evidence.

Omitting a role is not the same as unpinning it: absent keys fall through to the role-prompt pin, while an explicit `"inherit"` overrides the pin and delegates to the session. `unset` removes the key so the pin or default applies again. All three surfaces — `/gx-dev models`, `/gx-dev models set`, and `scripts/models.mjs` — write `agents.models.<role>` atomically, and the engine is rebuilt immediately so the next dispatch uses the new model.

**A mixed fleet.** Only roles listed in the config are explicit. Here the reviewer gets a heavyweight reasoning model, the researcher rides the session's model, and the rest stay on the fast default:

```json
{
  "version": 1,
  "agents": {
    "models": {
      "researcher": "inherit",
      "planner": "zai/glm-5.3-flash:max",
      "developer": "zai/glm-5.3-flash:max",
      "testWriter": "zai/glm-5.3-flash:max",
      "testRunner": "zai/glm-5.3-flash:max",
      "reviewer": "ollama-cloud/deepseek-v4-flash:0731:max",
      "committer": "zai/glm-5.3-flash:max"
    }
  }
}
```

- `researcher` — explicit `"inherit"`: spawned without `--model`, using whatever the interactive session runs.
- `reviewer` — a heavyweight model with the `:max` suffix; adversarial review is where reasoning depth pays.
- Everyone else — set to the default explicitly, keeping the file self-documenting.
- Drop any key (`unset`) and that role falls back to the package pin, then the default.

**Validation is structural; availability is advisory.** At load time a selection must be `"inherit"` or a well-formed `provider/model[:thinking]` string — anything else is a config error. Availability is different: models come from your own pi setup (`pi --list-models` and the model registry), so an unmatched selection only **warns** in `/gx-dev models show` and the picker — it never blocks a run. See [Troubleshooting](#configured-model-is-not-in-the-available-list).

## TUI reference

Every workflow is monitored and controlled from pi's terminal interface: the `/gx-dev` command set, a full-screen dashboard, a persistent footer status, a compact workflow widget, and a modal question flow — rendered with the active theme, never hard-coded colors.

### Commands

All commands are namespaced under `/gx-dev` and operate on the currently selected run unless a run id is given.

| Command | Usage | Description |
|---|---|---|
| `start` | `/gx-dev start <request>` | Begin a new run from a short feature request; enters intake and research. |
| `story` | `/gx-dev story <path-or-text>` | Load a story from a file path or literal text as the run input. |
| `status` | `/gx-dev status` | Show the current run, state, gate results, failure counters, and open questions. |
| `dashboard` | `/gx-dev dashboard` | Open the full-screen dashboard: state graph, active agents, worktrees, events, gates, and usage. |
| `answer` | `/gx-dev answer` | Respond to the pending question raised through the modal interface. |
| `pause` | `/gx-dev pause` | Checkpoint state and pause; child processes stop cleanly and work is preserved. |
| `resume` | `/gx-dev resume [run-id]` | Reconcile persisted state against live Git, then continue a paused or interrupted run. |
| `cancel` | `/gx-dev cancel` | Cancel the run, propagate cancellation to all children, and retain evidence. |
| `history` | `/gx-dev history` | Browse the append-only event log and per-attempt failure history. |
| `evidence` | `/gx-dev evidence` | Open the evidence directory for the current run. |
| `retry` | `/gx-dev retry` | Re-run the last failed agent or gate step after the cause has been addressed. |
| `rollback` | `/gx-dev rollback [run-id\|commit]` | Reverse a recorded commit using its documented rollback command. |
| `cleanup` | `/gx-dev cleanup` | Remove worktrees and branches for finished or cancelled runs, subject to retention policy. |
| `config` | `/gx-dev config` | Show the effective configuration and validation results for this project. |
| `models` | `/gx-dev models` | Open the per-subagent model picker: choose a role, then a model and thinking level from your own pi setup. |
| `models set` | `/gx-dev models set <role> <spec>` | Persist one selection directly, e.g. `set reviewer zai/glm-5.3-flash:max`; `inherit` delegates the role to the session model. |
| `models show` | `/gx-dev models show` | Print each role's resolved model and its source: explicit selection, role-prompt pin, or built-in default. |
| `memory` | `/gx-dev memory` | Browse reviewed memory pages, pending proposals, and lint findings. |
| `doctor` | `/gx-dev doctor` | Diagnose the environment: Node, Git, trust, config, worktrees, and memory health. |

### Model picker

`/gx-dev models` sets the model for each of the seven subagents from your own pi setup. Model discovery is registry-first: candidates come from pi's model registry, with a CLI fallback (`pi --list-models`) when the registry is unavailable. Unmatched picks warn but never block.

Picker flow: **Roles** (pick one of the seven) → **Models** (registry list with thinking badges, `inherit`, clear override) → **Thinking** (`off` → `max`, when supported) → **Persisted** (atomic write to `config.json`) → **Rebuilt** (engine rebuilt for the next spawn).

- Each candidate shows its thinking levels as badges, so the model and the reasoning budget are chosen together.
- `inherit` delegates the role to the session's default model — the child is spawned without `--model`.
- A *clear override* entry removes the role's key so the package pin or built-in default applies again.
- On save, the selection is persisted to `agents.models.<role>` in `.gx-dev/config.json` with an atomic write; the engine is rebuilt immediately, so the next dispatch of that role uses the new model — no restart needed.

### Dashboard

The dashboard shows the state graph with the current position, failure counters, recent events, gate progress, worktree status, and token/cost usage in one screen.

- **State graph** — canonical states with completed, current, and pending markers, plus per-gate failure counters against their limits (e.g. `test 2/5 · review 0/5 · integration 1/5 · infra 1`).
- **Active agents** — role, model, worktree, and streaming output, expandable without leaving the dashboard.
- **Events & usage** — a tail of the append-only event log alongside token and cost accounting for the run.

### Status widgets

- **Footer status** — pi's footer shows the selected run id, current stage, elapsed time, and failure counters: `gx-014 · TEST_GATE · 12m41s · test 2/5 review 0/5`.
- **Compact workflow widget** — above the editor, a one-line widget mirrors the canonical path and highlights the active state, without opening the dashboard.

Both widgets render through pi's theme-aware renderers: no hard-coded colors, native light and dark operation.

### Modal questions

Material decisions surface as a modal; minor reversible ones are answered by the orchestrator and logged. Flow: raised (ambiguity found) → classified (minor vs material) → modal (context + options) → answered → recorded (hash-linked approval) → resumed.

The modal shows: the question, with the material decision stated plainly; linked artifacts (requirements, plan sections, evidence); available options and their consequences; which checkpoint this satisfies.

Rules:

- Answers are persisted with artifact hashes before work resumes.
- Stale approvals cannot be reused against changed inputs (see [Hash-linked approvals](#hash-linked-approvals)).
- An absent user moves the run to `WAITING_FOR_USER`, checkpointed and resumable.
- Every question and answer appears in `/gx-dev history`.

## Configuration

One JSON document controls concurrency, timeouts, attempt limits, gate policy, research, memory, and Git behavior. Unknown keys, wrong types, and out-of-range values are rejected at load time.

### Example configuration

Stored as `.gx-dev/config.json` in the target repository and honored only after project trust is established:

```json
{
  "version": 1,
  "agents": {
    "maxConcurrency": 2,
    "timeoutMinutes": 30,
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
  "memory": { "enabled": true, "updateOnSuccess": true, "reviewRequired": true, "redactSecrets": true },
  "git": { "worktreeRoot": "adjacent", "retainFailedRuns": true, "autoCommit": true, "allowHistoryRewrite": false }
}
```

### Key reference

| Key | Type | Default | Constraints & notes |
|---|---|---|---|
| `version` | integer | `1` | Schema version. Must be `1`; other major versions are rejected, not migrated silently. |
| `agents.maxConcurrency` | integer | `2` | 1–4. Caps simultaneous subagents; the developer and test writer run in parallel at the default. |
| `agents.timeoutMinutes` | integer | `30` | 1–120. Child pi process timeout; expiry is treated as an agent failure and retried as infrastructure. |
| `agents.piBinary` | string | `"pi"` | Binary invoked to spawn child pi processes. |
| `agents.models.<role>` | string | `"zai/glm-5.3-flash:max"` | One of `researcher`, `planner`, `developer`, `testWriter`, `testRunner`, `reviewer`, `committer`. Accepts `"inherit"` or `provider/model[:thinking]`. A value present in the file is an **explicit selection** and takes precedence over the package's role-prompt pin; absent keys fall through to the pin, then the default. See [Per-subagent model selection](#per-subagent-model-selection). |
| `gates.maxConsecutiveFailures` | integer | `5` | 1–10. Consecutive failures on any single gate counter before the planner is engaged. |
| `gates.maxTotalAttempts` | integer | `20` | ≥ 10 and ≥ `maxConsecutiveFailures`. Hard ceiling across all attempts to prevent infinite loops. |
| `gates.requireCleanFinalTree` | boolean | `true` | Refuse the final commit while staging contains unintended files. |
| `research.webEnabled` | boolean | `true` | Enables automatic web research; `false` restricts the researcher to the repository. |
| `research.recordSources` | boolean | `true` | Records URL, title, retrieval date, excerpt, and confidence for every source. Required for provenance whenever research is used. |
| `memory.enabled` | boolean | `true` | Master switch for evidence capture and wiki promotion. |
| `memory.updateOnSuccess` | boolean | `true` | Propose memory updates only after both gates pass. |
| `memory.reviewRequired` | boolean | `true` | Only reviewer-verified proposals are promoted; unreviewed promotion is not permitted in v1. |
| `memory.redactSecrets` | boolean | `true` | Redact credential-shaped strings before any memory write. |
| `git.worktreeRoot` | string | `"adjacent"` | `"adjacent"` uses `<repo-parent>/.gx-dev-worktrees/`; alternatively an explicit path outside the repository. |
| `git.retainFailedRuns` | boolean | `true` | Keep failed worktrees and evidence for diagnosis until explicit cleanup. |
| `git.autoCommit` | boolean | `true` | Commit automatically after all gates pass — no final approval needed by design. |
| `git.allowHistoryRewrite` | boolean | `false` | Must remain `false`. Setting `true` is **rejected at validation**, not clamped: no `reset --hard`, force push, or history rewrite in v1. |

Group semantics:

- **Gates limits** — `maxConsecutiveFailures` applies independently to test, review, and integration counters; infrastructure retries are tracked separately and never consume the budget; `maxTotalAttempts` bounds every attempt including retries; `requireCleanFinalTree` keeps the final commit free of unrelated changes.
- **Memory flags** — `enabled` gates both evidence capture and promotion; `updateOnSuccess` ties proposals to passing gates; `reviewRequired` enforces reviewer-verified promotion; `redactSecrets` scrubs credential-shaped strings from memory writes.
- **Git flags** — custom `worktreeRoot` paths must sit outside the repository; `retainFailedRuns` preserves diagnosis material at the cost of disk; `autoCommit` always records rollback instructions.

### Validation and trust

- Unknown keys are rejected — typos never silently no-op.
- Types are exact: booleans are not coerced from strings.
- Numeric ranges are enforced as listed above.
- `git.allowHistoryRewrite: true` is a hard error, by design.
- Run `/gx-dev config` or `/gx-dev doctor` to see full validation output.

Trust ordering: project-local configuration is honored only after project trust is established; untrusted projects run on package defaults only. Project-local agent definitions face the same trust gate, so repository content cannot redefine gates — see [Project trust](#project-trust).

## Security

Repository and web content are untrusted data. Agents run with least capability, writes are confined to assigned worktrees, secrets never survive into logs or memory, and Git history stays untouched without explicit approval.

### Prompt-injection defense

Fetched pages, comments, issue bodies, and source files may contain instructions aimed at the agents. gx-dev treats all of it as data:

- **Untrusted data discipline** — web pages, repository files, and captured excerpts are observations, never directives; embedded instructions cannot redefine agent policy, gates, or approval rules.
- **Sanitization** — fetched material is sanitized before model exposure: markup stripped to content, suspicious instruction-like phrasing neutralized, binary or oversized payloads rejected.
- **Delimiting & provenance** — every excerpt is wrapped in explicit delimiters and labeled with source, title, and retrieval date, so the model always knows what is quoted data versus operator instruction.

### Project trust

- The user and pi TUI are the trusted authority; the orchestrator is application logic that accepts only sanitized untrusted inputs.
- Untrusted inputs (web pages, repo files, fetched excerpts) enter only through sanitization and are data, never authority.
- Writes are bounded to the run's own worktrees; `.git/`, secrets, evidence, and sibling worktrees are blocked targets.
- Core agent prompts ship with the package, so a repository cannot redefine gates or reviewer authority by dropping files into project-local agent directories.
- Pi's project trust flow gates local configuration and agents; gx-dev never reads project-local overrides from an untrusted project. **Trust before config.**

### Paths and blocked writes

- All paths are resolved — symlinks, `..` segments, and junctions included — before use; every tool call is checked against the agent's assigned working directory; escape attempts are blocked and logged as events.
- Each role receives only the tools its contract requires. Developer and test writer cannot read each other's uncommitted work; read-oriented agents cannot edit production files at all.

| Blocked target | Rule |
|---|---|
| `.git/` internals | Never written directly; all Git mutation goes through the bounded Git command layer. |
| Secret files (`.env`, key stores, credentials) | Never read into prompts, memory, titles, or filenames. |
| Immutable evidence | Append-only; captured artifacts are never edited or deleted by agents. |
| Sibling worktrees | Each agent writes only in its own worktree — the anti-collusion boundary. |
| User's working tree | Untouched except by the approved final integration step. |

### Secret redaction

- **Detection** — credential-shaped strings (tokens, keys, passwords, connection strings) are detected by pattern before any text leaves the process boundary.
- **Redaction scope** — logs, prompts, memory proposals, page titles, and filenames. Evidence stores references and hashes, not secrets.
- **Memory hygiene** — `memory.redactSecrets` is on by default; promoted pages are scrubbed again at validation time, independent of the capture path.

### Command execution

- Processes spawn with argument arrays — no shell interpolation.
- Child pi processes enforce `agents.timeoutMinutes` (default 30); gate commands enforce a 10-minute timeout each; expiry fails the attempt cleanly.
- Output is truncated at 64 KiB in the transcript and archived in full as evidence.
- Pause, cancel, and shutdown signals propagate to all child pi processes.
- Partial agent output is discarded; the attempt is recorded as interrupted.
- State is persisted before and after, so recovery is idempotent.

### Git safety

Never without explicit approval: `git reset --hard` and destructive checkout; force pushes of any kind; history rewriting (rejected outright in v1 — `allowHistoryRewrite` cannot be enabled); broad deletion or removal of unrelated user changes.

Always: record base branch, base commit, upstream, and dirty state before work starts; refuse to overwrite unrelated changes; resolve only mechanical conflicts automatically; record every commit with hash and rollback instructions; require fresh tests after every code-changing repair cycle.

### Non-repudiation

Approvals are bound to the exact artifacts they approved, so stale decisions cannot be reused silently:

- Requirements, plan, input revisions, and gate evidence are hashed at approval time and recorded in `state.json` and the event log.
- If any referenced artifact changes, the approval no longer applies: the workflow returns to the matching checkpoint instead of proceeding on stale authority.
- `/gx-dev history` and the evidence directory expose every approval with its hashes, question, and answer.

## Memory system

gx-dev adopts the LLM Wiki pattern with an essential safety distinction: capture is evidence; reviewed promotion creates memory.

### Three layers

1. **Immutable evidence** — user input, web captures, agent output, commands, diffs, tests, and reviews remain append-only raw sources at `.gx-dev/runs/<id>/evidence/` (layout in [Evidence directory](#evidence-directory)).
2. **Curated wiki** — reviewed architecture, conventions, decisions, features, failures, sources, and semantic correction pins at `.gx-dev/memory/` (layout in [Persistence](#persistence)).
3. **Schema** — deterministic rules for structure, provenance, freshness, links, verification, contradiction, and sensitive data at `.gx-dev/memory/SCHEMA.md`. Structure is checked deterministically rather than relying only on agent instructions.

Every memory page carries required frontmatter (`title`, `status`, `scope`, `freshness`, `sources`, optional `supersedes`) — field rules in [Memory frontmatter](#memory-frontmatter):

```yaml
---
title: Test conventions
status: verified
scope: project
freshness: 2026-08-28
sources:
  - run: gx-018
    evidence: tests/final.json
supersedes: []
---
```

### Promotion policy

Nothing becomes fact merely because an agent said it. Pipeline: capture (raw artifact) → verify (tests + review) → propose (memory diff) → review (the artifact, not intent) → validate (schema + links) → commit (with the project change) → reuse (future runs).

- Raw research, transcripts, and agent output remain evidence; the reviewer proposes memory changes only after test and review gates pass (`memory.updateOnSuccess`, `memory.reviewRequired`).
- Durable claims include provenance, scope, freshness, confidence, and verification status; unverified material stays explicitly marked (`NOT VERIFIED`) or remains raw evidence.
- Contradicted material is escalated rather than dropped; supersession is recorded via `supersedes`.
- Derived indexes are disposable and rebuildable from Markdown.

### Semantic correction pins

Human corrections are stored as intent rather than brittle line diffs. Regeneration must preserve them: still satisfied → retain; contradicted by newer evidence → escalate; target section removed → mark orphaned; never silently discard a human correction.

### Retrieval

Index first, then additive search:

1. Read `index.md` — the content map with concise summaries.
2. Collect index matches (known concepts and pages), full-text matches (facts buried in page bodies), and optional semantic matches (derived and disposable).
3. Union the results, then read the relevant pages.

Indexes are not truth: Markdown and Git remain authoritative. BM25, vector, graph, and reranking indexes must be rebuildable and evaluated before becoming defaults; search enhancements must not reduce recall available through basic index and text lookup.

### Concurrency and reservations

Problem: two runs can read the same index and independently create near-duplicate pages for the same concept (`authentication.md` vs. `auth-system.md`). Control:

1. Reason outside locks.
2. Atomically reserve proposed slugs as `planned`.
3. Track claimant run IDs as a set.
4. Degrade a conflicting create to an update.
5. Use conditional hash checks for final writes.
6. Cancelling one run removes only its claim.

### Memory lint

`/gx-dev memory` surfaces health findings:

- **Contradictions** — quote both claims and their provenance.
- **Staleness** — flag claims whose freshness contract expired.
- **Graph health** — orphans, missing backlinks, duplicates, and broken references.
- **Copied state** — mutable SHAs, counts, and dates copied into prose where they can drift.

Influence: Andrej Karpathy's [LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) — a persistent, interlinked Markdown wiki maintained from immutable raw sources under an explicit schema, with content-oriented indexing and chronological logging.

## Installation

gx-dev distributes as a pi package. Install it through pi's package install flow — from the registry, a Git URL, or a local path — grant project trust on first run, and start orchestrating.

### Requirements

| Requirement | Minimum | Why |
|---|---|---|
| Node.js | ≥ 22 | Extension runtime and child-process management. |
| Git | Any recent version on `PATH` | Worktrees, branches, integration, and evidence-grade commit records. |
| pi | ≥ 0.80 | Extension commands, child pi processes, custom TUI components, and theme-aware renderers. |
| Project | Git repository, or empty directory | Existing repos use worktrees; new projects can be bootstrapped after approval. |

### Install methods

All methods use pi's package install flow; the package manifest declares the gx-dev extension, and pi core modules remain peer dependencies. Consult `pi --help` for your version's exact install syntax.

```bash
# from the pi package registry
pi install gx-dev

# from a Git URL (track a branch or prerelease, pin before a registry release)
pi install https://github.com/<org>/gx-dev.git

# from a local checkout (development; restart pi to pick up changes)
pi install /path/to/gx-dev
```

### First run

1. Start pi inside your project; the gx-dev extension registers its `/gx-dev` commands.
2. Pi prompts for **project trust** before any project-local configuration or agents are honored.
3. On first use, gx-dev creates `.gx-dev/` for run state and scaffolds `.gx-dev/memory/` when memory promotion first succeeds.
4. Run `/gx-dev start "<your story>"` — intake and research begin immediately.

Verify the environment at any time with `/gx-dev doctor` (or `node scripts/doctor.mjs`): Node, Git, trust, configuration, worktrees, and memory health in one step.

### Upgrade and removal

Upgrading: finish or pause running workflows; repeat the package install command with the newer version (registry, Git URL, or local path); restart pi so the upgraded extension loads; run `/gx-dev doctor` — persisted run state is versioned and resumes across upgrades.

Removing: finish or cancel active runs; run `/gx-dev cleanup` to remove worktrees and run branches; uninstall via pi's package removal flow and restart pi. `.gx-dev/` — evidence and reviewed memory — is retained unless you delete it deliberately.

## Troubleshooting

Symptoms, causes, and fixes for the situations gx-dev deliberately refuses, retries, or checkpoints — and how to recover cleanly when a run is interrupted. Most refusals are safety features: gx-dev never overwrites unrelated work or rewrites history.

### Dirty repository refusal

- Symptom: `/gx-dev start` refuses to begin; the repository has unrelated uncommitted changes.
- This is by design: dirty state is recorded, never discarded.
- Commit or stash unrelated work, then start again.
- The refusal lists the offending paths so nothing is ambiguous.

### Detached HEAD or missing upstream

- Symptom: run cannot establish a base branch or upstream to record.
- Create or check out a branch: `git switch -c <branch>`.
- gx-dev branches its worktrees from the recorded base commit, so any named branch works.
- Empty projects can be bootstrapped after the framework choice is approved.

### Worktree creation failure

- Symptom: worktree path or branch name already exists from a previous run.
- Inspect `.gx-dev-worktrees/<run-id>/` for leftovers.
- Run `/gx-dev cleanup` to remove finished or cancelled runs.
- Failed runs are retained by default (`git.retainFailedRuns`) for diagnosis.

### Abandoned worktrees

- Symptom: a crashed session left worktrees and branches behind.
- `/gx-dev cleanup` lists candidates and removes only non-active runs.
- Confirm there is no unmerged intended work first — staging may hold accepted results.
- Stale branch deletion is guarded; nothing is force-deleted.

### Timeouts and model errors

- Symptom: an agent attempt ends with a timeout, model error, or malformed output.
- Infrastructure failures retry separately — they never consume a gate's five-failure budget.
- Invalid structured output is retried once with schema feedback, then treated as an agent failure.
- Check `/gx-dev history` for the exact error and raise `agents.timeoutMinutes` if long tasks are being cut off.

### Five-failure REPLAN loops

- Symptom: the run keeps entering REPLAN after repeated gate failures.
- Repeating the same command without change counts as another failure — look for the real root cause in the failure history.
- The planner receives the complete history; read its revised plan at the approval checkpoint.
- If failures expose material ambiguity, answer the pending question promptly, or narrow the story.

### Resume after restart

- Symptom: pi or the machine restarted mid-run.
- Run `/gx-dev resume [run-id]`; `state.json` is operational truth.
- State is reconciled against live Git before anything executes.
- Stale captured contexts are never trusted; transitions re-validate artifact hashes.

### Stuck at WAITING_FOR_USER

- Symptom: no progress and a pending question is open.
- A material decision is waiting: `/gx-dev status` shows it, `/gx-dev answer` responds.
- Minor reversible questions never block — the orchestrator resolves and logs those.
- Work is checkpointed; answering resumes exactly where the run paused.

### Config validation errors

- Symptom: `/gx-dev config` or `/gx-dev doctor` reports errors at load.
- Unknown keys, wrong types, and out-of-range values are listed with the expected shape — see [Key reference](#key-reference).
- `git.allowHistoryRewrite: true` is rejected, not clamped; keep it `false`.
- Project-local configuration is ignored until project trust is granted.

### Configured model is not in the available list

- Symptom: `/gx-dev models show` or the picker warns that a role's selection is not among pi's available models.
- Availability comes from your pi setup, not gx-dev: authenticate with `/login` and refresh the model list with `pi update --models`, then re-check.
- Matching accepts bare ids and provider-qualified specs — `glm-5.3-flash` can resolve to `zai/glm-5.3-flash` — but an id matching nothing only warns; prefer qualified specs like `zai/glm-5.3-flash:max`.
- Warn, not block: the run still starts with an unmatched selection; only a spawn that truly fails is classified as an infrastructure error and retried separately.
- Clear the override with `/gx-dev models set <role> inherit`, the picker's *clear override* entry, or `node scripts/models.mjs unset <role>` — the role-prompt pin or default applies again.

### Memory lint failures

- Symptom: `/gx-dev memory` reports contradictions, stale claims, or orphan pages.
- Lint findings quote both claims and their provenance — fix or supersede the flagged pages.
- Human corrections live as semantic pins and are never silently discarded.
- Evidence is immutable: only reviewed memory is edited.

Escalation path: if a problem persists, attach the run's `failure-history.md` and event log from `/gx-dev evidence` — every attempt records revisions, commands, findings, and root causes.

## Reference

The machine-readable contracts behind every run: persisted state, the append-only event log, structured agent completions, evidence layout, and memory frontmatter.

### state.json

Stored at `.gx-dev/runs/<run-id>/state.json`; written before every transition so recovery is idempotent.

| Field | Type | Description |
|---|---|---|
| `runId` | string | Unique run identifier, e.g. `gx-014`. |
| `version` | integer | State schema version. |
| `status` | enum | `running`, `waiting_for_user`, `paused`, `blocked`, `recovering`, `rolling_back`, `cancelled`, `failed`, `complete`. |
| `currentState` | enum | Canonical state-machine state: `INTAKE` … `COMPLETE`, including `WAITING_FOR_USER` and `REPLAN`. |
| `previousState` | enum | Last persisted state, for idempotent recovery. |
| `base` | object | `baseBranch`, `baseCommit`, `upstream`, `dirtyAtStart` recorded before any work begins. |
| `branches` | object | `developer`, `tests`, `staging` branch names under `gx-dev/<run-id>/`. |
| `worktrees` | object | Absolute paths of the developer, tests, and staging worktrees. |
| `counters` | object | `testConsecutiveFailures`, `reviewConsecutiveFailures`, `integrationConsecutiveFailures`, `infrastructureRetries` — separate counters; a pass resets only its own. |
| `attempts` | array | Per-attempt records: input revision hashes, changed files, responsible agent, commands, findings, proposed root cause, action taken, resulting state. |
| `approvals` | array | Hash-linked approvals: kind, artifact hash, question, answer, timestamp. |
| `artifacts` | object | Content hashes for `requirements.md`, `plan.md`, `verification.json`, and evidence roots. |
| `waitingReason` | string? | Why the run is in `WAITING_FOR_USER`, when applicable. |
| `timestamps` | object | `createdAt`, `updatedAt`, `pausedAt`. |

### events.jsonl

One JSON object per line at `.gx-dev/runs/<run-id>/events.jsonl`. The log is never rewritten.

| Event | Key fields | Emitted when |
|---|---|---|
| `RUN_STARTED` | runId, request, baseCommit | A run begins from intake. |
| `STATE_TRANSITIONED` | from, to, artifactHashes | The state machine advances. |
| `APPROVAL_RECORDED` | kind, hash, answerHash | A checkpoint decision is bound to artifact hashes. |
| `AGENT_DISPATCHED` | role, model, worktree | A subagent process starts. |
| `AGENT_COMPLETED` | role, completionHash | Validated structured output is accepted. |
| `AGENT_FAILED` | role, reason | Timeout, model error, schema rejection, or crash. |
| `GATE_EVALUATED` | gate, verdict, evidenceRef | Test, review, or final gate produces a verdict. |
| `FAILURE_RECORDED` | gate, owner, counterValue | A gate failure is classified and counted. |
| `REPLAN_TRIGGERED` | counter, historyRef | Five consecutive failures engage the planner. |
| `QUESTION_RAISED` | severity, payload | Ambiguity becomes a user question. |
| `QUESTION_ANSWERED` | answerHash | The modal question is answered. |
| `WORKTREE_CREATED` / `WORKTREE_REMOVED` | kind, path | Worktree lifecycle changes. |
| `INTEGRATION_COMPLETED` | stagingRevision | Tests and code are merged into staging. |
| `MEMORY_PROMOTED` | pages, provenance | Reviewed memory updates are committed. |
| `COMMIT_CREATED` | hash, rollbackCommand | The final commit lands. |
| `RUN_PAUSED` / `RUN_RESUMED` / `RUN_CANCELLED` | reason | Lifecycle commands take effect. |

### Agent completion protocol

Every agent returns validated structured output through a dedicated completion tool. Invalid output is retried once with schema feedback, then treated as an agent failure. Questions are routed by severity.

```json
{
  "status": "complete",
  "summary": "...",
  "artifacts": ["..."],
  "questions": [],
  "assumptions": [],
  "risks": [],
  "recommendedNextState": "PLAN"
}
```

Additional required fields per role:

| Role | Additional fields |
|---|---|
| Researcher | `sources`, `findings`, `requirementAmbiguities` |
| Planner | `tasks`, `dependencies`, `verificationContract` |
| Developer | `changedFiles`, `deviations`, `knownLimitations` |
| Test writer | `testInventory`, `requirementMapping` |
| Test runner | `commands`, `exits`, `ownership` classification |
| Reviewer | `findings` with severity, evidence, paths, lines, remediation |
| Committer | `strategy`, `commitHash`, `rollbackCommand` |

### Evidence directory

Raw evidence is append-only and content-addressed where practical. Capture is not automatically memory.

```text
.gx-dev/runs/<run-id>/evidence/
├── user-input/
├── web/
├── agent-output/
├── commands/
├── diffs/
├── tests/
└── reviews/
```

- Agents never edit or delete captured evidence.
- Gate verdicts reference evidence by path and hash.
- Secrets are redacted before capture; evidence holds references, not credentials.
- `/gx-dev evidence` opens the current run's directory.

### Memory frontmatter

Required metadata for every content page in `.gx-dev/memory/`; structure is validated deterministically against the in-repo `SCHEMA.md`.

| Field | Type | Rules |
|---|---|---|
| `provenance` | list | Semicolon-separated claim origins (run ids, evidence refs). Required. |
| `scope` | string | The domain the claim applies to, e.g. `feature`, `project`. Required. |
| `freshness` | ISO date | The claim's expiry contract; `NOT VERIFIED` pages older than freshness+30d lint as stale. Required. |
| `verification` | enum | `verified` \| `NOT VERIFIED`. Unverified material stays explicitly marked. Required. |
| `confidence` | enum | `low` \| `medium` \| `high`. Required. |
| `updated` | ISO date | Last reviewed date. Required. |

## Development

### Build and test

```bash
npm install
npm run typecheck   # tsc --noEmit (strict, erasable-syntax TS)
npm test            # 126 tests: unit, integration, e2e
node scripts/doctor.mjs
```

TypeScript is erasable-syntax only (no enums/namespaces/parameter properties) so Node's native type stripping and pi's loader both work without a build step. No runtime dependencies; peer: pi.

### Sample workflows

Headless sample workflow (fake agents, real Git):

```bash
node scripts/sample-workflow.mjs
```

Live sample workflow — every subagent spawned as a real `pi --mode json` child on `zai/glm-5.3-flash:max`:

```bash
node scripts/sample-workflow.mjs --live          # add --keep to retain evidence
GX_BUDGET_MINUTES=40 node scripts/sample-workflow.mjs --live --keep
```

### Delivery status

Eleven evidence-driven phases; each exits on a machine-checkable condition, not a feeling.

| Phase | Focus | Exit criterion |
|---|---|---|
| 1 · Foundation | Package scaffold, schemas, state machine, event store, core commands, fake-agent harness | Deterministic transitions survive restart. |
| 2 · Subagent runtime | Isolated pi subprocesses, streaming JSON, cancellation, timeout, structured completion | Every specialist runs independently with validated output. |
| 3 · Git isolation | Worktrees, branches, staging integration, cleanup, recovery, new projects | Parallel changes integrate without prematurely modifying the user tree. |
| 4 · Research & planning | Web research, provenance, sanitization, approvals, verification contracts | Approved artifacts are versioned and hash-linked. |
| 5 · Parallel development | Concurrency, moderated questions, independence controls | Neither worker can inspect the other's uncommitted work. |
| 6 · Test & review loops | Preflight, command discovery, evidence, ownership, five-failure replanning, review, docs | Every gate transition has machine-verifiable evidence. |
| 7 · Committer | Merge assessment, final verification, commit, rollback, cleanup policy | One traceable commit contains no unrelated changes. |
| 8 · Compounding memory | Evidence store, wiki, validator, pins, reservations, lint, redaction | Later workflows reuse reviewed knowledge rather than raw capture. |
| 9 · TUI polish | Dashboard, progress, questions, theme-aware rendering, accessibility | Users can monitor and control a complete workflow in TUI. |
| 10 · Documentation | Superseded: the standalone docs site was replaced by this README | Documentation is consolidated in this README. |
| 11 · Hardening & release | Threat review, cross-platform tests, package installation, release automation | npm, Git, and local pi package installation work. |

v1 includes local Git repositories, empty-project bootstrapping, isolated child pi processes, Git worktrees, automatic web research, reviewed Markdown memory, TUI workflow management, and automatic final commits. Deferred: remote workers and distributed queues, pull-request creation, team memory servers, browser workflow control, autonomous deployment, vector memory as a requirement, and force pushes or history rewriting.

## Implementation notes (v1)

- Documentation is consolidated in this README; the earlier multi-page HTML documentation site was removed.
- Commit messages are engine-owned: the committer agent advises, the engine composes a deterministic subject + body (live runs showed agents returning paragraph-length blobs).
- Role prompt files may pin `model:` in frontmatter; configuration remains the fallback, then the `zai/glm-5.3-flash:max` default.

## License

MIT — see [LICENSE](./LICENSE).
