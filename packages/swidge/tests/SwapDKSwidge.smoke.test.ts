import { describe, it, expect } from "vitest";

import { SwapDKSwidge } from "../src/SwapDKSwidge.js";
import {
  encodeSwapKitAsset,
  toHumanAmount,
  fromHumanAmount,
} from "../src/asset-encode.js";
import {
  swapkitChainFor,
  swidgeChainFor,
  chainFamilyFor,
  nativeMetaFor,
  allSwidgeChains,
} from "../src/chain-map.js";

// Smoke tests for the SwapDKSwidge scaffolding. Discovery / quote /
// status behaviour is covered in the network-mocking suite (follow-up
// commit); this file just confirms the class instantiates and the
// pure helpers behave correctly.

describe("chain-map", () => {
  it("resolves swidge id → SwapKit code", () => {
    expect(swapkitChainFor("ethereum")).toBe("ETH");
    expect(swapkitChainFor("bitcoin")).toBe("BTC");
    expect(swapkitChainFor("thorchain")).toBe("THOR");
    expect(swapkitChainFor("unknown-chain")).toBe("");
  });

  it("is case-insensitive on inputs", () => {
    expect(swapkitChainFor("Ethereum")).toBe("ETH");
    expect(swapkitChainFor("BITCOIN")).toBe("BTC");
    expect(swidgeChainFor("eth")).toBe("ethereum");
    expect(swidgeChainFor("BTC")).toBe("bitcoin");
  });

  it("reports chain family for each supported chain", () => {
    expect(chainFamilyFor("ethereum")).toBe("evm");
    expect(chainFamilyFor("arbitrum")).toBe("evm");
    expect(chainFamilyFor("bitcoin")).toBe("bitcoin");
    expect(chainFamilyFor("solana")).toBe("solana");
    expect(chainFamilyFor("tron")).toBe("tron");
    expect(chainFamilyFor("thorchain")).toBe("cosmos");
    expect(chainFamilyFor("unknown")).toBe("");
  });

  it("carries native gas coin metadata per chain", () => {
    expect(nativeMetaFor("ethereum")).toEqual({ symbol: "ETH", decimals: 18 });
    expect(nativeMetaFor("bitcoin")).toEqual({ symbol: "BTC", decimals: 8 });
    expect(nativeMetaFor("tron")).toEqual({ symbol: "TRX", decimals: 6 });
    expect(nativeMetaFor("thorchain")).toEqual({ symbol: "RUNE", decimals: 8 });
    expect(nativeMetaFor("nope")).toBeNull();
  });

  it("lists every registered chain", () => {
    const chains = allSwidgeChains();
    expect(chains.length).toBeGreaterThanOrEqual(10);
    // Sanity: the five bridge-suite source chains must all be there.
    for (const id of ["bitcoin", "ethereum", "solana", "tron", "thorchain"]) {
      expect(chains).toContain(id);
    }
  });
});

describe("encodeSwapKitAsset", () => {
  it("encodes native tokens as CHAIN.TICKER", () => {
    expect(encodeSwapKitAsset("ethereum", "ETH")).toBe("ETH.ETH");
    expect(encodeSwapKitAsset("bitcoin", "BTC")).toBe("BTC.BTC");
    expect(encodeSwapKitAsset("tron", "TRX")).toBe("TRON.TRX");
    expect(encodeSwapKitAsset("thorchain", "RUNE")).toBe("THOR.RUNE");
  });

  it("case-insensitive on the token side", () => {
    expect(encodeSwapKitAsset("ethereum", "eth")).toBe("ETH.ETH");
    expect(encodeSwapKitAsset("ethereum", "Eth")).toBe("ETH.ETH");
  });

  it("encodes fungibles with placeholder ticker + address", () => {
    expect(
      encodeSwapKitAsset("ethereum", "0xA0b86991C6218b36C1d19D4a2e9Eb0cE3606eB48"),
    ).toBe("ETH.T-0xA0b86991C6218b36C1d19D4a2e9Eb0cE3606eB48");
  });

  it("throws on unknown chain", () => {
    expect(() => encodeSwapKitAsset("mars", "ETH")).toThrow(/unknown chain/);
  });
});

describe("toHumanAmount / fromHumanAmount", () => {
  it("round-trips whole tokens", () => {
    expect(toHumanAmount(1_000_000_000_000_000_000n, 18)).toBe("1");
    expect(fromHumanAmount("1", 18)).toBe(1_000_000_000_000_000_000n);
  });

  it("round-trips fractional tokens", () => {
    expect(toHumanAmount(500_000n, 6)).toBe("0.5");
    expect(fromHumanAmount("0.5", 6)).toBe(500_000n);
  });

  it("handles amounts less than one token", () => {
    expect(toHumanAmount(1n, 8)).toBe("0.00000001");
    expect(fromHumanAmount("0.00000001", 8)).toBe(1n);
  });

  it("strips trailing zeros in human amount", () => {
    expect(toHumanAmount(1_000_000_000_000_000_000n + 500_000_000_000_000_000n, 18))
      .toBe("1.5");
  });

  it("rejects fractional numeric inputs", () => {
    expect(() => toHumanAmount(1.5, 8)).toThrow(/fractional/);
  });

  it("rejects negative amounts", () => {
    expect(() => toHumanAmount(-1n, 8)).toThrow(/negative/);
    expect(() => toHumanAmount(-1, 8)).toThrow(/bad amount/);
  });
});

describe("SwapDKSwidge instantiation", () => {
  it("constructs without an account (read-only mode)", () => {
    const swidge = new SwapDKSwidge(undefined, {
      apiUrl: "https://api.example.test",
      apiKey: "test-key",
    });
    expect(swidge).toBeInstanceOf(SwapDKSwidge);
    expect(typeof swidge.getSupportedChains).toBe("function");
    expect(typeof swidge.getSupportedTokens).toBe("function");
    expect(typeof swidge.quoteSwidge).toBe("function");
    expect(typeof swidge.swidge).toBe("function");
    expect(typeof swidge.getSwidgeStatus).toBe("function");
    // Base-class delegates come for free:
    expect(typeof swidge.bridge).toBe("function");
    expect(typeof swidge.quoteBridge).toBe("function");
    expect(typeof swidge.swap).toBe("function");
    expect(typeof swidge.quoteSwap).toBe("function");
  });

  it("swidge() rejects when constructed without a writable account", async () => {
    const swidge = new SwapDKSwidge(undefined, {
      apiUrl: "https://api.example.test",
      apiKey: "test-key",
    });
    await expect(
      swidge.swidge({
        fromToken: "ETH",
        fromChain: "ethereum",
        toToken: "BTC",
        toChain: "bitcoin",
        fromTokenAmount: 1000n,
      }),
    ).rejects.toThrow(/writable wallet account/);
  });
});
