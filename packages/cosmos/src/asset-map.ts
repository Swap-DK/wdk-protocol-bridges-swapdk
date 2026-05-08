// ---------------------------------------------------------------------------
// Cosmos source-chain asset mapping
//
// Translates the various forms of `token` a caller may pass on a Cosmos
// source — bare denom, SwapKit asset string, or the `"native"` sentinel —
// into the SwapKit notation swap-engine expects, and resolves decimals for
// the human↔base conversions at the HTTP boundary.
//
// Cosmos-specific bits (the `"native"` sentinel, the `toSwapKitAsset` /
// `resolveAssetDecimals` helpers that branch on it) live here. Cross-chain
// constants like NATIVE_DECIMALS, parseSwapKitAsset, lookupToken are
// imported from common.
// ---------------------------------------------------------------------------

import {
  NATIVE_SYMBOL,
  NATIVE_DECIMALS,
  parseSwapKitAsset,
  wdkChainToPrefix,
  prefixToWdkChain,
  lookupToken,
  SwapDKUserError,
} from "@swapdk/wdk-protocol-bridge-swapdk-common";

const COSMOS_PREFIXES = new Set(["THOR", "MAYA"]);

/**
 * Sentinel value indicating "the native gas/swap asset of the active source
 * chain" (RUNE on THORChain, CACAO on MAYAChain).
 */
export const NATIVE_TOKEN = "native";

/**
 * Bare-denom shortcuts for the natives, accepted as `token` in addition to
 * the SwapKit form. Lowercased for case-insensitive matching.
 */
const NATIVE_DENOM_BY_PREFIX: Record<string, string> = {
  THOR: "rune",
  MAYA: "cacao",
};

/**
 * Convert a Cosmos-source `token` value to a SwapKit asset string.
 *
 * Accepts three forms:
 * - `"native"` → resolved to the native of the active chain (`"THOR.RUNE"` /
 *   `"MAYA.CACAO"`)
 * - bare denom (`"rune"`, `"cacao"`) → resolved against the active chain
 * - SwapKit asset string (`"THOR.RUNE"`, `"MAYA.CACAO"`,
 *   `"THOR.BTC-BTC"`) → returned as-is after a basic sanity check
 *
 * @param token     The caller-supplied token identifier.
 * @param wdkChain  The WDK chain id the bridge is registered against
 *                  (`"thorchain"` or `"mayachain"`).
 */
export function toSwapKitAsset(token: string, wdkChain: string): string {
  if (!token) {
    throw new SwapDKUserError("token is required");
  }

  const prefix = wdkChainToPrefix(wdkChain);
  if (!COSMOS_PREFIXES.has(prefix)) {
    throw new SwapDKUserError(
      `Cosmos bridge only supports thorchain and mayachain as source, got: ${wdkChain}`,
    );
  }
  const nativeSymbol = NATIVE_SYMBOL[prefix];
  if (!nativeSymbol) {
    throw new SwapDKUserError(
      `No native asset registered for ${wdkChain}`,
    );
  }

  // `"native"` sentinel — resolve to the chain's gas asset.
  if (token.toLowerCase() === NATIVE_TOKEN) {
    return `${prefix}.${nativeSymbol}`;
  }

  // SwapKit form already — basic shape check, return verbatim.
  if (token.includes(".")) {
    const parsed = parseSwapKitAsset(token);
    if (!parsed.chain || !parsed.symbol) {
      throw new SwapDKUserError(`Invalid SwapKit asset string: ${token}`);
    }
    return token;
  }

  // Bare denom (e.g. "rune", "cacao"). Match against the active chain only —
  // we don't try to map "rune" while registered on MAYAChain or vice versa,
  // since that combination would need a separate cross-chain MsgSend path
  // that this module doesn't implement yet.
  const expectedDenom = NATIVE_DENOM_BY_PREFIX[prefix];
  if (expectedDenom && token.toLowerCase() === expectedDenom) {
    return `${prefix}.${nativeSymbol}`;
  }

  throw new SwapDKUserError(
    `Unsupported token "${token}" for source chain "${wdkChain}". ` +
      `Pass "native", "${expectedDenom}", or a SwapKit asset string ` +
      `like "${prefix}.${nativeSymbol}".`,
  );
}

/**
 * Resolve decimal precision for any SwapKit-form asset.
 *
 * Looks up via, in order:
 * 1. `lookupToken(chain, address)` for ERC-20 / SPL / TRC-20 (`"ETH.USDC-0xA0b…"`)
 * 2. `NATIVE_DECIMALS[prefix]` for chain-natives (`"THOR.RUNE"`, `"BTC.BTC"`)
 *
 * Throws if neither resolves — callers should always pass a known asset
 * (the swap-engine response uses SwapKit notation throughout, so this
 * should be reliable in practice).
 *
 * @param wdkChain Hint for ambiguous bare symbols. When `asset` is in
 *                 SwapKit form (`CHAIN.SYMBOL[-ADDR]`) the chain prefix
 *                 comes from the asset itself; this argument is only
 *                 consulted as a fallback.
 */
export function resolveAssetDecimals(
  wdkChain: string,
  asset: string | undefined,
): number {
  if (!asset) {
    // No token specified — use the native of the given WDK chain.
    const prefix = wdkChainToPrefix(wdkChain);
    return NATIVE_DECIMALS[prefix] ?? 18;
  }

  // SwapKit form: derive the chain prefix from the asset itself.
  if (asset.includes(".")) {
    const parsed = parseSwapKitAsset(asset);
    const prefix = parsed.chain.toUpperCase();
    if (parsed.address) {
      // The token registry is keyed by WDK chain id (e.g. "ethereum"),
      // so map prefix → wdk chain before lookup.
      try {
        const wdkChainForLookup = prefixToWdkChain(prefix);
        const known = lookupToken(wdkChainForLookup, parsed.address);
        if (known) return known.decimals;
      } catch {
        // Unknown prefix in `prefixToWdkChain` — fall through to native lookup.
      }
    }
    const decimals = NATIVE_DECIMALS[prefix];
    if (decimals !== undefined) return decimals;
    throw new SwapDKUserError(
      `Unknown decimals for asset: ${asset}. Pass a registered token or a chain native.`,
    );
  }

  // Bare denom — fall back to the chain's native decimals.
  const prefix = wdkChainToPrefix(wdkChain);
  return NATIVE_DECIMALS[prefix] ?? 18;
}
