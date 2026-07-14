import { create } from "zustand";

/** Session approval state for the builder fee. `approved` gates attachment; `suppressed` stops the
 *  one-time prompt from re-appearing after a decline / failure. Reset on wallet/network change. */
interface BuilderApprovalState {
  approved: boolean;
  suppressed: boolean;
  setApproved: (v: boolean) => void;
  suppress: () => void;
  reset: () => void;
}

export const useBuilderApprovalStore = create<BuilderApprovalState>((set) => ({
  approved: false,
  suppressed: false,
  setApproved: (v) => set({ approved: v }),
  suppress: () => set({ suppressed: true }),
  reset: () => set({ approved: false, suppressed: false }),
}));
