import React from "react";
import { View, Text, StyleSheet, ActivityIndicator } from "react-native";
import type { ThemeTokens } from "../theme/tokens";

type Kind = "loading" | "empty" | "error";

export function StateView({
  kind,
  message,
  theme,
}: {
  kind: Kind;
  message: string;
  theme: ThemeTokens;
}) {
  return (
    <View style={styles.container} accessibilityRole="text">
      {kind === "loading" && <ActivityIndicator color={theme.brand} />}
      <Text style={[styles.msg, { color: kind === "error" ? theme.down : theme.muted }]}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: "center", justifyContent: "center", padding: 32 },
  msg: { fontSize: 14, marginTop: 10, textAlign: "center" },
});
