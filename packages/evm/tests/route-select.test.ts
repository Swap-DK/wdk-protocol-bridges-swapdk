import { describe, it, expect } from "vitest";
import { pickBestRoute } from "@swapdk/wdk-protocol-bridge-swapdk-common";
import type { QuoteRoute } from "../src/types.js";

function route(expectedBuyAmount: string, routeId = "r"): QuoteRoute {
  return {
    routeId,
    providers: ["X"],
    sellAsset: "ETH.ETH",
    sellAmount: "1",
    buyAsset: "BTC.BTC",
    expectedBuyAmount,
    expectedBuyAmountMaxSlippage: "0",
    fees: [],
  } as unknown as QuoteRoute;
}

describe("pickBestRoute", () => {
  it("returns null for empty input", () => {
    expect(pickBestRoute([])).toBeNull();
  });

  it("returns null when all routes have zero expectedBuyAmount", () => {
    expect(pickBestRoute([route("0"), route("0")])).toBeNull();
  });

  it("returns null when all routes have invalid amounts", () => {
    expect(pickBestRoute([route("not-a-number"), route("")])).toBeNull();
  });

  it("filters out zero-amount routes and returns the remaining one", () => {
    const best = pickBestRoute([route("0", "r1"), route("100", "r2")]);
    expect(best?.routeId).toBe("r2");
  });

  it("picks the route with the highest expectedBuyAmount", () => {
    const best = pickBestRoute([
      route("10", "r1"),
      route("100", "r2"),
      route("50", "r3"),
    ]);
    expect(best?.routeId).toBe("r2");
  });

  it("handles decimal-string amounts from swap-engine", () => {
    const best = pickBestRoute([
      route("99300624.849952452900388332", "r1"),
      route("99500000.0", "r2"),
    ]);
    expect(best?.routeId).toBe("r2");
  });

  it("handles the real-world case that triggered this fix (MAYACHAIN zero + CHAINFLIP valid)", () => {
    // Reproduces the live swap-engine response where routes[0] is a zero-quote
    // MAYACHAIN fallback and routes[1] is the actual CHAINFLIP quote.
    const best = pickBestRoute([
      route("0", "maya"),
      route("99300624.85", "chainflip"),
    ]);
    expect(best?.routeId).toBe("chainflip");
  });
});
