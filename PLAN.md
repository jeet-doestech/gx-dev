# gx-dev Development Plan

## 1. Product definition

**gx-dev** will be an installable TypeScript pi package that coordinates isolated AI subagents through a deterministic, evidence-based feature-development workflow.

It will include:

1. **Pi TUI extension**
   - Runs through `/gx-dev` commands.
   - Coordinates agents, worktrees, gates, retries, escalation, user decisions, persistence, and commits.
   - Supports existing repositories and empty/new projects.
2. **Multi-page documentation application**
   - Documentation only; it does not control workflows.
   - Responsive light/dark design.
   - Includes architecture diagrams, workflow charts, agent responsibilities, state transitions, memory, configuration, troubleshooting, and security guidance.
3. **Agent definitions**
   - Researcher
   - Planner
   - Developer
   - Test writer
   - Test runner
   - Adversarial reviewer
   - Committer
   - Orchestrator behavior implemented by the extension itself

## 2. Confirmed product decisions

- gx-dev operates inside pi's TUI.
- The documentation is a separate multi-page static application.
- Developer and test-writer use isolated Git worktrees.
- They may communicate only through the orchestrator.
- The orchestrator moderates communication and prevents agents from negotiating false completion.
- Mandatory user checkpoints cover clarified requirements, architecture/planning, destructive operations, and material decisions.
- The reviewer updates affected documentation after code review succeeds.
- The committer may commit automatically after all gates pass; final user approval is not required because the commit is traceable and reversible.
- Automatic internet research is permitted and must retain source provenance.
- Both existing repositories and empty/new projects are supported.
- The documentation application supports light and dark mode.
- Memory follows the persistent, compounding LLM Wiki pattern while distinguishing raw capture from reviewed durable knowledge.

## 3. Primary design principles

1. **The extension owns the state machine.** Agents cannot declare the overall workflow complete. State transitions require validated artifacts and command evidence.
2. **Agents are isolated.** Each agent runs in a separate pi process with an isolated context. Developer and test-writer receive separate Git worktrees.
3. **Parallel implementation reduces model coupling.** Developer and test-writer independently implement from the same approved requirements and plan.
4. **Communication is moderated.** Agents submit structured questions and findings to the orchestrator. They cannot communicate directly or negotiate gate results.
5. **Evidence outranks confidence.** Tests, diffs, static analysis, Git state, and review findings determine outcomes. Agent assertions do not.
6. **Memory compounds carefully.** Raw evidence is preserved, but only reviewed and verified conclusions become durable project memory.
7. **Indexes are disposable.** Markdown and Git are authoritative; derived search indexes can always be rebuilt.
8. **Failures remain visible.** Attempts and failures are retained for diagnosis, replanning, and auditability.

## 4. System architecture

```text
┌─────────────────────────────────────────────────────────────┐
│                         User / Pi TUI                       │
└──────────────────────────────┬──────────────────────────────┘
                               │ questions, approvals, commands
┌──────────────────────────────▼──────────────────────────────┐
│                     gx-dev Orchestrator                     │
│                                                             │
│ State machine │ Policy engine │ Event log │ TUI │ Recovery  │
└─────────┬──────────┬──────────┬───────────┬──────────┬──────┘
          │          │          │           │          │
     Researcher   Planner   Developer   Test Writer   Gates
          │          │          │           │          │
          └──────────┴──────────┼───────────┘          │
                                │                      │
                    ┌───────────▼───────────┐          │
                    │ Isolated Git worktrees │          │
                    │ dev │ tests │ staging  │◄─────────┘
                    └───────────┬───────────┘
                                │
                  Test Runner → Reviewer → Committer
                                │
                    ┌───────────▼───────────┐
                    │ Project working branch │
                    └───────────────────────┘
```

### Implementation strategy

Use pi's subagent example as the subprocess and streaming foundation, but implement a dedicated gx-dev workflow engine instead of relying on a prompt-only chain.

The extension will:

