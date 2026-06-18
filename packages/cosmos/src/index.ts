export { SwapDKBridgeCosmos } from "./SwapDKBridgeCosmos.js";
export type { WaitForBridgeOptions } from "./SwapDKBridgeCosmos.js";

// SwapDK shared client + errors — re-exported so callers don't need a
// direct dependency on the common package.
export { SwapDKClient } from "@swapdk/swap-engine-client";
export {
  SwapDKError,
  SwapDKNetworkError,
  SwapDKApiError,
  SwapDKProviderError,
  SwapDKUserError,
} from "@swapdk/swap-engine-client";

// Standard WDK protocol types — re-exported for convenience.
export type {
  BridgeOptions,
  BridgeResult,
  BridgeProtocolConfig,
} from "@tetherto/wdk-wallet/protocols";
export { BridgeProtocol } from "@tetherto/wdk-wallet/protocols";

// SwapDK-specific types (module-local).
export type {
  SwapDKBridgeOptions,
  SwapDKBridgeResult,
  SwapDKBridgeQuoteResult,
  CosmosWalletAccount,
  SwapDKBridgeConfig,
} from "./types.js";

// swap-engine HTTP types — re-exported from common.
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

// Cosmos-specific helpers (the `"native"` sentinel, the asset-string
// resolver, and the decimals lookup).
export {
  NATIVE_TOKEN,
  toSwapKitAsset,
  resolveAssetDecimals,
} from "./asset-map.js";

// Cross-chain helpers re-exported from common — callers building their
// own quote/track flows often need these.
export {
  NATIVE_SYMBOL,
  NATIVE_DECIMALS,
  parseSwapKitAsset,
  wdkChainToPrefix,
  prefixToWdkChain,
  toHumanDecimal,
  fromHumanDecimal,
  toBigInt,
} from "@swapdk/swap-engine-client";
