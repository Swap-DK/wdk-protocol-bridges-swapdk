// ---------------------------------------------------------------------------
// TRON source-chain asset mapping
//
// Converts the various forms of `token` a caller may pass (`"native"`,
// `"TRX"`, `"TRON.TRX"`, `"TRON.USDT-T…"`) into the SwapKit notation
// swap-engine expects, and resolves decimals at the HTTP boundary.
//
// All TRON-routable assets in v1 (TRX, USDT, USDC) use 6 decimals, so
// the chain-native fallback already returns the right value for the
// known set without needing a per-token registry.
// ---------------------------------------------------------------------------

import {
  NATIVE_SYMBOL,
  NATIVE_DECIMALS,
  parseSwapKitAsset,
  wdkChainToPrefix,
  prefixToWdkChain,
  lookupToken,
  SwapDKUserError,
} from "@swapdk/swap-engine-client";

/**
 * Sentinel value indicating "the native gas/swap asset of the active
 * source chain" — i.e. TRX.
 */
export const NATIVE_TOKEN = "native";

/**
 * Convert a TRON-source `token` value to a SwapKit asset string.
 *
 * Accepts:
 * - `"native"` / `undefined` / `""` → `"TRON.TRX"`
 * - `"TRX"` → `"TRON.TRX"`
 * - `"TRON.TRX"` → returned as-is
 * - `"TRON.USDT-T…"` → returned as-is after a sanity check
 * - bare TRON base58 address (`"T…"`) → throws (callers must use the
 *   SwapKit form so the symbol is unambiguous; swap-engine's
 *   ConvertToChainflipFormat strips the address suffix and keeps the
 *   symbol, so the symbol must be supplied verbatim)
 *
 * @param token     Caller-supplied source token identifier.
 * @param wdkChain  Source WDK chain id (`"tron"`).
 */
export function toSourceAsset(
  token: string | undefined,
  wdkChain: string,
): string {
  const prefix = wdkChainToPrefix(wdkChain);
  if (prefix !== "TRON") {
    throw new SwapDKUserError(
      `SwapDKBridgeTron only supports TRON source. Got chain: ${wdkChain}`,
    );
  }
  const nativeAsset = `${prefix}.${NATIVE_SYMBOL[prefix]}`; // "TRON.TRX"
  if (!token || token === NATIVE_TOKEN) return nativeAsset;

  // Bare symbol — accept "TRX" as a convenience.
  if (token.toUpperCase() === NATIVE_SYMBOL[prefix]) return nativeAsset;

  // SwapKit form: must start with "TRON.".
  if (token.startsWith(`${prefix}.`)) {
    return token;
  }

  throw new SwapDKUserError(
    `Invalid TRON source token: ${token}. Expected "native", "TRX", "TRON.TRX", or "TRON.USDT-T…".`,
  );
}

/**
 * Resolve an asset identifier to its decimal precision.
 *
 * Supports:
 *   - SwapKit asset strings (`"TRON.USDT-T…"`, `"TRON.TRX"`, `"ETH.USDC-0xA0b…"`)
 *   - The `"native"` sentinel — uses NATIVE_DECIMALS for the chain prefix.
 *   - Bare TRON base58 — not a meaningful identifier for decimals on
 *     its own; falls back to chain native (which is 6, the right
 *     answer for every TRON-routable asset in v1).
 *
 * @param chain WDK chain id the asset belongs to.
 * @param token Asset identifier; falls back to chain-native when omitted.
 */
export function resolveAssetDecimals(
  chain: string,
  token?: string,
): number {
  const prefix = wdkChainToPrefix(chain);
  if (!token || token === NATIVE_TOKEN) {
    return NATIVE_DECIMALS[prefix];
  }

  // Gate on `.` — parseSwapKitAsset returns a truthy object even for
  // bare tokens, so the old `if (parsed)` was dead and bare TRC-20
  // contract addresses (e.g. just `TR7N…`) never reached the fallback.
  if (token.includes(".")) {
    const parsed = parseSwapKitAsset(token);
    // The SwapKit asset string carries its own chain prefix; honour
    // it even if it differs from `chain` (the destination chain may
    // not be the one the caller passed). `lookupToken` indexes by
    // the WDK chain name, not the SwapKit prefix.
    if (parsed.address) {
      const t = lookupToken(prefixToWdkChain(parsed.chain), parsed.address);
      if (t) return t.decimals;
    }
    if (parsed.symbol === NATIVE_SYMBOL[parsed.chain]) {
      return NATIVE_DECIMALS[parsed.chain];
    }
    // Unknown SwapKit asset on the parsed chain — fall back to chain
    // native. For TRON this is 6, which is correct for every TRC-20
    // currently routable via THORChain (USDT, USDC).
    return NATIVE_DECIMALS[parsed.chain];
  }

  return NATIVE_DECIMALS[prefix];
}
