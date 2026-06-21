import React from "react";
import { Pressable, View, StyleSheet } from "react-native";
import type { ThemeTokens } from "../theme/tokens";

/** Square phosphor switch used by strategy rows. Off = line, On = brand + glow. */
export function Toggle({
  theme,
  value,
  onValueChange,
  accessibilityLabel,
}: {
  theme: ThemeTokens;
  value: boolean;
  onValueChange?: (next: boolean) => void;
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      accessibilityLabel={accessibilityLabel}
      onPress={() => onValueChange?.(!value)}
      style={[
        styles.track,
        {
          backgroundColor: value ? theme.brand : theme.line,
          shadowColor: theme.brand,
          shadowOpacity: value ? 0.5 : 0,
          shadowRadius: value ? 5 : 0,
        },
      ]}
    >
      <View
        style={[
          styles.knob,
          { backgroundColor: theme.bg, alignSelf: value ? "flex-end" : "flex-start" },
        ]}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  track: { width: 38, height: 22, borderRadius: 6, padding: 3, justifyContent: "center" },
  knob: { width: 16, height: 16, borderRadius: 4 },
});
