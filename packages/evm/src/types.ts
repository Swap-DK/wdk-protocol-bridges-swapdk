// ---------------------------------------------------------------------------
// WDK-compatible bridge protocol types for SwapDK
// ---------------------------------------------------------------------------

// Re-export standard WDK bridge types so consumers don't need a direct
// dependency on @tetherto/wdk-wallet just for these.
export type {
  BridgeOptions,
  BridgeResult,
  BridgeProtocolConfig,
} from "@tetherto/wdk-wallet/protocols";

import type {
  BridgeOptions,
  BridgeResult,
} from "@tetherto/wdk-wallet/protocols";

import type { SwapResult } from "@tetherto/wdk-wallet/protocols";

// ---------------------------------------------------------------------------
// SwapDK extensions to the standard WDK protocol types
// ---------------------------------------------------------------------------

/**
 * Extended swap result.
 *
 * Superset of the standard WDK {@link SwapResult} with the ERC-20 approval
 * hash that swap-engine may return for same-chain swaps.
 */
export interface SwapDKSwapResult extends SwapResult {
  approveHash?: string;
}

// ---------------------------------------------------------------------------
// SwapDK extensions to the standard WDK bridge types
// ---------------------------------------------------------------------------

/**
 * Configuration passed to the SwapDKBridgeEvm constructor.
 *
 * The standard WDK {@link BridgeProtocolConfig} only has `bridgeMaxFee`.
 * This config adds SwapDK-specific options (API URL, key, slippage).
 */
export interface SwapDKBridgeConfig {
  /** swap-engine base URL (e.g. "https://api.swapdk.com") */
  apiUrl: string;
  /** SwapDK API key (sent as x-api-key header) */
  apiKey: string;
  /** Maximum estimated gas fee (wei) allowed per bridge tx. */
  bridgeMaxFee?: bigint;
  /** Maximum estimated gas fee (wei) allowed per same-chain swap tx. */
  swapMaxFee?: bigint;
  /** Default slippage in basis points (default: 300 = 3 %). */
  slippageBps?: number;
  /** HTTP request timeout in milliseconds (default: 10_000). */
  timeoutMs?: number;
  /** Max retries on network errors or 5xx responses (default: 2). */
  retries?: number;
}

/**
 * Extended bridge options.
 *
 * Adds an optional `tokenOut` field to the standard WDK {@link BridgeOptions}
 * because SwapDK supports cross-chain *swaps* (different token in / out),
 * not just same-token bridging.
 */
export interface SwapDKBridgeOptions extends BridgeOptions {
  /**
   * Buy token on the destination chain.
   * - For same-token bridging this can be omitted.
   * - For cross-chain swaps pass the destination token identifier
   *   (e.g. "BTC.BTC" or an address on the target chain).
   */
  tokenOut?: string;
}

/**
 * Extended bridge result.
 *
 * Superset of the standard WDK {@link BridgeResult} with additional fields
 * that are available from swap-engine.
 */
export interface SwapDKBridgeResult extends BridgeResult {
  /** Sell amount actually consumed (base units). */
  tokenInAmount: bigint;
  /** Expected buy amount on destination (base units). */
  tokenOutAmount: bigint;
  /** ERC-20 approve tx hash, if an approval was needed. */
  approveHash?: string;
  /**
   * SwapKit asset string identifying which currency `bridgeFee` is
   * denominated in (e.g. `"ETH.USDC-0xA0b…"`). For cross-asset routes
   * the fee asset can differ from both source and destination — UIs
   * need this to format the fee correctly. `undefined` when the route
   * did not surface a fee asset.
   */
  bridgeFeeAsset?: string;
}

/**
 * Result of a bridge quote.
 *
 * Matches `Omit<BridgeResult, 'hash'>` (the WDK contract for quoteBridge)
 * with additional SwapDK-specific fields.
 */
export interface SwapDKBridgeQuoteResult extends Omit<BridgeResult, "hash"> {
  /** Sell amount (base units). */
  tokenInAmount: bigint;
  /** Expected buy amount on destination (base units). */
  tokenOutAmount: bigint;
  /** Estimated total time in seconds. */
  estimatedTime?: number;
  /** Providers chosen by swap-engine (e.g. ["THORCHAIN"]). */
  providers?: string[];
  /** See {@link SwapDKBridgeResult.bridgeFeeAsset}. */
  bridgeFeeAsset?: string;
}

// ---------------------------------------------------------------------------
// EVM wallet account (minimal interface we depend on)
// ---------------------------------------------------------------------------

/**
 * Minimal subset of a WDK EVM wallet account.
 *
 * Consumers pass any object that satisfies this interface — typically a
 * `WalletAccountEvm` from `@tetherto/wdk-wallet-evm`.  We don't import
 * that package directly to avoid version coupling.
 *
 * `sendTransaction` is permissive about its return type: some
 * implementations (e.g. ethers-style) return an object carrying
 * `{ hash, wait, ... }`; others return the hash string directly.
 * The bridge normalises this internally.
 */
export interface EvmWalletAccount {
  getAddress(): string | Promise<string>;
  sendTransaction(tx: {
    to: string;
    value?: bigint;
    data?: string;
    gas?: bigint;
  }): Promise<string | { hash: string }>;
  /**
   * Wait for a transaction to be confirmed on-chain.
   * Optional — if not provided, bridge() will proceed immediately
   * after sending the approve tx (which may fail if the node has not
   * yet confirmed the allowance).
   */
  waitForTransaction?(hash: string): Promise<void>;
}

// HTTP types moved to @swapdk/swap-engine-client
