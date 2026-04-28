// @swapdk/wdk-protocol-bridge-swapdk-common — shared infrastructure for
// the SwapDK WDK protocol bridge family. Bridge-specific packages
// (`-evm`, `-solana`, …) depend on this and re-export what their users
// need; consumers don't typically install this package directly.

export {
  SwapDKError,
  SwapDKNetworkError,
  SwapDKApiError,
  SwapDKProviderError,
  SwapDKUserError,
} from "./errors.js";

export { SwapDKClient } from "./client.js";
export type { SwapDKClientConfig } from "./client.js";

export { pickBestRoute } from "./route-select.js";

export type {
  QuoteRequest,
  QuoteResponse,
  QuoteRoute,
  SwapRequest,
  SwapResponse,
  TrackRequest,
  TrackResponse,
  TrackLeg,
  TrackMeta,
  TrackStatus,
} from "./http-types.js";

export {
  CHAIN_MAP,
  NATIVE_SYMBOL,
  NATIVE_DECIMALS,
  wdkChainToPrefix,
  prefixToWdkChain,
  parseSwapKitAsset,
  toHumanDecimal,
  fromHumanDecimal,
  toBigInt,
} from "./asset-utils.js";

export {
  KNOWN_TOKENS,
  lookupToken,
  registerToken,
  isLikelySolanaAddress,
} from "./token-registry.js";
export type { KnownToken } from "./token-registry.js";
