import React from "react";
import Svg, { Path, Polyline, Circle, Rect } from "react-native-svg";

export type IconName =
  | "markets"
  | "trade"
  | "positions"
  | "agent"
  | "account"
  | "star"
  | "key"
  | "alert"
  | "swap"
  | "chevron"
  | "chevronRight"
  | "arrowRight"
  | "eye"
  | "lock"
  | "search"
  | "grid"
  | "repeat"
  | "bolt"
  | "shield"
  | "plus";

export interface IconProps {
  name: IconName;
  color: string;
  size?: number;
  active?: boolean;
  strokeWidth?: number;
}

/**
 * Monoline icon set in the phosphor / oscilloscope house style.
 * Every glyph lives on a 24px grid with a single stroke weight and is tinted
 * via `color`, so the whole UI stays visually consistent and theme-aware.
 */
export function Icon({ name, color, size = 24, active = false, strokeWidth = 1.7 }: IconProps) {
  const fillSolid = { fill: color, stroke: "none" as const };
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {renderGlyph(name, color, active, fillSolid)}
    </Svg>
  );
}

function renderGlyph(
  name: IconName,
  color: string,
  active: boolean,
  fillSolid: { fill: string; stroke: "none" },
) {
  switch (name) {
    case "markets":
      return (
        <>
          <Polyline points="2,14 6,14 8.5,8 11,17 13.5,6 16,14 22,14" />
          {active ? <Circle cx={13.5} cy={6} r={1.7} {...fillSolid} /> : null}
        </>
      );
    case "trade":
      return (
        <>
          <Path d="M8 20V5" />
          <Path d="M4.5 8.5 8 5l3.5 3.5" />
          <Path d="M16 4v15" />
          <Path d="M12.5 15.5 16 19l3.5-3.5" />
        </>
      );
    case "positions":
      return (
        <>
          <Path d="M12 3 21 8 12 13 3 8Z" />
          <Path d="M3 12.5 12 17.5 21 12.5" />
        </>
      );
    case "agent":
      return (
        <>
          <Circle cx={12} cy={12} r={7.5} />
          <Circle cx={12} cy={12} r={2.6} {...(active ? fillSolid : {})} />
          <Path d="M12 1.5V4.5" />
          <Path d="M12 19.5V22.5" />
          <Path d="M1.5 12H4.5" />
          <Path d="M19.5 12H22.5" />
        </>
      );
    case "account":
      return (
        <>
          <Rect x={3} y={6} width={18} height={13} rx={2.5} />
          <Path d="M3 10h18" />
          <Circle cx={16.5} cy={14.5} r={1.3} {...fillSolid} />
        </>
      );
    case "star":
      return (
        <Path
          d="M12 3.6 14.55 9.1 20.6 9.8 16.1 14 17.4 20 12 16.9 6.6 20 7.9 14 3.4 9.8 9.45 9.1Z"
          {...(active ? { fill: color } : {})}
        />
      );
    case "key":
      return (
        <>
          <Circle cx={8} cy={8} r={4.2} />
          <Path d="M11 11 20 20" />
          <Path d="M17.5 17.5 19.5 15.5" />
          <Path d="M15.2 15.2 17 13.4" />
        </>
      );
    case "alert":
      return (
        <>
          <Path d="M12 3 19.5 5.8V11c0 4.6-3.2 7.9-7.5 9.3C7.7 18.9 4.5 15.6 4.5 11V5.8Z" />
          <Path d="M12 8.5V12.6" />
          <Path d="M12 16h.01" />
        </>
      );
    case "swap":
      return (
        <>
          <Path d="M4 9h13" />
          <Path d="M14 6 17 9 14 12" />
          <Path d="M20 15H7" />
          <Path d="M10 12 7 15 10 18" />
        </>
      );
    case "chevron":
      return <Path d="M14.5 6 9 12l5.5 6" />;
    case "chevronRight":
      return <Path d="M9 6l6 6-6 6" />;
    case "grid":
      return (
        <>
          <Rect x={3} y={3} width={7} height={7} rx={1.5} />
          <Rect x={14} y={3} width={7} height={7} rx={1.5} />
          <Rect x={3} y={14} width={7} height={7} rx={1.5} />
          <Rect x={14} y={14} width={7} height={7} rx={1.5} />
        </>
      );
    case "repeat":
      return (
        <>
          <Path d="M4 9a6 6 0 0 1 6-6h7" />
          <Path d="M14 1l3 2-3 2" />
          <Path d="M20 15a6 6 0 0 1-6 6H7" />
          <Path d="M10 23l-3-2 3-2" />
        </>
      );
    case "bolt":
      return <Path d="M13 2 5 13h6l-1 9 8-12h-6z" {...(active ? fillSolid : {})} />;
    case "shield":
      return (
        <>
          <Path d="M12 3 19 6v5c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V6Z" />
          <Path d="M9 12l2 2 4-4" />
        </>
      );
    case "plus":
      return <Path d="M12 5v14M5 12h14" />;
    case "arrowRight":
      return (
        <>
          <Path d="M4 12h15" />
          <Path d="M13 6l6 6-6 6" />
        </>
      );
    case "eye":
      return (
        <>
          <Path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Z" />
          <Circle cx={12} cy={12} r={2.6} />
        </>
      );
    case "lock":
      return (
        <>
          <Rect x={4.5} y={10.5} width={15} height={10} rx={2.2} />
          <Path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
          <Circle cx={12} cy={15.2} r={1.1} {...fillSolid} />
        </>
      );
    case "search":
      return (
        <>
          <Circle cx={10.5} cy={10.5} r={6.5} />
          <Path d="M20 20 15.5 15.5" />
        </>
      );
    default:
      return null;
  }
}
