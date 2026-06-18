import { describe, it, expect, afterEach } from "vitest";
import { lookupToken, registerToken, KNOWN_TOKENS } from "@swapdk/swap-engine-client";
import { SwapDKUserError } from "@swapdk/swap-engine-client";
import { toSwapKitAsset, getAssetDecimals } from "../src/asset-map.js";

const USDC_SOL = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PYTH_SOL = "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3";
const FRAX_ETH = "0x853d955aCEf822Db058eb8505911ED77F175b99e";

describe("lookupToken", () => {
  it("finds USDC on Solana (base58 case-sensitive)", () => {
    expect(lookupToken("solana", USDC_SOL)).toEqual({ symbol: "USDC", decimals: 6 });
  });

  it("finds USDC on Ethereum via case-insensitive hex", () => {
    expect(
      lookupToken("ethereum", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
    ).toEqual({ symbol: "USDC", decimals: 6 });
  });

  it("returns undefined for unknown SPL mint", () => {
    expect(lookupToken("solana", PYTH_SOL)).toBeUndefined();
  });

  it("chain lookup is case-insensitive", () => {
    expect(lookupToken("Solana", USDC_SOL)).toEqual({ symbol: "USDC", decimals: 6 });
  });

  it("covers Solana + all EVM destinations out of the box", () => {
    for (const chain of ["solana", "ethereum", "arbitrum", "base", "bsc", "avalanche", "optimism", "polygon"]) {
      expect(Object.keys(KNOWN_TOKENS[chain] ?? {}).length).toBeGreaterThan(0);
    }
  });
});

describe("registerToken", () => {
  afterEach(() => {
    delete KNOWN_TOKENS["solana"]?.[PYTH_SOL];
    delete KNOWN_TOKENS["ethereum"]?.[FRAX_ETH.toLowerCase()];
    delete KNOWN_TOKENS["mytest-chain"];
  });

  it("adds an SPL mint", () => {
    expect(lookupToken("solana", PYTH_SOL)).toBeUndefined();
    registerToken("solana", PYTH_SOL, { symbol: "PYTH", decimals: 6 });
    expect(lookupToken("solana", PYTH_SOL)).toEqual({ symbol: "PYTH", decimals: 6 });
  });

  it("adds an EVM ERC-20 (case-insensitive address)", () => {
    registerToken("ethereum", FRAX_ETH, { symbol: "frax", decimals: 18 });
    expect(lookupToken("ethereum", FRAX_ETH.toLowerCase())).toEqual({ symbol: "FRAX", decimals: 18 });
  });

  it("overwrites existing entries", () => {
    registerToken("solana", PYTH_SOL, { symbol: "PYTH", decimals: 6 });
    registerToken("solana", PYTH_SOL, { symbol: "PYTH2", decimals: 9 });
    expect(lookupToken("solana", PYTH_SOL)).toEqual({ symbol: "PYTH2", decimals: 9 });
  });

  it("throws on invalid EVM address", () => {
    expect(() =>
      registerToken("ethereum", "0xdead", { symbol: "X", decimals: 18 }),
    ).toThrow(SwapDKUserError);
  });

  it("throws on invalid Solana address (wrong alphabet)", () => {
    expect(() =>
      registerToken("solana", "0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", { symbol: "X", decimals: 6 }),
    ).toThrow(SwapDKUserError);
  });

  it("throws on empty symbol", () => {
    expect(() =>
      registerToken("solana", PYTH_SOL, { symbol: "  ", decimals: 6 }),
    ).toThrow(SwapDKUserError);
  });

  it("throws on non-integer decimals", () => {
    expect(() =>
      registerToken("solana", PYTH_SOL, { symbol: "PYTH", decimals: 6.5 }),
    ).toThrow(SwapDKUserError);
  });

  it("throws on decimals > 77", () => {
    expect(() =>
      registerToken("solana", PYTH_SOL, { symbol: "PYTH", decimals: 100 }),
    ).toThrow(SwapDKUserError);
  });

  it("integrates with toSwapKitAsset and getAssetDecimals", () => {
    registerToken("solana", PYTH_SOL, { symbol: "PYTH", decimals: 6 });
    expect(toSwapKitAsset(PYTH_SOL, "solana")).toBe(`SOL.PYTH-${PYTH_SOL}`);
    expect(getAssetDecimals("solana", PYTH_SOL)).toBe(6);
  });
});
