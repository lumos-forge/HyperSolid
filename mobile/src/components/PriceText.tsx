import React from "react";
import { Text, StyleSheet } from "react-native";

export function formatPrice(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 4 });
}

export function formatPct(n: number): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

export function PriceText({ value, color }: { value: number; color: string }) {
  return <Text style={[styles.num, { color }]}>{formatPrice(value)}</Text>;
}

const styles = StyleSheet.create({
  num: { fontVariant: ["tabular-nums"], fontSize: 16, fontWeight: "500" },
});
