import React, { useState } from "react";
import { View, Text, StyleSheet, ActivityIndicator, Pressable, TextInput } from "react-native";
import { FlashList } from "@shopify/flash-list";
import { useMarketStore } from "../state/marketStore";
import { useWatchlistStore } from "../state/watchlistStore";
import { MarketRow } from "../components/MarketRow";
import { ScreenScaffold } from "../components/ScreenScaffold";
import { NetworkWarning } from "../components/NetworkWarning";
import { Icon } from "../components/Icon";
import { fonts } from "../theme/fonts";
import { useTheme } from "../theme/useTheme";

const TABS = [
  ["all", "All"],
  ["favorites", "Watchlist"],
] as const;

export function MarketsScreen({ onSelectMarket }: { onSelectMarket?: (coin: string) => void }) {
  const theme = useTheme();
  const { tickers, loading, error } = useMarketStore();
  const favorites = useWatchlistStore((s) => s.coins);
  const toggleFavorite = useWatchlistStore((s) => s.toggle);
  const [filter, setFilter] = useState<"all" | "favorites">("all");
  const [query, setQuery] = useState("");

  const base = filter === "favorites" ? tickers.filter((t) => favorites.includes(t.coin)) : tickers;
  const q = query.trim().toUpperCase();
  const data = q ? base.filter((t) => t.coin.toUpperCase().includes(q)) : base;

  return (
    <ScreenScaffold
      theme={theme}
      statusTitle="Markets"
      pill={<NetworkWarning variant="chip" />}
      scroll={false}
    >
      <View style={[styles.search, { backgroundColor: theme.surface, borderColor: theme.line }]}>
        <Icon name="search" color={theme.faint} size={16} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search markets"
          placeholderTextColor={theme.faint}
          autoCapitalize="characters"
          autoCorrect={false}
          style={[styles.searchInput, { color: theme.text }]}
        />
      </View>

      <View style={[styles.tabs, { borderBottomColor: theme.line }]}>
        {TABS.map(([f, label]) => (
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
              {label}
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
          <Text style={[styles.msg, { color: theme.muted }]}>
            No watchlist yet · tap the star to follow markets
          </Text>
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
  search: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 11,
    paddingVertical: 9,
    marginBottom: 12,
  },
  searchInput: { flex: 1, fontFamily: fonts.body.regular, fontSize: 13, padding: 0 },
  tabs: { flexDirection: "row", gap: 18, borderBottomWidth: 1, marginBottom: 4 },
  tab: {
    fontFamily: fonts.display.bold,
    fontSize: 13,
    letterSpacing: 0.3,
    paddingBottom: 8,
    borderBottomWidth: 2,
  },
  listArea: { flex: 1 },
  center: { alignItems: "center", justifyContent: "center", paddingTop: 40 },
  msg: { fontFamily: fonts.body.regular, fontSize: 14, marginTop: 8 },
});
