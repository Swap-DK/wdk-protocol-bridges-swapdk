export { SwapDKBridgeEvm } from "./SwapDKBridgeEvm.js";
export type { WaitForBridgeOptions } from "./SwapDKBridgeEvm.js";
export { SwapDKSwapEvm } from "./SwapDKSwapEvm.js";
export { SwapDKClient } from "@swapdk/wdk-protocol-bridge-swapdk-common";
export {
  SwapDKError,
  SwapDKNetworkError,
  SwapDKApiError,
  SwapDKProviderError,
  SwapDKUserError,
} from "@swapdk/wdk-protocol-bridge-swapdk-common";

// Re-export standard WDK protocol types
export type {
  BridgeOptions,
  BridgeResult,
  BridgeProtocolConfig,
  SwapOptions,
  SwapResult,
} from "@tetherto/wdk-wallet/protocols";
export { BridgeProtocol, SwapProtocol } from "@tetherto/wdk-wallet/protocols";

// SwapDK-specific types (module-local)
export type {
  SwapDKBridgeOptions,
  SwapDKBridgeResult,
  SwapDKBridgeQuoteResult,
  SwapDKSwapResult,
  EvmWalletAccount,
  SwapDKBridgeConfig,
} from "./types.js";

// swap-engine HTTP types — re-exported from common so callers don't have to
// install the common package directly.
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
} from "@swapdk/wdk-protocol-bridge-swapdk-common";

// EVM-specific (NATIVE_ADDRESS = 0x000…)
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
  KNOWN_TOKENS,
  lookupToken,
  registerToken,
} from "@swapdk/wdk-protocol-bridge-swapdk-common";
export type { KnownToken } from "@swapdk/wdk-protocol-bridge-swapdk-common";
