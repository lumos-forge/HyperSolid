export type IntegrityStatus = "trusted" | "compromised" | "unknown";

/**
 * Device-integrity (RASP) gate consulted before unlocking the wallet or signing.
 * A `compromised` result (rooted / jailbroken device) must block all signing.
 * The real root/jailbreak detection (e.g. jail-monkey) ships as a separate
 * hardening slice and is injected here without reworking consumers.
 */
export interface DeviceIntegrity {
  check(): Promise<IntegrityStatus>;
}

/** Default no-op implementation: trusts the device. Replaced by a RASP-backed impl later. */
export class AlwaysTrustedIntegrity implements DeviceIntegrity {
  async check(): Promise<IntegrityStatus> {
    return "trusted";
  }
}
