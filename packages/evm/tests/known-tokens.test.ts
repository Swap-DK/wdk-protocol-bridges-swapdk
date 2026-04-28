import { describe, it, expect, afterEach } from "vitest";
import { lookupToken, registerToken, KNOWN_TOKENS } from "@swapdk/wdk-protocol-bridge-swapdk-common";
import { SwapDKUserError } from "@swapdk/wdk-protocol-bridge-swapdk-common";
import { toSwapKitAsset, getAssetDecimals } from "../src/asset-map.js";

describe("lookupToken", () => {
  it("finds USDC on ethereum", () => {
    expect(lookupToken("ethereum", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"))
      .toEqual({ symbol: "USDC", decimals: 6 });
  });

  it("is case-insensitive on the address", () => {
    expect(lookupToken("ethereum", "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"))
      .toEqual({ symbol: "USDC", decimals: 6 });
  });

  it("is case-insensitive on the chain", () => {
    expect(lookupToken("Ethereum", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"))
      .toEqual({ symbol: "USDC", decimals: 6 });
  });

  it("finds WETH on ethereum with 18 decimals", () => {
    expect(lookupToken("ethereum", "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"))
      .toEqual({ symbol: "WETH", decimals: 18 });
  });

  it("finds bridged USDC.e on arbitrum", () => {
    expect(lookupToken("arbitrum", "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8"))
      .toEqual({ symbol: "USDC", decimals: 6 });
  });

  it("returns undefined for unknown address", () => {
    expect(lookupToken("ethereum", "0x0123456789012345678901234567890123456789"))
      .toBeUndefined();
  });

  it("returns undefined for unknown chain", () => {
    expect(lookupToken("solana", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"))
      .toBeUndefined();
  });

  it("covers all documented source chains", () => {
    for (const chain of ["ethereum", "arbitrum", "base", "bsc", "avalanche", "optimism", "polygon"]) {
      expect(Object.keys(KNOWN_TOKENS[chain] ?? {}).length).toBeGreaterThan(0);
    }
  });
});

describe("registerToken", () => {
  // Test fixture: a plausible but non-shipped token (FRAX on Ethereum).
  // Cleaned up after each test so we don't pollute other suites.
  const FRAX = "0x853d955aCEf822Db058eb8505911ED77F175b99e";

  afterEach(() => {
    delete KNOWN_TOKENS["ethereum"]?.[FRAX.toLowerCase()];
    delete KNOWN_TOKENS["mytest-chain"];
  });

  it("adds a new token that lookupToken can then find", () => {
    expect(lookupToken("ethereum", FRAX)).toBeUndefined();

    registerToken("ethereum", FRAX, { symbol: "FRAX", decimals: 18 });

    expect(lookupToken("ethereum", FRAX)).toEqual({ symbol: "FRAX", decimals: 18 });
  });

  it("normalises address to lowercase and symbol to uppercase", () => {
    registerToken("Ethereum", FRAX.toUpperCase(), { symbol: "frax", decimals: 18 });
    expect(lookupToken("ethereum", FRAX.toLowerCase())).toEqual({ symbol: "FRAX", decimals: 18 });
  });

  it("overwrites a previous registration for the same address", () => {
    registerToken("ethereum", FRAX, { symbol: "FRAX", decimals: 18 });
    registerToken("ethereum", FRAX, { symbol: "FRAX2", decimals: 6 });
    expect(lookupToken("ethereum", FRAX)).toEqual({ symbol: "FRAX2", decimals: 6 });
  });

  it("creates the chain bucket on the fly for chains not in KNOWN_TOKENS", () => {
    // A hypothetical chain that isn't shipped — registerToken shouldn't refuse;
    // it just stores the entry. (Whether that chain is supported elsewhere in
    // the module is a separate concern — it won't suddenly become routable.)
    registerToken("mytest-chain", FRAX, { symbol: "FRAX", decimals: 18 });
    expect(lookupToken("mytest-chain", FRAX)).toEqual({ symbol: "FRAX", decimals: 18 });
  });

  it("throws on invalid address (wrong length)", () => {
    expect(() =>
      registerToken("ethereum", "0xdeadbeef", { symbol: "X", decimals: 18 }),
    ).toThrow(SwapDKUserError);
  });

  it("throws on invalid address (missing 0x)", () => {
    expect(() =>
      registerToken(
        "ethereum",
        "853d955acef822db058eb8505911ed77f175b99e",
        { symbol: "X", decimals: 18 },
      ),
    ).toThrow(SwapDKUserError);
  });

  it("throws on empty symbol", () => {
    expect(() =>
      registerToken("ethereum", FRAX, { symbol: "   ", decimals: 18 }),
    ).toThrow(SwapDKUserError);
  });

  it("throws on negative decimals", () => {
    expect(() =>
      registerToken("ethereum", FRAX, { symbol: "FRAX", decimals: -1 }),
    ).toThrow(SwapDKUserError);
  });

  it("throws on non-integer decimals", () => {
    expect(() =>
      registerToken("ethereum", FRAX, { symbol: "FRAX", decimals: 1.5 }),
    ).toThrow(SwapDKUserError);
  });

  it("throws on absurdly large decimals (>77)", () => {
    expect(() =>
      registerToken("ethereum", FRAX, { symbol: "FRAX", decimals: 100 }),
    ).toThrow(SwapDKUserError);
  });

  it("registered token flows through toSwapKitAsset and getAssetDecimals", () => {
    registerToken("ethereum", FRAX, { symbol: "FRAX", decimals: 18 });

    expect(toSwapKitAsset(FRAX, "ethereum")).toBe(`ETH.FRAX-${FRAX}`);
    expect(getAssetDecimals("ethereum", FRAX)).toBe(18);
  });
});
