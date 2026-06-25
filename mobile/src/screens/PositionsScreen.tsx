import React, { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, Pressable, ActivityIndicator } from "react-native";
import { useTheme } from "../theme/useTheme";
import { useEnvStore } from "../state/envStore";
import { useWalletStore } from "../state/walletStore";
import { PositionsService } from "../services/positionsData";
import { FillsService } from "../services/fillsData";
import { OrdersService } from "../services/ordersData";
import {
  createPositionsInfoClient,
  createFillsInfoClient,
  createOrdersInfoClient,
} from "../lib/hyperliquid/client";
import { useViewOnlyPortfolio, isValidAddress } from "../hooks/useViewOnlyPortfolio";
import { useUnconfirmedIntents } from "../hooks/useUnconfirmedIntents";
import { PositionRow } from "../components/PositionRow";
import { ScreenScaffold } from "../components/ScreenScaffold";
import { NetworkWarning } from "../components/NetworkWarning";
import { SurfaceCard } from "../components/SurfaceCard";
import { UnconfirmedBanner } from "../components/UnconfirmedBanner";
import { PriceText, formatPrice } from "../components/PriceText";
import { fonts } from "../theme/fonts";
import { withAlpha } from "../theme/color";
import { useT } from "../i18n/useT";
import type { TranslationKey } from "../i18n/messages";
import type { ThemeTokens } from "../theme/tokens";
import type { Fill, OpenOrder, AccountSummary } from "../lib/hyperliquid/types";

export interface PositionsScreenDeps {
  positions: PositionsService;
  fills: FillsService;
  orders: OrdersService;
}

type Tab = "positions" | "fills" | "orders";

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

  const services = useMemo<PositionsScreenDeps>(
    () =>
      deps ?? {
        positions: new PositionsService(createPositionsInfoClient(network)),
        fills: new FillsService(createFillsInfoClient(network)),
        orders: new OrdersService(createOrdersInfoClient(network)),
      },
    [deps, network],
  );

  const { portfolio, loading, error, load } = useViewOnlyPortfolio(services.positions);
  const { count: unconfirmedCount } = useUnconfirmedIntents();
  const [tab, setTab] = useState<Tab>("positions");
  const [fills, setFills] = useState<Fill[]>([]);
  const [orders, setOrders] = useState<OpenOrder[]>([]);

  const runQuery = useCallback(
    (addr: string) => {
      void load(addr);
      if (!isValidAddress(addr)) return;
      void services.fills.loadRecent(addr).then(setFills).catch(() => setFills([]));
      void services.orders.loadOpenOrders(addr).then(setOrders).catch(() => setOrders([]));
    },
    [load, services],
  );

  // Show the connected/view-only wallet's own positions automatically — Positions is always "your"
  // account, so there is no manual address entry. Never queries without a wallet (mode "none"); that
  // state is gated below.
  useEffect(() => {
    if (mode !== "none" && walletAddress && isValidAddress(walletAddress)) runQuery(walletAddress);
  }, [mode, walletAddress, runQuery]);

  const tabs: Array<[Tab, TranslationKey, number]> = [
    ["positions", "tab.positions", portfolio?.positions.length ?? 0],
    ["orders", "positions.tabOrders", orders.length],
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

      {error ? <Text style={[styles.msg, { color: theme.down }]}>{error}</Text> : null}
      {loading ? <ActivityIndicator color={theme.brand} style={{ marginTop: 16 }} /> : null}

      {portfolio ? (
        <>
          <EquityCard theme={theme} summary={portfolio.summary} />

          <View style={[styles.tabs, { borderBottomColor: theme.line }]}>
            {tabs.map(([key, labelKey, n]) => (
              <Pressable
                key={key}
                onPress={() => setTab(key)}
                accessibilityRole="button"
                accessibilityState={{ selected: tab === key }}
              >
                <Text
                  style={[
                    styles.tab,
                    {
                      color: tab === key ? theme.brand : theme.muted,
                      borderBottomColor: tab === key ? theme.brand : "transparent",
                    },
                  ]}
                >
                  {t(labelKey)} · {n}
                </Text>
              </Pressable>
            ))}
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
              portfolio.positions.map((p) => <PositionRow key={p.coin} position={p} theme={theme} />)
            )
          ) : null}

          {tab === "fills" ? (
            fills.length === 0 ? (
              <Text style={[styles.msg, { color: theme.muted }]}>{t("positions.emptyFills")}</Text>
            ) : (
              fills.map((f) => <FillRow key={`${f.tid}`} fill={f} theme={theme} />)
            )
          ) : null}

          {tab === "orders" ? (
            orders.length === 0 ? (
              <Text style={[styles.msg, { color: theme.muted }]}>{t("positions.emptyOrders")}</Text>
            ) : (
              orders.map((o) => <OrderRow key={`${o.oid}`} order={o} theme={theme} />)
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

function OrderRow({ order, theme }: { order: OpenOrder; theme: ThemeTokens }) {
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
      <View style={styles.right}>
        <Text style={[styles.rowVal, { color: theme.text }]}>{order.limitPx}</Text>
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
  tab: { fontFamily: fonts.display.bold, fontSize: 12.5, letterSpacing: 0.3, paddingBottom: 8, borderBottomWidth: 2 },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 12, borderBottomWidth: 1 },
  rowCoin: { fontFamily: fonts.display.bold, fontSize: 14 },
  rowSub: { fontFamily: fonts.body.regular, fontSize: 11, marginTop: 3 },
  right: { alignItems: "flex-end" },
  rowVal: { fontFamily: fonts.mono.medium, fontSize: 13 },
});
