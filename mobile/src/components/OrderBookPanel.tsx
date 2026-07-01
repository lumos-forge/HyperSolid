import React, { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from "react-native";
import type { ThemeTokens } from "../theme/tokens";
import type { MarketTicker, Orderbook, Subscription, BookSigFigs } from "../lib/hyperliquid/types";
import { fonts } from "../theme/fonts";
import { useT } from "../i18n/useT";
import { DetailDataService } from "../services/detailData";
import { createDetailInfoClient, createDetailSubsClient } from "../lib/hyperliquid/client";
import { bookImbalance } from "../lib/hyperliquid/bookImbalance";
import { formatFundingPct } from "../lib/hyperliquid/format";
import { fundingCountdown } from "../lib/hyperliquid/fundingClock";
import { OrderbookView } from "./OrderbookView";
import { BookImbalanceBar } from "./BookImbalanceBar";
import { BookViewIcon, type BookView } from "./BookViewIcon";
import { Dropdown } from "./Dropdown";
import { LoadError } from "./LoadError";
import { classifyFetchError, type FetchErrorCode } from "../lib/errorMessage";
import { isMarketStale } from "../state/marketStore";

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
  onBook,
}: {
  theme: ThemeTokens;
  coin: string;
  network: "mainnet" | "testnet";
  ticker?: MarketTicker;
  onPickPrice?: (px: number) => void;
  onBook?: (book: Orderbook) => void;
}) {
  const t = useT();
  const service = useMemo(
    () => new DetailDataService(createDetailInfoClient(network), createDetailSubsClient(network)),
    [network],
  );
  const [orderbook, setOrderbook] = useState<Orderbook | null>(null);
  const [bookError, setBookError] = useState<FetchErrorCode | null>(null);
  const [lastBookAt, setLastBookAt] = useState(0);
  const [retryNonce, setRetryNonce] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [sizeInQuote, setSizeInQuote] = useState(true);
  // Surface the live book to the parent (for BBO pricing) without re-subscribing when the callback
  // identity changes.
  const onBookRef = useRef(onBook);
  onBookRef.current = onBook;
  useEffect(() => {
    if (orderbook) onBookRef.current?.(orderbook);
  }, [orderbook]);
  // Server-side book aggregation (HL nSigFigs). 5 = finest; lower = coarser tick, ALWAYS a full
  // ~20-level book (so changing it never collapses the ladder the way client-side bucketing did).
  const [nSigFigs, setNSigFigs] = useState<BookSigFigs>(5);
  // Order-book display mode (HL's red/green toggle): balanced shows equal asks/bids; bids/asks show
  // ONLY that side (full depth) while keeping the panel height stable.
  const [bookView, setBookView] = useState<BookView>("balanced");
  const askDepth = bookView === "asks" ? 18 : bookView === "bids" ? 0 : 9;
  const bidDepth = bookView === "bids" ? 18 : bookView === "asks" ? 0 : 9;

  // Clear the ladder only when the coin changes (a tick change keeps the old book visible until the
  // re-aggregated one arrives, avoiding a flicker).
  useEffect(() => {
    setOrderbook(null);
  }, [coin]);

  useEffect(() => {
    let sub: Subscription | null = null;
    let cancelled = false;
    setBookError(null);
    service
      .subscribeOrderbook(coin, (ob) => {
        setOrderbook(ob);
        setLastBookAt(Date.now());
      }, nSigFigs)
      .then((s) => {
        if (cancelled) void s.unsubscribe();
        else sub = s;
      })
      .catch((e) => {
        // Don't leave the panel spinning forever — record a code so the UI can offer Retry.
        if (!cancelled) setBookError(classifyFetchError(e));
      });
    return () => {
      cancelled = true;
      sub?.unsubscribe().catch(() => {});
    };
  }, [service, coin, nSigFigs, retryNonce]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const imbalance = orderbook ? bookImbalance(orderbook, 10) : { bidPct: 50, askPct: 50 };

  const mid = useMemo(() => {
    if (!orderbook || orderbook.asks.length === 0 || orderbook.bids.length === 0) return 0;
    return (orderbook.asks[0].px + orderbook.bids[0].px) / 2;
  }, [orderbook]);

  // Approximate price tick for each aggregation level, derived from the price magnitude: at k
  // significant figures the increment is ~10^(mag-(k-1)). Labelled numerically so the selector reads
  // "Tick 1 / 10 / 100 / 1000" rather than an opaque "Native".
  const tickOptions = useMemo(() => {
    const sigs: BookSigFigs[] = [5, 4, 3, 2];
    if (mid <= 0) return sigs.map((sig) => ({ value: String(sig), label: "—" }));
    const mag = Math.floor(Math.log10(mid));
    const fmt = (n: number) => (n < 1 ? String(Number(n.toPrecision(2))) : String(Math.round(n)));
    return sigs.map((sig) => ({ value: String(sig), label: fmt(Math.pow(10, mag - (sig - 1))) }));
  }, [mid]);

  const midColor = ticker ? (ticker.changePct >= 0 ? theme.up : theme.down) : undefined;
  // Book frozen (dropped/reconnecting socket) if no L2 update for a while; reuses the 1s `now` tick.
  const bookStale = isMarketStale(lastBookAt, now);

  return (
    <View style={styles.wrap}>
      <View style={styles.topRow}>
        <View style={styles.funding}>
          <Text style={[styles.fundingLabel, { color: theme.muted }]}>{t("trade.fundingRate")}</Text>
          <Text style={[styles.fundingValue, { color: theme.text }]} numberOfLines={1}>
            {ticker ? formatFundingPct(ticker.funding) : "—"}
          </Text>
          <Text style={[styles.fundingCountdown, { color: theme.muted }]} numberOfLines={1}>
            {fundingCountdown(now)}
          </Text>
        </View>
        <Pressable
          testID="book-size-unit"
          onPress={() => setSizeInQuote((v) => !v)}
          hitSlop={6}
          style={[styles.unitBtn, { borderColor: theme.line }]}
        >
          <Text style={[styles.unitText, { color: theme.muted }]}>{sizeInQuote ? "USDC" : coin}</Text>
        </Pressable>
      </View>
      {bookError && !orderbook ? (
        <LoadError theme={theme} code={bookError} compact onRetry={() => setRetryNonce((n) => n + 1)} testID="book-error" />
      ) : orderbook ? (
        <>
          {bookStale ? (
            <Text style={[styles.staleHint, { color: theme.warn }]} testID="book-stale">{t("common.reconnecting")}</Text>
          ) : null}
          <OrderbookView
            book={orderbook}
            theme={theme}
            coin={coin}
            compact
            askDepth={askDepth}
            bidDepth={bidDepth}
            sizeInQuote={sizeInQuote}
            midColor={midColor}
            onPickPrice={onPickPrice}
          />
          <View style={styles.imbalance}>
            <BookImbalanceBar theme={theme} bidPct={imbalance.bidPct} askPct={imbalance.askPct} compact />
          </View>
          <View style={styles.bottomRow}>
            <Dropdown
              testID="book-tick"
              value={String(nSigFigs)}
              compact
              fill
              options={tickOptions}
              onChange={(v) => setNSigFigs(Number(v) as BookSigFigs)}
            />
            <Pressable
              testID="book-view"
              accessibilityRole="button"
              hitSlop={6}
              onPress={() => setBookView((v) => (v === "balanced" ? "bids" : v === "bids" ? "asks" : "balanced"))}
              style={[styles.viewBtn, { borderColor: theme.line, backgroundColor: theme.surface }]}
            >
              <BookViewIcon theme={theme} mode={bookView} />
            </Pressable>
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
  topRow: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 10 },
  funding: { flex: 1 },
  fundingLabel: { fontFamily: fonts.body.regular, fontSize: 10, marginBottom: 2 },
  fundingValue: { fontFamily: fonts.mono.medium, fontSize: 11.5 },
  fundingCountdown: { fontFamily: fonts.mono.regular, fontSize: 10.5, marginTop: 1 },
  unitBtn: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2.5 },
  unitText: { fontFamily: fonts.mono.medium, fontSize: 10 },
  imbalance: { marginTop: 8 },
  bottomRow: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 8, marginTop: 10, zIndex: 30 },
  viewBtn: { width: 30, height: 30, borderRadius: 7, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  loading: { marginTop: 30 },
  staleHint: { fontFamily: fonts.body.semibold, fontSize: 10, textAlign: "center", paddingVertical: 3 },
});
