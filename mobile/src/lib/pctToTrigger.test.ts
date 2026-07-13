import { pctToTrigger } from "./pctToTrigger";

describe("pctToTrigger", () => {
  it("is positive when the mark must rise to reach the trigger", () => {
    expect(pctToTrigger(2950, 3000)).toBeCloseTo(1.695, 2);
  });
  it("is negative when the mark must fall to reach the trigger", () => {
    expect(pctToTrigger(2950, 2900)).toBeCloseTo(-1.695, 2);
  });
});
