import React from "react";
import { Text } from "react-native";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { MarketsStack } from "./MarketsStack";
import { TradeScreen } from "../screens/TradeScreen";
import { PositionsScreen } from "../screens/PositionsScreen";
import { AgentScreen } from "../screens/AgentScreen";
import { AccountScreen } from "../screens/AccountScreen";
import { useTheme } from "../theme/useTheme";

const Tab = createBottomTabNavigator();

export const TABS = [
  { name: "Markets", label: "行情", icon: "📈", component: MarketsStack },
  { name: "Trade", label: "交易", icon: "⚡", component: TradeScreen },
  { name: "Positions", label: "持仓", icon: "💼", component: PositionsScreen },
  { name: "Agent", label: "策略", icon: "🤖", component: AgentScreen },
  { name: "Account", label: "钱包", icon: "👤", component: AccountScreen },
] as const;

export function RootNavigator() {
  const theme = useTheme();
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
      {TABS.map((t) => (
        <Tab.Screen
          key={t.name}
          name={t.name}
          component={t.component}
          options={{
            tabBarLabel: t.label,
            tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 18 }}>{t.icon}</Text>,
          }}
        />
      ))}
    </Tab.Navigator>
  );
}
