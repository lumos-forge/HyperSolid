import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useNetStore, isOffline } from "../state/netStore";
import { useTheme } from "../theme/useTheme";
import { Icon } from "./Icon";
import { fonts } from "../theme/fonts";
import { useT } from "../i18n/useT";

/** Thin app-wide banner shown only while the device is offline; hides as soon as connectivity returns. */
export function OfflineBanner() {
  const theme = useTheme();
  const t = useT();
  const insets = useSafeAreaInsets();
  const online = useNetStore((s) => s.online);
  if (!isOffline(online)) return null;
  return (
    <View
      testID="offline-banner"
      accessibilityRole="alert"
      style={[styles.bar, { backgroundColor: theme.down, paddingTop: insets.top + 4 }]}
    >
      <Icon name="alert" color={theme.bg} size={13} />
      <Text style={[styles.text, { color: theme.bg }]}>{t("common.offline")}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 1000,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    paddingBottom: 7,
    paddingHorizontal: 12,
  },
  text: { fontFamily: fonts.body.semibold, fontSize: 12 },
});
