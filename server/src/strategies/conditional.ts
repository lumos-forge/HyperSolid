import type { ConditionalParams } from "./types";

/** True when the mark has crossed the trigger in the configured direction. */
export function conditionalTriggered(p: ConditionalParams, mark: number): boolean {
  return p.triggerDirection === "above" ? mark >= p.triggerPrice : mark <= p.triggerPrice;
}
