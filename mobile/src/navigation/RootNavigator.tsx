import React from "react";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { MarketsStack } from "./MarketsStack";
import { TradeScreen } from "../screens/TradeScreen";
import { PositionsScreen } from "../screens/PositionsScreen";
import { AgentScreen } from "../screens/AgentScreen";
import { AccountScreen } from "../screens/AccountScreen";
import { useTheme } from "../theme/useTheme";
import { Icon, type IconName } from "../components/Icon";

const Tab = createBottomTabNavigator();

export const TABS: {
  name: string;
  label: string;
  icon: IconName;
  component: React.ComponentType<object>;
}[] = [
  { name: "Markets", label: "Markets", icon: "markets", component: MarketsStack },
  { name: "Trade", label: "Trade", icon: "trade", component: TradeScreen },
  { name: "Positions", label: "Positions", icon: "positions", component: PositionsScreen },
  { name: "Agent", label: "Strategy", icon: "agent", component: AgentScreen },
  { name: "Account", label: "Wallet", icon: "account", component: AccountScreen },
];

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
            tabBarIcon: ({ color, focused }) => (
              <Icon name={t.icon} color={color} active={focused} size={24} />
            ),
          }}
        />
      ))}
    </Tab.Navigator>
  );
}
