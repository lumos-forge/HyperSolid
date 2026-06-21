import React from "react";
import { View, Text, ScrollView, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import type { ThemeTokens } from "../theme/tokens";
import { Trace } from "./Trace";
import { StatusRow } from "./StatusRow";

/**
 * Shared screen shell: optional phosphor Trace header, a StatusRow, an optional
 * big heading, and a scrollable content area — so every screen shares one frame.
 */
export function ScreenScaffold({
  theme,
  showTrace = false,
  traceProps,
  statusLeft,
  statusTitle,
  pill,
  heading,
  scroll = true,
  contentStyle,
  children,
}: {
  theme: ThemeTokens;
  showTrace?: boolean;
  traceProps?: { amp?: number; seed?: number; height?: number };
  statusLeft?: React.ReactNode;
  statusTitle?: string;
  pill?: React.ReactNode;
  heading?: string;
  scroll?: boolean;
  contentStyle?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
}) {
  const hasStatus = statusTitle !== undefined || pill !== undefined || statusLeft !== undefined;
  const inner = (
    <>
      {heading ? <Text style={[styles.heading, { color: theme.text }]}>{heading}</Text> : null}
      {children}
    </>
  );
  return (
    <View style={[styles.root, { backgroundColor: theme.bg }]}>
      {showTrace ? <Trace theme={theme} {...traceProps} /> : null}
      {hasStatus ? <StatusRow theme={theme} left={statusLeft} title={statusTitle} pill={pill} /> : null}
      {scroll ? (
        <ScrollView style={styles.body} contentContainerStyle={[styles.content, contentStyle]}>
          {inner}
        </ScrollView>
      ) : (
        <View style={[styles.body, styles.content, contentStyle]}>{inner}</View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: { flex: 1 },
  content: { padding: 16 },
  heading: { fontSize: 22, fontWeight: "700", marginBottom: 8 },
});
