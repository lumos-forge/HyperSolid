import React, { useRef, useState } from "react";
import { View, StyleSheet, PanResponder, type LayoutChangeEvent } from "react-native";
import { useTheme } from "../theme/useTheme";

const NOTCHES = [0, 25, 50, 75, 100];

/** Clamp a touch x (relative to the track) to a 0–100 percentage. */
export function pctFromX(x: number, width: number): number {
  if (!(width > 0)) return 0;
  const pct = (x / width) * 100;
  return Math.max(0, Math.min(100, pct));
}

/** Round a percentage to the nearest quarter notch (0/25/50/75/100). */
export function snapPct(pct: number): number {
  return NOTCHES.reduce((best, n) => (Math.abs(n - pct) < Math.abs(best - pct) ? n : best), 0);
}

/**
 * Horizontal 0–100% slider with quarter notches (no native dependency; PanResponder over a measured
 * track). Controlled via `value`; reports continuous changes through `onChange`. `snap` rounds drags
 * to the nearest quarter notch.
 */
export function Slider({
  value,
  onChange,
  snap = false,
  testID,
}: {
  value: number;
  onChange: (pct: number) => void;
  snap?: boolean;
  testID?: string;
}) {
  const theme = useTheme();
  const [width, setWidth] = useState(0);
  const widthRef = useRef(0);
  // Keep the latest onChange/snap so the (once-created) PanResponder never calls a stale closure
  // (e.g. an onSlide captured before the balance loaded, which would no-op forever).
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const snapRef = useRef(snap);
  snapRef.current = snap;

  const reportRef = useRef((x: number): number => {
    const pct = pctFromX(x, widthRef.current);
    return snapRef.current ? snapPct(pct) : pct;
  });

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => onChangeRef.current(reportRef.current(e.nativeEvent.locationX)),
      onPanResponderMove: (e) => onChangeRef.current(reportRef.current(e.nativeEvent.locationX)),
    }),
  ).current;
  function onLayout(e: LayoutChangeEvent) {
    const w = e.nativeEvent.layout.width;
    widthRef.current = w;
    setWidth(w);
  }

  const clamped = Math.max(0, Math.min(100, value));
  return (
    <View style={styles.wrap} onLayout={onLayout} testID={testID} {...responder.panHandlers}>
      <View style={[styles.track, { backgroundColor: theme.lineStrong }]} />
      <View style={[styles.fill, { backgroundColor: theme.brand, width: `${clamped}%` }]} />
      {NOTCHES.map((n) => (
        <View
          key={n}
          style={[
            styles.notch,
            { left: `${n}%`, backgroundColor: n <= clamped ? theme.brand : theme.lineStrong },
          ]}
        />
      ))}
      {width > 0 ? (
        <View style={[styles.handle, { left: `${clamped}%`, backgroundColor: theme.brand, borderColor: theme.bg }]} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { height: 28, justifyContent: "center", marginVertical: 6 },
  track: { height: 3, borderRadius: 2 },
  fill: { position: "absolute", left: 0, height: 3, borderRadius: 2 },
  notch: { position: "absolute", width: 8, height: 8, borderRadius: 4, marginLeft: -4 },
  handle: { position: "absolute", width: 18, height: 18, borderRadius: 9, marginLeft: -9, borderWidth: 3 },
});
