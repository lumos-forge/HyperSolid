import React, { useState } from "react";
import { View, Text, StyleSheet, ActivityIndicator, Pressable, TextInput } from "react-native";
import { FlashList } from "@shopify/flash-list";
import { useMarketStore } from "../state/marketStore";
import { useWatchlistStore } from "../state/watchlistStore";
import { useEnvStore } from "../state/envStore";
import { MarketRow } from "../components/MarketRow";
import { ScreenScaffold } from "../components/ScreenScaffold";
import { Pill } from "../components/Pill";
import { Icon } from "../components/Icon";
import { useTheme } from "../theme/useTheme";

const SIGNAL_LABEL = "SIGNAL · LIVE";

export function MarketsScreen({ onSelectMarket }: { onSelectMarket?: (coin: string) => void }) {
  const theme = useTheme();
  const { tickers, loading, error } = useMarketStore();
  const favorites = useWatchlistStore((s) => s.coins);
  const toggleFavorite = useWatchlistStore((s) => s.toggle);
  const network = useEnvStore((s) => s.network);
  const [filter, setFilter] = useState<"all" | "favorites">("all");
  const [query, setQuery] = useState("");

  const base = filter === "favorites" ? tickers.filter((t) => favorites.includes(t.coin)) : tickers;
  const q = query.trim().toUpperCase();
  const data = q ? base.filter((t) => t.coin.toUpperCase().includes(q)) : base;

  return (
    <ScreenScaffold
      theme={theme}
      showTrace
      statusTitle="HYPERSOLID"
      pill={<Pill theme={theme} label={`◷ ${network.toUpperCase()}`} />}
      scroll={false}
    >
      <View style={styles.readout}>
        <Text style={[styles.readoutLabel, { color: theme.brand }]}>{SIGNAL_LABEL}</Text>
        <View style={[styles.dot, { backgroundColor: theme.brand, shadowColor: theme.brand }]} />
      </View>

      <View style={[styles.search, { backgroundColor: theme.surface, borderColor: theme.line }]}>
        <Icon name="search" color={theme.muted} size={16} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="search markets"
          placeholderTextColor={theme.muted}
          autoCapitalize="characters"
          autoCorrect={false}
          style={[styles.searchInput, { color: theme.text }]}
        />
      </View>

      <View style={[styles.tabs, { borderBottomColor: theme.line }]}>
        {(["all", "favorites"] as const).map((f) => (
          <Pressable
            key={f}
            onPress={() => setFilter(f)}
            accessibilityRole="button"
            accessibilityState={{ selected: filter === f }}
          >
            <Text
              style={[
                styles.tab,
                {
                  color: filter === f ? theme.brand : theme.muted,
                  borderBottomColor: filter === f ? theme.brand : "transparent",
                },
              ]}
            >
              {f === "all" ? "全部" : "自选"}
            </Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.listArea}>
        {error ? (
          <Text style={[styles.msg, { color: theme.down }]}>{error}</Text>
        ) : loading ? (
          <View style={styles.center}>
            <ActivityIndicator color={theme.brand} />
            <Text style={[styles.msg, { color: theme.muted }]}>Loading markets…</Text>
          </View>
        ) : filter === "favorites" && data.length === 0 ? (
          <Text style={[styles.msg, { color: theme.muted }]}>暂无自选，点击星标收藏标的</Text>
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
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  readout: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 12 },
  readoutLabel: { fontSize: 11, fontWeight: "600", letterSpacing: 1.5 },
  dot: { width: 7, height: 7, borderRadius: 4, shadowOpacity: 0.9, shadowRadius: 4, elevation: 3 },
  search: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 11,
    paddingVertical: 9,
    marginBottom: 12,
  },
  searchInput: { flex: 1, fontSize: 13, padding: 0 },
  tabs: { flexDirection: "row", gap: 18, borderBottomWidth: 1, marginBottom: 4 },
  tab: { fontSize: 14, fontWeight: "600", paddingBottom: 8, borderBottomWidth: 2 },
  listArea: { flex: 1 },
  center: { alignItems: "center", justifyContent: "center", paddingTop: 40 },
  msg: { fontSize: 14, marginTop: 8 },
});
