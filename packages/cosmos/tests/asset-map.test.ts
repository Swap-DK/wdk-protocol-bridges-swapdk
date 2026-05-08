import { describe, it, expect } from "vitest";
import {
  toSwapKitAsset,
  resolveAssetDecimals,
  NATIVE_TOKEN,
} from "../src/asset-map.js";
import {
  wdkChainToPrefix,
  NATIVE_DECIMALS,
} from "@swapdk/wdk-protocol-bridge-swapdk-common";

describe("THORChain / MAYAChain in CHAIN_MAP (common)", () => {
  it("maps thorchain ↔ THOR", () => {
    expect(wdkChainToPrefix("thorchain")).toBe("THOR");
  });

  it("maps mayachain ↔ MAYA", () => {
    expect(wdkChainToPrefix("mayachain")).toBe("MAYA");
  });

  it("knows RUNE has 8 decimals and CACAO has 10", () => {
    expect(NATIVE_DECIMALS.THOR).toBe(8);
    expect(NATIVE_DECIMALS.MAYA).toBe(10);
  });
});

describe("toSwapKitAsset", () => {
  it("resolves the 'native' sentinel against the source chain", () => {
    expect(toSwapKitAsset(NATIVE_TOKEN, "thorchain")).toBe("THOR.RUNE");
    expect(toSwapKitAsset(NATIVE_TOKEN, "mayachain")).toBe("MAYA.CACAO");
  });

  it("is case-insensitive on the sentinel", () => {
    expect(toSwapKitAsset("Native", "thorchain")).toBe("THOR.RUNE");
    expect(toSwapKitAsset("NATIVE", "mayachain")).toBe("MAYA.CACAO");
  });

  it("accepts bare denom (rune / cacao) on the matching chain", () => {
    expect(toSwapKitAsset("rune", "thorchain")).toBe("THOR.RUNE");
    expect(toSwapKitAsset("cacao", "mayachain")).toBe("MAYA.CACAO");
  });

  it("rejects bare denom on the wrong chain", () => {
    expect(() => toSwapKitAsset("rune", "mayachain")).toThrow(/Unsupported token/);
    expect(() => toSwapKitAsset("cacao", "thorchain")).toThrow(/Unsupported token/);
  });

  it("returns SwapKit form verbatim", () => {
    expect(toSwapKitAsset("THOR.RUNE", "thorchain")).toBe("THOR.RUNE");
    expect(toSwapKitAsset("MAYA.CACAO", "mayachain")).toBe("MAYA.CACAO");
  });

  it("accepts cross-chain SwapKit references (trade asset notation)", () => {
    // We don't restrict the chain prefix in SwapKit form — swap-engine
    // validates the route at /quote time.
    expect(toSwapKitAsset("THOR.BTC-BTC", "thorchain")).toBe("THOR.BTC-BTC");
  });

  it("throws on empty token", () => {
    expect(() => toSwapKitAsset("", "thorchain")).toThrow(/required/);
  });

  it("throws on a non-cosmos source chain", () => {
    expect(() => toSwapKitAsset("native", "ethereum")).toThrow();
  });

  it("throws on malformed SwapKit form", () => {
    expect(() => toSwapKitAsset(".RUNE", "thorchain")).toThrow(/Invalid SwapKit/);
  });
});

describe("resolveAssetDecimals", () => {
  it("returns RUNE decimals (8) for THOR.RUNE", () => {
    expect(resolveAssetDecimals("thorchain", "THOR.RUNE")).toBe(8);
  });

  it("returns CACAO decimals (10) for MAYA.CACAO", () => {
    expect(resolveAssetDecimals("mayachain", "MAYA.CACAO")).toBe(10);
  });

  it("derives chain from the asset string, ignoring wdkChain hint", () => {
    // wdkChain is only consulted as a fallback for bare tokens.
    expect(resolveAssetDecimals("thorchain", "BTC.BTC")).toBe(8);
    expect(resolveAssetDecimals("thorchain", "ETH.ETH")).toBe(18);
  });

  it("looks up known ERC-20 tokens by address (USDC = 6 decimals)", () => {
    const usdc = "ETH.USDC-0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
    expect(resolveAssetDecimals("thorchain", usdc)).toBe(6);
  });

  it("falls back to source-chain native when asset is undefined", () => {
    expect(resolveAssetDecimals("thorchain", undefined)).toBe(8);
    expect(resolveAssetDecimals("mayachain", undefined)).toBe(10);
  });

  it("throws on unknown chain prefix in SwapKit form", () => {
    expect(() => resolveAssetDecimals("thorchain", "FOO.BAR")).toThrow(/Unknown decimals/);
  });
});
