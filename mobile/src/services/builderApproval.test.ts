import { queryBuilderApproval, type BuilderInfoLike } from "./builderApproval";

const U = ("0x" + "1".repeat(40)) as `0x${string}`;
const B = ("0x" + "2".repeat(40)) as `0x${string}`;
const info = (fn: BuilderInfoLike["maxBuilderFee"]): BuilderInfoLike => ({ maxBuilderFee: fn });

describe("queryBuilderApproval", () => {
  it("approved when the on-chain rate covers the needed fee", async () => {
    expect(await queryBuilderApproval(info(async () => 100), U, B, 20)).toBe("approved");
    expect(await queryBuilderApproval(info(async () => 20), U, B, 20)).toBe("approved");
  });
  it("unapproved when the on-chain rate is below the needed fee", async () => {
    expect(await queryBuilderApproval(info(async () => 0), U, B, 20)).toBe("unapproved");
    expect(await queryBuilderApproval(info(async () => 10), U, B, 20)).toBe("unapproved");
  });
  it("unknown when the query throws", async () => {
    expect(await queryBuilderApproval(info(async () => { throw new Error("net"); }), U, B, 20)).toBe("unknown");
  });
});
