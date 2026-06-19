// Hermes/React Native global polyfills — MUST be imported before any code that
// uses crypto randomness (viem key generation) or web event globals
// (viem / @nktkas/hyperliquid WebSocket transport reference `Event`/`EventTarget`).
import "react-native-get-random-values";
import "event-target-polyfill";
