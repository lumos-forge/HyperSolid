import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import type { ThemeTokens } from "../theme/tokens";
import { fonts } from "../theme/fonts";
import { useT } from "../i18n/useT";
import type { FetchErrorCode } from "../lib/errorMessage";

export type LoadErrorCode = FetchErrorCode | "invalidAddress";

/**
 * Shared network/load error state with a Retry. Replaces raw SDK error strings and blank/spinner-
 * forever states across screens. `compact` renders an inline one-line variant for sub-feeds (a
 * failed orders/fills/book panel) vs the full centered card for a whole-screen failure.
 */
export function LoadError({
  theme,
  code,
  onRetry,
  compact = false,
  testID,
}: {
  theme: ThemeTokens;
  code: LoadErrorCode;
  onRetry?: () => void;
  compact?: boolean;
  testID?: string;
}) {
  const t = useT();
  const title =
    code === "network" ? t("errors.networkTitle") : code === "invalidAddress" ? t("errors.addressTitle") : t("errors.unknownTitle");
  const body =
    code === "network" ? t("errors.networkBody") : code === "invalidAddress" ? t("errors.addressBody") : t("errors.unknownBody");
  const canRetry = code !== "invalidAddress" && onRetry;

  if (compact) {
    return (
      <View style={styles.inlineRow} testID={testID}>
        <Text style={[styles.inlineText, { color: theme.muted }]}>{title}</Text>
        {canRetry ? (
          <Pressable accessibilityRole="button" testID={testID ? `${testID}-retry` : undefined} onPress={onRetry} hitSlop={8}>
            <Text style={[styles.inlineRetry, { color: theme.brand }]}>{t("common.retry")}</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  return (
    <View style={styles.box} testID={testID}>
      <Text style={[styles.title, { color: theme.text }]}>{title}</Text>
      <Text style={[styles.body, { color: theme.muted }]}>{body}</Text>
      {canRetry ? (
        <Pressable
          accessibilityRole="button"
          testID={testID ? `${testID}-retry` : undefined}
          onPress={onRetry}
          style={[styles.retryBtn, { borderColor: theme.brand }]}
        >
          <Text style={[styles.retryText, { color: theme.brand }]}>{t("common.retry")}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { marginTop: 24, alignItems: "center", paddingHorizontal: 12 },
  title: { fontFamily: fonts.display.bold, fontSize: 15, marginBottom: 6 },
  body: { fontFamily: fonts.body.regular, fontSize: 12.5, lineHeight: 18, textAlign: "center", marginBottom: 14 },
  retryBtn: { paddingHorizontal: 22, paddingVertical: 10, borderRadius: 10, borderWidth: 1 },
  retryText: { fontFamily: fonts.display.bold, fontSize: 13, letterSpacing: 0.3 },
  inlineRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 18, paddingHorizontal: 2, gap: 12 },
  inlineText: { flex: 1, fontFamily: fonts.body.regular, fontSize: 12.5 },
  inlineRetry: { fontFamily: fonts.display.bold, fontSize: 12.5, letterSpacing: 0.3 },
});
