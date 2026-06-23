import {
  JetBrainsMono_400Regular,
  JetBrainsMono_500Medium,
  JetBrainsMono_700Bold,
} from "@expo-google-fonts/jetbrains-mono";
import { SpaceMono_400Regular, SpaceMono_700Bold } from "@expo-google-fonts/space-mono";
import {
  InterTight_400Regular,
  InterTight_500Medium,
  InterTight_600SemiBold,
  InterTight_700Bold,
} from "@expo-google-fonts/inter-tight";

/**
 * The .ttf asset map fed to `useFonts(...)` at App bootstrap. Shorthand keys make each fontFamily
 * name equal to its export name (e.g. "JetBrainsMono_400Regular") — matching `fonts.ts` tokens.
 * ISOLATED: imported ONLY by App so the native font assets stay out of jest (see fonts.ts for the
 * jest-safe tokens). Same isolation pattern as expoSqlDb.ts.
 */
export const fontMap = {
  JetBrainsMono_400Regular,
  JetBrainsMono_500Medium,
  JetBrainsMono_700Bold,
  SpaceMono_400Regular,
  SpaceMono_700Bold,
  InterTight_400Regular,
  InterTight_500Medium,
  InterTight_600SemiBold,
  InterTight_700Bold,
};
