// ---------------------------------------------------------------------------
// WDK-compatible bridge protocol types for SwapDK (Solana source)
// ---------------------------------------------------------------------------

export type {
  BridgeOptions,
  BridgeResult,
  BridgeProtocolConfig,
} from "@tetherto/wdk-wallet/protocols";

import type {
  BridgeOptions,
  BridgeResult,
} from "@tetherto/wdk-wallet/protocols";

// ---------------------------------------------------------------------------
// SwapDK extensions to the standard WDK bridge types
// ---------------------------------------------------------------------------

/**
 * Configuration passed to the SwapDKBridgeSolana constructor.
 *
 * The standard WDK {@link BridgeProtocolConfig} only has `bridgeMaxFee`.
 * This config adds SwapDK-specific options (API URL, key, slippage).
 */
export interface SwapDKBridgeConfig {
  /** swap-engine base URL (e.g. "https://api.swapdk.com") */
  apiUrl: string;
  /** SwapDK API key (sent as x-api-key header) */
  apiKey: string;
  /**
   * Maximum transaction fee (lamports) allowed per bridge tx.
   * Solana fees are measured in lamports (1 SOL = 1e9 lamports).
   */
  bridgeMaxFee?: bigint;
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
 * because SwapDK supports cross-chain swaps where the destination asset
 * is different from the source.
 */
export interface SwapDKBridgeOptions extends BridgeOptions {
  /**
   * Buy token on the destination chain.
   * - For same-symbol bridging (e.g. SOL.USDC → ETH.USDC) this can be omitted.
   * - For cross-chain swaps pass the destination token identifier
   *   (e.g. "BTC.BTC" or an ERC-20 address on the target chain).
   */
  tokenOut?: string;
}

/**
 * Extended bridge result.
 *
 * Superset of the standard WDK {@link BridgeResult} with swap-engine-specific
 * fields. There is no `approveHash` for Solana source: SPL transfers do not
 * require a separate approval tx (the CPI-based transfer is atomic).
 */
export interface SwapDKBridgeResult extends BridgeResult {
  /** Sell amount actually consumed (native base units: lamports / SPL base units). */
  tokenInAmount: bigint;
  /** Expected buy amount on destination (native base units of the buy asset). */
  tokenOutAmount: bigint;
  /**
   * SwapKit asset string identifying which currency `bridgeFee` is
   * denominated in. `undefined` when the route did not surface a fee
   * asset.
   */
  bridgeFeeAsset?: string;
}

/**
 * Result of a bridge quote.
 */
export interface SwapDKBridgeQuoteResult extends Omit<BridgeResult, "hash"> {
  /** Sell amount (native base units: lamports / SPL base units). */
  tokenInAmount: bigint;
  /** Expected buy amount on destination (native base units of the buy asset). */
  tokenOutAmount: bigint;
  /** Estimated total time in seconds. */
  estimatedTime?: number;
  /** Providers chosen by swap-engine (e.g. ["THORCHAIN"]). */
  providers?: string[];
  /** THORChain/MAYA vault address this bridge would deposit to. */
  inboundAddress?: string;
  /** THORChain memo that will be attached via the Memo program. */
  memo?: string;
  /**
   * Unix timestamp (as a decimal string) after which the inbound vault
   * no longer accepts this quote. The wire format from swap-engine is a
   * string; the BTC bridge also surfaces it as `string` — kept that way
   * here so callers can write one switch across all bridges.
   */
  expiration?: string;
  /** See {@link SwapDKBridgeResult.bridgeFeeAsset}. */
  bridgeFeeAsset?: string;
}

// ---------------------------------------------------------------------------
// Solana wallet account (minimal interface we depend on)
// ---------------------------------------------------------------------------

/**
 * Minimal subset of a WDK Solana wallet account.
 *
 * Consumers pass any object that satisfies this interface — typically a
 * `WalletAccountSolana` from `@tetherto/wdk-wallet-solana`. We don't
 * import that package directly to avoid version coupling.
 *
 * The critical capability: `sendTransaction` must accept either a
 * native-transfer convenience object (`{ to, value }`) *or* a
 * `transactionMessage` containing an `instructions` array built with
 * `@solana/transaction-messages`. The WDK Solana wallet (beta.7+)
 * already provides both paths. Our bridge relies on the `instructions`
 * path so it can attach a THORChain memo alongside the transfer.
 */
export interface SolanaWalletAccount {
  getAddress(): string | Promise<string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendTransaction(tx: any): Promise<{ hash: string; fee?: bigint }>;
  /**
   * Optional confirmation poll.
   * The WDK Solana wallet's own `sendTransaction` does not await
   * finality — if confirmation is needed, supply a helper here.
   */
  waitForTransaction?(hash: string): Promise<void>;
}

// HTTP types moved to @swapdk/swap-engine-client
