import React from "react";
import { View, Text, StyleSheet } from "react-native";
import type { ThemeTokens } from "../theme/tokens";
import { fonts } from "../theme/fonts";
import { withAlpha } from "../theme/color";
import { useT } from "../i18n/useT";

/**
 * Top-of-book bid/ask depth skew. Labelled "Book imbalance" so it is NOT mistaken for a
 * trader long/short ratio (which Hyperliquid's public API does not expose).
 */
export function BookImbalanceBar({
  theme,
  bidPct,
  askPct,
}: {
  theme: ThemeTokens;
  bidPct: number;
  askPct: number;
}) {
  const t = useT();
  return (
    <View style={styles.wrap}>
      <View style={styles.head}>
        <Text style={[styles.caption, { color: theme.faint }]}>{t("detail.bookImbalance")}</Text>
        <View style={styles.legend}>
          <Text style={[styles.pct, { color: theme.up }]}>{`B ${bidPct.toFixed(1)}%`}</Text>
          <Text style={[styles.pct, { color: theme.down }]}>{`${askPct.toFixed(1)}% A`}</Text>
        </View>
      </View>
      <View style={[styles.bar, { backgroundColor: withAlpha(theme.down, 0.25) }]}>
        <View style={[styles.fill, { width: `${bidPct}%`, backgroundColor: theme.up }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: 12 },
  head: { flexDirection: "row", justifyContent: "space-between", marginBottom: 6 },
  caption: { fontFamily: fonts.body.regular, fontSize: 10.5 },
  legend: { flexDirection: "row", gap: 10 },
  pct: { fontFamily: fonts.mono.bold, fontSize: 10.5 },
  bar: { height: 6, borderRadius: 3, overflow: "hidden" },
  fill: { height: 6 },
});
