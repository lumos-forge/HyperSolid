import React, { useState } from "react";
import { View, Text, StyleSheet, ActivityIndicator, Pressable } from "react-native";
import { FlashList } from "@shopify/flash-list";
import { useMarketStore } from "../state/marketStore";
import { useWatchlistStore } from "../state/watchlistStore";
import { MarketRow } from "../components/MarketRow";
import { useTheme } from "../theme/useTheme";

export function MarketsScreen({ onSelectMarket }: { onSelectMarket?: (coin: string) => void }) {
  const theme = useTheme();
  const { tickers, loading, error } = useMarketStore();
  const favorites = useWatchlistStore((s) => s.coins);
  const toggleFavorite = useWatchlistStore((s) => s.toggle);
  const [filter, setFilter] = useState<"all" | "favorites">("all");

  const data = filter === "favorites" ? tickers.filter((t) => favorites.includes(t.coin)) : tickers;

  return (
    <View style={[styles.container, { backgroundColor: theme.bg }]}>
      <Text style={[styles.title, { color: theme.text }]}>Markets</Text>
      <View style={styles.tabs}>
        {(["all", "favorites"] as const).map((f) => (
          <Pressable key={f} onPress={() => setFilter(f)} accessibilityRole="button">
            <Text
              style={[
                styles.tab,
                { color: filter === f ? theme.brand : theme.muted, borderBottomColor: filter === f ? theme.brand : "transparent" },
              ]}
            >
              {f === "all" ? "全部" : "自选"}
            </Text>
          </Pressable>
        ))}
      </View>
      {error ? (
        <Text style={[styles.msg, { color: theme.down }]}>{error}</Text>
      ) : loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.brand} />
          <Text style={[styles.msg, { color: theme.muted }]}>Loading markets…</Text>
        </View>
      ) : filter === "favorites" && data.length === 0 ? (
        <Text style={[styles.msg, { color: theme.muted }]}>暂无自选，点击 ☆ 收藏标的</Text>
      ) : (
        <FlashList
          data={data}
          keyExtractor={(t) => t.coin}
          renderItem={({ item }) => (
            <MarketRow
              ticker={item}
              theme={theme}
              onPress={() => onSelectMarket?.(item.coin)}
              isFavorite={favorites.includes(item.coin)}
              onToggleFavorite={() => toggleFavorite(item.coin)}
            />
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 16, paddingTop: 24 },
  title: { fontSize: 24, fontWeight: "700", marginBottom: 12 },
  tabs: { flexDirection: "row", gap: 18, marginBottom: 8 },
  tab: { fontSize: 14, fontWeight: "600", paddingBottom: 6, borderBottomWidth: 2 },
  center: { alignItems: "center", justifyContent: "center", paddingTop: 40 },
  msg: { fontSize: 14, marginTop: 8 },
});
