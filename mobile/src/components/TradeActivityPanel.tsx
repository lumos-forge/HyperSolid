import React, { useEffect, useMemo, useState } from "react";
import { View, Text, Pressable, ScrollView, StyleSheet } from "react-native";
import type { ThemeTokens } from "../theme/tokens";
import type { Network } from "../state/envStore";
import type { AccountSummary, Position, OpenOrder, Fill, FundingEvent } from "../lib/hyperliquid/types";
import { fonts } from "../theme/fonts";
import { withAlpha } from "../theme/color";
import { useT } from "../i18n/useT";
import type { TranslationKey } from "../i18n/messages";
import { PositionRow } from "./PositionRow";
import { LoadError } from "./LoadError";
import { classifyFetchError, type FetchErrorCode } from "../lib/errorMessage";
import { PositionsService } from "../services/positionsData";
import { OrdersService } from "../services/ordersData";
import { FillsService } from "../services/fillsData";
import { FundingsService } from "../services/fundingsData";
import {
  createPositionsInfoClient,
  createOrdersInfoClient,
  createFillsInfoClient,
  createFundingsInfoClient,
} from "../lib/hyperliquid/client";
import { isValidAddress } from "../hooks/useViewOnlyPortfolio";

type Tab = "positions" | "balance" | "orders" | "twap" | "fills" | "funding";

const TABS: Array<[Tab, TranslationKey]> = [
  ["positions", "tab.positions"],
  ["balance", "trade.tabBalance"],
  ["orders", "positions.tabOrders"],
  ["twap", "trade.tabTwap"],
  ["fills", "positions.tabHistory"],
  ["funding", "trade.tabFunding"],
];

/**
 * HL-mobile bottom activity panel for the Trade screen: 持仓/余额/当前委托/TWAP/交易历史/资金费历史.
 * Loads the connected wallet's data (mirrors the standalone Positions tab; duplication accepted).
 */
export function TradeActivityPanel({
  theme,
  address,
  network,
}: {
  theme: ThemeTokens;
  address: string | null;
  network: Network;
}) {
  const t = useT();
  const [tab, setTab] = useState<Tab>("positions");
  const [summary, setSummary] = useState<AccountSummary | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [orders, setOrders] = useState<OpenOrder[]>([]);
  const [fills, setFills] = useState<Fill[]>([]);
  const [funding, setFunding] = useState<FundingEvent[]>([]);
  const [error, setError] = useState<FetchErrorCode | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  const svc = useMemo(
    () => ({
      positions: new PositionsService(createPositionsInfoClient(network)),
      orders: new OrdersService(createOrdersInfoClient(network)),
      fills: new FillsService(createFillsInfoClient(network)),
      fundings: new FundingsService(createFundingsInfoClient(network)),
    }),
    [network],
  );

  useEffect(() => {
    if (!address || !isValidAddress(address)) {
      setSummary(null);
      setPositions([]);
      setOrders([]);
      setFills([]);
      setFunding([]);
      return;
    }
    let active = true;
    setError(null);
    // The portfolio load drives positions + balance; its failure is the panel's error signal so we
    // can show a compact retry instead of blank rows. Secondary feeds degrade to empty on failure.
    svc.positions
      .loadPortfolio(address)
      .then((p) => active && (setSummary(p.summary), setPositions(p.positions)))
      .catch((e) => active && setError(classifyFetchError(e)));
    svc.orders.loadOpenOrders(address).then((o) => active && setOrders(o)).catch(() => {});
    svc.fills.loadRecent(address).then((f) => active && setFills(f)).catch(() => {});
    svc.fundings.load(address, 0).then((f) => active && setFunding(f)).catch(() => {});
    return () => {
      active = false;
    };
  }, [svc, address, retryNonce]);

  const counts: Record<Tab, number | null> = {
    positions: positions.length,
    balance: null,
    orders: orders.length,
    twap: 0,
    fills: fills.length,
    funding: funding.length,
  };

  return (
    <View style={[styles.wrap, { borderTopColor: theme.line }]}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabsScroll} contentContainerStyle={styles.tabs}>
        {TABS.map(([key, labelKey]) => {
          const active = tab === key;
          const n = counts[key];
          return (
            <Pressable
              key={key}
              testID={`activity-tab-${key}`}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              onPress={() => setTab(key)}
              style={[styles.tabItem, { borderBottomColor: active ? theme.brand : "transparent" }]}
            >
              <Text style={[styles.tab, { color: active ? theme.brand : theme.muted }]}>{t(labelKey)}</Text>
              {n != null && n > 0 ? (
                <View style={[styles.badge, { backgroundColor: withAlpha(active ? theme.brand : theme.muted, 0.16) }]}>
                  <Text style={[styles.badgeText, { color: active ? theme.brand : theme.muted }]}>{n}</Text>
                </View>
              ) : null}
            </Pressable>
          );
        })}
      </ScrollView>

      <View style={styles.body}>
        {error && summary === null ? (
          <LoadError theme={theme} code={error} compact onRetry={() => setRetryNonce((n) => n + 1)} testID="activity-error" />
        ) : null}
        {tab === "positions" ? (
          positions.length === 0 ? (
            <Empty theme={theme} label={t("positions.emptyPositions")} />
          ) : (
            positions.map((p) => <PositionRow key={p.coin} position={p} theme={theme} />)
          )
        ) : null}

        {tab === "balance" ? (
          <View>
            <BalRow theme={theme} label={t("trade.perp")} value={summary ? `${summary.accountValue.toFixed(2)} USDC` : "—"} />
            <BalRow theme={theme} label={t("positions.available")} value={summary ? `${summary.withdrawable.toFixed(2)} USDC` : "—"} />
            <BalRow theme={theme} label={t("trade.spot")} value="0.00 USDC" />
          </View>
        ) : null}

        {tab === "orders" ? (
          orders.length === 0 ? (
            <Empty theme={theme} label={t("positions.emptyOrders")} />
          ) : (
            orders.map((o) => (
              <Row
                key={o.oid}
                theme={theme}
                left={`${o.coin} ${t(o.side === "buy" ? "common.buy" : "common.sell")}`}
                sub={t("positions.filled", { filled: o.sz, total: o.origSz })}
                right={String(o.limitPx)}
                color={o.side === "buy" ? theme.up : theme.down}
              />
            ))
          )
        ) : null}

        {tab === "twap" ? <Empty theme={theme} label={t("trade.noTwap")} /> : null}

        {tab === "fills" ? (
          fills.length === 0 ? (
            <Empty theme={theme} label={t("positions.emptyFills")} />
          ) : (
            fills.map((f) => (
              <Row
                key={String(f.tid)}
                theme={theme}
                left={`${f.coin} ${t(f.side === "buy" ? "common.buy" : "common.sell")}`}
                sub={f.dir}
                right={`${f.sz} @ ${f.px}`}
                color={f.side === "buy" ? theme.up : theme.down}
              />
            ))
          )
        ) : null}

        {tab === "funding" ? (
          funding.length === 0 ? (
            <Empty theme={theme} label={t("trade.noFunding")} />
          ) : (
            funding.map((f, i) => (
              <Row
                key={`${f.time}-${i}`}
                theme={theme}
                left={f.coin}
                sub={new Date(f.time).toLocaleString()}
                right={`${f.usdc >= 0 ? "+" : ""}${f.usdc.toFixed(4)} USDC`}
                color={f.usdc >= 0 ? theme.up : theme.down}
              />
            ))
          )
        ) : null}
      </View>
    </View>
  );
}

