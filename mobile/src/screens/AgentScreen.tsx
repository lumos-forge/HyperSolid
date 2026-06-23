import React, { useState } from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
import { useTheme } from "../theme/useTheme";
import { ScreenScaffold } from "../components/ScreenScaffold";
import { NetworkWarning } from "../components/NetworkWarning";
import { SurfaceCard } from "../components/SurfaceCard";
import { ReturnCurve } from "../components/ReturnCurve";
import { ChangeText } from "../components/ChangeText";
import { Toggle } from "../components/Toggle";
import { Icon, type IconName } from "../components/Icon";
import { fonts } from "../theme/fonts";
import { withAlpha } from "../theme/color";
import type { ThemeTokens } from "../theme/tokens";

// Mock strategy shell. TODO: source from a real agent/strategy store and wire enable/disable
// + the new-strategy flow to the execution layer.
const STRATEGIES = [
  { kind: "GRID", icon: "grid" as IconName, desc: "BTC-USDC · Running", ret: 5.82, on: true },
  { kind: "DCA", icon: "repeat" as IconName, desc: "ETH · Every Monday", ret: 1.24, on: true },
  { kind: "TP/SL", icon: "shield" as IconName, desc: "BTC · Armed", ret: 0, on: false },
];

const TEMPLATES: Array<[IconName, string]> = [
  ["grid", "Grid"],
  ["repeat", "DCA"],
  ["bolt", "TWAP"],
  ["shield", "TP-SL"],
];

const RETURN_SHAPE = [0.46, 0.4, 0.52, 0.47, 0.58, 0.5, 0.62, 0.7, 0.63, 0.76, 0.71, 0.82, 0.88, 0.8, 0.93, 1.0];

export function AgentScreen() {
  const theme = useTheme();
  const [enabled, setEnabled] = useState<boolean[]>(STRATEGIES.map((s) => s.on));
  const runningCount = enabled.filter(Boolean).length;

  return (
    <ScreenScaffold theme={theme} statusTitle="Strategy" pill={<NetworkWarning variant="chip" />}>
      <SurfaceCard theme={theme} style={styles.hero}>
        <Text style={[styles.heroLabel, { color: theme.muted }]}>30D strategy return</Text>
        <ChangeText theme={theme} value={7.06} size={28} />
        <Text style={[styles.heroSub, { color: theme.faint }]}>
          {runningCount} running · risk-bounded
        </Text>
        <View style={styles.curve}>
          <ReturnCurve points={RETURN_SHAPE} theme={theme} color={theme.up} />
        </View>
      </SurfaceCard>

      <Text style={[styles.eyebrow, { color: theme.faint }]}>Templates</Text>
      <View style={styles.templates}>
        {TEMPLATES.map(([icon, name]) => (
          <Pressable
            key={name}
            accessibilityRole="button"
            style={[styles.tmpl, { borderColor: theme.line, backgroundColor: theme.surface }]}
          >
            <Icon name={icon} color={theme.brand} size={16} />
            <Text style={[styles.tmplText, { color: theme.text }]}>{name}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={[styles.eyebrow, { color: theme.faint }]}>My strategies</Text>
      {STRATEGIES.map((s, i) => (
        <StrategyCard
          key={s.kind}
          theme={theme}
          strategy={s}
          on={enabled[i]}
          onToggle={(next) => setEnabled((prev) => prev.map((v, idx) => (idx === i ? next : v)))}
        />
      ))}

      <Pressable
        accessibilityRole="button"
        onPress={() => {
          /* TODO: open the new-strategy flow */
        }}
        style={[styles.cta, { borderColor: theme.brand }]}
      >
        <Icon name="plus" color={theme.brand} size={15} strokeWidth={2} />
        <Text style={[styles.ctaText, { color: theme.brand }]}>New strategy</Text>
      </Pressable>
    </ScreenScaffold>
  );
}

function StrategyCard({
  theme,
  strategy,
  on,
  onToggle,
}: {
  theme: ThemeTokens;
  strategy: { kind: string; icon: IconName; desc: string; ret: number };
  on: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <SurfaceCard theme={theme} rule={false} style={styles.scard}>
      <View style={styles.scardRow}>
        <View style={[styles.sicon, { backgroundColor: withAlpha(theme.brand, 0.12) }]}>
          <Icon name={strategy.icon} color={theme.brand} size={18} />
        </View>
        <View style={styles.smid}>
          <Text style={[styles.sname, { color: theme.text }]}>{strategy.kind}</Text>
          <Text style={[styles.sdesc, { color: theme.muted }]}>{strategy.desc}</Text>
        </View>
        <ChangeText theme={theme} value={strategy.ret} size={12.5} />
        <View style={styles.stoggle}>
          <Toggle theme={theme} value={on} onValueChange={onToggle} accessibilityLabel={`strategy-${strategy.kind}`} />
        </View>
      </View>
    </SurfaceCard>
  );
}

const styles = StyleSheet.create({
  hero: { padding: 16 },
  heroLabel: { fontFamily: fonts.body.regular, fontSize: 11, marginBottom: 6 },
  heroSub: { fontFamily: fonts.body.regular, fontSize: 11, marginTop: 6 },
  curve: { marginTop: 12 },
  eyebrow: {
    fontFamily: fonts.display.bold,
    fontSize: 10,
    letterSpacing: 1,
    textTransform: "uppercase",
    marginTop: 14,
    marginBottom: 8,
  },
  templates: { flexDirection: "row", gap: 8 },
  tmpl: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 11,
  },
  tmplText: { fontFamily: fonts.body.semibold, fontSize: 12 },
  scard: { padding: 12, marginBottom: 8 },
  scardRow: { flexDirection: "row", alignItems: "center", gap: 11 },
  sicon: { width: 36, height: 36, borderRadius: 9, alignItems: "center", justifyContent: "center" },
  smid: { flex: 1 },
  sname: { fontFamily: fonts.display.bold, fontSize: 13.5 },
  sdesc: { fontFamily: fonts.body.regular, fontSize: 11, marginTop: 2 },
  stoggle: { marginLeft: 11 },
  cta: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 13,
    marginTop: 14,
  },
  ctaText: { fontFamily: fonts.display.bold, fontSize: 14, letterSpacing: 0.3 },
});
