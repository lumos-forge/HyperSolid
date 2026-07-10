import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import { Platform } from "react-native";
import type { PushEnv, PermStatus } from "./pushRegistration";

function toStatus(s: string): PermStatus {
  return s === "granted" ? "granted" : s === "denied" ? "denied" : "undetermined";
}

/** Real PushEnv over expo-device / expo-notifications / expo-constants. Native — not unit-tested;
 *  lazy-imported by SettingsScreen so tests never load these modules. */
export function expoPushEnv(): PushEnv {
  return {
    isDevice: Device.isDevice,
    platform: Platform.OS,
    getPermissionStatus: async () => toStatus((await Notifications.getPermissionsAsync()).status),
    requestPermission: async () => toStatus((await Notifications.requestPermissionsAsync()).status),
    getExpoPushToken: async () => {
      const c = Constants as unknown as {
        expoConfig?: { extra?: { eas?: { projectId?: string } } };
        easConfig?: { projectId?: string };
      };
      const projectId = c.expoConfig?.extra?.eas?.projectId ?? c.easConfig?.projectId;
      const res = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
      return res.data;
    },
  };
}
