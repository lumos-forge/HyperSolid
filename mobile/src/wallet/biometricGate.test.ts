import { BiometricGate } from "./biometricGate";

function mockLA(over: Partial<Record<string, unknown>> = {}) {
  return {
    hasHardwareAsync: jest.fn().mockResolvedValue(true),
    isEnrolledAsync: jest.fn().mockResolvedValue(true),
    supportedAuthenticationTypesAsync: jest.fn().mockResolvedValue([1, 2]),
    authenticateAsync: jest.fn().mockResolvedValue({ success: true }),
    ...over,
  };
}

describe("BiometricGate.isAvailable", () => {
  it("reports available when hardware present and enrolled", async () => {
    const gate = new BiometricGate(mockLA() as never);
    expect(await gate.isAvailable()).toEqual({
      hasHardware: true,
      isEnrolled: true,
      supportedTypes: [1, 2],
    });
  });

  it("reports not enrolled when no biometric is set up", async () => {
    const gate = new BiometricGate(mockLA({ isEnrolledAsync: jest.fn().mockResolvedValue(false) }) as never);
    expect((await gate.isAvailable()).isEnrolled).toBe(false);
  });
});

describe("BiometricGate.authenticate", () => {
  it("returns 'unavailable' when no hardware or not enrolled (no prompt)", async () => {
    const la = mockLA({ isEnrolledAsync: jest.fn().mockResolvedValue(false) });
    const gate = new BiometricGate(la as never);
    expect(await gate.authenticate({ reason: "解锁钱包" })).toBe("unavailable");
    expect(la.authenticateAsync).not.toHaveBeenCalled();
  });

  it("returns 'success' on successful auth and forces biometric (no device passcode fallback)", async () => {
    const la = mockLA();
    const gate = new BiometricGate(la as never);
    expect(await gate.authenticate({ reason: "解锁钱包" })).toBe("success");
    expect(la.authenticateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ promptMessage: "解锁钱包", disableDeviceFallback: true }),
    );
  });

  it("maps user_cancel to 'cancelled'", async () => {
    const la = mockLA({ authenticateAsync: jest.fn().mockResolvedValue({ success: false, error: "user_cancel" }) });
    const gate = new BiometricGate(la as never);
    expect(await gate.authenticate({ reason: "x" })).toBe("cancelled");
  });

  it("maps other failures to 'failed'", async () => {
    const la = mockLA({ authenticateAsync: jest.fn().mockResolvedValue({ success: false, error: "lockout" }) });
    const gate = new BiometricGate(la as never);
    expect(await gate.authenticate({ reason: "x" })).toBe("failed");
  });
});
