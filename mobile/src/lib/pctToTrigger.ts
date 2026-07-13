/** Signed % the mark must still move to reach the trigger: (trigger - mark) / mark * 100. */
export function pctToTrigger(mark: number, triggerPrice: number): number {
  return ((triggerPrice - mark) / mark) * 100;
}
