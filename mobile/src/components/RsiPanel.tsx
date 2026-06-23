import React from "react";
import { View, Text, StyleSheet } from "react-native";
import Svg, { Line, Path } from "react-native-svg";
import type { ThemeTokens } from "../theme/tokens";
import { fonts } from "../theme/fonts";
import { withAlpha } from "../theme/color";

const VIEW_W = 348;

/** RSI(14) sub-panel under the candle chart: 70/30 guide lines + the RSI line, latest value labelled. */
export function RsiPanel({
  values,
  theme,
  height = 56,
}: {
  values: (number | null)[];
  theme: ThemeTokens;
  height?: number;
}) {
  const points = values
    .map((v, i) => ({ v, i }))
    .filter((p) => p.v != null) as { v: number; i: number }[];
  if (points.length < 2) return <View testID="rsi-panel-empty" style={{ height }} />;
  const latest = points[points.length - 1].v;
  const x = (i: number) => (i / (values.length - 1)) * VIEW_W;
  const y = (v: number) => height - (v / 100) * height;
  const d = points.map((p, k) => `${k ? "L" : "M"}${x(p.i).toFixed(1)} ${y(p.v).toFixed(1)}`).join(" ");
  const line = latest >= 70 ? theme.down : latest <= 30 ? theme.up : theme.brand;

  return (
    <View testID="rsi-panel" style={[styles.wrap, { height: height + 16 }]}>
      <Text style={[styles.label, { color: theme.faint }]}>{`RSI ${latest.toFixed(1)}`}</Text>
      <Svg width="100%" height={height} viewBox={`0 0 ${VIEW_W} ${height}`} preserveAspectRatio="none">
        <Line x1={0} y1={y(70)} x2={VIEW_W} y2={y(70)} stroke={withAlpha(theme.down, 0.4)} strokeWidth={1} strokeDasharray="3 4" />
        <Line x1={0} y1={y(30)} x2={VIEW_W} y2={y(30)} stroke={withAlpha(theme.up, 0.4)} strokeWidth={1} strokeDasharray="3 4" />
        <Path d={d} fill="none" stroke={line} strokeWidth={1.4} />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: 10 },
  label: { fontFamily: fonts.mono.regular, fontSize: 9, marginBottom: 4 },
});
