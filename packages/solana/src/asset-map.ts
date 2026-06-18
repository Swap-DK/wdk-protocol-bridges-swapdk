// ---------------------------------------------------------------------------
// Solana-specific asset mapping. Cross-chain primitives (CHAIN_MAP,
// decimal tables, helpers like `parseSwapKitAsset` / `toHumanDecimal` /
// `fromHumanDecimal`, registry lookup, `isLikelySolanaAddress`) all
// live in `@swapdk/swap-engine-client`. What's here is
// only the Solana-source-specific bits: the empty-string marker for
// native SOL, and the helpers that branch on it.
// ---------------------------------------------------------------------------

import {
  SwapDKUserError,
  NATIVE_DECIMALS,
  NATIVE_SYMBOL,
  lookupToken,
  parseSwapKitAsset,
  prefixToWdkChain,
  wdkChainToPrefix,
} from "@swapdk/swap-engine-client";

/**
 * Marker value that means "native SOL" as the source asset.
 *
 * Solana has no canonical "zero address" for native SOL — the community
 * convention varies (some use the wSOL mint `So111…112`; some use an
 * empty string). In this module the user passes an empty string to
 * signal native SOL; any non-empty `token` is treated as an SPL mint
 * and looked up in the known-token registry.
 */
export const NATIVE_ADDRESS = "";

/**
 * Look up the decimal precision of an SPL token or native SOL.
 *
 * @param wdkChain WDK chain id — for the source this is always "solana";
 *                 for a destination this could be any supported chain.
 * @param address  Empty string for native (gas) token on `wdkChain`,
 *                 or an address/mint for a token.
 *
 * Throws for unknown SPL mints — callers should only pass tokens that
 * exist in the known-token registry (or were added via `registerToken`).
 */
export function getAssetDecimals(wdkChain: string, address: string): number {
  const prefix = wdkChainToPrefix(wdkChain);
  if (!address || address === NATIVE_ADDRESS) {
    return NATIVE_DECIMALS[prefix];
  }
  const token = lookupToken(wdkChain, address);
  if (!token) {
    throw new SwapDKUserError(
      `Unknown token ${address} on ${wdkChain}. ` +
      `Only tokens registered in the known-token registry are supported.`,
    );
  }
  return token.decimals;
}

/**
 * Resolve decimals from any user-supplied asset reference on a given chain.
 *
 * Accepts:
 *  - `undefined` or `""` → native of `wdkChain`
 *  - Raw mint/address (Solana base58, EVM 0x…) → lookup in registry on `wdkChain`
 *  - Pre-formatted SwapKit notation (`BTC.BTC`, `ETH.USDC-0x…`,
 *    `SOL.USDC-Mint…`) → derive chain + decimals from the notation itself
 */
export function resolveAssetDecimals(
  wdkChain: string,
  tokenRef: string | undefined,
): number {
  if (!tokenRef) {
    return NATIVE_DECIMALS[wdkChainToPrefix(wdkChain)];
  }
  if (tokenRef.includes(".") && !tokenRef.startsWith("0x")) {
    const parsed = parseSwapKitAsset(tokenRef);
    if (parsed.address) {
      return getAssetDecimals(prefixToWdkChain(parsed.chain), parsed.address);
    }
    const decimals = NATIVE_DECIMALS[parsed.chain.toUpperCase()];
    if (decimals === undefined) {
      throw new SwapDKUserError(`Unknown SwapKit chain prefix: ${parsed.chain}`);
    }
    return decimals;
  }
  return getAssetDecimals(wdkChain, tokenRef);
}

/**
 * Convert a Solana asset identifier into SwapKit asset notation
 * `CHAIN.SYMBOL-Mint`, carrying the real token symbol.
 *
 * swap-engine's /quote handler parses this string, strips the `-Mint`
 * suffix, and routes on the symbol alone — so the symbol must be a
 * real one recognised upstream (SOL, USDC, USDT, …), not a placeholder.
 *
 * @example
 *   toSwapKitAsset("", "solana")                 // "SOL.SOL"
 *   toSwapKitAsset("EPjFWdd5…", "solana")        // "SOL.USDC-EPjFWdd5…"
 *   toSwapKitAsset("BTC.BTC")                    // passthrough
 */
export function toSwapKitAsset(
  tokenAddress: string,
  wdkChain?: string,
): string {
  if (tokenAddress.includes(".") && !tokenAddress.startsWith("0x")) {
    return tokenAddress;
  }

  if (!wdkChain) {
    throw new SwapDKUserError(
      "wdkChain is required when tokenAddress is a raw mint address",
    );
  }

  const prefix = wdkChainToPrefix(wdkChain);

  if (!tokenAddress || tokenAddress === NATIVE_ADDRESS) {
    return `${prefix}.${NATIVE_SYMBOL[prefix]}`;
  }

  const token = lookupToken(wdkChain, tokenAddress);
  if (!token) {
    throw new SwapDKUserError(
      `Unknown token ${tokenAddress} on ${wdkChain}. ` +
      `Only tokens registered in the known-token registry are supported.`,
    );
  }

  return `${prefix}.${token.symbol}-${tokenAddress}`;
}
