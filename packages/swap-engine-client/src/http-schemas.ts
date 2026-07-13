// ---------------------------------------------------------------------------
// swap-engine REST API schemas (zod-first) + types derived via `z.infer`.
//
// Schemas are the source of truth: every wire-format change happens here,
// types follow automatically. Bridge packages and WagmiDK import the type
// names (`QuoteResponse`, `TrackResponse`, …) — the schemas behind them
// are used by `SwapDKClient` to `.safeParse()` every response.
//
// Module-specific types (BridgeOptions/Result subclasses, wallet-account
// interfaces, etc.) live in their own packages.
// ---------------------------------------------------------------------------

import { z } from "zod";

// ---------------------------------------------------------------------------
// /quote
// ---------------------------------------------------------------------------

/** POST /quote request body (SwapKit-compatible). */
export const QuoteRequestSchema = z.object({
  sellAsset: z.string(),
  buyAsset: z.string(),
  sellAmount: z.string(),
  sourceAddress: z.string().optional(),
  destinationAddress: z.string().optional(),
  slippage: z.number().optional(),
  includeTx: z.boolean().optional(),
});
export type QuoteRequest = z.infer<typeof QuoteRequestSchema>;

const QuoteRouteFeeSchema = z.object({
  type: z.string(),
  amount: z.string(),
  asset: z.string(),
});

const RouteTxSchema = z.object({
  to: z.string(),
  from: z.string().optional(),
  value: z.string().optional(),
  data: z.string().optional(),
  gas: z.string().optional(),
  gasPrice: z.string().optional(),
  /**
   * Populated only on TRON routes — SUN cap on energy spend for the
   * contract call. EVM routes leave it empty and use `gas`/`gasPrice`
   * instead.
   */
  feeLimit: z.string().optional(),
});

const EstimatedTimeSchema = z.object({
  inbound: z.number(),
  swap: z.number(),
  outbound: z.number(),
  total: z.number(),
});

export const QuoteRouteSchema = z.object({
  routeId: z.string(),
  providers: z.array(z.string()),
  sellAsset: z.string(),
  sellAmount: z.string(),
  buyAsset: z.string(),
  expectedBuyAmount: z.string(),
  expectedBuyAmountMaxSlippage: z.string(),
  targetAddress: z.string().optional(),
  inboundAddress: z.string().optional(),
  approvalAddress: z.string().optional(),
  expiration: z.string().optional(),
  memo: z.string().optional(),
  fees: z.array(QuoteRouteFeeSchema),
  tx: RouteTxSchema.optional(),
  estimatedTime: EstimatedTimeSchema.optional(),
  totalSlippageBps: z.number(),
});
export type QuoteRoute = z.infer<typeof QuoteRouteSchema>;

/** POST /quote response (subset of fields we use). */
export const QuoteResponseSchema = z.object({
  quoteId: z.string(),
  routes: z.array(QuoteRouteSchema),
  providerErrors: z.array(
    z.object({
      errorCode: z.string(),
      provider: z.string(),
      message: z.string(),
    }),
  ).optional(),
});
export type QuoteResponse = z.infer<typeof QuoteResponseSchema>;

// ---------------------------------------------------------------------------
// /swap
// ---------------------------------------------------------------------------

/** POST /swap request body. */
export const SwapRequestSchema = z.object({
  routeId: z.string(),
  sourceAddress: z.string(),
  destinationAddress: z.string(),
});
export type SwapRequest = z.infer<typeof SwapRequestSchema>;

const SwapTxSchema = z.object({
  to: z.string(),
  from: z.string().optional(),
  value: z.string().optional(),
  data: z.string().optional(),
  gas: z.string().optional(),
  gasPrice: z.string().optional(),
  /** TRON only — SUN cap on energy. EVM routes leave it empty. */
  feeLimit: z.string().optional(),
  /**
   * TRON-only direct-vault-deposit path: when THORChain has the TRON
   * pool unhalted but no router contract deployed, swap-engine emits
   * a SwapTx with `data` empty and `memo` set to the routing string.
   * The wallet writes this into the TransferContract's
   * `raw_data.data` field (TVM equivalent of a Bitcoin OP_RETURN).
   * Empty / absent on the EVM, Cosmos, and TRON-router paths.
   */
  memo: z.string().optional(),
});

