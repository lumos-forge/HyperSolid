import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { useEnvStore } from "../state/envStore";
import { useTheme } from "../theme/useTheme";
import { useT } from "../i18n/useT";
import { withAlpha } from "../theme/color";
import { fonts } from "../theme/fonts";
import { Icon } from "./Icon";

/**
 * Asymmetric network warning (spec P0-B): testnet is loud, mainnet is silent. Driven by
 * `envStore.network` so a single source of truth decides visibility.
 *  - `chip`  -> compact caution tag for the Markets header.
 *  - `strip` -> full-width caution banner for order-placing screens (Trade / Market Detail).
 * Colors are tinted from the dedicated `warn` token (distinct from brand) — no hardcoded hex.
 */
export function NetworkWarning({ variant }: { variant: "chip" | "strip" }) {
  const network = useEnvStore((s) => s.network);
  const theme = useTheme();
  const t = useT();
  if (network !== "testnet") return null;

  if (variant === "chip") {
    return (
      <View
        testID="network-warning-chip"
        style={[styles.chip, { backgroundColor: withAlpha(theme.warn, 0.16), borderColor: theme.warn }]}
      >
        <Text style={[styles.chipText, { color: theme.warn }]}>{t("network.testnet")}</Text>
      </View>
    );
  }

  return (
    <View
      testID="network-warning-strip"
      style={[
        styles.strip,
        {
          backgroundColor: withAlpha(theme.warn, 0.13),
          borderLeftColor: theme.warn,
          borderBottomColor: withAlpha(theme.warn, 0.33),
        },
      ]}
    >
      <Icon name="alert" color={theme.warn} size={13} strokeWidth={1.8} />
      <Text style={[styles.stripTitle, { color: theme.warn }]}>{t("network.testnet")}</Text>
      <Text style={[styles.stripSub, { color: theme.muted }]}>{t("network.testnetSub")}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    alignSelf: "flex-start",
  },
  chipText: {
    fontFamily: fonts.display.bold,
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  strip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 18,
    paddingVertical: 7,
    borderLeftWidth: 3,
    borderBottomWidth: 1,
  },
  stripTitle: {
    fontFamily: fonts.display.bold,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  stripSub: { fontFamily: fonts.body.medium, fontSize: 10 },
});
