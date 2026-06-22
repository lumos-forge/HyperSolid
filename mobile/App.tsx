import React, { useEffect, useMemo } from "react";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { NavigationContainer } from "@react-navigation/native";
import * as LocalAuthentication from "expo-local-authentication";
import { RootNavigator } from "./src/navigation/RootNavigator";
import { LockScreen } from "./src/screens/LockScreen";
import { useLiveMarkets } from "./src/hooks/useLiveMarkets";
import { MarketDataService } from "./src/services/marketData";
import { createInfoClient, createSubsClient, createOrderStatusInfoClient } from "./src/lib/hyperliquid/client";
import { createSqlDb } from "./src/lib/storage/expoSqlDb";
import { useEnvStore } from "./src/state/envStore";
import { useAuthStore } from "./src/state/authStore";
import { useWalletStore } from "./src/state/walletStore";
import { useLedgerStore } from "./src/state/ledgerStore";
import { reconcilePendingIntents } from "./src/services/ledgerRecovery";
import { useAutoLock } from "./src/wallet/useAutoLock";
import { unlockSession } from "./src/wallet/sessionController";
import { BiometricGate } from "./src/wallet/biometricGate";
import { AlwaysTrustedIntegrity } from "./src/wallet/deviceIntegrity";
import { WalletManager } from "./src/wallet/walletManager";
import { SecureStoreKeyStore } from "./src/wallet/secureKeyStore";

const INTENT_DB_NAME = "hypersolid-intents.db";

export default function App() {
  const network = useEnvStore((s) => s.network);
  const service = useMemo(
    () => new MarketDataService(createInfoClient(network), createSubsClient(network)),
    [network],
  );
  useLiveMarkets(service);
  useAutoLock();

  // Persistent intent ledger (spec §6.2): one SQLite DB, hydrated/scoped by wallet × network so a
  // cloid idempotency ledger survives restarts. Re-scope when the active wallet or network changes.
  const walletMode = useWalletStore((s) => s.mode);
  const walletAddress = useWalletStore((s) => s.address);
  const intentDb = useMemo(() => createSqlDb(INTENT_DB_NAME), []);
  useEffect(() => {
    if (walletMode === "local" && walletAddress) {
      useLedgerStore.getState().init(intentDb, walletAddress, network);
      // §6.2 startup recovery: reconcile any pending/submitted intents by cloid against HL, so a
      // crash/kill mid-submit can't leave duplicate or orphan orders. Best-effort; never blocks UI.
      const ledger = useLedgerStore.getState().ledger;
      if (ledger) {
        void reconcilePendingIntents(ledger, createOrderStatusInfoClient(network), walletAddress)
          .finally(() => useLedgerStore.getState().bump());
      }
    } else {
      useLedgerStore.getState().reset();
    }
  }, [intentDb, walletMode, walletAddress, network]);

  const status = useAuthStore((s) => s.status);
  const manager = useMemo(() => new WalletManager(new SecureStoreKeyStore()), []);
  const gate = useMemo(() => new BiometricGate(LocalAuthentication), []);
  const integrity = useMemo(() => new AlwaysTrustedIntegrity(), []);

  useEffect(() => {
    useAuthStore.getState().evaluate(() => manager.hasWallet());
  }, [manager]);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      {status === "locked" ? (
        <LockScreen onUnlock={() => unlockSession(gate, manager, integrity)} />
      ) : (
        <NavigationContainer>
          <RootNavigator />
        </NavigationContainer>
      )}
    </SafeAreaProvider>
  );
}
