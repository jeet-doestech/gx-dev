/**
 * Validation bridge for the structured agent completion protocol (PLAN §12).
 *
 * Wraps the frozen domain validators: validateCompletion decides, and
 * schemaFeedback renders the retry feedback string the runner appends to the
 * task on the single allowed retry.
 */

import { schemaFeedback, validateCompletion } from "../domain/schemas.ts";
import type { AgentCompletion, AgentRole } from "../domain/schemas.ts";

export interface ValidationOutcome {
  ok: boolean;
  completion?: AgentCompletion;
  errors: string[];
  feedback?: string;
}

/** Validates raw agent text; on failure returns schema feedback for retry. */
export function validateOrFeedback(role: AgentRole, rawText: string): ValidationOutcome {
  const result = validateCompletion(role, rawText);
  if (result.ok && result.completion !== null) {
    return { ok: true, completion: result.completion, errors: [] };
  }
  const errors = result.errors.length > 0 ? result.errors : ["validation failed"];
  return { ok: false, errors, feedback: schemaFeedback(role, errors) };
}
