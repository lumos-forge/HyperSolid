import React, { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, Pressable, ActivityIndicator, Alert } from "react-native";
import { useTheme } from "../theme/useTheme";
import { useEnvStore } from "../state/envStore";
import { useWalletStore } from "../state/walletStore";
import { useToastStore } from "../state/toastStore";
import { useLedgerStore } from "../state/ledgerStore";
import { useMarketStore } from "../state/marketStore";
import { PositionsService } from "../services/positionsData";
import { FillsService } from "../services/fillsData";
import { OrdersService } from "../services/ordersData";
import { TwapService } from "../services/twapData";
import {
  createPositionsInfoClient,
  createFillsInfoClient,
  createOrdersInfoClient,
  createExchangeClient,
  createTwapInfoClient,
} from "../lib/hyperliquid/client";
import { buildAssetIndex } from "../lib/hyperliquid/assetId";
import { marketSlippagePrice } from "../lib/hyperliquid/orderForm";
import { ExchangeService } from "../services/exchange";
import type { LocalWalletService } from "../wallet/localWallet";
import { useViewOnlyPortfolio, isValidAddress } from "../hooks/useViewOnlyPortfolio";
import { classifyFetchError, type FetchErrorCode } from "../lib/errorMessage";
import { useUnconfirmedIntents } from "../hooks/useUnconfirmedIntents";
import { PositionRow } from "../components/PositionRow";
import { ScreenScaffold } from "../components/ScreenScaffold";
import { NetworkWarning } from "../components/NetworkWarning";
import { SurfaceCard } from "../components/SurfaceCard";
import { UnconfirmedBanner } from "../components/UnconfirmedBanner";
import { LoadError } from "../components/LoadError";
import { PriceText, formatPrice } from "../components/PriceText";
import { fonts } from "../theme/fonts";
import { withAlpha } from "../theme/color";
import { useT } from "../i18n/useT";
import type { TranslationKey } from "../i18n/messages";
import type { ThemeTokens } from "../theme/tokens";
import type { Fill, OpenOrder, AccountSummary, Position } from "../lib/hyperliquid/types";
import { twapProgressPct, type ActiveTwap } from "../lib/hyperliquid/twap";

export interface PositionsScreenDeps {
  positions: PositionsService;
  fills: FillsService;
  orders: OrdersService;
  twap: TwapService;
}

type Tab = "positions" | "fills" | "orders" | "twap";

