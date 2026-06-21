import React from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
import type { MarketTicker } from "../lib/hyperliquid/types";
import type { ThemeTokens } from "../theme/tokens";
import { PriceText, formatPct } from "./PriceText";
import { Icon } from "./Icon";

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
  const dirColor = ticker.changePct >= 0 ? theme.up : theme.down;
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
              color={isFavorite ? theme.brand : theme.muted}
              size={20}
            />
          </Pressable>
        )}
        <View>
          <Text style={[styles.coin, { color: theme.text }]}>{ticker.coin}</Text>
          <Text style={[styles.sub, { color: theme.muted }]}>
            {`funding ${(ticker.funding * 100).toFixed(3)}%`}
          </Text>
        </View>
      </View>
      <View style={styles.right}>
        <PriceText value={ticker.midPx} color={theme.text} />
        <Text style={[styles.chg, { color: dirColor }]}>{formatPct(ticker.changePct)}</Text>
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
  coin: { fontSize: 16, fontWeight: "700" },
  sub: { fontSize: 11, marginTop: 3 },
  right: { alignItems: "flex-end" },
  chg: { fontSize: 12, marginTop: 3, fontVariant: ["tabular-nums"] },
});
