// ---------------------------------------------------------------------------
// Translation between the swidge public API and the SwapKit-shaped HTTP
// surface of the swap-engine.
//
// Downstream code speaks swidge — { fromToken, fromChain, toToken, toChain }
// with `token` = ticker (native) or address (fungible). The swap-engine
// still speaks SwapKit — a single `"CHAIN.TICKER-0xAddress"` string per
// asset. This module encodes / decodes those two conventions.
// ---------------------------------------------------------------------------

import { swapkitChainFor, nativeMetaFor } from "./chain-map.js";

/**
 * Encodes a swidge {chain, token} pair into the SwapKit asset string the
 * swap-engine `/quote` / `/swap` endpoints consume.
 *
 * Rules:
 *   - Native token (matches the chain's nativeSymbol): `"CHAIN.TICKER"`.
 *   - Address-based token: `"CHAIN.<TICKER-placeholder>-<address>"`. The
 *     swap-engine parser strips everything before the '-' when resolving
 *     the actual asset, so the placeholder is unused — we pass "T" as a
 *     non-empty stub.
 *
 * Throws `Error` when the chain is not in the swidge catalogue.
 */
export function encodeSwapKitAsset(swidgeChain: string, token: string): string {
  const chainCode = swapkitChainFor(swidgeChain);
  if (chainCode === "") {
    throw new Error(
      `SwapDKSwidge: unknown chain "${swidgeChain}" — must be one of the swidge chain ids from getSupportedChains()`,
    );
  }
  const native = nativeMetaFor(swidgeChain);
  const upper = token.trim().toUpperCase();

  if (native && upper === native.symbol.toUpperCase()) {
    return `${chainCode}.${native.symbol.toUpperCase()}`;
  }

  // Fungible: prefix with a placeholder ticker so the SwapKit parser
  // sees a well-formed identifier. The swap-engine's parser drops the
  // ticker part and keeps only the trailing address, so the stub is
  // never surfaced downstream.
  const trimmed = token.trim();
  return `${chainCode}.T-${trimmed}`;
}

/**
 * Converts a base-unit amount (bigint or number) to the human-decimal
 * string the swap-engine expects on the wire.
 *
 * Example: `toHumanAmount(100_000_000n, 8)` → `"1"` (1 BTC).
 * Example: `toHumanAmount(500_000n, 6)` → `"0.5"` (0.5 USDC).
 *
 * Rejects negative and fractional numeric inputs — the swap-engine
 * expects integer base units on the way in, and JS `number` cannot
 * safely represent large integers (> 2^53), so callers should prefer
 * `bigint`.
 */
export function toHumanAmount(
  baseUnits: bigint | number,
  decimals: number,
): string {
  if (typeof baseUnits === "number") {
    if (!Number.isFinite(baseUnits) || baseUnits < 0) {
      throw new Error(`toHumanAmount: bad amount ${baseUnits}`);
    }
    if (!Number.isInteger(baseUnits)) {
      throw new Error(
        `toHumanAmount: fractional number ${baseUnits}; pass a bigint for large integer base-unit values`,
      );
    }
    baseUnits = BigInt(baseUnits);
  }

  if (baseUnits < 0n) throw new Error(`toHumanAmount: negative amount ${baseUnits}`);
  if (decimals < 0 || !Number.isInteger(decimals)) {
    throw new Error(`toHumanAmount: bad decimals ${decimals}`);
  }

  const raw = baseUnits.toString();
  if (decimals === 0) return raw;

  if (raw.length <= decimals) {
    const padded = raw.padStart(decimals + 1, "0");
    const intPart = padded.slice(0, padded.length - decimals);
    const fracPart = padded.slice(padded.length - decimals).replace(/0+$/, "");
    return fracPart === "" ? intPart : `${intPart}.${fracPart}`;
  }

  const intPart = raw.slice(0, raw.length - decimals);
  const fracPart = raw.slice(raw.length - decimals).replace(/0+$/, "");
  return fracPart === "" ? intPart : `${intPart}.${fracPart}`;
}

/**
 * Inverse of `toHumanAmount`: parses a human-decimal string returned
 * by the swap-engine and rounds to base units. Truncates rather than
 * rounds to avoid over-quoting.
 */
export function fromHumanAmount(human: string, decimals: number): bigint {
  const trimmed = human.trim();
  if (trimmed === "") return 0n;
  const [intPart, fracPartRaw = ""] = trimmed.split(".");
  const fracPart = fracPartRaw.slice(0, decimals).padEnd(decimals, "0");
  const combined = `${intPart}${fracPart}`.replace(/^0+/, "") || "0";
  return BigInt(combined);
}
