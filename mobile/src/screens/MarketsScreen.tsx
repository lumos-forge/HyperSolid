import React, { useMemo, useState } from "react";
import { View, Text, StyleSheet, ActivityIndicator, Pressable, TextInput } from "react-native";
import { FlashList } from "@shopify/flash-list";
import { useMarketStore } from "../state/marketStore";
import { LoadError } from "../components/LoadError";
import { useWatchlistStore } from "../state/watchlistStore";
import { MarketRow } from "../components/MarketRow";
import { ScreenScaffold } from "../components/ScreenScaffold";
import { NetworkWarning } from "../components/NetworkWarning";
import { Icon } from "../components/Icon";
import { fonts } from "../theme/fonts";
import { useTheme } from "../theme/useTheme";
import { useT } from "../i18n/useT";
import type { TranslationKey } from "../i18n/messages";

const TABS = [
  ["all", "markets.filterAll"],
  ["favorites", "markets.filterWatchlist"],
] as const satisfies readonly (readonly [string, TranslationKey])[];

type SortKey = "vol" | "chg" | "price";
const SORTS = [
  ["vol", "markets.sortVol"],
  ["chg", "markets.sortChg"],
  ["price", "markets.sortPrice"],
] as const satisfies readonly (readonly [SortKey, TranslationKey])[];

export function MarketsScreen({ onSelectMarket }: { onSelectMarket?: (coin: string) => void }) {
  const theme = useTheme();
  const t = useT();
  const { tickers, loading, error } = useMarketStore();
  const favorites = useWatchlistStore((s) => s.coins);
  const toggleFavorite = useWatchlistStore((s) => s.toggle);
  const [filter, setFilter] = useState<"all" | "favorites">("all");
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("vol");
  const [sortDesc, setSortDesc] = useState(true);

  const base = filter === "favorites" ? tickers.filter((t) => favorites.includes(t.coin)) : tickers;
  const q = query.trim().toUpperCase();
  const filtered = q ? base.filter((t) => t.coin.toUpperCase().includes(q)) : base;
  const data = useMemo(() => {
    const val = (tk: (typeof filtered)[number]) =>
      sortKey === "vol" ? tk.dayNtlVlm : sortKey === "chg" ? tk.changePct : tk.midPx;
    return [...filtered].sort((a, b) => (sortDesc ? -1 : 1) * (val(a) - val(b)));
  }, [filtered, sortKey, sortDesc]);

  function onSort(k: SortKey) {
    if (k === sortKey) setSortDesc((d) => !d);
    else {
      setSortKey(k);
      setSortDesc(true);
    }
  }

  return (
    <ScreenScaffold
      theme={theme}
      pill={<NetworkWarning variant="chip" />}
      scroll={false}
    >
      <View style={[styles.search, { backgroundColor: theme.surface, borderColor: theme.line }]}>
        <Icon name="search" color={theme.faint} size={16} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={t("markets.search")}
          placeholderTextColor={theme.faint}
          autoCapitalize="characters"
          autoCorrect={false}
          style={[styles.searchInput, { color: theme.text }]}
        />
      </View>

      <View style={[styles.tabs, { borderBottomColor: theme.line }]}>
        <View style={styles.tabGroup}>
          {TABS.map(([f, labelKey]) => (
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
                {t(labelKey)}
              </Text>
            </Pressable>
          ))}
        </View>
        <View style={styles.sortGroup}>
          {SORTS.map(([k, labelKey]) => (
            <Pressable key={k} onPress={() => onSort(k)} accessibilityRole="button" testID={`sort-${k}`}>
              <Text style={[styles.sortChip, { color: sortKey === k ? theme.brand : theme.faint }]}>
                {t(labelKey)}
                {sortKey === k ? (sortDesc ? " ↓" : " ↑") : ""}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={styles.listArea}>
        {error ? (
          <LoadError theme={theme} code={error} onRetry={() => useMarketStore.getState().retry()} testID="markets-error" />
        ) : loading ? (
          <View style={styles.center}>
            <ActivityIndicator color={theme.brand} />
            <Text style={[styles.msg, { color: theme.muted }]}>{t("markets.loading")}</Text>
          </View>
        ) : filter === "favorites" && data.length === 0 ? (
          <Text style={[styles.msg, { color: theme.muted }]}>
            {t("markets.emptyWatchlist")}
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
  tabs: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", borderBottomWidth: 1, marginBottom: 4 },
  tabGroup: { flexDirection: "row", gap: 18 },
  sortGroup: { flexDirection: "row", gap: 12, paddingBottom: 8 },
  sortChip: { fontFamily: fonts.mono.medium, fontSize: 11, letterSpacing: 0.2 },
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
