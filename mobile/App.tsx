import React, { useEffect, useMemo } from "react";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { NavigationContainer } from "@react-navigation/native";
import * as LocalAuthentication from "expo-local-authentication";
import { RootNavigator } from "./src/navigation/RootNavigator";
import { LockScreen } from "./src/screens/LockScreen";
import { useLiveMarkets } from "./src/hooks/useLiveMarkets";
import { MarketDataService } from "./src/services/marketData";
import { createInfoClient, createSubsClient } from "./src/lib/hyperliquid/client";
import { useEnvStore } from "./src/state/envStore";
import { useAuthStore } from "./src/state/authStore";
import { useAutoLock } from "./src/wallet/useAutoLock";
import { unlockSession } from "./src/wallet/sessionController";
import { BiometricGate } from "./src/wallet/biometricGate";
import { AlwaysTrustedIntegrity } from "./src/wallet/deviceIntegrity";
import { WalletManager } from "./src/wallet/walletManager";
import { SecureStoreKeyStore } from "./src/wallet/secureKeyStore";

export default function App() {
  const network = useEnvStore((s) => s.network);
  const service = useMemo(
    () => new MarketDataService(createInfoClient(network), createSubsClient(network)),
    [network],
  );
  useLiveMarkets(service);
  useAutoLock();

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
