import { useDepositIntentStore } from "./depositIntentStore";

describe("depositIntentStore", () => {
  beforeEach(() => useDepositIntentStore.setState({ requested: false }));

  it("request sets the flag; consume returns it once then clears", () => {
    expect(useDepositIntentStore.getState().requested).toBe(false);
    useDepositIntentStore.getState().request();
    expect(useDepositIntentStore.getState().requested).toBe(true);
    expect(useDepositIntentStore.getState().consume()).toBe(true);
    expect(useDepositIntentStore.getState().requested).toBe(false);
    expect(useDepositIntentStore.getState().consume()).toBe(false);
  });
});
