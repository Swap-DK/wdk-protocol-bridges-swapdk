// ---------------------------------------------------------------------------
// WDK-compatible bridge protocol types for SwapDK Bitcoin source.
// ---------------------------------------------------------------------------

import type {
  BridgeOptions,
  BridgeResult,
} from "@tetherto/wdk-wallet/protocols";

// Re-export the standard WDK bridge types so consumers don't need a direct
// dependency on @tetherto/wdk-wallet just for these.
export type {
  BridgeOptions,
  BridgeResult,
  BridgeProtocolConfig,
} from "@tetherto/wdk-wallet/protocols";

// ---------------------------------------------------------------------------
// SwapDK extensions
// ---------------------------------------------------------------------------

/**
 * Configuration passed to the SwapDKBridgeBtc constructor.
 */
export interface SwapDKBridgeConfig {
  /** swap-engine base URL (e.g. "https://api.swapdk.com") */
  apiUrl: string;
  /** SwapDK API key (sent as x-api-key header) */
  apiKey: string;
  /**
   * Maximum estimated bridge fee allowed (satoshis). When set, `bridge()`
   * throws if the route's reported liquidity fee meets or exceeds this cap.
   */
  bridgeMaxFee?: bigint;
  /** Default slippage in basis points (default: 300 = 3 %). */
  slippageBps?: number;
  /** HTTP request timeout in milliseconds (default: 10_000). */
  timeoutMs?: number;
  /** Max retries on network errors or 5xx responses (default: 2). */
  retries?: number;
  /**
   * Optional fee rate (sats/vB) passed through to the BTC wallet's
   * `sendTransaction`. When omitted, the wallet auto-estimates via its
   * Electrum/Blockbook client.
   */
  feeRate?: number | bigint;
}

/**
 * Extended bridge options.
 *
 * For BTC source, `token` is implicitly `"BTC.BTC"` (the only thing this
 * module accepts) and need not be supplied. `tokenOut` identifies the
 * destination token; defaults to the native of `targetChain` when omitted.
 */
export interface SwapDKBridgeOptions extends BridgeOptions {
  /**
   * Buy token on the destination chain.
   * - Omit for same-asset bridging (defaults to the native asset of
   *   `targetChain`).
   * - For cross-chain swaps pass the destination token identifier
   *   (`"ETH.ETH"`, `"ETH.USDC-0xA0b…"`, `"LTC.LTC"`).
   */
  tokenOut?: string;

  // ---------------------------------------------------------------------
  // Chainflip-only fields. All optional and ignored when the chosen
  // route is THORChain / MAYAChain (the THORChain path encodes refund
  // and affiliate semantics implicitly via the swap memo). The bridge
  // module fills sane defaults when these are omitted on a Chainflip
  // route — see SwapDKBridgeBtc.openBrokerChannel().
  // ---------------------------------------------------------------------

  /**
   * Chainflip-only: address to refund to if the swap fails or the
   * channel expires. Must be a BTC address (source-chain).
   *
   * Defaults to the sender's own address (`account.getAddress()`) when
   * omitted, which is almost always what you want.
   */
  refundAddress?: string;

  /**
   * Chainflip-only: price floor as a hex string (Chainflip-specific
   * encoding). `"0x0"` disables the floor — that's the default and
   * matches Chainflip's broker-API convention.
   */
  refundMinPrice?: string;

  /**
   * Chainflip-only: blocks the broker will retry the refund tx before
   * giving up. Defaults to 100 (Chainflip's default).
   */
  refundRetryDuration?: number;

  /**
   * Chainflip-only: split the swap into N chunks for DCA execution.
   * Defaults to 1 (no DCA). Requires `dcaChunkInterval` when > 1.
   */
  dcaChunks?: number;

  /**
   * Chainflip-only: blocks between DCA chunks. Only consulted when
   * `dcaChunks > 1`.
   */
  dcaChunkInterval?: number;

  /**
   * Chainflip-only: max boost fee in basis points to pay for faster
   * confirmation. `0` (or omitted) disables boost.
   */
  maxBoostFeeBps?: number;
}