- spawn child pi processes in JSON mode;
- assign role-specific models, thinking levels, tools, prompts, and working directories;
- parse streaming events;
- capture usage and diagnostics;
- enforce cancellation and timeouts;
- validate structured agent outputs;
- own every workflow transition;
- persist transition state before starting the next action.

## 5. Workflow state machine

```text
INTAKE
  ↓
RESEARCH
  ↓
REQUIREMENTS_APPROVAL  ← mandatory user checkpoint
  ↓
PLAN
  ↓
PLAN_APPROVAL          ← mandatory user checkpoint
  ↓
PREPARE_WORKTREES
  ↓
DEVELOP ───────────┐
                   ├── parallel
WRITE_TESTS ───────┘
  ↓
INTEGRATE
  ↓
TEST_GATE
  ├─ pass → REVIEW_GATE
  ├─ fail → Developer and/or Test Writer
  └─ 5 consecutive failures → REPLAN
                                  ↓
                      user input if materially ambiguous
  ↓
REVIEW_GATE
  ├─ pass → DOCUMENTATION_UPDATE
  ├─ fail → Developer and/or Test Writer
  └─ 5 consecutive failures → REPLAN
  ↓
FINAL_VERIFICATION
  ↓
COMMIT
  ↓
MEMORY_PROMOTION
  ↓
COMPLETE
```

Additional states:

- `WAITING_FOR_USER`
- `PAUSED`
- `CANCELLED`
- `BLOCKED`
- `RECOVERING`
- `ROLLING_BACK`
- `FAILED`

Every transition is persisted before the next action begins. A transition references the hashes of the requirements, plan, input revisions, and evidence on which it depends so stale approvals cannot be reused silently.

## 6. Agent contracts

### 6.1 Orchestrator

The orchestrator is application logic assisted by a constrained orchestrator prompt—not an unconstrained agent with authority to bypass gates.

Responsibilities:

- control the state machine;
- validate agent outputs;
- route moderated messages;
- answer only minor and reversible questions;
- ask the user about material decisions;
- maintain failure counters;
- manage worktrees and integration;
- fix narrowly scoped operational issues such as stale lock files, formatting-only conflicts, missing generated directories, retryable network errors, and clearly incorrect command paths;
- log every intervention.

It must never silently decide product scope, public API changes, architecture changes, destructive operations, security trade-offs, data migrations, or acceptance-criteria changes.

### 6.2 Researcher

Responsibilities:

- inspect the repository or empty directory;
- detect languages, frameworks, conventions, CI, tests, and documentation;
- research implementation patterns and best practices;
- search the internet automatically when useful;
- record URLs, titles, retrieval dates, relevant excerpts, and confidence;
- treat repository and web content as untrusted data rather than instructions;
- identify uncertainty, security concerns, compatibility risks, and stale assumptions;
- produce a requirements draft, repository brief, research report, source manifest, unresolved questions, and recommended acceptance criteria.

The researcher cannot edit production files.

### 6.3 Planner

Responsibilities:

- convert approved requirements and research into an architecture plan, file-level implementation plan, independent test plan, integration plan, rollback plan, documentation plan, and verification contract;
- assign separate tasks to developer and test-writer;
- define expected behavior without prescribing tests that merely mirror implementation;
- reconsider the whole approach after five consecutive gate failures;
- use complete failure history during replanning;
- ask the user when failures reveal unresolved product or architecture questions.

The planner cannot implement code or mark work complete.

### 6.4 Developer

Responsibilities:

- work only in the development worktree;
- implement the approved plan;
- add developer-level tests only when intrinsic to implementation, such as type-level or tightly coupled unit tests;
- document deviations from the plan;
- submit a structured implementation report;
- respond to test and review findings.

The developer does not see the test-writer's uncommitted tests unless a gate returns a relevant failure.

### 6.5 Test writer

Responsibilities:

- work only in the test worktree;
- independently implement planned tests from requirements and public contracts;
- prioritize externally observable behavior;
- include positive, negative, boundary, regression, and failure-path coverage;
- avoid changing production code;
- record assumptions and coverage gaps.

The test writer does not see the developer's uncommitted implementation.

