/**
 * Structured agent completion protocol (PLAN §12).
 *
 * Agents must return a single JSON object via a fenced ```json block (or the
 * whole message, if it parses) validated here. Validation is deterministic,
 * hand-rolled, and role-aware: no schema library, no network, no escape
 * hatches. Invalid output is retried once with schema feedback, then treated
 * as an agent failure (the runner implements the retry).
 */

export const AGENT_ROLES = [
  "researcher",
  "planner",
  "developer",
  "testWriter",
  "testRunner",
  "reviewer",
  "committer",
] as const;

export type AgentRole = (typeof AGENT_ROLES)[number];

export interface SourceRef {
  url: string;
  title: string;
  retrievedAt: string;
  excerpt?: string;
  confidence: "low" | "medium" | "high";
}

export interface AgentQuestion {
  question: string;
  severity: "minor" | "material";
  context?: string[];
}

export interface ReviewFinding {
  severity: "blocking" | "major" | "minor" | "info";
  path?: string;
  line?: number;
  expected?: string;
  observed?: string;
  remediation: string;
}

export interface CommandResult {
  command: string;
  exitCode: number;
  outputRef?: string;
  durationMs?: number;
}

/** Common envelope shared by every role. */
export interface CompletionBase {
  status: "complete" | "blocked";
  summary: string;
  artifacts: string[];
  questions: AgentQuestion[];
  assumptions: string[];
  risks: string[];
  recommendedNextState?:
    | "RESEARCH"
    | "PLAN"
    | "DEVELOP"
    | "WRITE_TESTS"
    | "INTEGRATE"
    | "REVIEW_GATE"
    | "DOCUMENTATION_UPDATE"
    | "COMMIT"
    | "REPLAN";
}

export interface ResearcherCompletion extends CompletionBase {
  sources: SourceRef[];
  findings: string[];
  requirementAmbiguities: string[];
}

export interface PlannerTask {
  id: string;
  assignee: "developer" | "testWriter";
  title: string;
  files: string[];
  dependsOn: string[];
}

export interface PlannerCompletion extends CompletionBase {
  tasks: PlannerTask[];
  verificationContract: string[];
  rollbackPlan: string;
}

export interface DeveloperCompletion extends CompletionBase {
  changedFiles: string[];
  deviations: string[];
  knownLimitations: string[];
}

export interface TestWriterCompletion extends CompletionBase {
  testInventory: { path: string; covers: string }[];
  coverageGaps: string[];
}

export interface TestRunnerCompletion extends CompletionBase {
  commands: CommandResult[];
  ownership:
    { failure: string; owner: "developer" | "testWriter" | "both" | "infrastructure" }[];
}

export interface ReviewerCompletion extends CompletionBase {
  findings: ReviewFinding[];
  documentationUpdates: string[];
}

export interface CommitterCompletion extends CompletionBase {
  strategy: "fast-forward" | "cherry-pick" | "merge-commit" | "patch" | "initial";
  commitHash: string;
  rollbackCommand: string;
}

export type AgentCompletion =
  | ResearcherCompletion
  | PlannerCompletion
  | DeveloperCompletion
  | TestWriterCompletion
  | TestRunnerCompletion
  | ReviewerCompletion
  | CommitterCompletion;

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  completion: AgentCompletion | null;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): v is string {
  return typeof v === "string";
}

function strArray(v: unknown, label: string, errors: string[]): string[] {
  if (!Array.isArray(v)) {
    errors.push(`${label}: must be an array of strings`);
    return [];
  }
  const out: string[] = [];
  for (const item of v) {
    if (!str(item)) errors.push(`${label}: every item must be a string`);
    else out.push(item);
  }
  return out;
}

function validateBase(
  raw: Record<string, unknown>,
  errors: string[],
): CompletionBase | null {
  const status = raw["status"];
  if (status !== "complete" && status !== "blocked") {
    errors.push("status: must be 'complete' or 'blocked'");
  }
  if (!str(raw["summary"]) || (raw["summary"] as string).length === 0) {
    errors.push("summary: required non-empty string");
  }
  const base: CompletionBase = {
    status: status === "blocked" ? "blocked" : "complete",
    summary: str(raw["summary"]) ? (raw["summary"] as string) : "",
    artifacts: strArray(raw["artifacts"], "artifacts", errors),
    questions: [],
    assumptions: strArray(raw["assumptions"], "assumptions", errors),
    risks: strArray(raw["risks"], "risks", errors),
  };
  const next = raw["recommendedNextState"];
  if (next !== undefined) {
    const allowed = [
      "RESEARCH",
      "PLAN",
      "DEVELOP",
      "WRITE_TESTS",
      "INTEGRATE",
      "REVIEW_GATE",
      "DOCUMENTATION_UPDATE",
      "COMMIT",
      "REPLAN",
    ] as const;
    if (!str(next) || !(allowed as readonly string[]).includes(next)) {
      errors.push(`recommendedNextState: must be one of ${allowed.join(", ")}`);
    } else {
      base.recommendedNextState = next as (typeof allowed)[number];
    }
  }
  const qs = raw["questions"];
  if (qs !== undefined) {
    if (!Array.isArray(qs)) errors.push("questions: must be an array");
    else {
      for (const q of qs) {
        if (!isObj(q) || !str(q["question"])) {
          errors.push("questions[].question: required string");
          continue;
        }
        const sev = q["severity"];
        if (sev !== "minor" && sev !== "material") {
          errors.push("questions[].severity: must be 'minor' or 'material'");
        }
        base.questions.push({
          question: q["question"] as string,
          severity: sev === "material" ? "material" : "minor",
        });
      }
    }
  }
  return errors.length === 0 ? base : base;
}