const ApprovalTxSchema = z.object({
  to: z.string(),
  from: z.string().optional(),
  value: z.string().optional(),
  data: z.string().optional(),
  gasLimit: z.string().optional(),
  /** TRON only — SUN cap on energy for the approve() call. */
  feeLimit: z.string().optional(),
});

/** POST /swap response (subset of fields we use). */
export const SwapResponseSchema = z.object({
  sellAsset: z.string(),
  sellAmount: z.string(),
  buyAsset: z.string(),
  buyAmount: z.string(),
  routeId: z.string(),
  providers: z.array(z.string()),
  targetAddress: z.string(),
  inboundAddress: z.string().optional(),
  memo: z.string().optional(),
  tx: SwapTxSchema.optional(),
  approvalTx: ApprovalTxSchema.optional(),
  fees: z.array(
    z.object({
      type: z.string(),
      amount: z.string(),
      asset: z.string(),
    }),
  ),
  estimatedTime: z.object({ total: z.number() }).optional(),
});
export type SwapResponse = z.infer<typeof SwapResponseSchema>;

// ---------------------------------------------------------------------------
// /track
// ---------------------------------------------------------------------------

/**
 * POST /track request body.
 *
 * swap-engine accepts either `(hash + chainId)` or `depositAddress`
 * alone. `depositAddress` is the Chainflip deposit-channel address; it
 * lets the client look up a swap before the inbound BTC tx has been
 * observed on-chain. Note: Chainflip's v2 swap API does **not** resolve
 * raw deposit addresses, so once a hash exists prefer it as the primary
 * identifier; the deposit address is a useful hint while waiting for
 * the first observation.
 */
export const TrackRequestSchema = z.object({
  hash: z.string().optional(),
  chainId: z.string().optional(),
  depositAddress: z.string().optional(),
});
export type TrackRequest = z.infer<typeof TrackRequestSchema>;

/**
 * Bridge-tracking status reported by swap-engine. Documented set; the
 * runtime field on legs / response is `z.string()` to accept future
 * server-introduced values without breaking parsing — consumers
 * `switch` on this type with a `default` arm for unknowns.
 */
export type TrackStatus =
  | "completed"
  | "pending"
  | "swapping"
  | "refunded"
  | "failed"
  | "unknown";

const TrackMetaSchema = z.object({
  provider: z.string().optional(),
  providerAction: z.string().optional(),
  images: z.object({
    from: z.string().optional(),
    to: z.string().optional(),
    provider: z.string().optional(),
    chain: z.string().optional(),
  }).optional(),
});
export type TrackMeta = z.infer<typeof TrackMetaSchema>;