### 6.6 Test runner

The test runner is both a constrained agent and a machine-controlled command runner.

Responsibilities:

1. Inspect developer and test diffs separately.
2. Reject obvious issues such as no meaningful implementation, missing promised tests, disabled tests, constant-only assertions, unrelated changes, secrets, unresolved conflict markers, or accidental generated/vendor files.
3. Integrate both branches into the staging worktree.
4. Discover and run project verification commands.
5. Compare failures with requirements and classify ownership.
6. Route findings to developer, test-writer, or both.
7. Persist exact commands, environment, exit codes, and output references.

It cannot weaken or delete legitimate tests to obtain a pass.

### 6.7 Adversarial reviewer

Responsibilities:

- inspect the combined staged diff;
- scrutinize correctness, requirement coverage, security, error handling, concurrency, maintainability, compatibility, data loss, performance, test quality, hidden coupling, and unnecessary complexity;
- produce severity-ranked findings with paths, lines, evidence, and remediation;
- return failures to developer and/or test-writer;
- trigger replanning after five consecutive review failures;
- update affected project documentation only after code review passes;
- verify documentation against actual behavior;
- propose durable memory updates based only on verified outcomes.

The reviewer may edit documentation and memory proposals, but not production implementation or tests. Documentation changes receive final mechanical verification before commit.

### 6.8 Committer

Responsibilities:

- assess repository merge and commit conventions;
- verify staging contains only intended changes;
- rerun the final verification contract;
- select the safest integration strategy: fast-forward, cherry-pick, merge commit, or patch application;
- initialize Git and baseline conventions for a new project when approved;
- create a clear commit message;
- add only intended files;
- commit without final user approval;
- record the commit hash and rollback instructions.

It must never force-push, rewrite existing history, or discard unrelated user changes.

## 7. User checkpoints

Mandatory user interaction occurs for:

1. clarified requirements;
2. architecture and plan approval;
3. destructive or difficult-to-reverse operations;
4. material scope, API, security, dependency, framework, or migration decisions;
5. planner escalation when five failures reveal unresolved ambiguity.

A final commit does not require approval after all automated and adversarial gates pass.

If the user is absent:

- minor reversible decisions may continue;
- material questions move the workflow to `WAITING_FOR_USER`;
- work is checkpointed and can resume later.

## 8. Git and worktree model

### Existing repository

Proposed layout:

```text
<repo>/
<repo-parent>/.gx-dev-worktrees/
  <run-id>/
    developer/
    tests/
    staging/
```

Branches:

```text
gx-dev/<run-id>/developer
gx-dev/<run-id>/tests
gx-dev/<run-id>/staging
```

Process:

1. Record base branch, base commit, upstream, dirty state, and existing worktrees.
2. Refuse to overwrite unrelated changes.
3. Create development and test branches from the same base commit.
4. Run developer and test-writer concurrently.
5. Commit/checkpoint their branch outputs internally.
6. Create staging from the original base.
7. Integrate tests and implementation deterministically.
8. Resolve only mechanical conflicts automatically.
9. Send semantic conflicts back to the relevant agent.
10. Run test and review loops in staging.
11. Apply the accepted staged result to the appropriate working branch.
12. Retain worktrees until success or explicit cleanup.

### New or empty project

The intake phase determines:

- intended language and framework;
- package manager;
- build/test/lint tooling;
- license expectations;
- runtime and deployment target.

After user approval, gx-dev may initialize:

- Git repository;
- `.gitignore`;
- editor configuration;
- README;
- selected license or placeholder;
- formatter, linter, tests, and CI baseline;
- dependency lockfile;
- environment example without secrets.

Framework choice is material and must not be selected silently.

## 9. Failure and escalation rules

Maintain separate counters:

```text
testConsecutiveFailures
reviewConsecutiveFailures
integrationConsecutiveFailures
infrastructureRetries
```

Rules:

