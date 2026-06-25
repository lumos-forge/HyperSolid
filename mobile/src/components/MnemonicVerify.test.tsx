import React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react-native";
import { MnemonicVerify, buildMnemonicChallenge } from "./MnemonicVerify";
import { useLocaleStore } from "../state/localeStore";

const WORDS =
  "abandon ability able about above absent absorb abstract absurd abuse access accident".split(" ");

// Deterministic RNG factory: identical fresh sequence each call so building the expected challenge
// and feeding the component produce the same quiz.
const makeRng = () => {
  const vals = [0.05, 0.42, 0.78, 0.21, 0.63, 0.11, 0.9, 0.33, 0.5, 0.7, 0.15, 0.88];
  let i = 0;
  return () => vals[i++ % vals.length];
};

describe("buildMnemonicChallenge", () => {
  it("produces `count` challenges, each with the correct answer among distinct options", () => {
    const ch = buildMnemonicChallenge(WORDS, 3, 3, makeRng());
    expect(ch).toHaveLength(3);
    for (const c of ch) {
      expect(WORDS[c.index]).toBe(c.answer);
      expect(c.options).toContain(c.answer);
      expect(c.options).toHaveLength(3);
      expect(new Set(c.options).size).toBe(3);
    }
    expect(new Set(ch.map((c) => c.index)).size).toBe(3);
  });

  it("never uses the answer as a decoy (random fuzz)", () => {
    for (let r = 0; r < 25; r++) {
      for (const c of buildMnemonicChallenge(WORDS, 3, 3, Math.random)) {
        expect(c.options.filter((o) => o === c.answer)).toHaveLength(1);
      }
    }
  });
});

describe("MnemonicVerify", () => {
  beforeEach(() => act(() => useLocaleStore.getState().setLocale("en")));

  it("calls onVerified after every sampled word is answered correctly", () => {
    const onVerified = jest.fn();
    const expected = buildMnemonicChallenge(WORDS, 3, 3, makeRng());
    render(<MnemonicVerify mnemonic={WORDS.join(" ")} onVerified={onVerified} rand={makeRng()} />);
    for (const c of expected) {
      expect(onVerified).not.toHaveBeenCalled();
      fireEvent.press(screen.getByText(c.answer));
    }
    expect(onVerified).toHaveBeenCalledTimes(1);
  });

  it("shows an error and does not advance on a wrong tap", () => {
    const onVerified = jest.fn();
    const expected = buildMnemonicChallenge(WORDS, 3, 3, makeRng());
    render(<MnemonicVerify mnemonic={WORDS.join(" ")} onVerified={onVerified} rand={makeRng()} />);
    const decoy = expected[0].options.find((o) => o !== expected[0].answer)!;
    fireEvent.press(screen.getByText(decoy));
    expect(screen.getByText(/Not quite/)).toBeTruthy();
    expect(onVerified).not.toHaveBeenCalled();
  });

  it("offers a back-out to view the phrase again when onBack is provided", () => {
    const onBack = jest.fn();
    render(<MnemonicVerify mnemonic={WORDS.join(" ")} onVerified={jest.fn()} onBack={onBack} rand={makeRng()} />);
    fireEvent.press(screen.getByTestId("verify-back"));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("omits the back-out when onBack is not provided", () => {
    render(<MnemonicVerify mnemonic={WORDS.join(" ")} onVerified={jest.fn()} rand={makeRng()} />);
    expect(screen.queryByTestId("verify-back")).toBeNull();
  });
});
