import React, { useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, ActivityIndicator } from "react-native";
import type { ThemeTokens } from "../theme/tokens";
import type { MarketTicker, Orderbook, Subscription } from "../lib/hyperliquid/types";
import { fonts } from "../theme/fonts";
import { useT } from "../i18n/useT";
import { DetailDataService } from "../services/detailData";
import { createDetailInfoClient, createDetailSubsClient } from "../lib/hyperliquid/client";
import { bookImbalance } from "../lib/hyperliquid/bookImbalance";
import { formatFundingPct } from "../lib/hyperliquid/format";
import { fundingCountdown } from "../lib/hyperliquid/fundingClock";
import { OrderbookView } from "./OrderbookView";
import { BookImbalanceBar } from "./BookImbalanceBar";

/**
 * Right-column live order book for the Trade ticket: funding rate + settlement countdown, an
 * 8-level book (tap a price to fill the limit field), and a bid/ask imbalance bar. Subscribes to
 * the L2 feed for the active coin; lighter than useLiveDetail (no candles/trades).
 */
export function OrderBookPanel({
  theme,
  coin,
  network,
  ticker,
  onPickPrice,
}: {
  theme: ThemeTokens;
  coin: string;
  network: "mainnet" | "testnet";
  ticker?: MarketTicker;
  onPickPrice?: (px: number) => void;
}) {
  const t = useT();
  const service = useMemo(
    () => new DetailDataService(createDetailInfoClient(network), createDetailSubsClient(network)),
    [network],
  );
  const [orderbook, setOrderbook] = useState<Orderbook | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let sub: Subscription | null = null;
    let cancelled = false;
    setOrderbook(null);
    service
      .subscribeOrderbook(coin, setOrderbook)
      .then((s) => {
        if (cancelled) void s.unsubscribe();
        else sub = s;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      sub?.unsubscribe().catch(() => {});
    };
  }, [service, coin]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const imbalance = orderbook ? bookImbalance(orderbook, 10) : { bidPct: 50, askPct: 50 };

  return (
    <View style={styles.wrap}>
      <Text style={[styles.fundingLabel, { color: theme.muted }]}>{t("trade.fundingRate")}</Text>
      <Text style={[styles.fundingValue, { color: theme.text }]}>
        {`${ticker ? formatFundingPct(ticker.funding) : "—"} · ${fundingCountdown(now)}`}
      </Text>
      {orderbook ? (
        <>
          <OrderbookView book={orderbook} theme={theme} compact onPickPrice={onPickPrice} />
          <View style={styles.imbalance}>
            <BookImbalanceBar theme={theme} bidPct={imbalance.bidPct} askPct={imbalance.askPct} compact />
          </View>
        </>
      ) : (
        <ActivityIndicator color={theme.brand} style={styles.loading} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  fundingLabel: { fontFamily: fonts.body.regular, fontSize: 10, marginBottom: 2 },
  fundingValue: { fontFamily: fonts.mono.medium, fontSize: 11.5, marginBottom: 10 },
  imbalance: { marginTop: 8 },
  loading: { marginTop: 30 },
});
