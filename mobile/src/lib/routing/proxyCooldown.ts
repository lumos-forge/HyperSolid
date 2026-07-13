const cooldownUntil = new Map<string, number>();
export const PROXY_COOLDOWN_MS = 30_000;

/** Put a proxy base URL into cooldown until now+ms (no-op for an empty url). */
export function markCooldown(url: string, now: number = Date.now(), ms: number = PROXY_COOLDOWN_MS): void {
  if (url) cooldownUntil.set(url, now + ms);
}

/** True while the url is cooling down; expired entries self-clear. */
export function isCoolingDown(url: string, now: number = Date.now()): boolean {
  const until = cooldownUntil.get(url);
  if (until === undefined) return false;
  if (now >= until) {
    cooldownUntil.delete(url);
    return false;
  }
  return true;
}

/** Test helper: clear all cooldowns. */
export function _resetCooldowns(): void {
  cooldownUntil.clear();
}
