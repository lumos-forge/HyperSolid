import { observeTick, incTick, setStrategies, incDeadManHealth, observeSignerRequest, metricsText, resetMetrics } from "./metrics";

describe("engine metrics", () => {
  beforeEach(() => resetMetrics());

  it("records tick, strategies, dead-man, and signer metrics into the registry text", async () => {
    observeTick(0.02);
    incTick("ok");
    incTick("error");
    setStrategies({ running: 3, paused: 1 });
    incDeadManHealth("alert");
    observeSignerRequest("sign", "ok", 0.01);

    const text = await metricsText();
    expect(text).toContain('hypersolid_engine_ticks_total{result="ok"} 1');
    expect(text).toContain('hypersolid_engine_ticks_total{result="error"} 1');
    expect(text).toContain('hypersolid_engine_strategies{status="running"} 3');
    expect(text).toContain('hypersolid_engine_deadman_health_events_total{event="alert"} 1');
    expect(text).toContain('hypersolid_engine_signer_requests_total{op="sign",result="ok"} 1');
    expect(text).toContain("hypersolid_engine_tick_duration_seconds");
  });

  it("is fail-safe on a bad value (never throws)", () => {
    expect(() => observeTick(NaN)).not.toThrow();
    expect(() => setStrategies({} as Record<string, number>)).not.toThrow();
  });
});