- A successful gate resets only its own consecutive-failure counter.
- Infrastructure failures do not count as code/test failures.
- Repeating the same command without a meaningful change counts as another failure.
- After five consecutive test failures, stop implementation and send the full attempt history to the planner.
- Apply the same rule independently to review failures.
- Request user input if replanning exposes material ambiguity.
- Use a configurable total-attempt ceiling to prevent infinite loops.
- Never discard the causal history needed by the planner.

Each attempt records:

- input revision hashes;
- changed files;
- responsible agent;
- commands run;
- findings;
- proposed root cause;
- action taken;
- resulting state.

## 10. Memory system

The memory architecture follows the LLM Wiki pattern while adding review gates, provenance, deterministic validation, and concurrency controls.

### 10.1 Immutable raw evidence

```text
.gx-dev/runs/<run-id>/evidence/
  user-input/
  web/
  agent-output/
  commands/
  diffs/
  tests/
  reviews/
```

Raw evidence is append-only and content-addressed where practical. Capture is not automatically memory.

### 10.2 Curated project memory

```text
.gx-dev/memory/
  index.md
  log.md
  project-overview.md
  architecture.md
  conventions.md
  testing.md
  decisions/
  features/
  failures/
  sources/
  pins/
```

This wiki stores reusable, reviewed knowledge such as repository architecture, build conventions, accepted decisions, recurring failure patterns, previous feature summaries, known risks, and source-backed best practices.

The researcher reads `index.md` first, then uses the union of index matches and full-text results. Search enhancements are additive: they must not reduce recall available through basic index and text lookup.

### 10.3 Schema and operating rules

```text
.gx-dev/memory/SCHEMA.md
```

Defines:

- page structure and required headings;
- frontmatter fields;
- citation and source format;
- cross-link conventions;
- confidence, freshness, verification, and scope fields;
- `NOT VERIFIED` handling;
- contradiction and supersession rules;
- archival rules;
- prohibited sensitive content;
- semantic correction pins that regeneration must preserve.

Structure is checked deterministically rather than relying only on agent instructions.

### 10.4 Runtime state

```text
.gx-dev/runs/<run-id>/
  state.json
  events.jsonl
  requirements.md
  research.md
  plan.md
  test-plan.md
  decisions.md
  failure-history.md
  verification.json
  memory-proposal.md
  result.md
```

`state.json` is operational truth. Markdown memory is curated knowledge, not a lock or transaction mechanism.

### 10.5 Promotion policy

- Raw research, transcripts, and agent output remain evidence.
- The reviewer proposes memory changes only after test and review gates pass.
- Durable facts must include provenance, scope, freshness, and verification status.
- Human corrections are represented as semantic pins so later regeneration cannot silently erase them.
- Contradicted pins are escalated rather than dropped.
- Derived indexes are disposable and rebuildable from Markdown.
- Mutable runtime values such as current SHA, counts, and sync times are not copied into prose unless historically relevant or required by a named dependent.
- A memory lint checks stale claims, contradictions, orphan pages, missing links, missing provenance, copied mutable state, and unresolved verification status.

### 10.6 Concurrent memory updates

If multiple gx-dev runs promote memory concurrently:

1. Agent reasoning occurs outside locks.
2. Proposed page names are atomically reserved in the index as `planned`.
3. Reservations contain a set of claimant run IDs.
4. A conflicting create degrades to an update rather than creating a semantic duplicate.
5. Cancelling one run removes only its claim.
6. Final writes use conditional revision/hash checks.

## 11. TUI design

### Commands

```text
/gx-dev start <request>
/gx-dev story <path-or-text>
/gx-dev status
/gx-dev dashboard
/gx-dev answer
/gx-dev pause
/gx-dev resume [run-id]
/gx-dev cancel
/gx-dev history
/gx-dev evidence
/gx-dev retry
/gx-dev rollback [run-id|commit]
/gx-dev cleanup
/gx-dev config
/gx-dev memory
/gx-dev doctor
```

### TUI elements

- Footer status showing run, stage, elapsed time, and failures.
- Compact workflow widget above the editor.
- Full-screen dashboard showing state graph, active agents, worktrees, recent events, gates, and token/cost usage.
- Modal user-question interface.
- Expandable agent output.
- Final evidence and commit summary.

