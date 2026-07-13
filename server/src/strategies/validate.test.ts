import { validateParams } from "./validate";

describe("validateParams", () => {
  it("accepts a valid dca", () => {
    expect(validateParams("dca", { coin: "BTC", side: "buy", quoteAmountUsdc: 50, intervalHours: 24 }).ok).toBe(true);
  });
  it("rejects dca with non-positive amount", () => {
    const r = validateParams("dca", { coin: "BTC", side: "buy", quoteAmountUsdc: 0, intervalHours: 24 });
    expect(r.ok).toBe(false);
  });
  it("rejects dca with numeric strings", () => {
    const r = validateParams("dca", { coin: "BTC", side: "buy", quoteAmountUsdc: "50", intervalHours: "24" });
    expect(r.ok).toBe(false);
  });
  it("accepts a valid twap (buy or sell)", () => {
    expect(validateParams("twap", { coin: "ETH", side: "sell", totalUsdc: 300, slices: 6, durationHours: 3 }).ok).toBe(true);
  });
  it("rejects twap with slices < 1 or non-integer", () => {
    expect(validateParams("twap", { coin: "ETH", side: "buy", totalUsdc: 300, slices: 0, durationHours: 3 }).ok).toBe(false);
    expect(validateParams("twap", { coin: "ETH", side: "buy", totalUsdc: 300, slices: 2.5, durationHours: 3 }).ok).toBe(false);
  });
  it("rejects twap with numeric strings", () => {
    expect(validateParams("twap", { coin: "ETH", side: "buy", totalUsdc: "300", slices: "6", durationHours: "3" }).ok).toBe(false);
  });
  it("accepts tpsl with one of tp/sl and rejects neither", () => {
    expect(validateParams("tpsl", { coin: "SOL", takeProfitPrice: 200 }).ok).toBe(true);
    expect(validateParams("tpsl", { coin: "SOL" }).ok).toBe(false);
  });
  it("rejects tpsl with numeric strings", () => {
    expect(validateParams("tpsl", { coin: "SOL", takeProfitPrice: "200" }).ok).toBe(false);
  });
  it("rejects an unknown kind", () => {
    expect(validateParams("nope" as never, {}).ok).toBe(false);
  });
});

describe("validateParams grid", () => {
  const ok = { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 50 };

  it("accepts a valid grid and defaults mode to longOnly", () => {
    const r = validateParams("grid", ok);
    expect(r).toEqual({ ok: true, params: { ...ok, mode: "longOnly" } });
  });
  it("accepts an explicit symmetric mode", () => {
    const r = validateParams("grid", { ...ok, mode: "symmetric" });
    expect(r).toEqual({ ok: true, params: { ...ok, mode: "symmetric" } });
  });
  it("rejects an invalid mode", () => {
    expect(validateParams("grid", { ...ok, mode: "wat" })).toEqual({ ok: false, error: "mode must be longOnly or symmetric" });
  });
  it("rejects upper <= lower", () => {
    expect(validateParams("grid", { ...ok, upperPrice: 100 }).ok).toBe(false);
  });
  it("rejects levels < 2", () => {
    expect(validateParams("grid", { ...ok, levels: 1 }).ok).toBe(false);
  });
  it("rejects a non-integer levels", () => {
    expect(validateParams("grid", { ...ok, levels: 3.5 }).ok).toBe(false);
  });
  it("rejects perLevelUsdc <= 0", () => {
    expect(validateParams("grid", { ...ok, perLevelUsdc: 0 }).ok).toBe(false);
  });
});

describe("validateParams gridLimit", () => {
  const ok = { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 50 };
  it("accepts a valid gridLimit", () => {
    expect(validateParams("gridLimit", ok)).toEqual({ ok: true, params: { ...ok, mode: "longOnly" } });
  });
  it("rejects upper <= lower", () => {
    expect(validateParams("gridLimit", { ...ok, upperPrice: 100 }).ok).toBe(false);
  });
  it("rejects levels < 2", () => {
    expect(validateParams("gridLimit", { ...ok, levels: 1 }).ok).toBe(false);
  });
  it("rejects perLevelUsdc <= 0", () => {
    expect(validateParams("gridLimit", { ...ok, perLevelUsdc: 0 }).ok).toBe(false);
  });
});

