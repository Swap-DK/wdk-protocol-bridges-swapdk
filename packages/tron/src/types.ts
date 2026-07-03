// ---------------------------------------------------------------------------
// WDK-compatible bridge protocol types for SwapDK TRON source.
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
 * Configuration passed to the SwapDKBridgeTron constructor.
 */
export interface SwapDKBridgeConfig {
  /** swap-engine base URL (e.g. "https://api.swapdk.com") */
  apiUrl: string;
  /** SwapDK API key (sent as x-api-key header) */
  apiKey: string;
  /**
   * Maximum estimated bridge fee allowed (SUN). When set, `bridge()`
   * throws if the route's reported liquidity fee meets or exceeds this
   * cap.
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
 * For TRON source, `token` is one of:
 * - `"native"` / undefined → native TRX
 * - `"TRON.TRX"` → native TRX (SwapKit notation)
 * - `"TRON.USDT-T…"` → TRC-20 (SwapKit notation with base58 contract)
 *
 * `tokenOut` identifies the destination token; defaults to the native
 * of `targetChain` when omitted.
 */
export interface SwapDKBridgeOptions extends BridgeOptions {
  /**
   * Buy token on the destination chain.
   * - Omit for same-asset bridging (defaults to the native asset of
   *   `targetChain`).
   * - For cross-chain swaps pass the destination token identifier
   *   (`"ETH.ETH"`, `"ETH.USDC-0xA0b…"`, `"BTC.BTC"`).
   */
  tokenOut?: string;
}

/** Result of an executed bridge. */
export interface SwapDKBridgeResult extends BridgeResult {
  /** Sell amount actually consumed (base units of the source asset; SUN for TRX, raw units for TRC-20). */
  tokenInAmount: bigint;
  /** Expected buy amount on destination (base units of the destination asset). */
  tokenOutAmount: bigint;
  /**
   * Hash of the TRC-20 approval transaction, populated only when the
   * sell asset is a TRC-20 and the bridge had to set an allowance for
   * the THORChain router. `undefined` for native TRX swaps and for
   * cases where the existing allowance was already sufficient (not
   * currently checked; swap-engine emits an approvalTx whenever the
   * sell asset is TRC-20, so this is populated for every TRC-20 path
   * in v1).
   */
  approveHash?: string;
  /**
   * SwapKit asset string the `bridgeFee` is denominated in (e.g.
   * `"TRON.TRX"`). Empty / undefined when the route reported no
   * liquidity fee.
   */
  bridgeFeeAsset?: string;
}

/** Result of `quoteBridge()` — same shape as `bridge()` minus `hash`. */
export interface SwapDKBridgeQuoteResult extends Omit<BridgeResult, "hash"> {
  /** Sell amount (base units of the source asset). */
  tokenInAmount: bigint;
  /** Expected buy amount on destination (base units). */
  tokenOutAmount: bigint;
  /** Estimated total time in seconds (THORChain inbound + swap + outbound). */
  estimatedTime?: number;
  /** Providers chosen by swap-engine (e.g. ["THORCHAIN"]). */
  providers?: string[];
  /** See {@link SwapDKBridgeResult.bridgeFeeAsset}. */
  bridgeFeeAsset?: string;
}

// ---------------------------------------------------------------------------
// TRON wallet account (minimal interface we depend on)
// ---------------------------------------------------------------------------

/**
 * Minimal subset of a WDK TRON wallet account.
 *
 * Consumers pass any object that satisfies this interface — typically a
 * `WalletAccountTron` from `@swapdk/wdk-wallet-tron` (the fork that
 * adds optional `data` + `feeLimit` to `sendTransaction`, letting the
 * caller broadcast a `TriggerSmartContract` with raw ABI-encoded
 * calldata). We don't import that package directly to avoid version
 * coupling.
 */
export interface TronWalletAccount {
  /** Returns the base58 TRON address (`T…`). */
  getAddress(): string | Promise<string>;

  /**
   * Sign and broadcast a TRON transaction.
   *
   * Three modes:
   * - Plain TRX transfer: `{ to, value }`. No `data` / `feeLimit`.
   * - Smart-contract call (router deposit, TRC-20 approve, …):
   *   `{ to, value, data, feeLimit }` where `data` is the full
   *   ABI-encoded calldata (selector + args) and `feeLimit` caps SUN
   *   spent on energy. `value` becomes callValue.
   * - TransferContract with memo (THORChain inbound-vault deposit
   *   when the router contract isn't deployed): `{ to, value, memo }`
   *   where `memo` is the THORChain routing instruction. The wallet
   *   embeds it into the tx's `raw_data.data` field (the TVM
   *   equivalent of a BTC OP_RETURN). `data` MUST be unset for this
   *   path — if both are passed the wallet falls back to the
   *   contract-call path.
   */
  sendTransaction(options: {
    to: string;
    value?: bigint;
    data?: string;
    feeLimit?: bigint;
    memo?: string;
  }): Promise<{ hash: string; fee: bigint }>;

  /**
   * Optional — when present, the bridge module uses it to confirm
   * the TRC-20 approval tx before broadcasting the main bridge tx
   * (so the router has the allowance by the time it pulls funds).
   * The wallet may noop / poll its TronWeb-receipt API internally.
   */
  waitForTransaction?(hash: string, timeoutMs?: number): Promise<void>;
}
