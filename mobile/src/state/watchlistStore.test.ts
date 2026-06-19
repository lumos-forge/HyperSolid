import { useWatchlistStore } from "./watchlistStore";

describe("watchlistStore", () => {
  beforeEach(() => useWatchlistStore.setState({ coins: [] }));

  it("starts empty", () => {
    expect(useWatchlistStore.getState().coins).toEqual([]);
    expect(useWatchlistStore.getState().isFavorite("BTC")).toBe(false);
  });

  it("toggles a coin on and off", () => {
    useWatchlistStore.getState().toggle("BTC");
    expect(useWatchlistStore.getState().isFavorite("BTC")).toBe(true);
    useWatchlistStore.getState().toggle("BTC");
    expect(useWatchlistStore.getState().isFavorite("BTC")).toBe(false);
  });

  it("keeps multiple favorites", () => {
    useWatchlistStore.getState().toggle("BTC");
    useWatchlistStore.getState().toggle("ETH");
    expect(useWatchlistStore.getState().coins).toEqual(["BTC", "ETH"]);
  });
});
