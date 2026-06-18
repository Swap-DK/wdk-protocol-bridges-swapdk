import { describe, it, expect } from "vitest";
import { toSwapKitAsset, getAssetDecimals } from "../src/asset-map.js";
import {
  wdkChainToPrefix,
  prefixToWdkChain,
  parseSwapKitAsset,
  toHumanDecimal,
  fromHumanDecimal,
  NATIVE_DECIMALS,
} from "@swapdk/swap-engine-client";

const NATIVE_ADDRESS = "0x0000000000000000000000000000000000000000";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const UNKNOWN_TOKEN = "0x0123456789012345678901234567890123456789";

describe("wdkChainToPrefix", () => {
  it("maps known chains", () => {
    expect(wdkChainToPrefix("ethereum")).toBe("ETH");
    expect(wdkChainToPrefix("bitcoin")).toBe("BTC");
    expect(wdkChainToPrefix("bsc")).toBe("BSC");
    expect(wdkChainToPrefix("avalanche")).toBe("AVAX");
    expect(wdkChainToPrefix("tron")).toBe("TRON");
  });

  it("is case-insensitive", () => {
    expect(wdkChainToPrefix("Ethereum")).toBe("ETH");
    expect(wdkChainToPrefix("ARBITRUM")).toBe("ARB");
  });

  it("throws for unknown chain", () => {
    expect(() => wdkChainToPrefix("stellar")).toThrow("Unsupported WDK chain");
  });
});

describe("prefixToWdkChain", () => {
  it("maps known prefixes", () => {
    expect(prefixToWdkChain("ETH")).toBe("ethereum");
    expect(prefixToWdkChain("BTC")).toBe("bitcoin");
    expect(prefixToWdkChain("BSC")).toBe("bsc");
  });

  it("is case-insensitive", () => {
    expect(prefixToWdkChain("eth")).toBe("ethereum");
  });

  it("throws for unknown prefix", () => {
    expect(() => prefixToWdkChain("XLM")).toThrow("Unknown SwapKit chain prefix");
  });
});

describe("toSwapKitAsset", () => {
  it("returns native asset for zero address", () => {
    expect(toSwapKitAsset(NATIVE_ADDRESS, "ethereum")).toBe("ETH.ETH");
    expect(toSwapKitAsset(NATIVE_ADDRESS, "bsc")).toBe("BSC.BNB");
    expect(toSwapKitAsset(NATIVE_ADDRESS, "avalanche")).toBe("AVAX.AVAX");
  });

  it("handles uppercase zero address", () => {
    expect(toSwapKitAsset("0X0000000000000000000000000000000000000000", "ethereum"))
      .toBe("ETH.ETH");
  });

  it("resolves registered ERC-20 symbols via the known-token registry", () => {
    expect(toSwapKitAsset(USDC, "ethereum")).toBe(`ETH.USDC-${USDC}`);
    expect(toSwapKitAsset(WETH, "ethereum")).toBe(`ETH.WETH-${WETH}`);
  });

  it("throws for unknown ERC-20 address (not in registry)", () => {
    expect(() => toSwapKitAsset(UNKNOWN_TOKEN, "ethereum"))
      .toThrow("Unknown token");
  });

  it("passes through SwapKit notation unchanged", () => {
    expect(toSwapKitAsset("BTC.BTC")).toBe("BTC.BTC");
    expect(toSwapKitAsset("ETH.USDC-0xA0b86991")).toBe("ETH.USDC-0xA0b86991");
  });

  it("throws when wdkChain is missing for an address", () => {
    expect(() => toSwapKitAsset("0xA0b86991")).toThrow("wdkChain is required");
  });
});

describe("parseSwapKitAsset", () => {
  it("parses native asset", () => {
    expect(parseSwapKitAsset("ETH.ETH")).toEqual({ chain: "ETH", symbol: "ETH" });
  });

  it("parses ERC-20 asset with address", () => {
    expect(parseSwapKitAsset("ETH.USDC-0xA0b86991")).toEqual({
      chain: "ETH",
      symbol: "USDC",
      address: "0xA0b86991",
    });
  });

  it("handles chain-only string", () => {
    expect(parseSwapKitAsset("BTC")).toEqual({ chain: "BTC", symbol: "BTC" });
  });

  it("handles address with multiple dashes", () => {
    expect(parseSwapKitAsset("ETH.TOKEN-0xABC-DEF")).toEqual({
      chain: "ETH",
      symbol: "TOKEN",
      address: "0xABC-DEF",
    });
  });
});

