import React, { useEffect, useRef, useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { useTheme } from "../theme/useTheme";
import { useT } from "../i18n/useT";
import { Icon } from "../components/Icon";
import type { AuthResult } from "../wallet/biometricGate";

export function LockScreen({ onUnlock }: { onUnlock: () => Promise<AuthResult> }) {
  const theme = useTheme();
  const t = useT();
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const autoTriggered = useRef(false);

  async function handle() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await onUnlock();
      if (r === "failed") setMsg(t("lock.failed"));
      else if (r === "cancelled") setMsg(t("lock.cancelled"));
      else if (r === "unavailable") setMsg(t("lock.unavailable"));
      else if (r === "compromised") setMsg(t("lock.compromised"));
    } catch {
      setMsg(t("lock.failed"));
    } finally {
      setBusy(false);
    }
  }

  // Surface the biometric prompt automatically the moment the lock screen appears (cold start /
  // return-from-background), so unlocking is one fewer tap. Fire once; after a cancel/fail the user
  // retries with the button. The integrity gate inside onUnlock still runs first, so a compromised
  // device never reaches a prompt.
  useEffect(() => {
    if (autoTriggered.current) return;
    autoTriggered.current = true;
    void handle();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={[styles.root, { backgroundColor: theme.bg }]}>
      <Icon name="lock" color={theme.brand} size={48} />
      <Text style={[styles.title, { color: theme.text }]}>{t("lock.title")}</Text>
      <Text style={[styles.sub, { color: theme.muted }]}>{t("lock.subtitle")}</Text>
      {msg ? <Text style={[styles.msg, { color: theme.down }]}>{msg}</Text> : null}
      <Pressable
        accessibilityRole="button"
        disabled={busy}
        onPress={handle}
        style={[styles.btn, { backgroundColor: theme.brand }]}
      >
        <Text style={[styles.btnText, { color: theme.bg }]}>{t("lock.unlock")}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 12 },
  title: { fontSize: 20, fontWeight: "700" },
  sub: { fontSize: 13 },
  msg: { fontSize: 13, textAlign: "center" },
  btn: { marginTop: 12, paddingVertical: 13, paddingHorizontal: 40, borderRadius: 10 },
  btnText: { fontSize: 15, fontWeight: "700" },
});
