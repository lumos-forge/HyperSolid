export type Locale = "en" | "zh";

/**
 * Flat, dot-namespaced translation dictionaries. Every locale MUST carry the same key set (enforced by
 * messages.test.ts). Placeholders use `{var}` and are interpolated by `useT`. Order-rejection copy is
 * keyed by HL rejection CODE so the guarded encoding core (`src/lib/hyperliquid/order.ts`) stays
 * untouched — the UI translates by code.
 */
export const messages = {
  en: {
    "orderbook.price": "PRICE",
    "orderbook.size": "SIZE",
    "orderbook.sum": "SUM",
    "orderbook.spread": "Spread {spread} ({pct}%)",

    "common.cancel": "Cancel",
    "common.confirm": "Confirm",
    "common.buy": "Buy",
    "common.sell": "Sell",
    "common.deposit": "Deposit",
    "common.withdraw": "Withdraw",
    "common.trade": "Trade",

    "settings.language": "Language",
    "lang.en": "English",
    "lang.zh": "中文",

    "lock.title": "HyperSolid locked",
    "lock.subtitle": "Unlock with biometrics to continue",
    "lock.unlock": "Unlock",
    "lock.failed": "Authentication failed, try again",
    "lock.cancelled": "Cancelled",
    "lock.unavailable": "No biometrics detected — enable Face ID / fingerprint in Settings",
    "lock.compromised": "Device security check failed: root/jailbreak risk detected. Unlock is disabled to protect your assets.",

    "banner.unconfirmedTitle": "{count} unconfirmed order(s)",
    "banner.unconfirmedBody": "These orders may have been submitted to the exchange and carry exposure; their status is not yet confirmed. Don't re-place them manually — review, and if needed retry safely with the same id (cloid).",
    "banner.review": "Review",

    "common.comingSoon": "In progress · Coming soon",
    "common.uncertainReceipt": "Uncertain receipt",

    "agent.connectFailed": "Connection failed",
    "agent.gatedNoConfig": "The server hasn't delivered the strategy config yet — try again shortly.",
    "agent.gatedNoWallet": "A local wallet is required: create or restore one in Wallet first, then use automation.",
    "agent.connectHint": "Once connected, the server runs your strategies 24/7 with a trade-only agent; the agent can't withdraw and your main key never leaves the device.",
    "agent.approveFailed": "Authorization failed",
    "agent.approveHint": "Authorize a trade-only agent (can't withdraw) so the server can run strategies for you.",
    "agent.invalidParams": "Invalid parameters",
    "agent.invalidParamsBody": "Enter a positive amount and interval (hours)",

    "reject.tickRejected": "Price does not match the tick size",
    "reject.minTradeNtlRejected": "Order notional is below the $10 minimum",
    "reject.sizeRejected": "Invalid size or below the minimum order size",
    "reject.priceRejected": "Invalid price",
    "reject.perpMarginRejected": "Insufficient margin",
    "reject.reduceOnlyRejected": "Reduce-only orders cannot increase the position",
    "reject.badAloPxRejected": "ALO (post-only) price would fill immediately",
    "reject.badTriggerPxRejected": "Trigger price is on the wrong side",
    "reject.iocCancelRejected": "IOC order canceled without filling",
    "reject.oracleRejected": "Price deviates too far from the oracle",
    "reject.builderFeeRejected": "Builder fee exceeds the cap (perps 0.1% / spot 1%)",
    "reject.unknownAsset": "Market not found (unknown asset)",
  },
  zh: {
    "orderbook.price": "价格",
    "orderbook.size": "数量",
    "orderbook.sum": "累计",
    "orderbook.spread": "价差 {spread} ({pct}%)",

    "common.cancel": "取消",
    "common.confirm": "确认",
    "common.buy": "买入",
    "common.sell": "卖出",
    "common.deposit": "充值",
    "common.withdraw": "提现",
    "common.trade": "交易",

    "settings.language": "语言",
    "lang.en": "English",
    "lang.zh": "中文",

    "lock.title": "HyperSolid 已锁定",
    "lock.subtitle": "用生物识别解锁以继续",
    "lock.unlock": "解锁",
    "lock.failed": "验证失败，请重试",
    "lock.cancelled": "已取消",
    "lock.unavailable": "未检测到生物识别，请在系统设置中启用 Face ID/指纹",
    "lock.compromised": "设备安全检查未通过：检测到 root/越狱风险，为保护你的资产已禁止解锁。",

    "banner.unconfirmedTitle": "{count} 笔未确认订单",
    "banner.unconfirmedBody": "这些订单可能已提交至交易所、存在敞口，状态尚未确认。请勿重复手动下单；请复核，必要时用同一编号(cloid)安全重试。",
    "banner.review": "复核",

    "common.comingSoon": "开发中 · Coming soon",
    "common.uncertainReceipt": "回执不确定",

    "agent.connectFailed": "连接失败",
    "agent.gatedNoConfig": "服务器策略配置尚未下发，请稍后重试。",
    "agent.gatedNoWallet": "需要本地钱包：请先在「钱包」创建或恢复钱包，再使用自动化。",
    "agent.connectHint": "连接后由服务器用 trade-only 代理 24/7 执行策略；代理不能提现、主私钥不出设备。",
    "agent.approveFailed": "授权失败",
    "agent.approveHint": "授权一个只能交易、不能提现的代理，由服务器替你执行策略。",
    "agent.invalidParams": "参数无效",
    "agent.invalidParamsBody": "请填写正数的金额与周期（小时）",

    "reject.tickRejected": "价格不符合最小变动单位（tick）规则",
    "reject.minTradeNtlRejected": "订单名义价值低于最小 $10",
    "reject.sizeRejected": "数量无效或低于最小下单量",
    "reject.priceRejected": "价格无效",
    "reject.perpMarginRejected": "保证金不足",
    "reject.reduceOnlyRejected": "仅减仓订单不能增加仓位",
    "reject.badAloPxRejected": "ALO（只挂单）价格会立即成交",
    "reject.badTriggerPxRejected": "触发价位于错误一侧",
    "reject.iocCancelRejected": "IOC 订单未成交被取消",
    "reject.oracleRejected": "价格偏离预言机过大",
    "reject.builderFeeRejected": "Builder 返佣费率超出上限（perps 0.1% / spot 1%）",
    "reject.unknownAsset": "未找到该交易对（asset 未知）",
  },
} as const;

export type TranslationKey = keyof (typeof messages)["en"];