describe("validateParams gridLimit mode", () => {
  const base = { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 6, perLevelUsdc: 50 };
  it("defaults mode to longOnly when omitted", () => {
    const r = validateParams("gridLimit", base);
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.params as any).mode).toBe("longOnly");
  });
  it("accepts symmetric", () => {
    const r = validateParams("gridLimit", { ...base, mode: "symmetric" });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.params as any).mode).toBe("symmetric");
  });
  it("rejects an unknown mode", () => {
    const r = validateParams("gridLimit", { ...base, mode: "wat" });
    expect(r.ok).toBe(false);
  });
});

describe("validateParams deadMan opt-in", () => {
  it("threads deadMan:true into dca params", () => {
    const r = validateParams("dca", { coin: "BTC", side: "buy", quoteAmountUsdc: 50, intervalHours: 24, deadMan: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.params as { deadMan?: boolean }).deadMan).toBe(true);
  });
  it("threads deadMan:true into gridLimit params", () => {
    const r = validateParams("gridLimit", { coin: "BTC", lowerPrice: 100, upperPrice: 200, levels: 4, perLevelUsdc: 50, deadMan: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.params as { deadMan?: boolean }).deadMan).toBe(true);
  });
  it("omits deadMan when absent or false (default off)", () => {
    const a = validateParams("dca", { coin: "BTC", side: "buy", quoteAmountUsdc: 50, intervalHours: 24 });
    const b = validateParams("dca", { coin: "BTC", side: "buy", quoteAmountUsdc: 50, intervalHours: 24, deadMan: false });
    expect(a.ok && !("deadMan" in a.params)).toBe(true);
    expect(b.ok && !("deadMan" in b.params)).toBe(true);
  });
  it("rejects a non-boolean deadMan", () => {
    const r = validateParams("dca", { coin: "BTC", side: "buy", quoteAmountUsdc: 50, intervalHours: 24, deadMan: "yes" });
    expect(r.ok).toBe(false);
  });
});

describe("validateParams trailing", () => {
  it("accepts a valid trailing config", () => {
    const r = validateParams("trailing", { coin: "BTC", trailPct: 5 });
    expect(r).toEqual({ ok: true, params: { coin: "BTC", trailPct: 5 } });
  });

  it("carries deadMan through", () => {
    const r = validateParams("trailing", { coin: "BTC", trailPct: 5, deadMan: true });
    expect(r).toEqual({ ok: true, params: { coin: "BTC", trailPct: 5, deadMan: true } });
  });

  it("rejects a non-positive or out-of-range trailPct", () => {
    expect(validateParams("trailing", { coin: "BTC", trailPct: 0 }).ok).toBe(false);
    expect(validateParams("trailing", { coin: "BTC", trailPct: 100 }).ok).toBe(false);
    expect(validateParams("trailing", { coin: "BTC", trailPct: "5" }).ok).toBe(false);
  });

  it("rejects a missing coin", () => {
    expect(validateParams("trailing", { trailPct: 5 }).ok).toBe(false);
  });
});

describe("validateParams conditional", () => {
  it("accepts a valid conditional config (above buy)", () => {
    const r = validateParams("conditional", { coin: "BTC", side: "buy", sizeUsdc: 100, triggerPrice: 30000, triggerDirection: "above" });
    expect(r).toEqual({ ok: true, params: { coin: "BTC", side: "buy", sizeUsdc: 100, triggerPrice: 30000, triggerDirection: "above" } });
  });

  it("accepts a below sell with deadMan", () => {
    const r = validateParams("conditional", { coin: "ETH", side: "sell", sizeUsdc: 50, triggerPrice: 2000, triggerDirection: "below", deadMan: true });
    expect(r).toEqual({ ok: true, params: { coin: "ETH", side: "sell", sizeUsdc: 50, triggerPrice: 2000, triggerDirection: "below", deadMan: true } });
  });

  it("rejects a bad side / size / price / direction / coin", () => {
    expect(validateParams("conditional", { coin: "BTC", side: "long", sizeUsdc: 100, triggerPrice: 30000, triggerDirection: "above" }).ok).toBe(false);
    expect(validateParams("conditional", { coin: "BTC", side: "buy", sizeUsdc: 0, triggerPrice: 30000, triggerDirection: "above" }).ok).toBe(false);
    expect(validateParams("conditional", { coin: "BTC", side: "buy", sizeUsdc: 100, triggerPrice: 0, triggerDirection: "above" }).ok).toBe(false);
    expect(validateParams("conditional", { coin: "BTC", side: "buy", sizeUsdc: 100, triggerPrice: 30000, triggerDirection: "sideways" }).ok).toBe(false);
    expect(validateParams("conditional", { side: "buy", sizeUsdc: 100, triggerPrice: 30000, triggerDirection: "above" }).ok).toBe(false);
  });
});
