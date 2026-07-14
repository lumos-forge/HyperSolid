import { appConfigFromEnv, geoHeadersFromEnv } from "./appConfig";

describe("appConfigFromEnv", () => {
  it("maps env vars into the app-config payload the mobile app expects", () => {
    const cfg = appConfigFromEnv({
      ARBITRUM_RPC_MAINNET: "https://arb-main.example/key",
      ARBITRUM_RPC_TESTNET: "https://arb-test.example/key",
      WITHDRAW_FEE_USDC_MAINNET: "1",
      WITHDRAW_FEE_USDC_TESTNET: "0",
      STRATEGY_API_BASE_URL: "https://api.example",
    });
    expect(cfg).toEqual({
      arbitrumRpc: { mainnet: "https://arb-main.example/key", testnet: "https://arb-test.example/key" },
      withdrawFeeUsdc: { mainnet: 1, testnet: 0 },
      strategyApiBaseUrl: "https://api.example",
    });
  });

  it("returns nulls for absent vars and ignores non-numeric fees", () => {
    const cfg = appConfigFromEnv({ WITHDRAW_FEE_USDC_MAINNET: "abc" });
    expect(cfg).toEqual({
      arbitrumRpc: { mainnet: null, testnet: null },
      withdrawFeeUsdc: { mainnet: null, testnet: null },
      strategyApiBaseUrl: null,
    });
  });
});

describe("appConfigFromEnv builder", () => {
  const ADDR = "0x" + "a".repeat(40);
  it("includes a valid builder config", () => {
    const cfg = appConfigFromEnv({ BUILDER_ADDRESS: ADDR, BUILDER_PERP_FEE_TENTH_BPS: "20" });
    expect(cfg.builder).toEqual({ address: ADDR, perpFeeTenthBps: 20 });
  });
  it("omits builder when the address is invalid", () => {
    expect(appConfigFromEnv({ BUILDER_ADDRESS: "0xnope", BUILDER_PERP_FEE_TENTH_BPS: "20" }).builder).toBeUndefined();
  });
  it("omits builder when the fee is out of [1,100] or non-integer", () => {
    expect(appConfigFromEnv({ BUILDER_ADDRESS: ADDR, BUILDER_PERP_FEE_TENTH_BPS: "0" }).builder).toBeUndefined();
    expect(appConfigFromEnv({ BUILDER_ADDRESS: ADDR, BUILDER_PERP_FEE_TENTH_BPS: "101" }).builder).toBeUndefined();
    expect(appConfigFromEnv({ BUILDER_ADDRESS: ADDR, BUILDER_PERP_FEE_TENTH_BPS: "1.5" }).builder).toBeUndefined();
  });
  it("omits builder when unset", () => {
    expect(appConfigFromEnv({}).builder).toBeUndefined();
  });
});

describe("geoHeadersFromEnv", () => {
  it("defaults to the Cloudflare headers", () => {
    expect(geoHeadersFromEnv({})).toEqual({ countryHeader: "cf-ipcountry", regionHeader: "cf-region" });
  });
  it("honors overrides", () => {
    expect(geoHeadersFromEnv({ GEO_COUNTRY_HEADER: "x-country", GEO_REGION_HEADER: "x-region" }))
      .toEqual({ countryHeader: "x-country", regionHeader: "x-region" });
  });
});
