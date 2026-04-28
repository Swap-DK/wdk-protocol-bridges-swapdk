// ---------------------------------------------------------------------------
// Cross-package asset utilities:
//   - chain id ↔ SwapKit prefix mapping (full superset of supported chains)
//   - native symbol + decimals tables for every chain swap-engine may route
//     to or from
//   - `parseSwapKitAsset` and the human-decimal conversion helpers used at
//     the HTTP boundary (swap-engine exchanges amounts as human-decimal
//     strings)
//
// Source-chain-specific bits (the `NATIVE_ADDRESS` marker value, the
// `toSwapKitAsset` / `getAssetDecimals` / `resolveAssetDecimals` helpers
// that branch on it) live in each consuming package's own asset-map.ts.
// ---------------------------------------------------------------------------

import { SwapDKUserError } from "./errors.js";

/**
 * Map of WDK chain identifiers → SwapKit chain prefix.
 * Keys are lowercase for case-insensitive lookup. This is the full
 * superset across every source and destination chain swap-engine knows
 * about; individual packages don't need their own copy.
 */
export const CHAIN_MAP: Record<string, string> = {
  solana: "SOL",
  ethereum: "ETH",
  arbitrum: "ARB",
  base: "BASE",
  bsc: "BSC",
  avalanche: "AVAX",
  optimism: "OP",
  polygon: "MATIC",
  bitcoin: "BTC",
  litecoin: "LTC",
  dogecoin: "DOGE",
  tron: "TRON",
};

/** Native (gas) token symbol per SwapKit chain prefix. */
export const NATIVE_SYMBOL: Record<string, string> = {
  SOL: "SOL",
  ETH: "ETH",
  ARB: "ETH",
  BASE: "ETH",
  BSC: "BNB",
  AVAX: "AVAX",
  OP: "ETH",
  MATIC: "MATIC",
  BTC: "BTC",
  LTC: "LTC",
  DOGE: "DOGE",
  TRON: "TRX",
};

/** Native (gas) token decimal precision per SwapKit chain prefix. */
export const NATIVE_DECIMALS: Record<string, number> = {
  SOL: 9, // 1 SOL = 1e9 lamports
  ETH: 18,
  ARB: 18,
  BASE: 18,
  BSC: 18,
  AVAX: 18,
  OP: 18,
  MATIC: 18,
  BTC: 8,
  LTC: 8,
  DOGE: 8,
  TRON: 6,
};

const REVERSE_CHAIN_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(CHAIN_MAP).map(([k, v]) => [v, k]),
);

/**
 * Convert a WDK chain id to SwapKit chain prefix.
 *
 * @example wdkChainToPrefix("ethereum") // "ETH"
 * @example wdkChainToPrefix("solana")   // "SOL"
 */
export function wdkChainToPrefix(wdkChain: string): string {
  const prefix = CHAIN_MAP[wdkChain.toLowerCase()];
  if (!prefix) throw new SwapDKUserError(`Unsupported WDK chain: ${wdkChain}`);
  return prefix;
}

/**
 * Convert a SwapKit chain prefix back to WDK chain id.
 *
 * @example prefixToWdkChain("ETH") // "ethereum"
 * @example prefixToWdkChain("SOL") // "solana"
 */
export function prefixToWdkChain(prefix: string): string {
  const chain = REVERSE_CHAIN_MAP[prefix.toUpperCase()];
  if (!chain) throw new SwapDKUserError(`Unknown SwapKit chain prefix: ${prefix}`);
  return chain;
}

/**
 * Parse a SwapKit asset string into its parts.
 *
 * @example parseSwapKitAsset("ETH.USDC-0xA0b86991…")
 *   // { chain: "ETH", symbol: "USDC", address: "0xA0b86991…" }
 * @example parseSwapKitAsset("SOL.USDC-EPjFWdd5…")
 *   // { chain: "SOL", symbol: "USDC", address: "EPjFWdd5…" }
 */
export function parseSwapKitAsset(asset: string): {
  chain: string;
  symbol: string;
  address?: string;
} {
  const [chain, rest] = asset.split(".");
  if (!rest) return { chain, symbol: chain };

  const dashIdx = rest.indexOf("-");
  if (dashIdx === -1) return { chain, symbol: rest };

  return {
    chain,
    symbol: rest.slice(0, dashIdx),
    address: rest.slice(dashIdx + 1),
  };
}

/**
 * Convert a bigint amount in native base units to a human-decimal string.
 *
 * Used before sending to swap-engine, which expects human-decimal strings
 * in its `/quote` request body.
 *
 * @example
 *   toHumanDecimal(10_000_000_000_000_000n, 18)  // "0.01"     (0.01 ETH)
 *   toHumanDecimal(30_400n, 8)                   // "0.000304" (0.000304 BTC)
 *   toHumanDecimal(100_000_000n, 6)              // "100"      (100 USDC)
 *   toHumanDecimal(1_000_000_000n, 9)            // "1"        (1 SOL)
 */
export function toHumanDecimal(amount: bigint, decimals: number): string {
  if (amount === 0n) return "0";
  const negative = amount < 0n;
  const absVal = negative ? -amount : amount;
  const padded = absVal.toString().padStart(decimals + 1, "0");
  const intPart = padded.slice(0, padded.length - decimals);
  const fracPart = padded.slice(padded.length - decimals).replace(/0+$/, "");
  const result = fracPart ? `${intPart}.${fracPart}` : intPart;
  return negative ? `-${result}` : result;
}

/**
 * Convert a human-decimal string to a bigint in native base units.
 * Truncates fractional digits beyond `decimals` (floor).
 */
export function fromHumanDecimal(value: string, decimals: number): bigint {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "0") return 0n;

  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;

  const [intPart, fracPart = ""] = unsigned.split(".");
  const fracPadded = (fracPart + "0".repeat(decimals)).slice(0, decimals);
  const digits = (intPart || "0") + fracPadded;
  const abs = BigInt(digits);
  return negative ? -abs : abs;
}

/**
 * Convert a numeric string from swap-engine to bigint, truncating fractional
 * digits. Compatibility helper for raw response fields where the scale is
 * already correct; prefer `fromHumanDecimal` when you know the decimals.
 */
export function toBigInt(value: string): bigint {
  const idx = value.indexOf(".");
  return BigInt(idx === -1 ? value : value.slice(0, idx));
}
