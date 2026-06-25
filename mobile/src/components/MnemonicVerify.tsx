import React, { useMemo, useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { useTheme } from "../theme/useTheme";
import { useT } from "../i18n/useT";
import { fonts } from "../theme/fonts";

export interface WordChallenge {
  /** 0-based position of the word being checked. */
  index: number;
  /** Shuffled answer + decoys. */
  options: string[];
  answer: string;
}

function take<T>(arr: T[], n: number, rand: () => number): T[] {
  const pool = [...arr];
  const out: T[] = [];
  while (out.length < n && pool.length > 0) out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  return out;
}

/**
 * Build a "confirm your backup" quiz: pick `count` distinct word positions and, for each, present the
 * correct word among `optionsPer-1` decoys drawn from the rest of the phrase. Pure + injectable RNG
 * so it's deterministically testable. Decoys never equal the answer string (all occurrences filtered).
 */
export function buildMnemonicChallenge(
  words: string[],
  count = 3,
  optionsPer = 3,
  rand: () => number = Math.random,
): WordChallenge[] {
  const indices = take(
    words.map((_, i) => i),
    Math.min(count, words.length),
    rand,
  ).sort((a, b) => a - b);
  return indices.map((index) => {
    const answer = words[index];
    const decoys = take(words.filter((w) => w !== answer), optionsPer - 1, rand);
    return { index, answer, options: take([answer, ...decoys], optionsPer, rand) };
  });
}

/** Backup-confirmation quiz shown after wallet creation, before the phrase can be dismissed. */
export function MnemonicVerify({
  mnemonic,
  onVerified,
  onBack,
  rand = Math.random,
}: {
  mnemonic: string;
  onVerified: () => void;
  onBack?: () => void;
  rand?: () => number;
}) {
  const theme = useTheme();
  const t = useT();
  const words = useMemo(() => mnemonic.trim().split(/\s+/), [mnemonic]);
  // Build the quiz once on mount — `rand` is intentionally not a dep so taps don't reshuffle it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const challenges = useMemo(() => buildMnemonicChallenge(words, 3, 3, rand), [words]);
  const [step, setStep] = useState(0);
  const [wrong, setWrong] = useState(false);
  const c = challenges[step];

  function answer(opt: string) {
    if (opt === c.answer) {
      setWrong(false);
      if (step + 1 >= challenges.length) onVerified();
      else setStep(step + 1);
    } else {
      setWrong(true);
    }
  }

  return (
    <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.line }]}>
      <Text style={[styles.title, { color: theme.text }]}>{t("account.verifyTitle")}</Text>
      <Text style={[styles.prompt, { color: theme.muted }]}>
        {t("account.verifyPrompt", { n: c.index + 1, step: step + 1, total: challenges.length })}
      </Text>
      <View style={styles.options}>
        {c.options.map((opt) => (
          <Pressable
            key={opt}
            accessibilityRole="button"
            onPress={() => answer(opt)}
            style={[styles.option, { borderColor: theme.lineStrong }]}
          >
            <Text style={[styles.optionText, { color: theme.text }]}>{opt}</Text>
          </Pressable>
        ))}
      </View>
      {wrong ? <Text style={[styles.wrong, { color: theme.down }]}>{t("account.verifyWrong")}</Text> : null}
      {onBack ? (
        <Pressable accessibilityRole="button" testID="verify-back" onPress={onBack} style={styles.backBtn}>
          <Text style={[styles.backText, { color: theme.muted }]}>{t("account.viewPhraseAgain")}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 12, padding: 16, marginBottom: 12 },
  title: { fontFamily: fonts.display.bold, fontSize: 15, marginBottom: 6 },
  prompt: { fontFamily: fonts.body.regular, fontSize: 12.5, marginBottom: 12 },
  options: { gap: 8 },
  option: { borderWidth: 1, borderRadius: 10, paddingVertical: 12, alignItems: "center" },
  optionText: { fontFamily: fonts.mono.medium, fontSize: 14 },
  wrong: { fontFamily: fonts.body.semibold, fontSize: 12, marginTop: 10 },
  backBtn: { marginTop: 12, alignItems: "center" },
  backText: { fontFamily: fonts.body.medium, fontSize: 12.5, textDecorationLine: "underline" },
});