/** Extract the last fenced ```json block, else the whole trimmed text. */
export function extractJson(text: string): string {
  const matches = [...text.matchAll(/```json\r?\n([\s\S]*?)```/g)];
  const last = matches[matches.length - 1];
  if (last?.[1]) return last[1].trim();
  const bare = text.trim();
  return bare.startsWith("{") ? bare : text;
}

/** Deterministic, role-aware validation of a raw agent message. */
export function validateCompletion(
  role: AgentRole,
  rawText: string,
): ValidationResult {
  const errors: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(rawText));
  } catch (e) {
    return {
      ok: false,
      errors: [`unparseable JSON: ${(e as Error).message}`],
      completion: null,
    };
  }
  if (!isObj(parsed)) {
    return { ok: false, errors: ["completion must be a JSON object"], completion: null };
  }
  const base = validateBase(parsed, errors);
  if (base === null) {
    return { ok: false, errors, completion: null };
  }
  let completion: AgentCompletion;
  switch (role) {
    case "researcher": {
      const sources: SourceRef[] = [];
      const rawSources = parsed["sources"];
      if (rawSources !== undefined && Array.isArray(rawSources)) {
        for (const s of rawSources) {
          if (!isObj(s) || !str(s["url"]) || !str(s["title"])) {
            errors.push("sources[]: url and title required");
            continue;
          }
          const conf = s["confidence"];
          sources.push({
            url: s["url"] as string,
            title: s["title"] as string,
            retrievedAt: str(s["retrievedAt"]) ? (s["retrievedAt"] as string) : new Date().toISOString(),
            ...(str(s["excerpt"]) ? { excerpt: s["excerpt"] as string } : {}),
            confidence: conf === "high" || conf === "medium" ? conf : "low",
          });
        }
      } else {
        errors.push("sources: required array (may be empty)");
      }
      completion = {
        ...base,
        sources,
        findings: strArray(parsed["findings"], "findings", errors),
        requirementAmbiguities: strArray(parsed["requirementAmbiguities"], "requirementAmbiguities", errors),
      };
      break;
    }
    case "planner": {
      const tasks: PlannerTask[] = [];
      const rawTasks = parsed["tasks"];
      if (rawTasks !== undefined && Array.isArray(rawTasks)) {
        for (const t of rawTasks) {
          if (!isObj(t) || !str(t["id"]) || !str(t["title"])) {
            errors.push("tasks[]: id and title required");
            continue;
          }
          const assignee = t["assignee"];
          if (assignee !== "developer" && assignee !== "testWriter") {
            errors.push(`tasks[${t["id"] as string}].assignee: must be developer or testWriter`);
            continue;
          }
          tasks.push({
            id: t["id"] as string,
            assignee,
            title: t["title"] as string,
            files: strArray(t["files"], `tasks[${t["id"] as string}].files`, errors),
            dependsOn: strArray(t["dependsOn"], `tasks[${t["id"] as string}].dependsOn`, errors),
          });
        }
      } else {
        errors.push("tasks: required array");
      }
      completion = {
        ...base,
        tasks,
        verificationContract: strArray(parsed["verificationContract"], "verificationContract", errors),
        rollbackPlan: str(parsed["rollbackPlan"]) ? (parsed["rollbackPlan"] as string) : "",
      };
      if (completion.rollbackPlan === "") errors.push("rollbackPlan: required string");
      break;
    }
    case "developer": {
      completion = {
        ...base,
        changedFiles: strArray(parsed["changedFiles"], "changedFiles", errors),
        deviations: strArray(parsed["deviations"], "deviations", errors),
        knownLimitations: strArray(parsed["knownLimitations"], "knownLimitations", errors),
      };
      break;
    }
    case "testWriter": {
      const inv: TestWriterCompletion["testInventory"] = [];
      const rawInv = parsed["testInventory"];
      if (rawInv !== undefined && Array.isArray(rawInv)) {
        for (const t of rawInv) {
          if (!isObj(t) || !str(t["path"]) || !str(t["covers"])) {
            errors.push("testInventory[]: path and covers required");
            continue;
          }
          inv.push({ path: t["path"] as string, covers: t["covers"] as string });
        }
      } else {
        errors.push("testInventory: required array");
      }
      completion = {
        ...base,
        testInventory: inv,
        coverageGaps: strArray(parsed["coverageGaps"], "coverageGaps", errors),
      };
      break;
    }
    case "testRunner": {
      const commands: CommandResult[] = [];
      const rawCmds = parsed["commands"];
      if (rawCmds !== undefined && Array.isArray(rawCmds)) {
        for (const c of rawCmds) {
          if (!isObj(c) || !str(c["command"])) {
            errors.push("commands[]: command required");
            continue;
          }
          const exit = c["exitCode"];
          if (typeof exit !== "number") errors.push("commands[]: exitCode required number");
          commands.push({
            command: c["command"] as string,
            exitCode: typeof exit === "number" ? exit : -1,
            ...(str(c["outputRef"]) ? { outputRef: c["outputRef"] as string } : {}),
            ...(typeof c["durationMs"] === "number" ? { durationMs: c["durationMs"] as number } : {}),
          });
        }
      } else {
        errors.push("commands: required array");
      }
      const ownership: TestRunnerCompletion["ownership"] = [];
      const rawOwn = parsed["ownership"];
      if (rawOwn !== undefined && Array.isArray(rawOwn)) {
        for (const o of rawOwn) {
          if (!isObj(o) || !str(o["failure"])) {
            errors.push("ownership[]: failure required");
            continue;
          }
          const owner = o["owner"];
          if (owner !== "developer" && owner !== "testWriter" && owner !== "both" && owner !== "infrastructure") {
            errors.push("ownership[]: owner must be developer|testWriter|both|infrastructure");
            continue;
          }
          ownership.push({ failure: o["failure"] as string, owner });
        }
      }
      completion = { ...base, commands, ownership };
      break;
    }
    case "reviewer": {
      const findings: ReviewFinding[] = [];
      const rawFindings = parsed["findings"];
      if (rawFindings !== undefined && Array.isArray(rawFindings)) {
        for (const f of rawFindings) {
          if (!isObj(f) || !str(f["remediation"])) {
            errors.push("findings[]: remediation required");
            continue;
          }
          const sev = f["severity"];
          if (sev !== "blocking" && sev !== "major" && sev !== "minor" && sev !== "info") {
            errors.push("findings[]: severity must be blocking|major|minor|info");
            continue;
          }
          findings.push({
            severity: sev,
            ...(str(f["path"]) ? { path: f["path"] as string } : {}),
            ...(typeof f["line"] === "number" ? { line: f["line"] as number } : {}),
            ...(str(f["expected"]) ? { expected: f["expected"] as string } : {}),
            ...(str(f["observed"]) ? { observed: f["observed"] as string } : {}),
            remediation: f["remediation"] as string,
          });
        }
      } else {
        errors.push("findings: required array (may be empty)");
      }
      completion = {
        ...base,
        findings,
        documentationUpdates: strArray(parsed["documentationUpdates"], "documentationUpdates", errors),
      };
      break;
    }
    case "committer": {
      const strategy = parsed["strategy"];
      const allowed = ["fast-forward", "cherry-pick", "merge-commit", "patch", "initial"];
      if (!str(strategy) || !allowed.includes(strategy as string)) {
        errors.push(`strategy: must be one of ${allowed.join("|")}`);
      }
      if (!str(parsed["commitHash"])) errors.push("commitHash: required string");
      if (!str(parsed["rollbackCommand"])) errors.push("rollbackCommand: required string");
      completion = {
        ...base,
        strategy: (str(strategy) ? strategy : "merge-commit") as CommitterCompletion["strategy"],
        commitHash: str(parsed["commitHash"]) ? (parsed["commitHash"] as string) : "",
        rollbackCommand: str(parsed["rollbackCommand"]) ? (parsed["rollbackCommand"] as string) : "",
      };
      break;
    }
  }
  return { ok: errors.length === 0, errors, completion: errors.length === 0 ? completion : null };
}

/** Compact schema feedback string for the one allowed retry (PLAN §12). */
export function schemaFeedback(role: AgentRole, errors: string[]): string {
  return [
    `Your previous output failed ${role} schema validation. Return ONLY one corrected JSON object.`,
    `Errors:`,
    ...errors.slice(0, 20).map((e) => `- ${e}`),
    `Required base fields: status, summary, artifacts, questions, assumptions, risks.`,
  ].join("\n");
}
