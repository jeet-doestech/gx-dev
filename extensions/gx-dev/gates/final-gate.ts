/**
 * Final verification gate (PLAN §6.8): reruns every contract command in the
 * staging worktree (all must exit 0) and, when configured, requires a clean
 * git tree. Uses the same allowlist, timeout, and truncation as the test
 * gate — the contract was authored under those rules and must survive them.
 */

import { hashContent } from "../domain/artifacts.ts";
import type { CommandResult } from "../domain/schemas.ts";
import {
  COMMAND_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  isAllowlistedCommand,
  type CommandExecutor,
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
}): Promise<FinalGateResult> {
  const failures: string[] = [];
  const commands: CommandResult[] = [];

  for (const command of input.verificationContract) {
    if (!isAllowlistedCommand(command)) {
      commands.push({
        command,
        exitCode: -1,
        outputRef: "rejected: command not on allowlist",
      });
      failures.push(`rejected non-allowlisted verification command: ${command}`);
      continue;
    }
    const startedAt = Date.now();
    const run = await input.exec.execute(input.stagingDir, command, COMMAND_TIMEOUT_MS);
    const truncated = run.truncated || run.output.length > MAX_OUTPUT_BYTES;
    const output = truncated ? run.output.slice(0, MAX_OUTPUT_BYTES) : run.output;
    commands.push({
      command,
      exitCode: run.exitCode,
      outputRef: `output:${hashContent(output).slice(0, 16)}`,
      durationMs: Date.now() - startedAt,
    });
    if (run.exitCode !== 0) {
      failures.push(`verification command failed with exit ${run.exitCode}: ${command}`);
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