The TUI uses pi's active theme rather than hard-coded colors, enabling native light and dark operation.

## 12. Structured agent protocol

Agents return validated structured output through a dedicated completion tool, for example:

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

Specialized fields differ by role:

- researcher: sources, findings, requirement ambiguities;
- planner: tasks, dependencies, verification contract;
- developer: changed files, deviations, known limitations;
- test writer: test inventory and requirement mapping;
- test runner: commands, exits, and ownership classification;
- reviewer: findings with severity and evidence;
- committer: strategy, commit hash, and rollback command.

Invalid output is retried once with schema feedback, then treated as an agent failure.

## 13. Security and integrity controls

- Require project trust before using project-local configuration or agents.
- Prefer package-owned core agents so repository prompts cannot redefine gates.
- Treat web pages, comments, source files, and repository content as untrusted data.
- Instruct agents not to follow embedded prompt instructions.
- Sanitize and delimit fetched source material before model exposure.
- Restrict tools by role.
- Canonicalize all paths.
- Prevent writes outside assigned worktrees.
- Block direct writes to `.git/`, secret files, immutable evidence, and other agents' worktrees.
- Redact likely credentials from logs, prompts, memory, filenames, and titles.
- Enforce command timeout and output truncation.
- Propagate cancellation to all child processes.
- Never use `git reset --hard`, force push, or broad deletion without explicit approval.
- Record hashes for plans, requirements, and gate evidence.
- Require fresh tests after every code-changing review cycle.
- Review actual generated diffs rather than accepting an agent's stated intention.

## 14. Package structure

```text
gx-dev/
├── package.json
├── tsconfig.json
├── README.md
├── LICENSE
├── extensions/
│   └── gx-dev/
│       ├── index.ts
│       ├── commands.ts
│       ├── config.ts
│       ├── domain/
│       │   ├── state.ts
│       │   ├── events.ts
│       │   ├── artifacts.ts
│       │   └── schemas.ts
│       ├── orchestration/
│       │   ├── engine.ts
│       │   ├── transitions.ts
│       │   ├── routing.ts
│       │   ├── escalation.ts
│       │   └── recovery.ts
│       ├── agents/
│       │   ├── runner.ts
│       │   ├── protocol.ts
│       │   ├── discovery.ts
│       │   └── streaming.ts
│       ├── git/
│       │   ├── repository.ts
│       │   ├── worktrees.ts
│       │   ├── integration.ts
│       │   └── commit.ts
│       ├── gates/
│       │   ├── test-gate.ts
│       │   ├── review-gate.ts
│       │   └── final-gate.ts
│       ├── memory/
│       │   ├── store.ts
│       │   ├── wiki.ts
│       │   ├── indexer.ts
│       │   ├── validator.ts
│       │   └── redaction.ts
│       ├── web/
│       │   ├── search.ts
│       │   ├── sanitize.ts
│       │   └── sources.ts
│       └── ui/
│           ├── dashboard.ts
│           ├── workflow-widget.ts
│           ├── questions.ts
│           └── renderers.ts
├── agents/
│   ├── researcher.md
│   ├── planner.md
│   ├── developer.md
│   ├── test-writer.md
│   ├── test-runner.md
│   ├── reviewer.md
│   └── committer.md
├── docs-app/
│   ├── src/
│   ├── public/
│   └── tests/
└── tests/
    ├── unit/
    ├── integration/
    ├── fixtures/
    └── e2e/
```

Package manifest:

```json
{
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions/gx-dev/index.ts"]
  }
}
```

Core pi packages belong in `peerDependencies`. Other runtime packages belong in `dependencies`.

## 15. Multi-page documentation application

Build a static, accessible documentation site that outputs ordinary HTML, CSS, and JavaScript and requires no server at runtime.

### Pages