export function PositionsScreen({
  deps,
  navigation,
}: {
  deps?: PositionsScreenDeps;
  navigation?: { navigate: (name: string) => void };
} = {}) {
  const theme = useTheme();
  const t = useT();
  const network = useEnvStore((s) => s.network);
  const walletAddress = useWalletStore((s) => s.address);
  const mode = useWalletStore((s) => s.mode);
  const wallet = useWalletStore((s) => s.wallet);
  const tickers = useMarketStore((s) => s.tickers);

  const services = useMemo<PositionsScreenDeps>(
    () =>
      deps ?? {
        positions: new PositionsService(createPositionsInfoClient(network)),
        fills: new FillsService(createFillsInfoClient(network)),
        orders: new OrdersService(createOrdersInfoClient(network)),
        twap: new TwapService(createTwapInfoClient(network)),
      },
    [deps, network],
  );

  const { portfolio, loading, error, load } = useViewOnlyPortfolio(services.positions);
  const { count: unconfirmedCount } = useUnconfirmedIntents();
  const [tab, setTab] = useState<Tab>("positions");
  const [fills, setFills] = useState<Fill[]>([]);
  const [orders, setOrders] = useState<OpenOrder[]>([]);
  const [fillsError, setFillsError] = useState<FetchErrorCode | null>(null);
  const [ordersError, setOrdersError] = useState<FetchErrorCode | null>(null);
  const [activeTwaps, setActiveTwaps] = useState<ActiveTwap[]>([]);
  const [twapError, setTwapError] = useState<FetchErrorCode | null>(null);

  const runQuery = useCallback(
    (addr: string) => {
      void load(addr);
      if (!isValidAddress(addr)) return;
      setFillsError(null);
      setOrdersError(null);
      setTwapError(null);
      void services.fills.loadRecent(addr).then(setFills).catch((e) => setFillsError(classifyFetchError(e)));
      void services.orders.loadOpenOrders(addr).then(setOrders).catch((e) => setOrdersError(classifyFetchError(e)));
      void services.twap.loadActive(addr).then(setActiveTwaps).catch((e) => setTwapError(classifyFetchError(e)));
    },
    [load, services],
  );

  // Show the connected/view-only wallet's own positions automatically — Positions is always "your"
  // account, so there is no manual address entry. Never queries without a wallet (mode "none"); that
  // state is gated below.
  useEffect(() => {
    if (mode !== "none" && walletAddress && isValidAddress(walletAddress)) runQuery(walletAddress);
  }, [mode, walletAddress, runQuery]);

  // Build a signing exchange service on demand (signing wallet + asset index from the market store)
  // so close/cancel work even before the Trade tab is visited. Returns null if anything's missing.
  const buildSvc = useCallback(() => {
    const local = wallet as Partial<LocalWalletService> | null;
    if (mode !== "local" || !local || typeof local.getViemAccount !== "function" || tickers.length === 0) return null;
    const index = buildAssetIndex({
      universe: tickers.map((tk) => ({ name: tk.coin, szDecimals: tk.szDecimals, maxLeverage: tk.maxLeverage })),
    });
    // Route through the persistent intent ledger (scoped by wallet × network) so an uncertain close is
    // deduped by cloid on retry — never re-issued as a fresh order.
    const ledger = useLedgerStore.getState().ledger ?? undefined;
    return new ExchangeService(createExchangeClient(network, local.getViemAccount()), index, ledger);
  }, [wallet, mode, tickers, network]);

  // One-tap market close/reduce: reduce-only IOC at mid ± 5%, opposite the position side. Confirm
  // first; for a limit close the user goes to the Trade tab. Reloads on success.
  const marketClose = useCallback(
    (p: Position, fraction: number) => {
      const side = p.side === "long" ? "sell" : "buy";
      const size = Number(((p.size * fraction) / 100).toFixed(6));
      const action = t(side === "buy" ? "common.buy" : "common.sell");
      const title = fraction >= 100 ? t("positions.closeTitle", { coin: p.coin }) : t("positions.reduceTitle", { coin: p.coin, pct: fraction });
      Alert.alert(title, t("positions.closeBody", { action, sz: size, coin: p.coin }), [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("common.confirm"),
          style: "destructive",
          onPress: async () => {
            try {
              const svc = buildSvc();
              const mid = tickers.find((tk) => tk.coin === p.coin)?.midPx ?? 0;
              if (!svc || mid <= 0 || size <= 0) {
                Alert.alert(t("positions.closeFailed"));
                return;
              }
              const res = await svc.placeOrder({ coin: p.coin, side, size, price: marketSlippagePrice(mid, side), reduceOnly: true, market: true });
              if (res.ok) {
                useToastStore.getState().show(t("positions.closeSubmitted"), "success");
                runQuery(walletAddress ?? "");
              } else if (res.uncertain) {
                // Network/timeout — the close may have landed. Never call it a failure; the persistent
                // ledger lets a later submit dedupe by cloid. Reload so a filled close surfaces.
                Alert.alert(t("common.uncertainReceipt"), t("positions.closeUncertain", { error: res.error }));
                runQuery(walletAddress ?? "");
              } else {
                Alert.alert(t("positions.closeFailed"), res.error);
              }
            } catch (e) {
              // A synchronous throw (client/account construction) must not red-box; nothing was signed.
              Alert.alert(t("positions.closeFailed"), e instanceof Error ? e.message : String(e));
            }
          },
        },
      ]);
    },
    [buildSvc, tickers, runQuery, walletAddress, t],
  );

  // Cancel an open order via the same exchange service; reloads orders on success.
  const cancelOrder = useCallback(
    async (order: OpenOrder) => {
      const side = t(order.side === "buy" ? "common.buy" : "common.sell");
      Alert.alert(
        t("positions.cancelOrderTitle"),
        t("positions.cancelOrderBody", { coin: order.coin, side, sz: order.sz, px: order.limitPx }),
        [
          { text: t("common.cancel"), style: "cancel" },
          {
            text: t("common.confirm"),
            style: "destructive",
            onPress: async () => {
              try {
                const svc = buildSvc();
                if (!svc) {
                  Alert.alert(t("positions.cancelFailed"));
                  return;
                }
                const res = await svc.cancelOrder(order.coin, order.oid);
                if (res.ok) runQuery(walletAddress ?? "");
                else Alert.alert(t("positions.cancelFailed"), res.error);
              } catch (e) {
                Alert.alert(t("positions.cancelFailed"), e instanceof Error ? e.message : String(e));
              }
            },
          },
        ],
      );
    },
    [buildSvc, runQuery, walletAddress, t],
  );

  // Cancel a TWAP via the exchange service; reloads TWAPs on success.
  const cancelTwap = useCallback(
    async (twp: ActiveTwap) => {
      const side = t(twp.side === "buy" ? "common.buy" : "common.sell");
      Alert.alert(
        t("positions.twapCancelTitle"),
        t("positions.twapCancelBody", { coin: twp.coin, side, done: twp.executedSz, total: twp.sz }),
        [
          { text: t("common.cancel"), style: "cancel" },
          {
            text: t("common.confirm"),
            style: "destructive",
            onPress: async () => {
              try {
                const svc = buildSvc();
                if (!svc) {
                  Alert.alert(t("positions.twapCancelFailed"));
                  return;
                }
                const res = await svc.cancelTwap(twp.coin, twp.twapId);
                if (res.ok) {
                  useToastStore.getState().show(t("positions.twapCancelled"), "success");
                  runQuery(walletAddress ?? "");
                } else if (res.uncertain) {
                  Alert.alert(t("common.uncertainReceipt"), res.error);
                  runQuery(walletAddress ?? "");
                } else {
                  Alert.alert(t("positions.twapCancelFailed"), res.error);
                }
              } catch (e) {
                Alert.alert(t("positions.twapCancelFailed"), e instanceof Error ? e.message : String(e));
              }
            },
          },
        ],
      );
    },
    [buildSvc, runQuery, walletAddress, t],
  );

  const tabs: Array<[Tab, TranslationKey, number]> = [
    ["positions", "tab.positions", portfolio?.positions.length ?? 0],
    ["orders", "positions.tabOrders", orders.length],
    ["twap", "positions.tabTwap", activeTwaps.length],
    ["fills", "positions.tabHistory", fills.length],
  ];

  if (mode === "none") {
    return (
      <ScreenScaffold theme={theme} pill={<NetworkWarning variant="chip" />}>
        <Text style={[styles.msg, { color: theme.muted }]}>{t("positions.gatedNoWallet")}</Text>
        <Pressable
          accessibilityRole="button"
          testID="gated-setup-wallet"
          onPress={() => navigation?.navigate("Account")}
          style={[styles.btn, { backgroundColor: theme.brand, marginTop: 16, paddingVertical: 13 }]}
        >
          <Text style={[styles.btnText, { color: theme.bg }]}>{t("common.setUpWallet")}</Text>
        </Pressable>
      </ScreenScaffold>
    );
  }

  return (
    <ScreenScaffold theme={theme} pill={<NetworkWarning variant="chip" />}>
      <UnconfirmedBanner theme={theme} count={unconfirmedCount} />

      {error && !portfolio ? (
        <LoadError theme={theme} code={error} onRetry={() => runQuery(walletAddress ?? "")} testID="positions-error" />
      ) : null}
      {loading ? <ActivityIndicator color={theme.brand} style={{ marginTop: 16 }} /> : null}

      {portfolio ? (
        <>
          <EquityCard theme={theme} summary={portfolio.summary} />

          <View style={[styles.tabs, { borderBottomColor: theme.line }]}>
            {tabs.map(([key, labelKey, n]) => {
              const active = tab === key;
              return (
                <Pressable
                  key={key}
                  onPress={() => setTab(key)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  style={[styles.tabItem, { borderBottomColor: active ? theme.brand : "transparent" }]}
                >
                  <Text style={[styles.tab, { color: active ? theme.brand : theme.muted }]}>{t(labelKey)}</Text>
                  {n > 0 ? (
                    <View style={[styles.badge, { backgroundColor: withAlpha(active ? theme.brand : theme.muted, 0.16) }]}>
                      <Text style={[styles.badgeText, { color: active ? theme.brand : theme.muted }]}>{n}</Text>
                    </View>
                  ) : null}
                </Pressable>
              );
            })}
          </View>

          {tab === "positions" ? (
            portfolio.positions.length === 0 ? (
              <View>
                <Text style={[styles.msg, { color: theme.muted }]}>{t("positions.emptyPositions")}</Text>
                {mode === "local" ? (
                  <Pressable
                    onPress={() => navigation?.navigate("Trade")}
                    accessibilityRole="button"
                    testID="first-trade-cta"
                    style={[styles.firstTrade, { backgroundColor: theme.brand }]}
                  >
                    <Text style={[styles.firstTradeText, { color: theme.bg }]}>{t("positions.firstTrade")}</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : (
              portfolio.positions.map((p) => (
                <PositionRow key={p.coin} position={p} theme={theme} onClose={marketClose} />
              ))
            )
          ) : null}

          {tab === "fills" ? (
            fillsError && fills.length === 0 ? (
              <LoadError theme={theme} code={fillsError} compact onRetry={() => runQuery(walletAddress ?? "")} testID="fills-error" />
            ) : fills.length === 0 ? (
              <Text style={[styles.msg, { color: theme.muted }]}>{t("positions.emptyFills")}</Text>
            ) : (
              fills.map((f) => <FillRow key={`${f.tid}`} fill={f} theme={theme} />)
            )
          ) : null}

          {tab === "orders" ? (
            ordersError && orders.length === 0 ? (
              <LoadError theme={theme} code={ordersError} compact onRetry={() => runQuery(walletAddress ?? "")} testID="orders-error" />
            ) : orders.length === 0 ? (
              <Text style={[styles.msg, { color: theme.muted }]}>{t("positions.emptyOrders")}</Text>
            ) : (
              orders.map((o) => <OrderRow key={`${o.oid}`} order={o} theme={theme} onCancel={cancelOrder} />)
            )
          ) : null}

          {tab === "twap" ? (
            twapError && activeTwaps.length === 0 ? (
              <LoadError theme={theme} code={twapError} compact onRetry={() => runQuery(walletAddress ?? "")} testID="twap-error" />
            ) : activeTwaps.length === 0 ? (
              <Text style={[styles.msg, { color: theme.muted }]}>{t("positions.emptyTwaps")}</Text>
            ) : (
              activeTwaps.map((tw) => <TwapRow key={tw.twapId} twap={tw} theme={theme} onCancel={cancelTwap} />)
            )
          ) : null}
        </>
      ) : null}
    </ScreenScaffold>
  );
}

function EquityCard({ theme, summary }: { theme: ThemeTokens; summary: AccountSummary }) {
  const t = useT();
  const up = summary.totalUnrealizedPnl >= 0;
  const marginRatio = summary.accountValue ? (summary.totalMarginUsed / summary.accountValue) * 100 : 0;
  const fill = Math.max(2, Math.min(100, marginRatio));
  const healthColor = marginRatio < 50 ? theme.up : marginRatio < 80 ? theme.warn : theme.down;
  const healthLabel =
    marginRatio < 50
      ? t("positions.healthHealthy")
      : marginRatio < 80
        ? t("positions.healthCaution")
        : t("positions.healthAtRisk");

  return (
    <SurfaceCard theme={theme} style={styles.eqCard}>
      <View style={styles.eqTop}>
        <Text style={[styles.eqLabel, { color: theme.muted }]}>{t("positions.equity")}</Text>
        <Text style={[styles.eqPill, { color: theme.brand, borderColor: theme.lineStrong }]}>{t("positions.cross")}</Text>
      </View>
      <PriceText value={summary.accountValue} color={theme.text} size={28} glow glowColor={theme.glow} />

      <View style={styles.eqRow}>
        <EqCell theme={theme} label={t("positions.available")} value={formatPrice(summary.withdrawable)} />
        <EqCell
          theme={theme}
          label={t("positions.unrealizedPnl")}
          value={`${up ? "▲ +" : "▼ "}${summary.totalUnrealizedPnl.toFixed(2)}`}
          color={up ? theme.up : theme.down}
        />
        <EqCell theme={theme} label={t("positions.marginRatio")} value={`${marginRatio.toFixed(1)}%`} />
      </View>

      <View style={styles.health}>
        <View style={[styles.healthBar, { backgroundColor: withAlpha(healthColor, 0.18) }]}>
          <View style={[styles.healthFill, { width: `${fill}%`, backgroundColor: healthColor }]} />
        </View>
        <View style={styles.healthRow}>
          <Text style={[styles.healthLabel, { color: theme.muted }]}>{t("positions.accountHealth")}</Text>
          <Text style={[styles.healthLabel, { color: healthColor }]}>
            {t("positions.healthSummary", { label: healthLabel, ratio: marginRatio.toFixed(1) })}
          </Text>
        </View>
      </View>
    </SurfaceCard>
  );
}

function EqCell({
  theme,
  label,
  value,
  color,
}: {
  theme: ThemeTokens;
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <View style={styles.eqCell}>
      <Text style={[styles.eqCellLabel, { color: theme.faint }]}>{label}</Text>
      <Text style={[styles.eqCellValue, { color: color ?? theme.text }]}>{value}</Text>
    </View>
  );
}

function FillRow({ fill, theme }: { fill: Fill; theme: ThemeTokens }) {
  const t = useT();
  const sideColor = fill.side === "buy" ? theme.up : theme.down;
  return (
    <View style={[styles.row, { borderBottomColor: theme.line }]}>
      <View>
        <Text style={[styles.rowCoin, { color: theme.text }]}>
          {fill.coin} <Text style={{ color: sideColor }}>{t(fill.side === "buy" ? "common.buy" : "common.sell")}</Text>
        </Text>
        <Text style={[styles.rowSub, { color: theme.muted }]}>{fill.dir}</Text>
      </View>
      <View style={styles.right}>
        <Text style={[styles.rowVal, { color: theme.text }]}>{`${fill.sz} @ ${fill.px}`}</Text>
        <Text style={[styles.rowSub, { color: theme.muted }]}>{`fee ${fill.fee} ${fill.feeToken}`}</Text>
      </View>
    </View>
  );
}

function OrderRow({ order, theme, onCancel }: { order: OpenOrder; theme: ThemeTokens; onCancel?: (o: OpenOrder) => void }) {
  const t = useT();
  const sideColor = order.side === "buy" ? theme.up : theme.down;
  return (
    <View style={[styles.row, { borderBottomColor: theme.line }]}>
      <View>
        <Text style={[styles.rowCoin, { color: theme.text }]}>
          {order.coin} <Text style={{ color: sideColor }}>{t(order.side === "buy" ? "common.buy" : "common.sell")}</Text>
          {order.reduceOnly ? <Text style={{ color: theme.muted }}> {t("positions.reduceOnly")}</Text> : null}
        </Text>
        <Text style={[styles.rowSub, { color: theme.muted }]}>
          {t("positions.filled", { filled: order.sz, total: order.origSz })}
        </Text>
      </View>
      <View style={styles.rowRight}>
        <View style={styles.right}>
          <Text style={[styles.rowVal, { color: theme.text }]}>{order.limitPx}</Text>
        </View>
        {onCancel ? (
          <Pressable
            accessibilityRole="button"
            testID={`cancel-${order.oid}`}
            onPress={() => onCancel(order)}
            style={[styles.cancelBtn, { borderColor: theme.lineStrong }]}
          >
            <Text style={[styles.cancelText, { color: theme.down }]}>{t("positions.cancelOrder")}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function TwapRow({ twap, theme, onCancel }: { twap: ActiveTwap; theme: ThemeTokens; onCancel?: (t: ActiveTwap) => void }) {
  const t = useT();
  const sideColor = twap.side === "buy" ? theme.up : theme.down;
  const pct = Math.round(twapProgressPct(twap));
  return (
    <View style={[styles.row, { borderBottomColor: theme.line }]} testID={`twap-${twap.twapId}`}>
      <View>
        <Text style={[styles.rowCoin, { color: theme.text }]}>
          {twap.coin} <Text style={{ color: sideColor }}>{t(twap.side === "buy" ? "common.buy" : "common.sell")}</Text>
          {twap.reduceOnly ? <Text style={{ color: theme.muted }}> {t("positions.reduceOnly")}</Text> : null}
        </Text>
        <Text style={[styles.rowSub, { color: theme.muted }]}>
          {t("positions.twapProgress", { done: twap.executedSz, total: twap.sz, pct, ntl: Math.round(twap.executedNtl), minutes: twap.minutes })}
        </Text>
      </View>
      <View style={styles.rowRight}>
        {onCancel ? (
          <Pressable
            accessibilityRole="button"
            testID={`twap-cancel-${twap.twapId}`}
            onPress={() => onCancel(twap)}
            style={[styles.cancelBtn, { borderColor: theme.lineStrong }]}
          >
            <Text style={[styles.cancelText, { color: theme.down }]}>{t("positions.cancelOrder")}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  btn: { paddingHorizontal: 18, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  btnText: { fontFamily: fonts.display.bold, fontSize: 14 },
  msg: { fontFamily: fonts.body.regular, fontSize: 13, marginTop: 14 },
  firstTrade: { marginTop: 14, paddingVertical: 13, borderRadius: 12, alignItems: "center" },
  firstTradeText: { fontFamily: fonts.display.bold, fontSize: 15, letterSpacing: 0.3 },
  eqCard: { marginTop: 16, padding: 16 },
  eqTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  eqLabel: { fontFamily: fonts.body.regular, fontSize: 11 },
  eqPill: { fontFamily: fonts.mono.bold, fontSize: 9, letterSpacing: 0.4, borderWidth: 1, borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2, overflow: "hidden" },
  eqRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 14 },
  eqCell: { flex: 1 },
  eqCellLabel: { fontFamily: fonts.body.regular, fontSize: 10, marginBottom: 3 },
  eqCellValue: { fontFamily: fonts.mono.medium, fontSize: 13 },
  health: { marginTop: 14 },
  healthBar: { height: 6, borderRadius: 3, overflow: "hidden" },
  healthFill: { height: 6, borderRadius: 3 },
  healthRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 6 },
  healthLabel: { fontFamily: fonts.body.medium, fontSize: 10.5 },
  tabs: { flexDirection: "row", gap: 18, borderBottomWidth: 1, marginTop: 8, marginBottom: 6 },
  tabItem: { flexDirection: "row", alignItems: "center", gap: 6, paddingBottom: 8, borderBottomWidth: 2 },
  tab: { fontFamily: fonts.display.bold, fontSize: 12.5, letterSpacing: 0.3 },
  badge: { minWidth: 18, paddingHorizontal: 5, height: 16, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  badgeText: { fontFamily: fonts.mono.bold, fontSize: 10, letterSpacing: 0.2 },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 12, borderBottomWidth: 1 },
  rowCoin: { fontFamily: fonts.display.bold, fontSize: 14 },
  rowSub: { fontFamily: fonts.body.regular, fontSize: 11, marginTop: 3 },
  right: { alignItems: "flex-end" },
  rowRight: { flexDirection: "row", alignItems: "center", gap: 10 },
  cancelBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 7, borderWidth: 1 },
  cancelText: { fontFamily: fonts.display.bold, fontSize: 11.5, letterSpacing: 0.3 },
  rowVal: { fontFamily: fonts.mono.medium, fontSize: 13 },
});
