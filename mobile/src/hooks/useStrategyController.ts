import { useCallback, useEffect, useState } from "react";
import type { StrategyApi, Strategy, DcaParams, TwapParams, TpslParams, AgentStatus, Activity } from "../services/strategyApi";
import type { ApproveAgentResult } from "../services/exchange";

type ApproveAgentFn = (req: { agentAddress: string; agentName?: string }) => Promise<ApproveAgentResult>;

/**
 * Control-plane logic for the Strategy tab: load agent status + strategies, run the agent-approval
 * flow (provision → sign approveAgent with the main key → confirm), and manage DCA strategies. Pure
 * orchestration over an injected `StrategyApi` + `approveAgent` — testable without the screen.
 */
export function useStrategyController(api: StrategyApi, approveAgent: ApproveAgentFn, agentName: string) {
  const [status, setStatus] = useState<AgentStatus>({ approved: false });
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [s, list, acts] = await Promise.all([api.agentStatus(), api.listStrategies(), api.getRecentActivity()]);
    setStatus(s);
    setStrategies(list);
    setActivity(acts);
  }, [api]);

  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

  const approveAgentFlow = useCallback(async (): Promise<ApproveAgentResult> => {
    setBusy(true);
    try {
      const { agentAddress } = await api.provisionAgent();
      const res = await approveAgent({ agentAddress, agentName });
      if (!res.ok) return res;
      await api.confirmAgent(agentAddress);
      await refresh();
      return res;
    } finally {
      setBusy(false);
    }
  }, [api, approveAgent, agentName, refresh]);

  const revoke = useCallback(async () => {
    await api.revokeAgent();
    await refresh();
  }, [api, refresh]);

  const createDca = useCallback(async (params: DcaParams) => {
    await api.createStrategy("dca", params);
    await refresh();
  }, [api, refresh]);

  const createTwap = useCallback(async (params: TwapParams) => {
    await api.createStrategy("twap", params);
    await refresh();
  }, [api, refresh]);

  const createTpsl = useCallback(async (params: TpslParams) => {
    await api.createStrategy("tpsl", params);
    await refresh();
  }, [api, refresh]);

  const toggle = useCallback(
    async (s: Strategy) => {
      await api.setStrategyStatus(s.id, s.status === "running" ? "paused" : "running");
      await refresh();
    },
    [api, refresh],
  );

  const killAll = useCallback(async () => {
    await api.killSwitch();
    await refresh();
  }, [api, refresh]);

  return { approved: status.approved, status, strategies, activity, busy, approveAgentFlow, revoke, createDca, createTwap, createTpsl, toggle, killAll, refresh };
}