describe("getAssetDecimals", () => {
  it("returns native decimals for native address", () => {
    expect(getAssetDecimals("ethereum", NATIVE_ADDRESS)).toBe(18);
    expect(getAssetDecimals("bitcoin", NATIVE_ADDRESS)).toBe(8);
    expect(getAssetDecimals("tron", NATIVE_ADDRESS)).toBe(6);
  });

  it("returns decimals from the registry for ERC-20s", () => {
    expect(getAssetDecimals("ethereum", USDC)).toBe(6);
    expect(getAssetDecimals("ethereum", WETH)).toBe(18);
  });

  it("throws for unknown ERC-20", () => {
    expect(() => getAssetDecimals("ethereum", UNKNOWN_TOKEN))
      .toThrow("Unknown token");
  });

  it("throws for unknown chain", () => {
    expect(() => getAssetDecimals("stellar", NATIVE_ADDRESS))
      .toThrow("Unsupported WDK chain");
  });

  it("NATIVE_DECIMALS covers every prefix in NATIVE_SYMBOL", () => {
    expect(NATIVE_DECIMALS).toHaveProperty("ETH");
    expect(NATIVE_DECIMALS).toHaveProperty("BTC");
    expect(NATIVE_DECIMALS).toHaveProperty("TRON");
  });
});

describe("toHumanDecimal", () => {
  it("converts 0.01 ETH (18 decimals)", () => {
    expect(toHumanDecimal(10_000_000_000_000_000n, 18)).toBe("0.01");
  });

  it("converts 30400 satoshi to 0.000304 BTC", () => {
    expect(toHumanDecimal(30_400n, 8)).toBe("0.000304");
  });

  it("converts whole USDC (6 decimals)", () => {
    expect(toHumanDecimal(100_000_000n, 6)).toBe("100");
  });

  it("handles zero", () => {
    expect(toHumanDecimal(0n, 18)).toBe("0");
  });

  it("strips trailing zeros from fraction", () => {
    expect(toHumanDecimal(1_200_000_000_000_000_000n, 18)).toBe("1.2");
  });

  it("handles sub-unit amounts (no integer part)", () => {
    expect(toHumanDecimal(1n, 8)).toBe("0.00000001");
  });

  it("handles 0 decimals", () => {
    expect(toHumanDecimal(42n, 0)).toBe("42");
  });

  it("handles negative amounts", () => {
    expect(toHumanDecimal(-10_000_000_000_000_000n, 18)).toBe("-0.01");
  });
});

describe("fromHumanDecimal", () => {
  it("converts 0.01 ETH to wei", () => {
    expect(fromHumanDecimal("0.01", 18)).toBe(10_000_000_000_000_000n);
  });

  it("converts 0.000304 BTC to satoshi", () => {
    expect(fromHumanDecimal("0.000304", 8)).toBe(30_400n);
  });

  it("converts 100 USDC to base units", () => {
    expect(fromHumanDecimal("100", 6)).toBe(100_000_000n);
  });

  it("truncates (floor) beyond target precision", () => {
    expect(fromHumanDecimal("0.12345678901", 6)).toBe(123_456n);
  });

  it("handles integer-only input", () => {
    expect(fromHumanDecimal("5", 18)).toBe(5_000_000_000_000_000_000n);
  });

  it("handles leading dot", () => {
    expect(fromHumanDecimal(".5", 2)).toBe(50n);
  });

  it("handles empty string", () => {
    expect(fromHumanDecimal("", 18)).toBe(0n);
  });

  it("handles negative", () => {
    expect(fromHumanDecimal("-0.01", 18)).toBe(-10_000_000_000_000_000n);
  });

  it("round-trips with toHumanDecimal", () => {
    for (const [raw, dec] of [
      [10_000_000_000_000_000n, 18],
      [30_400n, 8],
      [100_000_000n, 6],
      [1n, 8],
    ] as const) {
      expect(fromHumanDecimal(toHumanDecimal(raw, dec), dec)).toBe(raw);
    }
  });
});
