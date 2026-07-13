import { detectRoutingEnv } from "./routingEnv";
import { useRoutingEnvStore } from "../state/routingEnvStore";

beforeEach(() => {
  useRoutingEnvStore.setState({ proxyRecommended: false, detected: false });
});

describe("detectRoutingEnv", () => {
  it("does not probe and does not recommend proxy outside China", async () => {
    const fetchImpl = jest.fn();
    const rec = await detectRoutingEnv({ network: "mainnet", geoCountry: "US", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(rec).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(useRoutingEnvStore.getState().proxyRecommended).toBe(false);
    expect(useRoutingEnvStore.getState().detected).toBe(true);
  });

  it("recommends proxy for China when HL is unreachable", async () => {
    const fetchImpl = jest.fn(async () => { throw new Error("blocked"); });
    const rec = await detectRoutingEnv({ network: "mainnet", geoCountry: "CN", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(rec).toBe(true);
    expect(useRoutingEnvStore.getState().proxyRecommended).toBe(true);
  });

  it("does not recommend proxy for China when HL is reachable", async () => {
    const fetchImpl = jest.fn(async () => ({ ok: true }) as Response);
    const rec = await detectRoutingEnv({ network: "mainnet", geoCountry: "cn", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(rec).toBe(false);
    expect(useRoutingEnvStore.getState().proxyRecommended).toBe(false);
  });
});
