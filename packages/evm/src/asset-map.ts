// ---------------------------------------------------------------------------
// EVM-specific asset mapping. Cross-chain primitives (CHAIN_MAP, decimal
// tables, helpers like `parseSwapKitAsset` / `toHumanDecimal` /
// `fromHumanDecimal`, registry lookup) all live in
// `@swapdk/wdk-protocol-bridge-swapdk-common`. What's here is only the
// EVM-source-specific bits: the zero-address marker for native gas
// tokens, and the helpers that branch on it.
// ---------------------------------------------------------------------------

import {
  SwapDKUserError,
  NATIVE_DECIMALS,
  NATIVE_SYMBOL,
  lookupToken,
  parseSwapKitAsset,
  prefixToWdkChain,
  wdkChainToPrefix,
} from "@swapdk/wdk-protocol-bridge-swapdk-common";

export const NATIVE_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Look up the decimal precision of a token.
 *
 * Throws for unknown ERC-20 addresses — callers should only pass tokens
 * that exist in the known-token registry (or extend it via
 * `registerToken`).
 */
export function getAssetDecimals(wdkChain: string, address: string): number {
  const prefix = wdkChainToPrefix(wdkChain);
  if (address.toLowerCase() === NATIVE_ADDRESS) {
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
 *  - `undefined` → native of `wdkChain`
 *  - Native zero address → native of `wdkChain`
 *  - Raw ERC-20 address → lookup in registry on `wdkChain`
 *  - Pre-formatted SwapKit notation (`BTC.BTC`, `TRON.USDT`, `ETH.USDC-0xA0b…`)
 *    → derive chain + decimals from the notation itself
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
 * Convert a token address + WDK chain into SwapKit asset notation
 * `CHAIN.SYMBOL-0xAddress`, carrying the real token symbol.
 *
 * swap-engine's /quote handler parses this string, strips the
 * `-0xAddress` suffix, and routes on the symbol alone — so the symbol
 * must be a real one recognised upstream (USDC, USDT, WETH, …),
 * not a placeholder.
 *
 * @example
 *   toSwapKitAsset("0x0000…0000", "ethereum")   // "ETH.ETH"
 *   toSwapKitAsset("0xA0b86991…", "ethereum")   // "ETH.USDC-0xA0b86991…"
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
      "wdkChain is required when tokenAddress is an ERC-20 address",
    );
  }

  const prefix = wdkChainToPrefix(wdkChain);

  if (tokenAddress.toLowerCase() === NATIVE_ADDRESS) {
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