const TrackLegBaseSchema = z.object({
  chainId: z.string(),
  hash: z.string(),
  block: z.number(),
  type: z.string(),
  /** Open string; see TrackStatus for the documented values. */
  status: z.string(),
  trackingStatus: z.string(),
  fromAsset: z.string(),
  fromAmount: z.string(),
  fromAddress: z.string(),
  toAsset: z.string(),
  toAmount: z.string(),
  toAddress: z.string(),
  finalisedAt: z.number(),
  meta: TrackMetaSchema.optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

export const TrackLegSchema = TrackLegBaseSchema;
export type TrackLeg = z.infer<typeof TrackLegSchema>;

/** POST /track response (subset of fields we expose). */
export const TrackResponseSchema = TrackLegBaseSchema.extend({
  legs: z.array(TrackLegSchema).optional(),
});
export type TrackResponse = z.infer<typeof TrackResponseSchema>;

// ---------------------------------------------------------------------------
// /chainflip/broker/channel
// ---------------------------------------------------------------------------

/**
 * Chainflip asset notation — pair of `chain` (e.g. "Bitcoin",
 * "Ethereum") and `asset` (e.g. "BTC", "USDC"). Distinct from the
 * SwapKit-style `"ETH.USDC-0x…"` strings used elsewhere; this shape is
 * only consumed by the `/chainflip/broker/channel` endpoint.
 */
export const ChainflipAssetSchema = z.object({
  chain: z.string(),
  asset: z.string(),
});
export type ChainflipAsset = z.infer<typeof ChainflipAssetSchema>;

/**
 * Refund parameters for a Chainflip deposit channel.
 *
 * `refundAddress` is required by Chainflip v2.0.5+ (swap-engine will
 * 400 if it's empty). It must be an address on the **source** chain —
 * for BTC source that's a BTC address.
 */
export const BrokerChannelRefundParametersSchema = z.object({
  refundAddress: z.string(),
  /** Price floor as a hex string; "0x0" disables the floor (default). */
  minPrice: z.string().optional(),
  /** Blocks the broker will retry the refund tx before giving up (default: 100). */
  retryDuration: z.number().optional(),
});
export type BrokerChannelRefundParameters = z.infer<typeof BrokerChannelRefundParametersSchema>;

/** Optional Dollar-Cost-Averaging parameters for split execution. */
export const BrokerChannelDCAParametersSchema = z.object({
  chunkInterval: z.number(),
  numberOfChunks: z.number(),
});
export type BrokerChannelDCAParameters = z.infer<typeof BrokerChannelDCAParametersSchema>;

/**
 * Optional Cross-Chain-Messaging metadata. Only relevant for destination
 * chains that support CCM (currently Ethereum / Arbitrum / Solana). For
 * plain BTC → ETH this is unused.
 */
export const BrokerChannelMetadataSchema = z.object({
  ccmAdditionalData: z.string().optional(),
  gasBudget: z.string().optional(),
  message: z.string().optional(),
  cfParameters: z.string().optional(),
});
export type BrokerChannelMetadata = z.infer<typeof BrokerChannelMetadataSchema>;

/** A single affiliate fee entry — up to 5 may be supplied. */
export const BrokerChannelAffiliateFeeSchema = z.object({
  /** Chainflip broker account (cF…). */
  brokerAddress: z.string(),
  /** Fee in basis points (1 bps = 0.01%). */
  feeBps: z.number(),
});
export type BrokerChannelAffiliateFee = z.infer<typeof BrokerChannelAffiliateFeeSchema>;

/** POST /chainflip/broker/channel request body. */
export const BrokerChannelRequestSchema = z.object({
  sellAsset: ChainflipAssetSchema,
  buyAsset: ChainflipAssetSchema,
  destinationAddress: z.string(),
  /**
   * Refund parameters. Required in practice — swap-engine 400s without
   * `refundAddress`. Kept optional in the schema to mirror the JSON
   * binding shape; callers must populate it.
   */
  refundParameters: BrokerChannelRefundParametersSchema.optional(),
  /**
   * Human-decimal sell amount (e.g. `"0.01"` for 0.01 BTC). When
   * supplied, swap-engine pre-checks it against the broker's
   * `minimum_deposit_amount` and returns 422
   * `broker_channel_amount_below_min` if the amount would lose funds
   * (Chainflip does NOT refund sub-minimum deposits).
   *
   * Strongly recommended for every channel allocation. The field is
   * optional so older clients keep working, but new code must populate
   * it from the quote's `sellAmount` to keep the safety net armed.
   */
  sellAmount: z.string().optional(),
  /** Optional DCA split. Defaults to no DCA (single execution). */
  dcaParameters: BrokerChannelDCAParametersSchema.optional(),
  /** Max boost-fee in bps; `0` (or omitted) disables boost. */
  maxBoostFeeBps: z.number().optional(),
  /** Up to 5 affiliate fee entries. */
  affiliateFees: z.array(BrokerChannelAffiliateFeeSchema).optional(),
  /** Optional CCM metadata (destination-chain dependent). */
  channelMetadata: BrokerChannelMetadataSchema.optional(),
});
export type BrokerChannelRequest = z.infer<typeof BrokerChannelRequestSchema>;

/** POST /chainflip/broker/channel response body. */
export const BrokerChannelResponseSchema = z.object({
  /** Unique deposit address allocated for this swap intent. */
  depositAddress: z.string(),
  /**
   * Composite channel identifier in the form
   * `<issuedBlock>-<SourceChain>-<channelId>` (e.g.
   * `6739624-Bitcoin-2562`). Suitable for explorer deep-links and as
   * the primary identifier passed to `/track` if no inbound tx hash
   * has been observed yet.
   */
  channelId: z.string(),
  /** Chainflip explorer URL for the channel; empty if not configured. */
  explorerUrl: z.string(),
  /**
   * Server-side error message in the response body; HTTP status will be
   * non-2xx in that case and the client throws. Surfaced here mainly
   * because the wire shape always carries the field, even on success
   * (it's empty then).
   */
  error: z.string(),
});
export type BrokerChannelResponse = z.infer<typeof BrokerChannelResponseSchema>;

// ---------------------------------------------------------------------------
// /chains + /tokens?shape=swidge — swidge-native discovery
// ---------------------------------------------------------------------------

/**
 * A chain entry returned by `GET /chains`. The shape mirrors the
 * `SwidgeSupportedChain` typedef in `@tetherto/wdk-wallet/protocols`
 * so downstream swidge modules can return this value unchanged.
 *
 * Swap-engine aggregates the union of chains supported across
 * THORChain / MAYAChain / Chainflip and drops chains that are
 * paused at every provider that would otherwise route them.
 */
export const SwidgeSupportedChainSchema = z.object({
  /** Swidge chain identifier (lowercase, e.g. "ethereum", "bitcoin", "tron"). */
  id: z.string(),
  /** Human-readable chain name. */
  name: z.string(),
  /** Chain family: "evm" | "bitcoin" | "cosmos" | "tron" | "solana" | "other". */
  type: z.string(),
  /** Ticker of the native gas asset ("ETH", "BTC", "TRX", …). */
  nativeToken: z.string(),
});
export type SwidgeSupportedChain = z.infer<typeof SwidgeSupportedChainSchema>;

export const SwidgeChainsResponseSchema = z.array(SwidgeSupportedChainSchema);
export type SwidgeChainsResponse = z.infer<typeof SwidgeChainsResponseSchema>;

/**
 * A token entry returned by `GET /tokens?shape=swidge`. Shape mirrors
 * `SwidgeSupportedToken` in the swidge protocol interface.
 *
 * `token` is the contract address (EIP-55 checksummed for EVM, base58
 * or base58check for TRON / Solana) for fungible tokens, or the
 * upper-case ticker for native gas coins. `chain` is the swidge chain
 * id (matches `SwidgeSupportedChain.id`).
 */
export const SwidgeSupportedTokenSchema = z.object({
  token: z.string(),
  chain: z.string(),
  symbol: z.string(),
  decimals: z.number(),
  address: z.string().optional(),
  name: z.string().optional(),
});
export type SwidgeSupportedToken = z.infer<typeof SwidgeSupportedTokenSchema>;

export const SwidgeTokensResponseSchema = z.array(SwidgeSupportedTokenSchema);
export type SwidgeTokensResponse = z.infer<typeof SwidgeTokensResponseSchema>;

/**
 * Optional filters for `GET /tokens?shape=swidge`. Empty / undefined
 * fields disable the corresponding filter.
 */
export interface SwidgeTokensQuery {
  /** Restrict to tokens on this chain (swidge chain id). */
  fromChain?: string;
  /**
   * Reserved for future route-scoped discovery. Currently accepted by
   * the backend but ignored — see swap-engine's
   * `internal/swidgediscovery/tokens.go` for the rationale.
   */
  fromToken?: string;
  /** Restrict to tokens on this destination chain (swidge chain id). */
  toChain?: string;
}
