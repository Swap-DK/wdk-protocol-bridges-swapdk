// ---------------------------------------------------------------------------
// @swapdk/wdk-protocol-swidge-swapdk — public exports.
// ---------------------------------------------------------------------------

export { SwapDKSwidge } from "./SwapDKSwidge.js";
export type {
  SwidgeStatus,
  SwidgeFeeType,
  SwidgeFee,
  SwidgeTransaction,
  SwidgeQuote,
  SwidgeResult,
  SwidgeStatusOptions,
  SwidgeStatusResult,
} from "./SwapDKSwidge.js";

export type {
  SwapDKSwidgeConfig,
  SwapDKSwidgeOptions,
  SwidgeWalletAccount,
  TronPrebuiltTransaction,
  TronWebLike,
} from "./types.js";

// Per-source-chain adapter account interfaces. Consumers use these to
// type-check the wallet they pass to `new SwapDKSwidge(account, config)`.
// The adapter functions + registry themselves are not part of the public
// surface — extension via custom adapters is a non-goal for now; consumers
// with genuine needs there should open an issue.
export type {
  SwidgeBtcAccount,
  SwidgeCosmosAccount,
  SwidgeEvmAccount,
  SwidgeSolanaAccount,
  SwidgeTronAccount,
} from "./adapters/index.js";

export {
  swapkitChainFor,
  swidgeChainFor,
  chainFamilyFor,
  nativeMetaFor,
  allSwidgeChains,
} from "./chain-map.js";

export {
  encodeSwapKitAsset,
  toHumanAmount,
  fromHumanAmount,
} from "./asset-encode.js";

// Re-export the swap-engine-client errors that consumers may catch on
// their end so they don't need to install the client package directly.
export {
  SwapDKError,
  SwapDKNetworkError,
  SwapDKApiError,
  SwapDKProviderError,
  SwapDKUserError,
} from "@swapdk/swap-engine-client";
