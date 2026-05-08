// ---------------------------------------------------------------------------
// swap-engine REST API request/response shapes shared across every bridge
// module. These types describe the wire contract; module-specific types
// (BridgeOptions/Result subclasses, wallet-account interfaces, etc.) live
// in their own packages.
// ---------------------------------------------------------------------------

/** POST /quote request body (SwapKit-compatible). */
export interface QuoteRequest {
  sellAsset: string;
  buyAsset: string;
  sellAmount: string;
  sourceAddress?: string;
  destinationAddress?: string;
  slippage?: number;
  includeTx?: boolean;
}

/** POST /quote response (subset of fields we use). */
export interface QuoteResponse {
  quoteId: string;
  routes: QuoteRoute[];
  providerErrors?: Array<{
    errorCode: string;
    provider: string;
    message: string;
  }>;
}

export interface QuoteRoute {
  routeId: string;
  providers: string[];
  sellAsset: string;
  sellAmount: string;
  buyAsset: string;
  expectedBuyAmount: string;
  expectedBuyAmountMaxSlippage: string;
  targetAddress?: string;
  inboundAddress?: string;
  approvalAddress?: string;
  expiration?: string;
  memo?: string;
  fees: Array<{
    type: string;
    amount: string;
    asset: string;
  }>;
  tx?: {
    to: string;
    from?: string;
    value?: string;
    data?: string;
    gas?: string;
    gasPrice?: string;
  };
  estimatedTime?: {
    inbound: number;
    swap: number;
    outbound: number;
    total: number;
  };
  totalSlippageBps: number;
}

/** POST /swap request body. */
export interface SwapRequest {
  routeId: string;
  sourceAddress: string;
  destinationAddress: string;
}

/** POST /swap response (subset of fields we use). */
export interface SwapResponse {
  sellAsset: string;
  sellAmount: string;
  buyAsset: string;
  buyAmount: string;
  routeId: string;
  providers: string[];
  targetAddress: string;
  inboundAddress?: string;
  memo?: string;
  tx?: {
    to: string;
    from?: string;
    value?: string;
    data?: string;
    gas?: string;
    gasPrice?: string;
  };
  approvalTx?: {
    to: string;
    from?: string;
    value?: string;
    data?: string;
    gasLimit?: string;
  };
  fees: Array<{
    type: string;
    amount: string;
    asset: string;
  }>;
  estimatedTime?: {
    total: number;
  };
}

/** POST /track request body. */
export interface TrackRequest {
  hash: string;
  chainId: string;
}

/**
 * Bridge-tracking status reported by swap-engine.
 *
 * Open string type — swap-engine may introduce new values over time,
 * but these are the documented set. Treat anything else as `"unknown"`.
 */
export type TrackStatus =
  | "completed"
  | "pending"
  | "swapping"
  | "refunded"
  | "failed"
  | "unknown";

export interface TrackMeta {
  provider?: string;
  providerAction?: string;
  images?: {
    from?: string;
    to?: string;
    provider?: string;
    chain?: string;
  };
}

export interface TrackLeg {
  chainId: string;
  hash: string;
  block: number;
  type: string;
  status: TrackStatus | string;
  trackingStatus: string;
  fromAsset: string;
  fromAmount: string;
  fromAddress: string;
  toAsset: string;
  toAmount: string;
  toAddress: string;
  finalisedAt: number;
  meta?: TrackMeta;
  payload?: Record<string, unknown>;
}

/** POST /track response (subset of fields we expose). */
export interface TrackResponse {
  chainId: string;
  hash: string;
  block: number;
  type: string;
  status: TrackStatus | string;
  trackingStatus: string;
  fromAsset: string;
  fromAmount: string;
  fromAddress: string;
  toAsset: string;
  toAmount: string;
  toAddress: string;
  finalisedAt: number;
  meta?: TrackMeta;
  payload?: Record<string, unknown>;
  legs?: TrackLeg[];
}
