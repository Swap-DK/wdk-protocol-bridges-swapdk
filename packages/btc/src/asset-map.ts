// ---------------------------------------------------------------------------
// Bitcoin source-chain asset mapping
//
// Single-asset case: BTC source can only sell native BTC ("BTC.BTC"). The
// helpers here exist mostly for symmetry with the EVM / Cosmos bridge
// modules and to provide a consistent resolveAssetDecimals() for the
// destination side.
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
 * Sentinel for "the native asset of the source chain" — i.e. BTC.
 */
export const NATIVE_TOKEN = "native";

/**
 * Resolve a caller-supplied source `token` to a SwapKit asset string.
 *
 * For BTC source the only valid sell asset is `BTC.BTC`. Accepts:
 *   - `"native"` / `undefined` / `""` → `"BTC.BTC"`
 *   - `"BTC.BTC"` → returned verbatim
 *   - anything else → throws
 *
 * @param token     Caller's source token identifier.
 * @param wdkChain  Source WDK chain id (`"bitcoin"`).
 */
export function toSourceAsset(
  token: string | undefined,
  wdkChain: string,
): string {
  const prefix = wdkChainToPrefix(wdkChain);
  if (prefix !== "BTC") {
    throw new SwapDKUserError(
      `SwapDKBridgeBtc only supports BTC source. Got chain: ${wdkChain}`,
    );
  }
  const fallback = `${prefix}.${NATIVE_SYMBOL[prefix]}`; // "BTC.BTC"
  if (!token || token === NATIVE_TOKEN) return fallback;
  if (token === fallback) return fallback;
  const parsed = parseSwapKitAsset(token);
  if (parsed && parsed.chain === prefix && parsed.symbol === NATIVE_SYMBOL[prefix]) {
    return fallback;
  }
  throw new SwapDKUserError(
    `BTC source only sells native BTC. Got token: ${token}`,
  );
}

/**
 * Resolve an asset identifier to its decimal precision.
 *
 * Supports:
 *   - SwapKit asset strings (`"ETH.USDC-0xA0b…"`, `"BTC.BTC"`)
 *   - Bare contract addresses (`"0x…"`) — only meaningful for EVM
 *     destinations; needs `chain` to resolve.
 *   - The `"native"` sentinel — uses NATIVE_DECIMALS for the chain prefix.
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

  // SwapKit asset strings always contain a `.` separator
  // ("PREFIX.SYMBOL[-address]"). Anything without it is a bare token
  // and falls through to the contract-address path below — gating on
  // `.` keeps that path reachable. `parseSwapKitAsset` itself always
  // returns a truthy object, so the previous `if (parsed)` was dead.
  if (token.includes(".")) {
    const parsed = parseSwapKitAsset(token);
    // The SwapKit asset string carries its own chain prefix; honour it
    // even if it differs from `chain` (the destination chain may not be
    // the one the caller passed). `lookupToken` indexes by the WDK
    // chain name (e.g. "ethereum"), not the SwapKit prefix ("ETH"), so
    // translate before the lookup.
    if (parsed.address) {
      const t = lookupToken(prefixToWdkChain(parsed.chain), parsed.address);
      if (t) return t.decimals;
    }
    if (parsed.symbol === NATIVE_SYMBOL[parsed.chain]) {
      return NATIVE_DECIMALS[parsed.chain];
    }
    // Unknown SwapKit asset on a non-EVM chain — fall back to chain native.
    return NATIVE_DECIMALS[parsed.chain];
  }

  // Bare token — assume it's a contract address on the given chain.
  if (token.startsWith("0x")) {
    const t = lookupToken(chain, token);
    if (t) return t.decimals;
  }

  return NATIVE_DECIMALS[prefix];
}