1. **Home** — executive summary, benefits, limitations, and workflow overview.
2. **Architecture** — component map, process boundaries, worktrees, and trust boundaries.
3. **Workflow** — interactive state diagram, pass/fail/escalation paths, and user checkpoints.
4. **Agents** — role cards, permissions, inputs, outputs, and independence rules.
5. **Gates** — test gate, review gate, five-failure escalation, and evidence requirements.
6. **Memory** — raw evidence, curated wiki, provenance, promotion, index, log, and retention.
7. **TUI reference** — commands, dashboard mockups, status indicators, resume, and rollback.
8. **Configuration** — models, concurrency, timeouts, attempt limits, worktrees, research, and memory.
9. **Security** — prompt injection, project trust, path restrictions, secret handling, and Git safety.
10. **Installation** — npm, Git, local install, first run, upgrades, and removal.
11. **Troubleshooting** — Git, dirty repositories, test discovery, child failures, recovery, and abandoned worktrees.
12. **Reference** — configuration, state, event, and artifact schemas.

### Visual requirements

- automatic system theme plus manual light/dark toggle;
- persisted theme preference;
- responsive sidebar and mobile navigation;
- searchable documentation;
- inline SVG or locally bundled diagrams;
- workflow and failure-loop charts;
- reduced-motion support;
- accessible color contrast and keyboard navigation;
- print-friendly styling;
- no external runtime CDN dependency.

## 16. Configuration model

Example:

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
  "research": {
    "webEnabled": true,
    "recordSources": true
  },
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

Project configuration is honored only after project trust is established.

## 17. Testing strategy

### Unit tests

- state transitions;
- failure counters;
- schema validation;
- question severity classification;
- artifact hashing;
- path containment;
- secret redaction;
- Git output parsing;
- source normalization;
- memory index updates;
- provenance and freshness checks;
- semantic pin preservation;
- page-name reservation conflicts.

### Integration tests

Use temporary Git repositories to verify:

- clean and dirty repositories;
- detached HEAD and missing upstream;
- multiple worktrees;
- conflicting developer/test changes;
- failed and successful integration;
- five consecutive test failures;
- five consecutive review failures;
- resume after process restart;
- cancellation and child cleanup;
- final commit and rollback;
- concurrent memory promotion.

### Agent protocol tests

Use deterministic fake child processes emitting pi JSON events:

- success;
- malformed completion;
- timeout;
- abort;
- partial output;
- nonzero exit;
- model error;
- oversized output requiring truncation.

### TUI tests

- narrow and wide terminals;
- light and dark pi themes;
- keyboard navigation;
- dashboard rendering;
- modal questions;
- dynamic updates;
- line-width compliance;
- theme invalidation.

### Documentation tests

- all pages build;
- no broken links;
- valid landmarks and heading order;
- WCAG contrast;
- keyboard navigation;
- responsive layouts;
- light/dark screenshots;
- no external runtime assets.

### End-to-end scenarios

1. Existing TypeScript project, successful first pass.
2. Existing Python project, test failure repaired by developer.
3. Test-writer error repaired independently.
4. Five test failures causing replanning.
5. Five review failures causing replanning.
6. New empty project requiring stack approval.
7. Workflow paused for user input and resumed after restart.
8. Documentation updated by reviewer and committed automatically.
9. User cancellation with safe worktree preservation.
10. Rollback of the final commit.
11. Malicious instructions embedded in fetched research are treated as data.
12. Concurrent runs propose the same memory page without creating duplicates.

## 18. Delivery phases

### Phase 1 — Foundation

- Package scaffold.
- Schemas and state machine.
- Persistent event store.
- `/gx-dev start`, `status`, `pause`, `resume`, and `cancel`.
- Fake-agent test harness.

**Exit criterion:** deterministic state transitions survive restart.

### Phase 2 — Subagent runtime

- Isolated pi subprocess runner.
- Streaming JSON parser.
- Agent discovery and role prompts.
- Cancellation, timeout, usage, and truncation.
- Structured completion protocol.

**Exit criterion:** all seven agents can be invoked independently with validated output.

### Phase 3 — Git isolation

- Repository discovery.
- Worktree manager.
- Branch and checkpoint handling.
- Staging integration.
- Safe cleanup and recovery.
- New-project support.

