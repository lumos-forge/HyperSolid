/** Narrow info surface: the approved builder fee rate (tenth-bps) for a user+builder. */
export interface BuilderInfoLike {
  maxBuilderFee(params: { user: `0x${string}`; builder: `0x${string}` }): Promise<number>;
}

export type BuilderApprovalStatus = "approved" | "unapproved" | "unknown";

/** Whether `user` has approved `builder` for at least `perpFeeTenthBps` (HL maxBuilderFee is tenth-bps).
 *  A thrown query → "unknown" so the caller places without a builder and does not nag. */
export async function queryBuilderApproval(
  info: BuilderInfoLike,
  user: `0x${string}`,
  builder: `0x${string}`,
  perpFeeTenthBps: number,
): Promise<BuilderApprovalStatus> {
  try {
    const approved = await info.maxBuilderFee({ user, builder });
    return approved >= perpFeeTenthBps ? "approved" : "unapproved";
  } catch {
    return "unknown";
  }
}
