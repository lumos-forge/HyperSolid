import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import type { ThemeTokens } from "../theme/tokens";

/**
 * Persistent, honest disclosure of unconfirmed (pending/submitted/orphan) intents (spec §6.1).
 * Distinct from the transient post-submit notice: this is driven by the durable ledger and so
 * survives restarts and startup recovery. Renders nothing when there is nothing to disclose.
 */
export function UnconfirmedBanner({
  theme,
  count,
  onReview,
  reviewLabel = "复核",
}: {
  theme: ThemeTokens;
  count: number;
  onReview?: () => void;
  reviewLabel?: string;
}) {
  if (count <= 0) return null;
  return (
    <View
      testID="unconfirmed-banner"
      style={[styles.box, { borderColor: theme.down, backgroundColor: theme.surface }]}
    >
      <Text style={[styles.title, { color: theme.down }]}>{count} 笔未确认订单</Text>
      <Text style={[styles.body, { color: theme.muted }]}>
        这些订单可能已提交至交易所、存在敞口，状态尚未确认。请勿重复手动下单；请复核，必要时用同一编号(cloid)安全重试。
      </Text>
      {onReview ? (
        <Pressable
          onPress={onReview}
          accessibilityRole="button"
          testID="unconfirmed-review"
          style={[styles.action, { borderColor: theme.brand }]}
        >
          <Text style={[styles.actionText, { color: theme.brand }]}>{reviewLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderWidth: 1, borderRadius: 10, padding: 12, marginBottom: 12 },
  title: { fontSize: 13, fontWeight: "700", marginBottom: 4 },
  body: { fontSize: 12, lineHeight: 17 },
  action: { borderWidth: 1, borderRadius: 8, paddingVertical: 10, alignItems: "center", marginTop: 10 },
  actionText: { fontSize: 14, fontWeight: "700" },
});