function Empty({ theme, label }: { theme: ThemeTokens; label: string }) {
  return <Text style={[styles.empty, { color: theme.muted }]}>{label}</Text>;
}

function BalRow({ theme, label, value }: { theme: ThemeTokens; label: string; value: string }) {
  return (
    <View style={[styles.balRow, { borderBottomColor: theme.line }]}>
      <Text style={[styles.balLabel, { color: theme.muted }]}>{label}</Text>
      <Text style={[styles.balValue, { color: theme.text }]}>{value}</Text>
    </View>
  );
}

function Row({ theme, left, sub, right, color }: { theme: ThemeTokens; left: string; sub: string; right: string; color: string }) {
  return (
    <View style={[styles.row, { borderBottomColor: theme.line }]}>
      <View style={styles.rowMain}>
        <Text style={[styles.rowTitle, { color }]}>{left}</Text>
        <Text style={[styles.rowSub, { color: theme.muted }]}>{sub}</Text>
      </View>
      <Text style={[styles.rowRight, { color: theme.text }]}>{right}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderTopWidth: 1, marginTop: 18, paddingTop: 10 },
  tabsScroll: { marginBottom: 8 },
  tabs: { flexDirection: "row", gap: 16, paddingRight: 16 },
  tabItem: { flexDirection: "row", alignItems: "center", gap: 6, paddingBottom: 7, borderBottomWidth: 2 },
  tab: { fontFamily: fonts.display.bold, fontSize: 12.5, letterSpacing: 0.2 },
  badge: { minWidth: 18, paddingHorizontal: 5, height: 16, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  badgeText: { fontFamily: fonts.mono.bold, fontSize: 10, letterSpacing: 0.2 },
  body: { minHeight: 80 },
  empty: { fontFamily: fonts.body.regular, fontSize: 13, paddingVertical: 18 },
  balRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 12, borderBottomWidth: 1 },
  balLabel: { fontFamily: fonts.body.regular, fontSize: 13 },
  balValue: { fontFamily: fonts.mono.medium, fontSize: 13 },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 11, borderBottomWidth: 1 },
  rowMain: { flex: 1 },
  rowTitle: { fontFamily: fonts.display.bold, fontSize: 13.5 },
  rowSub: { fontFamily: fonts.body.regular, fontSize: 11, marginTop: 3 },
  rowRight: { fontFamily: fonts.mono.medium, fontSize: 13 },
});
