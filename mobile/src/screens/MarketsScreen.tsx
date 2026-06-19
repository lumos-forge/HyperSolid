import React from "react";
import { View, Text, StyleSheet, ActivityIndicator } from "react-native";
import { FlashList } from "@shopify/flash-list";
import { useMarketStore } from "../state/marketStore";
import { MarketRow } from "../components/MarketRow";
import { themes, defaultTheme } from "../theme/tokens";

export function MarketsScreen() {
  const theme = themes[defaultTheme];
  const { tickers, loading, error } = useMarketStore();

  return (
    <View style={[styles.container, { backgroundColor: theme.bg }]}>
      <Text style={[styles.title, { color: theme.text }]}>Markets</Text>
      {error ? (
        <Text style={[styles.msg, { color: theme.down }]}>{error}</Text>
      ) : loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.brand} />
          <Text style={[styles.msg, { color: theme.muted }]}>Loading markets…</Text>
        </View>
      ) : (
        <FlashList
          data={tickers}
          keyExtractor={(t) => t.coin}
          renderItem={({ item }) => <MarketRow ticker={item} theme={theme} />}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 16, paddingTop: 24 },
  title: { fontSize: 24, fontWeight: "700", marginBottom: 12 },
  center: { alignItems: "center", justifyContent: "center", paddingTop: 40 },
  msg: { fontSize: 14, marginTop: 8 },
});
