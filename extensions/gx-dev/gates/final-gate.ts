/**
 * Final verification gate (PLAN §6.8): reruns every contract command in the
 * staging worktree (all must exit 0) and, when configured, requires a clean
 * git tree. The contract must be nonempty — an empty contract never passes,
 * even when the clean-tree check succeeds (e.g. after an incomplete restart
 * hydration). Uses the same allowlist, timeout, and truncation as the test
 * gate — the contract was authored under those rules and must survive them.
 * When an artifact store or archiver callback is supplied, each command's
 * executable-command metadata plus its raw output is archived as immutable
 * evidence (the store applies the shared secret-redaction boundary);
 * failures carry bounded, secret-REDACTED diagnostic output so reroutes see
 * the real error, not just an exit code.
 */

import type { ArtifactStore } from "../domain/artifacts.ts";
import type { CommandResult } from "../domain/schemas.ts";
import {
  COMMAND_TIMEOUT_MS,
  FAILURE_DIAGNOSTIC_BUDGET,
  FAILURE_DIAGNOSTIC_CHARS,
  MAX_OUTPUT_BYTES,
  boundedDiagnostic,
  executeGateCommand,
  isAllowlistedCommand,
  type CommandExecutor,
  type OutputArchiver,
} from "./test-gate.ts";

export interface FinalGateResult {
  pass: boolean;
  failures: string[];
  commands: CommandResult[];
}

/**
 * Reruns the verification contract. `requireCleanTree` additionally demands
 * `checkClean()` === true (git status --porcelain empty in staging).
 */
export async function runFinalGate(input: {
  stagingDir: string;
  verificationContract: string[];
  exec: CommandExecutor;
  requireCleanTree: boolean;
  checkClean: () => Promise<boolean>;
  /** Optional: archives each executed command's actual output as evidence. */
  store?: ArtifactStore;
  /** Optional callback alternative to `store`; returns the recorded ref. */
  archiveOutput?: OutputArchiver;
}): Promise<FinalGateResult> {
  const failures: string[] = [];
  const commands: CommandResult[] = [];

  const contract = input.verificationContract
    .map((c) => c.trim())
    .filter((c) => c !== "");
  if (contract.length === 0) {
    failures.push(
      "verification contract is empty: at least one required command must be executed before final verification can pass",
    );
  }

  let diagnosticBudget = FAILURE_DIAGNOSTIC_BUDGET;
  for (const command of contract) {
    if (!isAllowlistedCommand(command)) {
      commands.push({
        command,
        exitCode: -1,
        outputRef: "rejected: command not on allowlist",
      });
      failures.push(`rejected non-allowlisted verification command: ${command}`);
      continue;
    }
    const executed = await executeGateCommand({
      stagingDir: input.stagingDir,
      command,
      exec: input.exec,
      store: input.store,
      archiveOutput: input.archiveOutput,
      source: "final-gate",
      evidenceNamePrefix: "final-gate-output",
    });
    commands.push(executed.result);
    if (executed.failed) {
      const diagnostic = boundedDiagnostic(
        executed.output,
        Math.min(FAILURE_DIAGNOSTIC_CHARS, diagnosticBudget),
      );
      diagnosticBudget = Math.max(0, diagnosticBudget - diagnostic.length);
      failures.push(
        `verification command failed with exit ${executed.result.exitCode}: ${command}${diagnostic}`,
      );
    }
  }

  if (input.requireCleanTree) {
    let clean: boolean;
    try {
      clean = await input.checkClean();
    } catch (e) {
      clean = false;
      failures.push(`clean-tree check failed: ${(e as Error).message}`);
    }
    if (!clean) {
      failures.push("staging worktree is not clean: git status --porcelain is not empty");
    }
  }

  return { pass: failures.length === 0, failures, commands };
}
