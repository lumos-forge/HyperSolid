import React, { useCallback, useMemo, useState } from "react";
import { View, Text, StyleSheet, TextInput, Pressable, ActivityIndicator } from "react-native";
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
import { Pill } from "../components/Pill";
import { UnconfirmedBanner } from "../components/UnconfirmedBanner";
import { Icon } from "../components/Icon";
import { formatCompact } from "../lib/hyperliquid/format";
import type { ThemeTokens } from "../theme/tokens";
import type { Fill, OpenOrder } from "../lib/hyperliquid/types";

export interface PositionsScreenDeps {
  positions: PositionsService;
  fills: FillsService;
  orders: OrdersService;
}

type Tab = "positions" | "fills" | "orders";

export function PositionsScreen({ deps }: { deps?: PositionsScreenDeps } = {}) {
  const theme = useTheme();
  const network = useEnvStore((s) => s.network);
  const walletAddress = useWalletStore((s) => s.address);

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
  const [address, setAddress] = useState(walletAddress ?? "");
  const [tab, setTab] = useState<Tab>("positions");
  const [fills, setFills] = useState<Fill[]>([]);
  const [orders, setOrders] = useState<OpenOrder[]>([]);

  const onQuery = useCallback(() => {
    const addr = address.trim();
    void load(addr);
    if (!isValidAddress(addr)) return;
    void services.fills.loadRecent(addr).then(setFills).catch(() => setFills([]));
    void services.orders.loadOpenOrders(addr).then(setOrders).catch(() => setOrders([]));
  }, [address, load, services]);

  const pnlColor = (portfolio?.summary.totalUnrealizedPnl ?? 0) >= 0 ? theme.up : theme.down;

  return (
    <ScreenScaffold
      theme={theme}
      statusTitle="HYPERSOLID"
      pill={<Pill theme={theme} label={`◷ ${network.toUpperCase()}`} />}
      heading="持仓 Positions"
    >
      <UnconfirmedBanner theme={theme} count={unconfirmedCount} />
      <View style={[styles.banner, { borderColor: theme.line }]}>
        <Icon name="eye" color={theme.muted} size={16} />
        <Text style={[styles.bannerText, { color: theme.muted }]}>
          view-only 预览：输入任意地址查看其持仓（零私钥）。连接钱包后将自动填充本人地址。
        </Text>
      </View>

      <View style={styles.inputRow}>
        <TextInput
          value={address}
          onChangeText={setAddress}
          placeholder="0x… 钱包地址"
          placeholderTextColor={theme.muted}
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.input, { color: theme.text, borderColor: theme.line, backgroundColor: theme.surface }]}
        />
        <Pressable onPress={onQuery} accessibilityRole="button" style={[styles.btn, { backgroundColor: theme.brand }]}>
          <Text style={[styles.btnText, { color: theme.bg }]}>查询</Text>
        </Pressable>
      </View>

      {error ? <Text style={[styles.msg, { color: theme.down }]}>{error}</Text> : null}
      {loading ? <ActivityIndicator color={theme.brand} style={{ marginTop: 16 }} /> : null}

      {portfolio ? (
        <>
          <View style={[styles.summary, { borderColor: theme.line }]}>
            <Summary label="账户权益" value={`$${formatCompact(portfolio.summary.accountValue)}`} theme={theme} />
            <Summary label="可提现" value={`$${formatCompact(portfolio.summary.withdrawable)}`} theme={theme} />
            <Summary
              label="未实现盈亏"
              value={`${portfolio.summary.totalUnrealizedPnl >= 0 ? "+" : ""}${portfolio.summary.totalUnrealizedPnl.toFixed(2)}`}
              color={pnlColor}
              theme={theme}
            />
          </View>

          <View style={styles.tabs}>
            {([
              ["positions", "持仓"],
              ["fills", "成交"],
              ["orders", "订单"],
            ] as [Tab, string][]).map(([key, label]) => (
              <Pressable
                key={key}
                onPress={() => setTab(key)}
                accessibilityRole="button"
                style={[styles.tab, { borderBottomColor: tab === key ? theme.brand : "transparent" }]}
              >
                <Text style={{ color: tab === key ? theme.text : theme.muted, fontWeight: "700", fontSize: 13 }}>
                  {label}
                </Text>
              </Pressable>
            ))}
          </View>

          {tab === "positions" ? (
            portfolio.positions.length === 0 ? (
              <Text style={[styles.msg, { color: theme.muted }]}>该地址暂无持仓</Text>
            ) : (
              portfolio.positions.map((p) => <PositionRow key={p.coin} position={p} theme={theme} />)
            )
          ) : null}

          {tab === "fills" ? (
            fills.length === 0 ? (
              <Text style={[styles.msg, { color: theme.muted }]}>暂无成交</Text>
            ) : (
              fills.map((f) => <FillRow key={`${f.tid}`} fill={f} theme={theme} />)
            )
          ) : null}

          {tab === "orders" ? (
            orders.length === 0 ? (
              <Text style={[styles.msg, { color: theme.muted }]}>暂无挂单</Text>
            ) : (
              orders.map((o) => <OrderRow key={`${o.oid}`} order={o} theme={theme} />)
            )
          ) : null}
        </>
      ) : null}
    </ScreenScaffold>
  );
}

