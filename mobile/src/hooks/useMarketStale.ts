import { useEffect, useState } from "react";
import { useMarketStore, isMarketStale } from "../state/marketStore";
import { useNetStore, isOffline } from "../state/netStore";

/**
 * True when the live mids stream has gone quiet (likely a dropped/reconnecting socket) while the
 * device is still online — so the UI can flag that prices may be stale. Re-evaluates on a timer
 * because the underlying timestamp doesn't itself trigger a re-render. Suppressed when offline (the
 * global OfflineBanner already covers that) or before the first data arrives.
 */
export function useMarketStale(pollMs = 5000): boolean {
  const lastTickAt = useMarketStore((s) => s.lastTickAt);
  const online = useNetStore((s) => s.online);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), pollMs);
    return () => clearInterval(id);
  }, [pollMs]);

  if (isOffline(online)) return false;
  return isMarketStale(lastTickAt, now);
}