**Exit criterion:** parallel fixture changes integrate without prematurely modifying the user tree.

### Phase 4 — Research and planning

- Research pipeline.
- Automatic web research and source manifest.
- Source sanitization and provenance.
- Requirement and plan approval screens.
- Acceptance and verification contracts.

**Exit criterion:** approved research and plans are versioned and hash-linked to execution.

### Phase 5 — Parallel development

- Simultaneous developer and test-writer execution.
- Moderated question routing.
- Independence controls.
- Structured handoff artifacts.

**Exit criterion:** neither agent can inspect the other's worktree before the test gate.

### Phase 6 — Test and review loops

- Obvious-issue preflight.
- Command discovery.
- Test execution.
- Ownership routing.
- Counters and five-failure replanning.
- Adversarial review and documentation update.

**Exit criterion:** every pass/fail transition has machine-verifiable evidence.

### Phase 7 — Committer

- Merge-style assessment.
- Final verification.
- Automatic commit.
- Result report and rollback command.
- Cleanup policy.

**Exit criterion:** a successful run creates one traceable commit without unrelated changes.

### Phase 8 — Compounding memory

- Evidence store.
- Wiki schema and deterministic validator.
- Index and chronological log.
- Provenance, freshness, verification, and scope metadata.
- Semantic correction pins.
- Concurrent page reservations.
- Lint and redaction.

**Exit criterion:** a second workflow safely reuses reviewed knowledge from the first without treating raw capture as fact.

### Phase 9 — TUI polish

- Dashboard.
- Progress widget.
- Question and evidence views.
- Theme-aware renderers.
- Accessibility and narrow-terminal behavior.

**Exit criterion:** a complete workflow can be monitored and controlled without reading raw files.

### Phase 10 — Documentation application

- All documentation pages.
- Charts and diagrams.
- Responsive navigation.
- Light/dark mode.
- Search.
- Build and accessibility tests.

**Exit criterion:** the static build passes link, accessibility, responsive, and theme tests.

### Phase 11 — Hardening and release

- Threat review.
- Cross-platform testing.
- Package installation tests.
- Versioning and migration policy.
- Examples and release automation.

**Exit criterion:** installable through pi's npm, Git, and local package mechanisms.

## 19. Version-one scope boundaries

Include in v1:

- local Git repositories;
- empty-project bootstrapping;
- isolated child pi processes;
- Git worktrees;
- automatic web research;
- persistent reviewed memory wiki;
- TUI workflow management;
- automatic final commits;
- static documentation application.

Defer unless needed:

- remote worker machines;
- GitHub/GitLab pull-request creation;
- distributed queues;
- embedding/vector memory;
- team-wide shared memory server;
- browser-based workflow control;
- autonomous deployment;
- force pushes or history rewriting.

## 20. Definition of done

gx-dev v1 is complete when:

- an installable pi package exposes the documented `/gx-dev` commands;
- all agents execute in isolated contexts with role-specific tools;
- developer and test-writer operate concurrently in separate worktrees;
- communication is routed only through the orchestrator;
- requirements and architecture receive mandatory user approval;
- tests and review have independent five-failure escalation loops;
- the planner receives complete failure history during escalation;
- reviewer-approved documentation is included before commit;
- the committer safely commits without final approval;
- existing and empty projects are supported;
- workflows survive restart and can be paused, resumed, cancelled, and rolled back;
- web research records provenance and treats fetched content as untrusted;
- raw capture remains separate from reviewed durable memory;
- memory compounds through an indexed, validated Markdown wiki;
- corrections, provenance, freshness, scope, and verification state are preserved;
- secrets and destructive operations are guarded;
- the full automated test suite passes;
- the multi-page documentation application passes accessibility, responsive, link, light-mode, and dark-mode checks.

## 21. Primary references

- Pi extension documentation and examples, including subagents, TUI components, session persistence, package distribution, compaction, Git checkpoints, and merge handling.
- Andrej Karpathy, **LLM Wiki**: <https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f>