/** Result of an executed bridge. */
export interface SwapDKBridgeResult extends BridgeResult {
  /** Sell amount actually consumed (satoshis). */
  tokenInAmount: bigint;
  /** Expected buy amount on destination (base units of the destination asset). */
  tokenOutAmount: bigint;
  /**
   * SwapKit asset string the `bridgeFee` is denominated in (e.g.
   * `"BTC.BTC"` for THORChain BTC routes, `"ETH.USDC-0xA0b…"` for
   * Chainflip's USDC-denominated liquidity fee). Empty / undefined when
   * the route reported no liquidity fee. Pair with the bridge module's
   * `resolveAssetDecimals` to format `bridgeFee` for display.
   */
  bridgeFeeAsset?: string;
  /** Which provider this bridge went through (`"THORCHAIN"`, `"MAYACHAIN"`, `"CHAINFLIP"`). */
  provider: string;
  /**
   * Chainflip-only: the deposit address allocated for this swap. Useful
   * for the consumer to persist alongside the tx hash — `trackBridge`
   * accepts it as a fallback identifier while the BTC inbound tx is
   * still in the mempool.
   */
  depositAddress?: string;
  /**
   * Chainflip-only: composite channel identifier (e.g.
   * `"6739624-Bitcoin-2562"`). Used for explorer deep-links.
   */
  channelId?: string;
}

/** Result of `quoteBridge()` — same shape as `bridge()` minus `hash`. */
export interface SwapDKBridgeQuoteResult extends Omit<BridgeResult, "hash"> {
  /** Sell amount (satoshis). */
  tokenInAmount: bigint;
  /** Expected buy amount on destination (base units). */
  tokenOutAmount: bigint;
  /** See {@link SwapDKBridgeResult.bridgeFeeAsset}. */
  bridgeFeeAsset?: string;
  /** Estimated total time in seconds (THORChain inbound + swap + outbound). */
  estimatedTime?: number;
  /** Providers chosen by swap-engine (e.g. ["THORCHAIN"]). */
  providers?: string[];
  /**
   * Where the user should send their BTC.
   *
   * - For THORChain / MAYAChain routes this is the inbound vault from
   *   `/quote` (rotating Asgard address); the deposit tx must carry
   *   `memo` as an OP_RETURN output.
   * - For Chainflip routes this is the unique deposit channel address
   *   allocated by the broker; the deposit is a plain transfer with
   *   no OP_RETURN.
   */
  inboundAddress?: string;
  /**
   * THORChain / MAYAChain only: the OP_RETURN memo for the deposit tx.
   * Empty / undefined for Chainflip routes.
   */
  memo?: string;
  /**
   * Unix timestamp (seconds) after which the inbound vault no longer
   * accepts this quote. Re-quote past this time. Populated for
   * THORChain / MAYAChain; Chainflip's `sourceChainExpiryBlock` is
   * not currently surfaced by swap-engine and is omitted here.
   */
  expiration?: string;
  /**
   * Chainflip-only: composite channel id for explorer deep-links.
   */
  channelId?: string;
}

// ---------------------------------------------------------------------------
// BTC wallet account (minimal interface we depend on)
// ---------------------------------------------------------------------------

/**
 * Minimal subset of a WDK Bitcoin wallet account.
 *
 * Consumers pass any object that satisfies this interface — typically a
 * `WalletAccountBtc` from `@swapdk/wdk-wallet-btc` (the fork that adds
 * OP_RETURN `memo` support to `sendTransaction`). We don't import that
 * package directly to avoid version coupling.
 */
export interface BtcWalletAccount {
  /** Returns the BIP-84 native-SegWit address (`bc1q…`). */
  getAddress(): string | Promise<string>;

  /**
   * Sign and broadcast a spending transaction. `memo`, when supplied, is
   * emitted as an `OP_RETURN` output carrying the bytes verbatim — this
   * is the contract added by `@swapdk/wdk-wallet-btc` over upstream
   * `@tetherto/wdk-wallet-btc`. The memo is required for THORChain
   * inbound observation; deposits without it are refunded.
   */
  sendTransaction(
    options: {
      to: string;
      value: bigint;
      feeRate?: number | bigint;
      confirmationTarget?: number;
      memo?: string | Uint8Array;
    },
    timeoutMs?: number,
  ): Promise<{ hash: string; fee: bigint }>;
}
