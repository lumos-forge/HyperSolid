import { useEffect } from "react";
import NetInfo from "@react-native-community/netinfo";
import { useNetStore } from "../state/netStore";

/**
 * Subscribe to device connectivity and mirror it into {@link useNetStore}. Considers the device
 * online only when NetInfo reports connected AND internet is reachable (isInternetReachable !== false),
 * so a Wi-Fi with no actual internet still surfaces as offline. Runs once app-wide (mounted in App).
 */
export function useNetworkStatus(): void {
  useEffect(() => {
    const unsub = NetInfo.addEventListener((state) => {
      const online = Boolean(state.isConnected) && state.isInternetReachable !== false;
      useNetStore.getState().setOnline(online);
    });
    return () => unsub();
  }, []);
}
