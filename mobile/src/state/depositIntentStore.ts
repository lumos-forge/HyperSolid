import { create } from "zustand";

/**
 * One-shot cross-tab signal to open the Account deposit sheet. A Trade-tab CTA calls `request()` then
 * navigates to Account; AccountScreen subscribes to `requested` and opens the deposit sheet, then
 * `consume()` clears it (so it fires at most once per request). Reactive (not focus-based) so it works
 * whether or not the Account tab was previously mounted, and is trivially testable.
 */
interface DepositIntentState {
  requested: boolean;
  request: () => void;
  consume: () => boolean;
}

export const useDepositIntentStore = create<DepositIntentState>((set, get) => ({
  requested: false,
  request: () => set({ requested: true }),
  consume: () => {
    const was = get().requested;
    if (was) set({ requested: false });
    return was;
  },
}));
