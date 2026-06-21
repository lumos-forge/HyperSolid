import React, { useState } from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
import { useTheme } from "../theme/useTheme";
import { ScreenScaffold } from "../components/ScreenScaffold";
import { Pill } from "../components/Pill";
import { SectionLabel } from "../components/SectionLabel";
import { Toggle } from "../components/Toggle";

// Mock strategies for the UI shell. TODO: source from a real agent/strategy
// store and wire enable/disable + kill-switch to the execution layer.
const STRATEGIES = [
  { kind: "TP/SL", market: "BTC", params: "+3% / −1.5%", on: true },
  { kind: "GRID", market: "ETH", params: "2.9k–3.2k ×8", on: true },
  { kind: "DCA", market: "BTC", params: "$50 / 8h", on: false },
] as const;

export function AgentScreen() {
  const theme = useTheme();
  const [enabled, setEnabled] = useState<boolean[]>(STRATEGIES.map((s) => s.on));

  return (
    <ScreenScaffold
      theme={theme}
      showTrace
      traceProps={{ amp: 10, seed: 2.2, height: 34 }}
      statusTitle="YOUR AGENT"
      pill={<Pill theme={theme} label="◉ ARMED" variant="up" />}
    >
      <View style={[styles.head, { borderColor: theme.line, backgroundColor: theme.surface }]}>
        <Text style={[styles.headTitle, { color: theme.brand }]}>PHOSPHOR TRACE · ACTIVE</Text>
        <Text style={[styles.sub, { color: theme.muted }]}>trade-only · 无提现权限 · 离线也运行</Text>
      </View>

      <SectionLabel theme={theme}>STRATEGIES</SectionLabel>
      {STRATEGIES.map((s, i) => (
        <View key={s.kind} style={[styles.srow, { borderBottomColor: theme.line }]}>
          <View style={styles.srowLeft}>
            <View style={styles.snameRow}>
              <Text style={[styles.sname, { color: theme.text }]}>{s.kind}</Text>
              <Text style={[styles.smkt, { color: theme.muted }]}> {s.market}</Text>
            </View>
            <Text style={[styles.sub, { color: theme.muted }]}>{s.params}</Text>
          </View>
          <Toggle
            theme={theme}
            value={enabled[i]}
            onValueChange={(next) =>
              setEnabled((prev) => prev.map((v, idx) => (idx === i ? next : v)))
            }
            accessibilityLabel={`strategy-${s.kind}`}
          />
        </View>
      ))}

      <View style={styles.guard}>
        <Text style={[styles.sub, { color: theme.muted }]}>GUARDRAILS</Text>
        <Text style={[styles.guardValue, { color: theme.text }]}>max 5× · 日内 −$200</Text>
      </View>

      <View style={styles.ladder}>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            /* TODO: wire kill-switch to the execution/automation layer */
          }}
          style={[styles.btn, { backgroundColor: theme.down }]}
        >
          <Text style={[styles.killText, { color: theme.bg }]}>▮ KILL SWITCH</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            /* TODO: open the new-strategy flow */
          }}
          style={[styles.btn, styles.newBtn, { borderColor: theme.brand }]}
        >
          <Text style={[styles.newText, { color: theme.brand }]}>+ 新建</Text>
        </Pressable>
      </View>
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  head: { borderWidth: 1, borderRadius: 10, padding: 14, marginBottom: 12 },
  headTitle: { fontSize: 15, fontWeight: "700", letterSpacing: 0.8 },
  sub: { fontSize: 11, marginTop: 3 },
  srow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  srowLeft: { flex: 1 },
  snameRow: { flexDirection: "row", alignItems: "baseline" },
  sname: { fontSize: 14, fontWeight: "700", letterSpacing: 0.4 },
  smkt: { fontSize: 12, fontWeight: "400" },
  guard: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 14,
  },
  guardValue: { fontSize: 13, fontWeight: "600", fontVariant: ["tabular-nums"] },
  ladder: { flexDirection: "row", gap: 10, marginTop: 6 },
  btn: { flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 13, borderRadius: 9 },
  newBtn: { borderWidth: 1, backgroundColor: "transparent" },
  killText: { fontSize: 14, fontWeight: "700", letterSpacing: 0.5 },
  newText: { fontSize: 14, fontWeight: "700", letterSpacing: 0.5 },
});
