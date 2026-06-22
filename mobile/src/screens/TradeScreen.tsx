import React, { useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, TextInput, Pressable, Alert, ActivityIndicator } from "react-native";
import { useTheme } from "../theme/useTheme";
import { useWalletStore } from "../state/walletStore";
import { useEnvStore } from "../state/envStore";
import { useMarketStore } from "../state/marketStore";
import { useLedgerStore } from "../state/ledgerStore";
import { useExchangeStore } from "../state/exchangeStore";
import { createExchangeClient } from "../lib/hyperliquid/client";
import { buildAssetIndex } from "../lib/hyperliquid/assetId";
import { ScreenScaffold } from "../components/ScreenScaffold";
import { Pill } from "../components/Pill";
import type { LocalWalletService } from "../wallet/localWallet";
import type { OrderSide } from "../lib/hyperliquid/buildOrder";
import { validateOrder, rejectionMessage } from "../lib/hyperliquid/order";

export function TradeScreen() {
  const theme = useTheme();
  const mode = useWalletStore((s) => s.mode);
  const wallet = useWalletStore((s) => s.wallet);
  const network = useEnvStore((s) => s.network);
  const tickers = useMarketStore((s) => s.tickers);
  const ledger = useLedgerStore((s) => s.ledger);

  const [coin, setCoin] = useState("BTC");
  const [side, setSide] = useState<OrderSide>("buy");
  const [size, setSize] = useState("");
  const [price, setPrice] = useState("");
  const [busy, setBusy] = useState(false);
  // Reused on a retry so the same cloid dedupes; cleared when the order is edited or succeeds.
  const [retryCloid, setRetryCloid] = useState<`0x${string}` | null>(null);

  const ticker = tickers.find((t) => t.coin === coin.toUpperCase());
  const index = useMemo(() => {
    if (tickers.length === 0) return null;
    return buildAssetIndex({
      universe: tickers.map((t) => ({ name: t.coin, szDecimals: t.szDecimals, maxLeverage: t.maxLeverage })),
    });
  }, [tickers]);

  const client = useMemo(() => {
    if (mode !== "local" || !wallet) return null;
    const local = wallet as Partial<LocalWalletService>;
    if (typeof local.getViemAccount !== "function") return null;
    return createExchangeClient(network, local.getViemAccount());
  }, [mode, wallet, network]);

  // Wire the long-lived singleton ExchangeService to the persistent ledger; re-init when the
  // client/index/ledger change (the SAME ledger instance keeps cloid dedup working across submits).
  useEffect(() => {
    if (!client || !index) {
      useExchangeStore.getState().reset();
      return;
    }
    useExchangeStore.getState().init(client, index, ledger ?? undefined);
  }, [client, index, ledger]);

  const notional = (Number(size) || 0) * (Number(price) || 0);
  const canSubmit =
    mode === "local" && !!wallet && Number(size) > 0 && Number(price) > 0 && notional >= 10;

  // Editing the order means a new intent — drop any retry cloid so we never reuse it cross-order.
  function edit<T>(setter: (v: T) => void) {
    return (v: T) => {
      setRetryCloid(null);
      setter(v);
    };
  }

  async function onSubmit() {
    if (!wallet || mode !== "local" || !index) return;
    const svc = useExchangeStore.getState().service;
    if (!svc) return;
    const szDec = index.szDecimals(coin.toUpperCase()) ?? 2;
    const rej = validateOrder({ price: Number(price), size: Number(size), szDecimals: szDec });
    if (rej) {
      Alert.alert("订单无效", rejectionMessage(rej));
      return;
    }
    setBusy(true);
    try {
      // §6.2: placeOrder persists the (pending) cloid BEFORE signing and dedupes by cloid.
      const res = await svc.placeOrder({
        coin: coin.toUpperCase(),
        side,
        size: Number(size),
        price: Number(price),
        cloid: retryCloid ?? undefined,
      });
      if (res.ok) {
        setRetryCloid(null);
        const note = res.status?.message ?? "已提交";
        Alert.alert("下单成功", `${note} · cloid ${res.cloid.slice(0, 10)}…`);
        setSize("");
      } else {
        // Keep the cloid so the next attempt reuses it instead of orphaning a duplicate.
        if (res.cloid) setRetryCloid(res.cloid);
        Alert.alert("下单失败", res.error);
      }
    } catch (e) {
      Alert.alert("下单异常", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const networkPill = <Pill theme={theme} label={`◷ ${network.toUpperCase()}`} />;

  if (mode !== "local") {
    return (
      <ScreenScaffold theme={theme} statusTitle="HYPERSOLID" pill={networkPill} heading="交易 Trade">
        <Text style={[styles.msg, { color: theme.muted }]}>
          {mode === "viewOnly" ? "只读模式不能交易，请在「钱包」创建本地钱包。" : "请先在「钱包」连接钱包后交易。"}
        </Text>
      </ScreenScaffold>
    );
  }

  return (
    <ScreenScaffold theme={theme} statusTitle="HYPERSOLID" pill={networkPill} heading="交易 Trade">
      <Text style={[styles.net, { color: theme.muted }]}>网络：{network}（仅测试网可下真单）</Text>

      <View style={styles.sideRow}>
        {(["buy", "sell"] as const).map((s) => (
          <Pressable
            key={s}
            onPress={() => {
              setRetryCloid(null);
              setSide(s);
            }}
            accessibilityRole="button"
            style={[
              styles.sideBtn,
              { backgroundColor: side === s ? (s === "buy" ? theme.up : theme.down) : theme.surface, borderColor: theme.line },
            ]}
          >
            <Text style={{ color: side === s ? theme.bg : theme.text, fontWeight: "700" }}>
              {s === "buy" ? "买入 / 做多" : "卖出 / 做空"}
            </Text>
          </Pressable>
        ))}
      </View>

      <Field label="标的" value={coin} onChange={edit(setCoin)} theme={theme} autoCap testID="field-coin" />
      {ticker ? <Text style={[styles.hint, { color: theme.muted }]}>当前价 {ticker.midPx}</Text> : null}
      <Field label="数量" value={size} onChange={edit(setSize)} theme={theme} keyboard testID="field-size" />
      <Field label="价格" value={price} onChange={edit(setPrice)} theme={theme} keyboard testID="field-price" />

      <Text style={[styles.hint, { color: notional >= 10 ? theme.muted : theme.down }]}>
        名义价值 ${notional.toFixed(2)} {notional < 10 ? "（需 ≥ $10）" : ""}
      </Text>

      <Pressable
        disabled={!canSubmit || busy}
        onPress={onSubmit}
        accessibilityRole="button"
        testID="submit-order"
        style={[styles.submit, { backgroundColor: canSubmit ? theme.brand : theme.line }]}
      >
        {busy ? <ActivityIndicator color={theme.bg} /> : <Text style={[styles.submitText, { color: theme.bg }]}>提交订单</Text>}
      </Pressable>
    </ScreenScaffold>
  );
}

function Field({
  label,
  value,
  onChange,
  theme,
  keyboard,
  autoCap,
  testID,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  theme: { text: string; muted: string; line: string; surface: string };
  keyboard?: boolean;
  autoCap?: boolean;
  testID?: string;
}) {
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: theme.muted }]}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        testID={testID}
        keyboardType={keyboard ? "decimal-pad" : "default"}
        autoCapitalize={autoCap ? "characters" : "none"}
        style={[styles.input, { color: theme.text, borderColor: theme.line, backgroundColor: theme.surface }]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  msg: { fontSize: 14, marginTop: 10 },
  net: { fontSize: 12, marginBottom: 14 },
  sideRow: { flexDirection: "row", gap: 10, marginBottom: 14 },
  sideBtn: { flex: 1, paddingVertical: 12, borderRadius: 8, alignItems: "center", borderWidth: 1 },
  field: { marginBottom: 12 },
  label: { fontSize: 11, marginBottom: 4 },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
  hint: { fontSize: 12, marginBottom: 10 },
  submit: { paddingVertical: 15, borderRadius: 10, alignItems: "center", marginTop: 10 },
  submitText: { fontSize: 16, fontWeight: "700" },
});
