import React from "react";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { MarketsStack } from "./MarketsStack";
import { TradeScreen } from "../screens/TradeScreen";
import { PositionsScreen } from "../screens/PositionsScreen";
import { AgentScreen } from "../screens/AgentScreen";
import { AccountScreen } from "../screens/AccountScreen";
import { useTheme } from "../theme/useTheme";
import { useT } from "../i18n/useT";
import type { TranslationKey } from "../i18n/messages";
import { Icon, type IconName } from "../components/Icon";

const Tab = createBottomTabNavigator();

export const TABS: {
  name: string;
  labelKey: TranslationKey;
  icon: IconName;
  component: React.ComponentType<object>;
}[] = [
  { name: "Markets", labelKey: "tab.markets", icon: "markets", component: MarketsStack },
  { name: "Trade", labelKey: "tab.trade", icon: "trade", component: TradeScreen },
  { name: "Positions", labelKey: "tab.positions", icon: "positions", component: PositionsScreen },
  { name: "Agent", labelKey: "tab.strategy", icon: "agent", component: AgentScreen },
  { name: "Account", labelKey: "tab.wallet", icon: "account", component: AccountScreen },
];

export function RootNavigator() {
  const theme = useTheme();
  const t = useT();
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.brand,
        tabBarInactiveTintColor: theme.muted,
        tabBarStyle: { backgroundColor: theme.surface, borderTopColor: theme.line },
        sceneStyle: { backgroundColor: theme.bg },
      }}
    >
      {TABS.map((tab) => (
        <Tab.Screen
          key={tab.name}
          name={tab.name}
          component={tab.component}
          options={{
            tabBarLabel: t(tab.labelKey),
            tabBarIcon: ({ color, focused }) => (
              <Icon name={tab.icon} color={color} active={focused} size={24} />
            ),
          }}
        />
      ))}
    </Tab.Navigator>
  );
}
