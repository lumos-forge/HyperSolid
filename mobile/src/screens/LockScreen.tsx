import React, { useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { useTheme } from "../theme/useTheme";
import { Icon } from "../components/Icon";
import type { AuthResult } from "../wallet/biometricGate";

export function LockScreen({ onUnlock }: { onUnlock: () => Promise<AuthResult> }) {
  const theme = useTheme();
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handle() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await onUnlock();
      if (r === "failed") setMsg("验证失败，请重试");
      else if (r === "cancelled") setMsg("已取消");
      else if (r === "unavailable") setMsg("未检测到生物识别，请在系统设置中启用 Face ID/指纹");
      else if (r === "compromised") setMsg("设备安全检查未通过：检测到 root/越狱风险，为保护你的资产已禁止解锁。");
    } catch {
      setMsg("验证失败，请重试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={[styles.root, { backgroundColor: theme.bg }]}>
      <Icon name="lock" color={theme.brand} size={48} />
      <Text style={[styles.title, { color: theme.text }]}>HyperSolid 已锁定</Text>
      <Text style={[styles.sub, { color: theme.muted }]}>用生物识别解锁以继续</Text>
      {msg ? <Text style={[styles.msg, { color: theme.down }]}>{msg}</Text> : null}
      <Pressable
        accessibilityRole="button"
        disabled={busy}
        onPress={handle}
        style={[styles.btn, { backgroundColor: theme.brand }]}
      >
        <Text style={[styles.btnText, { color: theme.bg }]}>解锁</Text>
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
