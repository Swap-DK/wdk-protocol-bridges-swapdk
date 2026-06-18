export { SwapDKBridgeBtc } from "./SwapDKBridgeBtc.js";
export type {
  WaitForBridgeOptions,
  TrackBridgeOptions,
} from "./SwapDKBridgeBtc.js";

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
  BtcWalletAccount,
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
  ChainflipAsset,
  BrokerChannelRequest,
  BrokerChannelResponse,
  BrokerChannelRefundParameters,
  BrokerChannelDCAParameters,
  BrokerChannelMetadata,
  BrokerChannelAffiliateFee,
} from "@swapdk/swap-engine-client";

// BTC-specific helpers.
export {
  NATIVE_TOKEN,
  toSourceAsset,
  resolveAssetDecimals,
} from "./asset-map.js";

// Cross-chain helpers re-exported from common.
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
