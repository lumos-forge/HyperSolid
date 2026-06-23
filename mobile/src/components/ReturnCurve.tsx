import React from "react";
import { View } from "react-native";
import Svg, { Path } from "react-native-svg";
import type { ThemeTokens } from "../theme/tokens";
import { withAlpha } from "../theme/color";

const VIEW_W = 300;

/**
 * Cumulative-return area+line spark for the strategy hero. Pure SVG: a translucent fill under a
 * solid line, tinted from a single token (`color`). Points are normalized 0..1 (bottom..top).
 */
export function ReturnCurve({
  points,
  theme,
  color,
  height = 46,
}: {
  points: number[];
  theme: ThemeTokens;
  color: string;
  height?: number;
}) {
  if (points.length < 2) {
    return <View testID="return-curve-empty" style={{ height }} />;
  }
  const x = (i: number) => (i / (points.length - 1)) * VIEW_W;
  const y = (v: number) => height - Math.max(0, Math.min(1, v)) * (height - 6) - 3;
  const line = points.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const area = `M0 ${height} ${points.map((v, i) => `L${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ")} L${VIEW_W} ${height} Z`;

  return (
    <View testID="return-curve" style={{ height }}>
      <Svg width="100%" height={height} viewBox={`0 0 ${VIEW_W} ${height}`} preserveAspectRatio="none">
        <Path d={area} fill={withAlpha(color, 0.15)} />
        <Path d={line} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" />
      </Svg>
    </View>
  );
}
