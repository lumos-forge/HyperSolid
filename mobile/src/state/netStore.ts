import { create } from "zustand";

interface NetState {
  /** Null until the first NetInfo reading arrives; true/false thereafter. */
  online: boolean | null;
  setOnline: (online: boolean) => void;
}

/** App-wide connectivity flag, fed by NetInfo (see useNetworkStatus). `online: false` = show banner. */
export const useNetStore = create<NetState>((set) => ({
  online: null,
  setOnline: (online) => set({ online }),
}));

/** Treat only a definite offline reading as offline; unknown (null) stays optimistic. */
export function isOffline(online: boolean | null): boolean {
  return online === false;
}
