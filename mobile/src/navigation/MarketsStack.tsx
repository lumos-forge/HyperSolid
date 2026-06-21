import React from "react";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { MarketsStackParamList } from "./types";
import { MarketsScreen } from "../screens/MarketsScreen";
import { MarketDetailScreen } from "../screens/MarketDetailScreen";
import { useTheme } from "../theme/useTheme";

const Stack = createNativeStackNavigator<MarketsStackParamList>();

function MarketsListScreen({ navigation }: NativeStackScreenProps<MarketsStackParamList, "MarketsList">) {
  return <MarketsScreen onSelectMarket={(coin) => navigation.navigate("MarketDetail", { coin })} />;
}

export function MarketsStack() {
  const theme = useTheme();
  return (
    <Stack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: theme.surface },
        headerTintColor: theme.text,
        contentStyle: { backgroundColor: theme.bg },
      }}
    >
      <Stack.Screen name="MarketsList" component={MarketsListScreen} options={{ headerShown: false }} />
      <Stack.Screen
        name="MarketDetail"
        component={MarketDetailScreen}
        options={{ headerShown: false }}
      />
    </Stack.Navigator>
  );
}
