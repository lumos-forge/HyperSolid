import React, { useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { useTheme } from "../theme/useTheme";
import { fonts } from "../theme/fonts";
import { Icon } from "./Icon";

export interface DropdownOption<T extends string> {
  value: T;
  label: string;
}

/**
 * Lightweight select: a control showing the current label that expands a list of options. In
 * `compact` mode it shrinks to its content and the menu overlays (absolute) instead of pushing the
 * layout — used for the inline TIF and size-unit controls; otherwise it's a full-width field.
 */
export function Dropdown<T extends string>({
  label,
  prefix,
  value,
  options,
  onChange,
  testID,
  compact = false,
  center = false,
  bare = false,
}: {
  label?: string;
  prefix?: string;
  value: T;
  options: DropdownOption<T>[];
  onChange: (v: T) => void;
  testID?: string;
  compact?: boolean;
  center?: boolean;
  bare?: boolean;
}) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);
  const display = `${prefix ? `${prefix} ` : ""}${current?.label ?? value}`;
  const centered = center && !compact;
  return (
    <View style={compact ? styles.wrapCompact : styles.wrap}>
      {label ? <Text style={[styles.label, { color: theme.muted }]}>{label}</Text> : null}
      <Pressable
        testID={testID}
        accessibilityRole="button"
        onPress={() => setOpen((o) => !o)}
        style={[
          compact ? styles.controlCompact : styles.control,
          centered ? styles.controlCenter : null,
          bare ? styles.controlBare : { borderColor: theme.line, backgroundColor: theme.surface },
        ]}
      >
        <Text style={[compact ? styles.valueCompact : styles.value, centered ? styles.valueCenter : null, { color: theme.text }]}>
          {display}
        </Text>
        {centered ? (
          <View style={styles.centerChevron}>
            <Icon name="chevronDown" color={theme.muted} size={16} />
          </View>
        ) : (
          <Icon name="chevronDown" color={theme.muted} size={compact ? 13 : 16} />
        )}
      </Pressable>
      {open ? (
        <View
          style={[
            compact ? styles.menuCompact : styles.menu,
            { borderColor: theme.line, backgroundColor: theme.surface },
          ]}
        >
          {options.map((o) => (
            <Pressable
              key={o.value}
              testID={testID ? `${testID}-opt-${o.value}` : undefined}
              accessibilityRole="button"
              onPress={() => {
                onChange(o.value);
                setOpen(false);
              }}
              style={({ pressed }) => [styles.option, { backgroundColor: pressed ? theme.bg : "transparent" }]}
            >
              <Text style={[styles.optionText, { color: o.value === value ? theme.brand : theme.text }]}>
                {o.label}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: 12 },
  wrapCompact: { position: "relative", alignSelf: "flex-start" },
  label: { fontFamily: fonts.body.regular, fontSize: 11, marginBottom: 4 },
  control: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  controlCenter: { justifyContent: "center" },
  controlBare: { borderWidth: 0, paddingHorizontal: 0, paddingVertical: 0 },
  centerChevron: { position: "absolute", right: 12 },
  valueCenter: { textAlign: "center" },
  controlCompact: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  value: { fontFamily: fonts.mono.medium, fontSize: 14 },
  valueCompact: { fontFamily: fonts.mono.medium, fontSize: 12.5 },
  menu: { borderWidth: 1, borderRadius: 10, marginTop: 4, overflow: "hidden" },
  menuCompact: {
    position: "absolute",
    top: "100%",
    right: 0,
    marginTop: 4,
    minWidth: 96,
    borderWidth: 1,
    borderRadius: 10,
    overflow: "hidden",
    zIndex: 30,
    elevation: 8,
  },
  option: { paddingHorizontal: 12, paddingVertical: 11 },
  optionText: { fontFamily: fonts.body.medium, fontSize: 13.5 },
});