function FillRow({ fill, theme }: { fill: Fill; theme: ThemeTokens }) {
  const sideColor = fill.side === "buy" ? theme.up : theme.down;
  return (
    <View style={[styles.row, { borderBottomColor: theme.line }]}>
      <View>
        <Text style={[styles.rowCoin, { color: theme.text }]}>
          {fill.coin} <Text style={{ color: sideColor }}>{fill.side === "buy" ? "买" : "卖"}</Text>
        </Text>
        <Text style={[styles.rowSub, { color: theme.muted }]}>{fill.dir}</Text>
      </View>
      <View style={styles.right}>
        <Text style={[styles.rowVal, { color: theme.text }]}>{`${fill.sz} @ ${fill.px}`}</Text>
        <Text style={[styles.rowSub, { color: theme.muted }]}>{`费 ${fill.fee} ${fill.feeToken}`}</Text>
      </View>
    </View>
  );
}

function OrderRow({ order, theme }: { order: OpenOrder; theme: ThemeTokens }) {
  const sideColor = order.side === "buy" ? theme.up : theme.down;
  return (
    <View style={[styles.row, { borderBottomColor: theme.line }]}>
      <View>
        <Text style={[styles.rowCoin, { color: theme.text }]}>
          {order.coin} <Text style={{ color: sideColor }}>{order.side === "buy" ? "买" : "卖"}</Text>
          {order.reduceOnly ? <Text style={{ color: theme.muted }}> 只减仓</Text> : null}
        </Text>
        <Text style={[styles.rowSub, { color: theme.muted }]}>{`挂单 ${order.sz}/${order.origSz}`}</Text>
      </View>
      <View style={styles.right}>
        <Text style={[styles.rowVal, { color: theme.text }]}>{order.limitPx}</Text>
      </View>
    </View>
  );
}

function Summary({
  label,
  value,
  color,
  theme,
}: {
  label: string;
  value: string;
  color?: string;
  theme: { muted: string; text: string };
}) {
  return (
    <View style={styles.summaryCell}>
      <Text style={[styles.summaryLabel, { color: theme.muted }]}>{label}</Text>
      <Text style={[styles.summaryValue, { color: color ?? theme.text }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: { flexDirection: "row", alignItems: "flex-start", gap: 8, borderWidth: 1, borderRadius: 8, padding: 10, marginBottom: 12 },
  bannerText: { flex: 1, fontSize: 12, lineHeight: 18 },
  inputRow: { flexDirection: "row", gap: 8 },
  input: { flex: 1, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 13 },
  btn: { paddingHorizontal: 18, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  btnText: { fontSize: 14, fontWeight: "700" },
  msg: { fontSize: 13, marginTop: 14 },
  summary: { flexDirection: "row", borderWidth: 1, borderRadius: 10, padding: 12, marginTop: 16, marginBottom: 8 },
  summaryCell: { flex: 1 },
  summaryLabel: { fontSize: 10, marginBottom: 3 },
  summaryValue: { fontSize: 15, fontWeight: "700", fontVariant: ["tabular-nums"] },
  tabs: { flexDirection: "row", gap: 18, marginTop: 6, marginBottom: 4 },
  tab: { paddingVertical: 8, borderBottomWidth: 2 },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 12, borderBottomWidth: 1 },
  rowCoin: { fontSize: 14, fontWeight: "700" },
  rowSub: { fontSize: 11, marginTop: 3 },
  right: { alignItems: "flex-end" },
  rowVal: { fontSize: 13, fontVariant: ["tabular-nums"] },
});
