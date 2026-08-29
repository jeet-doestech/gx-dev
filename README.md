# gx-dev

Deterministic, evidence-based multi-agent feature delivery for the
[pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).

gx-dev coordinates isolated AI subagents through a persisted workflow state
machine: research → requirements approval → plan → plan approval → parallel
development in isolated Git worktrees → deterministic integration → test
gate → adversarial review → documentation → final verification → automatic
commit → memory promotion. Agents never approve their own work; every
transition is validated and persisted before the next action begins.

**All seven subagents default to `zai/glm-5.3-flash:max`** (GLM-5.3-Flash at
maximum thinking). Per-role overrides and `inherit` are supported through
configuration.

## Install

```bash
pi install gx-dev        # from the pi package registry
# or from a checkout:
pi install /path/to/gx-dev
```

Requirements: Node ≥ 22, Git, pi ≥ 0.80. Run `node scripts/doctor.mjs` to
verify the environment.

## Usage

```
/gx-dev start <request>    begin a feature workflow
/gx-dev status             current run, state, counters
/gx-dev dashboard          full-screen state graph, events, usage
/gx-dev answer <text>      answer a pending question
/gx-dev pause|resume|cancel
/gx-dev history            list runs
/gx-dev config             effective configuration
/gx-dev doctor             environment checks
```

Headless sample workflow (fake agents, real Git):

```bash
node scripts/sample-workflow.mjs
```

Live sample workflow — every subagent spawned as a real `pi --mode json`
child on `zai/glm-5.3-flash:max`:

```bash
node scripts/sample-workflow.mjs --live          # add --keep to retain evidence
GX_BUDGET_MINUTES=40 node scripts/sample-workflow.mjs --live --keep
```

## Per-subagent model selection

Each of the seven subagents can run on a model chosen from **your pi
setup**. Resolution precedence (first match wins):

1. **Explicit selection** in `.gx-dev/config.json` → `agents.models.<role>`
   (written by the picker or CLI below — this always wins)
2. **Role-prompt pin** in the package's `agents/*.md` frontmatter
3. **Built-in default**: `zai/glm-5.3-flash:max`

The literal `"inherit"` delegates a role to the session's default model
(child spawned without `--model`). Specs are `provider/model` with an
optional `:thinking` suffix (`off|low|medium|high|xhigh|max`, applied only
when the model supports reasoning).

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

Selections are validated (`provider/model[:thinking]` or `inherit`) and
matched against `pi --list-models`; unmatched selections warn but never
block — availability depends on your auth. Every agent result records the
provider-reported `servedModel` and token usage as evidence.

## Configuration

`.gx-dev/config.json` in the target repository (honored after project trust):

```json
{
  "version": 1,
  "agents": {
    "maxConcurrency": 2,
    "timeoutMinutes": 30,
    "piBinary": "pi",
    "models": {
      "researcher": "zai/glm-5.3-flash:max",
      "planner": "zai/glm-5.3-flash:max",
      "developer": "zai/glm-5.3-flash:max",
      "testWriter": "zai/glm-5.3-flash:max",
      "testRunner": "zai/glm-5.3-flash:max",
      "reviewer": "zai/glm-5.3-flash:max",
      "committer": "zai/glm-5.3-flash:max"
    }
  },
  "gates": { "maxConsecutiveFailures": 5, "maxTotalAttempts": 20, "requireCleanFinalTree": true },
  "research": { "webEnabled": true, "recordSources": true },
  "memory": { "enabled": true, "updateOnSuccess": true, "reviewRequired": true, "redactSecrets": true },
  "git": { "worktreeRoot": "adjacent", "retainFailedRuns": true, "autoCommit": true, "allowHistoryRewrite": false }
}
```

See the documentation site (`./website/` — open `website/index.html`) for the full reference.
The original planning document is [`PLAN.md`](./PLAN.md) at the repo root.

## Architecture

```
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
scripts/              sample-workflow.mjs (fake + --live), doctor.mjs
tests/                unit / integration / e2e + fake-agent harness
```

### Design invariants

- The extension owns the state machine; agents cannot declare completion.
- Developer and test-writer build independently in separate Git worktrees
  from the same approved plan; they never see each other's uncommitted work.
- Read-only roles (researcher, planner, review-gate reviewer, test-runner
  advisor, committer) run in disposable snapshots so they cannot dirty the
  real tree. The engine — never an agent — performs Git operations.
- Gate commands run through an allowlist (`npm|pnpm|yarn|node|npx|python3?|
  pytest|make|deno|bun|git diff|git status`) with timeouts and truncation.
- Five consecutive test or review failures force replanning with the full
  failure history; separate counters; hard ceiling on total attempts.
- Approvals are hash-linked to requirements/plan/evidence revisions.
- Raw evidence is append-only; only reviewed conclusions become durable
  memory; human corrections are preserved as semantic pins.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit (strict, erasable-syntax TS)
npm test            # 126 tests: unit, integration, e2e
node scripts/doctor.mjs
```

TypeScript is erasable-syntax only (no enums/namespaces/parameter
properties) so Node's native type stripping and pi's loader both work
without a build step. No runtime dependencies; peer: pi.

## Implementation notes (v1)

- The multi-page documentation application lives in-repo at `website/`
  (13 pages, searchable, light/dark); PLAN.md §14's `docs-app/` name was
  kept as `website/` to preserve the established site.
- Commit messages are engine-owned: the committer agent advises, the engine
  composes a deterministic subject + body (live runs showed agents returning
  paragraph-length blobs).
- Role prompt files may pin `model:` in frontmatter; configuration remains
  the fallback, then the `zai/glm-5.3-flash:max` default.
