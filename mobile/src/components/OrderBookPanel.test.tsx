import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react-native";
import { OrderBookPanel } from "./OrderBookPanel";
import { themes } from "../theme/tokens";

const mockSubscribeOrderbook = jest.fn();
jest.mock("../lib/hyperliquid/client", () => ({
  createDetailInfoClient: jest.fn(() => ({})),
  createDetailSubsClient: jest.fn(() => ({})),
}));
jest.mock("../services/detailData", () => ({
  DetailDataService: class {
    subscribeOrderbook = mockSubscribeOrderbook;
  },
}));

const theme = themes.electrum;

describe("OrderBookPanel", () => {
  beforeEach(() => jest.clearAllMocks());

  it("shows an error + retry instead of an infinite spinner when the book subscribe fails", async () => {
    const httpErr = new Error("Unknown HTTP request error: down");
    httpErr.name = "HttpRequestError";
    mockSubscribeOrderbook.mockRejectedValueOnce(httpErr).mockResolvedValueOnce({ unsubscribe: async () => {} });
    render(<OrderBookPanel theme={theme} coin="BTC" network="mainnet" />);
    await waitFor(() => expect(screen.getByTestId("book-error")).toBeTruthy());
    fireEvent.press(screen.getByTestId("book-error-retry"));
    await waitFor(() => expect(mockSubscribeOrderbook).toHaveBeenCalledTimes(2));
  });
});
