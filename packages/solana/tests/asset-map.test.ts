import { describe, it, expect } from "vitest";
import {
  toSwapKitAsset,
  getAssetDecimals,
  resolveAssetDecimals,
  NATIVE_ADDRESS,
} from "../src/asset-map.js";
import {
  wdkChainToPrefix,
  prefixToWdkChain,
  parseSwapKitAsset,
  toHumanDecimal,
  fromHumanDecimal,
  isLikelySolanaAddress,
  NATIVE_DECIMALS,
} from "@swapdk/wdk-protocol-bridge-swapdk-common";

const USDC_SOL = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT_SOL = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const UNKNOWN_MINT = "1nc1nerator11111111111111111111111111111111";
const UNKNOWN_EVM = "0x0123456789012345678901234567890123456789";

describe("wdkChainToPrefix", () => {
  it("maps Solana + destination chains", () => {
    expect(wdkChainToPrefix("solana")).toBe("SOL");
    expect(wdkChainToPrefix("ethereum")).toBe("ETH");
    expect(wdkChainToPrefix("bitcoin")).toBe("BTC");
    expect(wdkChainToPrefix("tron")).toBe("TRON");
  });

  it("is case-insensitive", () => {
    expect(wdkChainToPrefix("Solana")).toBe("SOL");
  });

  it("throws for unsupported chain", () => {
    expect(() => wdkChainToPrefix("cardano")).toThrow("Unsupported WDK chain");
  });
});

describe("prefixToWdkChain", () => {
  it("round-trips Solana and others", () => {
    expect(prefixToWdkChain("SOL")).toBe("solana");
    expect(prefixToWdkChain("ETH")).toBe("ethereum");
    expect(prefixToWdkChain("BTC")).toBe("bitcoin");
  });
});

describe("toSwapKitAsset", () => {
  it("returns native asset for empty address (native SOL marker)", () => {
    expect(toSwapKitAsset("", "solana")).toBe("SOL.SOL");
  });

  it("returns SwapKit notation for registered SPL mints", () => {
    expect(toSwapKitAsset(USDC_SOL, "solana")).toBe(`SOL.USDC-${USDC_SOL}`);
    expect(toSwapKitAsset(USDT_SOL, "solana")).toBe(`SOL.USDT-${USDT_SOL}`);
  });

  it("throws for unknown SPL mint", () => {
    expect(() => toSwapKitAsset(UNKNOWN_MINT, "solana")).toThrow("Unknown token");
  });

  it("passes through SwapKit notation unchanged", () => {
    expect(toSwapKitAsset("BTC.BTC")).toBe("BTC.BTC");
    expect(toSwapKitAsset(`SOL.USDC-${USDC_SOL}`)).toBe(`SOL.USDC-${USDC_SOL}`);
  });

  it("throws when wdkChain is missing for a raw mint", () => {
    expect(() => toSwapKitAsset(USDC_SOL)).toThrow("wdkChain is required");
  });
});

describe("parseSwapKitAsset", () => {
  it("parses Solana SwapKit notation with base58 mint", () => {
    expect(parseSwapKitAsset(`SOL.USDC-${USDC_SOL}`)).toEqual({
      chain: "SOL",
      symbol: "USDC",
      address: USDC_SOL,
    });
  });

  it("parses native SOL", () => {
    expect(parseSwapKitAsset("SOL.SOL")).toEqual({ chain: "SOL", symbol: "SOL" });
  });
});

describe("getAssetDecimals", () => {
  it("returns 9 for native SOL", () => {
    expect(getAssetDecimals("solana", NATIVE_ADDRESS)).toBe(9);
    expect(getAssetDecimals("solana", "")).toBe(9);
  });

  it("returns 6 for USDC on Solana", () => {
    expect(getAssetDecimals("solana", USDC_SOL)).toBe(6);
  });

  it("works for destination EVM tokens via the destination-side registry", () => {
    expect(getAssetDecimals("ethereum", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")).toBe(6);
  });

  it("throws for unknown SPL mint", () => {
    expect(() => getAssetDecimals("solana", UNKNOWN_MINT)).toThrow("Unknown token");
  });

  it("throws for unknown EVM ERC-20", () => {
    expect(() => getAssetDecimals("ethereum", UNKNOWN_EVM)).toThrow("Unknown token");
  });

  it("NATIVE_DECIMALS covers Solana and all destinations", () => {
    expect(NATIVE_DECIMALS["SOL"]).toBe(9);
    expect(NATIVE_DECIMALS["BTC"]).toBe(8);
    expect(NATIVE_DECIMALS["ETH"]).toBe(18);
    expect(NATIVE_DECIMALS["TRON"]).toBe(6);
  });
});

describe("resolveAssetDecimals", () => {
  it("undefined → native of the given chain", () => {
    expect(resolveAssetDecimals("solana", undefined)).toBe(9);
    expect(resolveAssetDecimals("ethereum", undefined)).toBe(18);
  });

  it("empty string → native", () => {
    expect(resolveAssetDecimals("solana", "")).toBe(9);
  });

  it("raw Solana mint address → from registry", () => {
    expect(resolveAssetDecimals("solana", USDC_SOL)).toBe(6);
  });

  it("SwapKit notation → derives chain from notation", () => {
    expect(resolveAssetDecimals("solana", "BTC.BTC")).toBe(8);
    expect(resolveAssetDecimals("solana", `SOL.USDC-${USDC_SOL}`)).toBe(6);
    expect(resolveAssetDecimals("solana", "TRON.TRX")).toBe(6);
  });
});

describe("isLikelySolanaAddress", () => {
  it("accepts base58 pubkeys of typical length", () => {
    expect(isLikelySolanaAddress(USDC_SOL)).toBe(true);
    expect(isLikelySolanaAddress("So11111111111111111111111111111111111111112")).toBe(true);
  });

  it("rejects EVM addresses and too-short strings", () => {
    expect(isLikelySolanaAddress("0xdead")).toBe(false);
    expect(isLikelySolanaAddress("short")).toBe(false);
    expect(isLikelySolanaAddress("")).toBe(false);
  });

  it("rejects strings with forbidden base58 chars", () => {
    // Contains '0' which is not in the base58 alphabet used by Solana.
    expect(isLikelySolanaAddress("0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).toBe(false);
  });
});

describe("toHumanDecimal", () => {
  it("converts 1 SOL to human", () => {
    expect(toHumanDecimal(1_000_000_000n, 9)).toBe("1");
  });

  it("converts 100 USDC (Solana, 6 decimals)", () => {
    expect(toHumanDecimal(100_000_000n, 6)).toBe("100");
  });

  it("sub-unit lamport (10 lamports)", () => {
    expect(toHumanDecimal(10n, 9)).toBe("0.00000001");
  });

  it("zero", () => {
    expect(toHumanDecimal(0n, 9)).toBe("0");
  });
});

describe("fromHumanDecimal", () => {
  it("parses 1 SOL to lamports", () => {
    expect(fromHumanDecimal("1", 9)).toBe(1_000_000_000n);
  });

  it("parses 0.01 SOL to lamports", () => {
    expect(fromHumanDecimal("0.01", 9)).toBe(10_000_000n);
  });

  it("truncates beyond target precision", () => {
    expect(fromHumanDecimal("0.1234567891", 6)).toBe(123_456n);
  });

  it("round-trips with toHumanDecimal", () => {
    for (const [raw, dec] of [
      [1_000_000_000n, 9],
      [100_000_000n, 6],
      [30_400n, 8],
    ] as const) {
      expect(fromHumanDecimal(toHumanDecimal(raw, dec), dec)).toBe(raw);
    }
  });
});
