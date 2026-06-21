import { AlwaysTrustedIntegrity, type DeviceIntegrity, type IntegrityStatus } from "./deviceIntegrity";

describe("AlwaysTrustedIntegrity", () => {
  it("reports trusted by default (no native RASP wired yet)", async () => {
    const integrity: DeviceIntegrity = new AlwaysTrustedIntegrity();
    expect(await integrity.check()).toBe("trusted");
  });

  it("conforms to the DeviceIntegrity interface so a real impl can be injected", async () => {
    const compromised: DeviceIntegrity = { check: async (): Promise<IntegrityStatus> => "compromised" };
    expect(await compromised.check()).toBe("compromised");
  });
});
