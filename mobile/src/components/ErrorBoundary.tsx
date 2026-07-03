import React from "react";
import { View, Text, StyleSheet } from "react-native";

interface Props {
  children: React.ReactNode;
  /** Reporter for caught render errors (default wired to Sentry at the app root). */
  onError?: (error: Error) => void;
}
interface State { hasError: boolean }

/** Catches render-time crashes so the whole app doesn't white-screen; reports via `onError`. */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }
  componentDidCatch(error: Error): void {
    this.props.onError?.(error);
  }
  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <View style={styles.fallback} testID="error-fallback">
          <Text style={styles.text}>Something went wrong.</Text>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  fallback: { flex: 1, alignItems: "center", justifyContent: "center" },
  text: { fontSize: 15 },
});
