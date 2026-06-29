import React from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
import type { Position } from "../lib/hyperliquid/types";
import type { ThemeTokens } from "../theme/tokens";
import { SurfaceCard } from "./SurfaceCard";
import { ChangeText } from "./ChangeText";
import { formatPrice } from "./PriceText";
import { fonts } from "../theme/fonts";
import { withAlpha } from "../theme/color";
import { useT } from "../i18n/useT";

/** v8 position card: header (coin · PERP · Long/Short tag · ▲▼ PnL) + Size/Entry/Mark/ROE grid. */
export function PositionRow({
  position,
  theme,
  onClose,
}: {
  position: Position;
  theme: ThemeTokens;
  /** One-tap market reduce-only close (fraction = 25/50/75/100% of size); confirmed by caller. */
  onClose?: (position: Position, fraction: number) => void;
}) {
  const t = useT();
  const up = position.unrealizedPnl >= 0;
  const dir = up ? theme.up : theme.down;
  const sideColor = position.side === "long" ? theme.up : theme.down;
  const roe = position.marginUsed ? (position.unrealizedPnl / position.marginUsed) * 100 : 0;
  const mark = position.size ? position.positionValue / position.size : 0;
  const pnl = `${up ? "▲ " : "▼ "}${up ? "+" : ""}${position.unrealizedPnl.toFixed(2)} USDC`;

  const cell = (label: string, value: string, color?: string) => (
    <View style={styles.cell}>
      <Text style={[styles.gl, { color: theme.faint }]}>{label}</Text>
      <Text style={[styles.gv, { color: color ?? theme.text }]}>{value}</Text>
    </View>
  );

  return (
    <SurfaceCard theme={theme} rule={false} style={styles.card}>
      <View style={styles.head}>
        <Text style={[styles.coin, { color: theme.text }]}>
          {position.coin}
          <Text style={[styles.perp, { color: theme.faint }]}> PERP</Text>
        </Text>
        <Text
          style={[
            styles.tag,
            { color: sideColor, backgroundColor: withAlpha(sideColor, 0.13) },
          ]}
        >
          {position.side === "long" ? t("positions.long") : t("positions.short")} · {position.leverage}×
        </Text>
        <Text style={[styles.pnl, { color: dir }]}>{pnl}</Text>
      </View>
      <View style={styles.grid}>
        {cell(t("positions.colSize"), String(position.size))}
        {cell(t("positions.colEntry"), formatPrice(position.entryPx))}
        {cell(t("detail.mark"), formatPrice(mark))}
        <View style={styles.cell}>
          <Text style={[styles.gl, { color: theme.faint }]}>ROE</Text>
          <ChangeText theme={theme} value={roe} size={12} showArrow={false} />
        </View>
      </View>
      {onClose ? (
        <View style={[styles.actions, { borderTopColor: theme.line }]}>
          {[25, 50, 75].map((pct) => (
            <Pressable
              key={pct}
              accessibilityRole="button"
              testID={`reduce-${position.coin}-${pct}`}
              onPress={() => onClose(position, pct)}
              style={[styles.reduceBtn, { borderColor: theme.lineStrong }]}
            >
              <Text style={[styles.reduceText, { color: theme.text }]}>{pct}%</Text>
            </Pressable>
          ))}
          <Pressable
            accessibilityRole="button"
            testID={`close-${position.coin}`}
            onPress={() => onClose(position, 100)}
            style={[styles.closeBtn, { backgroundColor: withAlpha(theme.brand, 0.16), borderColor: theme.brand }]}
          >
            <Text style={[styles.closeText, { color: theme.brand }]}>{t("positions.close")}</Text>
          </Pressable>
        </View>
      ) : null}
    </SurfaceCard>
  );
}

const styles = StyleSheet.create({
  card: { padding: 14, marginBottom: 10 },
  head: { flexDirection: "row", alignItems: "center", marginBottom: 12 },
  coin: { fontFamily: fonts.display.bold, fontSize: 14 },
  perp: { fontFamily: fonts.mono.bold, fontSize: 8, letterSpacing: 0.4 },
  tag: {
    fontFamily: fonts.mono.bold,
    fontSize: 9.5,
    letterSpacing: 0.3,
    borderRadius: 5,
    paddingHorizontal: 6,
    paddingVertical: 2,
    overflow: "hidden",
    marginLeft: 8,
  },
  pnl: { fontFamily: fonts.mono.bold, fontSize: 12.5, marginLeft: "auto" },
  grid: { flexDirection: "row", justifyContent: "space-between" },
  cell: { flex: 1 },
  gl: { fontFamily: fonts.body.regular, fontSize: 10, marginBottom: 3 },
  gv: { fontFamily: fonts.mono.medium, fontSize: 12.5 },
  actions: { flexDirection: "row", gap: 8, marginTop: 12, paddingTop: 12, borderTopWidth: 1 },
  reduceBtn: { flex: 1, paddingVertical: 8, borderRadius: 8, borderWidth: 1, alignItems: "center" },
  reduceText: { fontFamily: fonts.mono.medium, fontSize: 12 },
  closeBtn: { flex: 1.4, paddingVertical: 8, borderRadius: 8, borderWidth: 1, alignItems: "center" },
  closeText: { fontFamily: fonts.display.bold, fontSize: 12.5, letterSpacing: 0.3 },
});
