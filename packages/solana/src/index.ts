export {
  SwapDKBridgeSolana,
  SOLANA_BASE_FEE_LAMPORTS,
} from "./SwapDKBridgeSolana.js";
export type { WaitForBridgeOptions } from "./SwapDKBridgeSolana.js";

export { SwapDKClient } from "@swapdk/swap-engine-client";
export {
  SwapDKError,
  SwapDKNetworkError,
  SwapDKApiError,
  SwapDKProviderError,
  SwapDKUserError,
} from "@swapdk/swap-engine-client";

// Re-export standard WDK protocol types
export type {
  BridgeOptions,
  BridgeResult,
  BridgeProtocolConfig,
} from "@tetherto/wdk-wallet/protocols";
export { BridgeProtocol } from "@tetherto/wdk-wallet/protocols";

// SwapDK-specific types (module-local)
export type {
  SwapDKBridgeOptions,
  SwapDKBridgeResult,
  SwapDKBridgeQuoteResult,
  SolanaWalletAccount,
  SwapDKBridgeConfig,
} from "./types.js";

// swap-engine HTTP types — re-exported from common so callers don't have
// to install the common package directly.
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
} from "@swapdk/swap-engine-client";

// Solana-specific (NATIVE_ADDRESS = "")
export {
  NATIVE_ADDRESS,
  getAssetDecimals,
  resolveAssetDecimals,
  toSwapKitAsset,
} from "./asset-map.js";

// Cross-chain helpers, registry, decimal tables — re-exported from common
export {
  NATIVE_SYMBOL,
  NATIVE_DECIMALS,
  parseSwapKitAsset,
  wdkChainToPrefix,
  prefixToWdkChain,
  toHumanDecimal,
  fromHumanDecimal,
  toBigInt,
  isLikelySolanaAddress,
  KNOWN_TOKENS,
  lookupToken,
  registerToken,
} from "@swapdk/swap-engine-client";
export type { KnownToken } from "@swapdk/swap-engine-client";

export { buildNativeTransferWithMemo } from "./tx-builder.js";
export type { BuildNativeTransferWithMemoArgs } from "./tx-builder.js";
