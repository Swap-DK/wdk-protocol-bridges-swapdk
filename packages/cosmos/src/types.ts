// ---------------------------------------------------------------------------
// WDK-compatible bridge protocol types for SwapDK Cosmos source.
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
 * Configuration passed to the SwapDKBridgeCosmos constructor.
 *
 * The standard WDK `BridgeProtocolConfig` only has `bridgeMaxFee`. This
 * config adds SwapDK-specific options (API URL, key, slippage).
 */
export interface SwapDKBridgeConfig {
  /** swap-engine base URL (e.g. "https://api.swapdk.com") */
  apiUrl: string;
  /** SwapDK API key (sent as x-api-key header) */
  apiKey: string;
  /**
   * Maximum estimated bridge fee allowed (base units of the source asset's
   * native denom). When set, `bridge()` and `quoteBridge()` throw if the
   * estimated fee meets or exceeds this cap.
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
 * `tokenOut` is added because SwapDK supports cross-chain *swaps* (different
 * token in / out), not just same-token bridging.
 *
 * For Cosmos source, `token` is one of:
 * - the bare denom (`"rune"`, `"cacao"`)
 * - the SwapKit asset string (`"THOR.RUNE"`, `"MAYA.CACAO"`)
 * - the sentinel `"native"` — resolved against the active source chain
 */
export interface SwapDKBridgeOptions extends BridgeOptions {
  /**
   * Buy token on the destination chain.
   * - For same-token bridging this can be omitted (defaults to the native
   *   asset of `targetChain`).
   * - For cross-chain swaps pass the destination token identifier
   *   (e.g. `"BTC.BTC"`, `"ETH.ETH"`, or `"ETH.USDC-0xA0b…"`).
   */
  tokenOut?: string;
}

/** Result of an executed bridge. */
export interface SwapDKBridgeResult extends BridgeResult {
  /** Sell amount actually consumed (base units). */
  tokenInAmount: bigint;
  /** Expected buy amount on destination (base units). */
  tokenOutAmount: bigint;
  /**
   * SwapKit asset string identifying which currency `bridgeFee` is
   * denominated in (e.g. `"THOR.RUNE"`). `undefined` when the route did
   * not surface a fee asset.
   */
  bridgeFeeAsset?: string;
}

/** Result of `quoteBridge()` — same shape as `bridge()` minus `hash`. */
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
// Cosmos wallet account (minimal interface we depend on)
// ---------------------------------------------------------------------------

/**
 * Minimal subset of a WDK Cosmos wallet account.
 *
 * Consumers pass any object that satisfies this interface — typically a
 * `WalletAccountCosmos` from `@swapdk/wdk-wallet-cosmos`. We don't import
 * that package directly to avoid version coupling.
 */
export interface CosmosWalletAccount {
  /** Returns the bech32 address for this account. */
  getAddress(): string | Promise<string>;

  /**
   * Sign and broadcast a `types.MsgDeposit` against the configured RPC.
   * Used by `bridge()` for THORChain-routed RUNE swaps and
   * MAYAChain-routed CACAO swaps (the protocol-native source case).
   */
  deposit(
    options: { asset: string; amount: bigint | string; memo: string },
    overrides?: { gas?: string | number },
  ): Promise<{ hash: string; fee: bigint }>;

  /**
   * Sign and broadcast a Cosmos `MsgSend` against the configured RPC,
   * with the supplied memo attached to the tx. Used by `bridge()` for
   * cross-chain routes where the source asset must be sent to another
   * protocol's inbound vault (e.g. RUNE → BTC routed via MAYAChain
   * sends RUNE to MAYAChain's THORChain vault with the swap memo).
   */
  transfer(
    options: {
      token: string;
      recipient: string;
      amount: bigint | string;
      memo?: string;
    },
  ): Promise<{ hash: string; fee: bigint }>;
}
