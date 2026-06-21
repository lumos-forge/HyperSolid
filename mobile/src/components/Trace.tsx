import React, { useMemo } from "react";
import { View, StyleSheet } from "react-native";
import Svg, { Path } from "react-native-svg";
import type { ThemeTokens } from "../theme/tokens";

function wavePath(w: number, h: number, amp: number, seed: number): string {
  let d = `M0 ${h / 2}`;
  const n = 64;
  for (let i = 1; i <= n; i++) {
    const x = (i / n) * w;
    const s =
      Math.sin(i * 0.55 + seed) * amp * 0.6 +
      Math.sin(i * 0.17 + seed * 2) * amp * 0.4 +
      Math.sin(i * 1.9 + seed) * amp * 0.15;
    d += ` L${x.toFixed(1)} ${(h / 2 - s).toFixed(1)}`;
  }
  return d;
}

/** Phosphor waveform header — the signature element of the oscilloscope house style. */
export function Trace({
  theme,
  amp = 6,
  seed = 0.4,
  height = 30,
}: {
  theme: ThemeTokens;
  amp?: number;
  seed?: number;
  height?: number;
}) {
  const d = useMemo(() => wavePath(320, height, amp, seed), [height, amp, seed]);
  return (
    <View
      testID="trace"
      style={[styles.wrap, { height, backgroundColor: theme.surface, borderBottomColor: theme.line }]}
    >
      <Svg width="100%" height={height} viewBox={`0 0 320 ${height}`} preserveAspectRatio="none">
        <Path d={d} fill="none" stroke={theme.brand} strokeWidth={3} opacity={0.28} />
        <Path d={d} fill="none" stroke={theme.brand} strokeWidth={1.2} />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { width: "100%", borderBottomWidth: 1 },
});
