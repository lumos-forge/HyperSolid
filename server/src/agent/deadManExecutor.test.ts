import { makeDeadManExecutor, type DeadManClientLike } from "./deadManExecutor";

function deps(client: DeadManClientLike | undefined, shadowVerify?: (kind: string, params: unknown) => void) {
  return { clientFor: () => client, shadowVerify };
}

describe("makeDeadManExecutor.arm", () => {
  it("sends scheduleCancel with the target time and returns true", async () => {
    const calls: any[] = [];
    const client: DeadManClientLike = { scheduleCancel: async (p) => { calls.push(p); return {}; } };
    const exec = makeDeadManExecutor(deps(client));
    expect(await exec.arm("0xo", 1_700_000_060_000)).toBe(true);
    expect(calls[0]).toEqual({ time: 1_700_000_060_000 });
  });
  it("returns false with no client (fail-closed)", async () => {
    const exec = makeDeadManExecutor(deps(undefined));
    expect(await exec.arm("0xo", 1_700_000_060_000)).toBe(false);
  });
  it("returns false when scheduleCancel throws (fail-closed, no record)", async () => {
    const client: DeadManClientLike = { scheduleCancel: async () => { throw new Error("rate limited"); } };
    const exec = makeDeadManExecutor(deps(client));
    expect(await exec.arm("0xo", 1_700_000_060_000)).toBe(false);
  });
  it("shadow-verifies the scheduleCancel time, fire-and-forget", async () => {
    const shadow = jest.fn();
    const client: DeadManClientLike = { scheduleCancel: async () => ({}) };
    const exec = makeDeadManExecutor(deps(client, shadow));
    await exec.arm("0xo", 1_700_000_060_000);
    expect(shadow).toHaveBeenCalledWith("scheduleCancel", { time: 1_700_000_060_000 });
  });
  it("a throwing shadowVerify never affects the arm", async () => {
    const client: DeadManClientLike = { scheduleCancel: async () => ({}) };
    const exec = makeDeadManExecutor(deps(client, () => { throw new Error("shadow boom"); }));
    expect(await exec.arm("0xo", 1_700_000_060_000)).toBe(true);
  });
});

describe("makeDeadManExecutor.clear", () => {
  it("sends scheduleCancel with no time (clear) and returns true", async () => {
    const calls: any[] = [];
    const client: DeadManClientLike = { scheduleCancel: async (p) => { calls.push(p); return {}; } };
    const exec = makeDeadManExecutor(deps(client));
    expect(await exec.clear("0xo")).toBe(true);
    expect(calls[0]).toEqual({});
  });
  it("returns false with no client (fail-closed)", async () => {
    const exec = makeDeadManExecutor(deps(undefined));
    expect(await exec.clear("0xo")).toBe(false);
  });
  it("returns false when scheduleCancel throws", async () => {
    const client: DeadManClientLike = { scheduleCancel: async () => { throw new Error("boom"); } };
    const exec = makeDeadManExecutor(deps(client));
    expect(await exec.clear("0xo")).toBe(false);
  });
  it("shadow-verifies the clear (empty payload), fire-and-forget", async () => {
    const shadow = jest.fn();
    const client: DeadManClientLike = { scheduleCancel: async () => ({}) };
    const exec = makeDeadManExecutor(deps(client, shadow));
    await exec.clear("0xo");
    expect(shadow).toHaveBeenCalledWith("scheduleCancel", {});
  });
});
