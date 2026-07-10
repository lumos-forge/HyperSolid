export type PushLocale = "en" | "zh";

export function sideLabel(locale: PushLocale, side: string): string {
  const buy = side.toLowerCase() === "buy";
  if (locale === "zh") return buy ? "买入" : "卖出";
  return buy ? "Buy" : "Sell";
}

export const pushMessages = {
  en: {
    fillTitle: "Order filled",
    fillBody: (side: string, sz: string, coin: string, px: string) => `${sideLabel("en", side)} ${sz} ${coin} @ ${px}`,
    deadmanAlertTitle: "Strategy protection at risk",
    deadmanAlertBody: (n: number) => `${n} consecutive unprotected heartbeats — check your agent authorization.`,
    deadmanRecoveredTitle: "Strategy protection restored",
    deadmanRecoveredBody: "Your automated strategies are protected again.",
  },
  zh: {
    fillTitle: "订单成交",
    fillBody: (side: string, sz: string, coin: string, px: string) => `${sideLabel("zh", side)} ${sz} ${coin} @ ${px}`,
    deadmanAlertTitle: "策略保护异常",
    deadmanAlertBody: (n: number) => `连续 ${n} 次心跳未受保护——请检查 agent 授权。`,
    deadmanRecoveredTitle: "策略保护已恢复",
    deadmanRecoveredBody: "你的自动策略重新受到保护。",
  },
} as const;

/** Normalize any stored/raw locale to a supported PushLocale (default en). */
export function toPushLocale(v: string | null | undefined): PushLocale {
  return v === "zh" ? "zh" : "en";
}
