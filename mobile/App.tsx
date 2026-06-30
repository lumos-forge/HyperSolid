import React, { useEffect, useMemo } from "react";
import { StatusBar } from "expo-status-bar";
import { useFonts } from "expo-font";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { NavigationContainer } from "@react-navigation/native";
import * as LocalAuthentication from "expo-local-authentication";
import { RootNavigator } from "./src/navigation/RootNavigator";
import { LockScreen } from "./src/screens/LockScreen";
import { PinSetupScreen } from "./src/screens/PinSetupScreen";
import { WelcomeScreen } from "./src/screens/WelcomeScreen";
import { Toast } from "./src/components/Toast";
import { fontMap } from "./src/theme/fontAssets";
import { useLiveMarkets } from "./src/hooks/useLiveMarkets";
import { MarketDataService } from "./src/services/marketData";
import { createInfoClient, createSubsClient, createOrderStatusInfoClient } from "./src/lib/hyperliquid/client";
import { createSqlDb } from "./src/lib/storage/expoSqlDb";
import { useEnvStore } from "./src/state/envStore";
import { useAuthStore } from "./src/state/authStore";
import { useWalletStore } from "./src/state/walletStore";
import { useOnboardingStore } from "./src/state/onboardingStore";
import { useLockPrefsStore } from "./src/state/lockPrefsStore";
import { useThemeStore } from "./src/state/themeStore";
import { useLocaleStore } from "./src/state/localeStore";
import { useLedgerStore } from "./src/state/ledgerStore";
import { reconcilePendingIntents } from "./src/services/ledgerRecovery";
import { hydrateRuntimeConfig } from "./src/services/appConfig";
import { useAutoLock } from "./src/wallet/useAutoLock";
import { unlockSession, unlockWithPin, recoverFromLock } from "./src/wallet/sessionController";
import { BiometricGate } from "./src/wallet/biometricGate";
import { AlwaysTrustedIntegrity } from "./src/wallet/deviceIntegrity";
import { WalletManager } from "./src/wallet/walletManager";
import { SecureStoreKeyStore } from "./src/wallet/secureKeyStore";
import { PinStore } from "./src/wallet/pinStore";

const INTENT_DB_NAME = "hypersolid-intents.db";

export default function App() {
  // v8 type system: JetBrains Mono / Space Mono / Inter Tight, loaded app-wide. On font-CDN error
  // we proceed with system-font fallback rather than block the app.
  const [fontsLoaded, fontError] = useFonts(fontMap);

  const network = useEnvStore((s) => s.network);
  const service = useMemo(
    () => new MarketDataService(createInfoClient(network), createSubsClient(network)),
    [network],
  );
  useLiveMarkets(service);
  useAutoLock();

  // Server-delivered runtime config (RPC keys etc. — never embedded in the bundle). Best-effort at
  // startup; the backend base URL is not secret. Deposits block clearly until the RPC arrives.
  useEffect(() => {
    const baseUrl = process.env.EXPO_PUBLIC_APP_CONFIG_URL;
    if (baseUrl) void hydrateRuntimeConfig(baseUrl);
  }, []);

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
  const welcomeSeen = useOnboardingStore((s) => s.welcomeSeen);
  const startTab = useOnboardingStore((s) => s.startTab);
  const dismissWelcome = useOnboardingStore((s) => s.dismiss);
  const biometricEnabled = useLockPrefsStore((s) => s.biometricEnabled);
  const manager = useMemo(() => new WalletManager(new SecureStoreKeyStore()), []);
  const pinStore = useMemo(() => new PinStore(), []);
  const gate = useMemo(() => new BiometricGate(LocalAuthentication), []);
  const integrity = useMemo(() => new AlwaysTrustedIntegrity(), []);

  useEffect(() => {
    void useLockPrefsStore.getState().hydrate();
    void useThemeStore.getState().hydrate();
    void useLocaleStore.getState().hydrate();
    void useEnvStore.getState().hydrate();
    useAuthStore.getState().evaluate(
      () => manager.hasWallet(),
      () => pinStore.hasPin(),
    );
  }, [manager, pinStore]);

  // Hold first paint until fonts are ready (avoids a system→custom font flash); never block on error.
  if (!fontsLoaded && !fontError) return null;

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      {status === "locked" ? (
        <LockScreen
          onUnlockBiometric={() => unlockSession(gate, manager, integrity)}
          onUnlockPin={(pin) => unlockWithPin(pinStore, manager, integrity, pin)}
          biometricEnabled={biometricEnabled}
          onRecover={() => recoverFromLock(manager, pinStore)}
        />
      ) : status === "needsPinSetup" ? (
        <PinSetupScreen pinStore={pinStore} manager={manager} gate={gate} />
      ) : status === "noWallet" && !welcomeSeen ? (
        <WelcomeScreen
          onGetStarted={() => dismissWelcome("Account")}
          onBrowse={() => dismissWelcome("Markets")}
        />
      ) : (
        <NavigationContainer>
          <RootNavigator initialTab={startTab} />
        </NavigationContainer>
      )}
      <Toast />
    </SafeAreaProvider>
  );
}
