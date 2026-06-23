import React from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
import type { MarketTicker } from "../lib/hyperliquid/types";
import type { ThemeTokens } from "../theme/tokens";
import { fonts } from "../theme/fonts";
import { PriceText } from "./PriceText";
import { ChangeText } from "./ChangeText";
import { Icon } from "./Icon";

/** Compact 24h notional volume, e.g. 2.75B / 606.50M / 35.53K. */
export function formatVol(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return n.toFixed(2).replace(/\.00$/, "");
}

export function MarketRow({
  ticker,
  theme,
  onPress,
  isFavorite,
  onToggleFavorite,
}: {
  ticker: MarketTicker;
  theme: ThemeTokens;
  onPress?: () => void;
  isFavorite?: boolean;
  onToggleFavorite?: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={[styles.row, { borderBottomColor: theme.line }]}>
      <View style={styles.left}>
        {onToggleFavorite && (
          <Pressable
            onPress={onToggleFavorite}
            accessibilityRole="button"
            accessibilityLabel={`favorite-${ticker.coin}`}
            hitSlop={8}
            style={styles.star}
          >
            <Icon
              name="star"
              active={isFavorite}
              color={isFavorite ? theme.brand : theme.faint}
              size={18}
            />
          </Pressable>
        )}
        <View>
          <View style={styles.tickRow}>
            <Text style={[styles.coin, { color: theme.text }]}>{ticker.coin}</Text>
            <Text style={[styles.perp, { color: theme.faint, borderColor: theme.lineStrong }]}>
              PERP
            </Text>
          </View>
          <Text style={[styles.sub, { color: theme.muted }]}>
            {`Fund ${(ticker.funding * 100).toFixed(4)}% · Vol ${formatVol(ticker.dayNtlVlm)}`}
          </Text>
        </View>
      </View>
      <View style={styles.right}>
        <PriceText value={ticker.midPx} color={theme.text} />
        <ChangeText theme={theme} value={ticker.changePct} size={11.5} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 13,
    borderBottomWidth: 1,
  },
  left: { flexDirection: "row", alignItems: "center" },
  star: { marginRight: 10, alignItems: "center", justifyContent: "center" },
  tickRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  coin: { fontFamily: fonts.display.bold, fontSize: 15 },
  perp: {
    fontFamily: fonts.mono.bold,
    fontSize: 8,
    letterSpacing: 0.4,
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 1,
    overflow: "hidden",
  },
  sub: { fontFamily: fonts.body.regular, fontSize: 11, marginTop: 4 },
  right: { alignItems: "flex-end", gap: 4 },
});
