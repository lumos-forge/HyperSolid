import React from "react";
import { render, screen } from "@testing-library/react-native";
import { OfflineBanner } from "./OfflineBanner";
import { useNetStore } from "../state/netStore";

describe("OfflineBanner", () => {
  beforeEach(() => useNetStore.setState({ online: null }));

  it("renders nothing while online or unknown", () => {
    render(<OfflineBanner />);
    expect(screen.queryByTestId("offline-banner")).toBeNull();
    useNetStore.setState({ online: true });
    render(<OfflineBanner />);
    expect(screen.queryByTestId("offline-banner")).toBeNull();
  });

  it("shows the banner when offline", () => {
    useNetStore.setState({ online: false });
    render(<OfflineBanner />);
    expect(screen.getByTestId("offline-banner")).toBeTruthy();
    expect(screen.getByText(/offline/i)).toBeTruthy();
  });
});
