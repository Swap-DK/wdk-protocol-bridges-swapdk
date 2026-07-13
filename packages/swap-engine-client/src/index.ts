// @swapdk/swap-engine-client — shared HTTP client + zod-validated schemas
// for the SwapDK swap-engine REST API. Consumed by both distribution
// channels (the WDK protocol bridge family under @swapdk/wdk-protocol-
// bridge-swapdk-* and the wagmi-native @swapdk/wagmidk).

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

// HTTP wire formats — zod schemas authoritative; types derived via z.infer.
// Re-exporting both the schemas (for callers who need runtime checks of
// their own) and the type aliases (the common consumer face).
export {
  QuoteRequestSchema,
  QuoteResponseSchema,
  QuoteRouteSchema,
  SwapRequestSchema,
  SwapResponseSchema,
  TrackRequestSchema,
  TrackLegSchema,
  TrackResponseSchema,
  ChainflipAssetSchema,
  BrokerChannelRequestSchema,
  BrokerChannelResponseSchema,
  BrokerChannelRefundParametersSchema,
  BrokerChannelDCAParametersSchema,
  BrokerChannelMetadataSchema,
  BrokerChannelAffiliateFeeSchema,
  SwidgeSupportedChainSchema,
  SwidgeSupportedTokenSchema,
  SwidgeChainsResponseSchema,
  SwidgeTokensResponseSchema,
} from "./http-schemas.js";

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
  SwidgeSupportedChain,
  SwidgeSupportedToken,
  SwidgeChainsResponse,
  SwidgeTokensResponse,
  SwidgeTokensQuery,
} from "./http-schemas.js";

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

export {
  TERMINAL_TRACK_STATUSES,
  isTerminalTrackStatus,
  sleep,
  defaultBuyAsset,
  feeAssetOfType,
  sumFeesOfType,
  assertAllowedSourceChain,
} from "./bridge-helpers.js";
export type { BridgeFee } from "./bridge-helpers.js";
