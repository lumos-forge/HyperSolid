import React, { useEffect, useRef, useState } from "react";
import { View, TextInput, Animated, StyleSheet } from "react-native";
import type { ThemeTokens } from "../theme/tokens";
import { fonts } from "../theme/fonts";

/**
 * Numeric field with a floating label (Material style): while empty + unfocused the label sits
 * large and centred like a placeholder; once focused or filled it shrinks and floats to the top with
 * the value below. A single persistent TextInput is kept mounted so focus is never lost across the
 * transition. `rightInside` renders an in-box accessory (e.g. the size-unit selector) after a divider.
 */
export function FloatingField({
  label,
  value,
  onChange,
  theme,
  testID,
  keyboard = true,
  rightInside,
  style,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  theme: ThemeTokens;
  testID?: string;
  keyboard?: boolean;
  rightInside?: React.ReactNode;
  style?: object;
}) {
  const [focused, setFocused] = useState(false);
  const floated = focused || value.length > 0;
  const anim = useRef(new Animated.Value(floated ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(anim, { toValue: floated ? 1 : 0, duration: 140, useNativeDriver: false }).start();
  }, [floated, anim]);

  const labelStyle = {
    fontSize: anim.interpolate({ inputRange: [0, 1], outputRange: [17, 11] }),
    color: anim.interpolate({ inputRange: [0, 1], outputRange: [theme.faint, theme.muted] }),
    transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [13, 2] }) }],
  };

  return (
    <View style={[styles.box, { borderColor: theme.line, backgroundColor: theme.surface }, style]}>
      <View style={styles.main}>
        <Animated.Text style={[styles.label, labelStyle]} pointerEvents="none" numberOfLines={1}>
          {label}
        </Animated.Text>
        <TextInput
          value={value}
          onChangeText={onChange}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          testID={testID}
          keyboardType={keyboard ? "decimal-pad" : "default"}
          style={[styles.input, { color: theme.text }]}
        />
      </View>
      {rightInside ? <View style={[styles.divider, { backgroundColor: theme.line }]} /> : null}
      {rightInside}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    height: 50,
    marginBottom: 12,
  },
  main: { flex: 1, height: "100%", position: "relative", justifyContent: "center" },
  label: { position: "absolute", top: 0, left: 0, right: 0, textAlign: "center", fontFamily: fonts.body.regular },
  input: { fontFamily: fonts.mono.bold, fontSize: 16, textAlign: "center", padding: 0, marginTop: 7 },
  divider: { width: 1, height: 26, marginHorizontal: 10 },
});
