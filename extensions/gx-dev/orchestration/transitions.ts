/**
 * Persisted state-machine transitions (PLAN §5).
 *
 * The engine owns every transition. A transition is validated by the domain
 * (`applyTransition`), persisted via the RunStore (state.json is operational
 * truth), and recorded in the append-only event log — all before the engine
 * begins the next action.
 */

import type { EventStore } from "../domain/events.ts";
import type { RunStore } from "../domain/interfaces.ts";
import { applyTransition } from "../domain/state.ts";
import type { RunState, TransitionInput } from "../domain/state.ts";

/**
 * Applies `input` to `state`, persists the resulting state, appends a
 * `transition` event, and returns the new state.
 *
 * Throws when the transition is illegal for the current state; callers must
 * treat an illegal transition as an engine bug (agents can never request one).
 */
export async function persistTransition(
  deps: { runStore: RunStore; events: EventStore },
  state: RunState,
  input: TransitionInput,
): Promise<RunState> {
  const result = applyTransition(state, input);
  if (!result.ok) {
    throw new Error(`persistTransition: ${result.error}`);
  }
  await deps.runStore.save(result.state);
  deps.events.append("transition", `${state.state} → ${input.to} (${input.reason})`, {
    from: state.state,
    to: input.to,
    reason: input.reason,
  });
  return result.state;
}
