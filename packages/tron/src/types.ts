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
   * TronWeb instance used to build the router-contract calldata tx AND
   * the memo-carrying TransferContract before they're handed to
   * `wallet.sendTransaction`. Upstream `@tetherto/wdk-wallet-tron@^1.0.0-beta.8`
   * accepts a prebuilt tronweb Transaction (detected via `txID`) and
   * signs+broadcasts it verbatim — the bridge constructs the two
   * tx-shapes THORChain requires (see `bridge()` for the router vs.
   * direct-vault dispatch).
   *
   * Pass the SAME tronweb instance you gave to WalletManagerTron for
   * consistent chain/RPC state.
   */
  tronWeb: TronWebLike;
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
// TRON wallet account (aligned with @tetherto/wdk-wallet-tron@^1.0.0-beta.8)
// ---------------------------------------------------------------------------

/**
 * A tronweb `Transaction` — the shape upstream `_isPrebuiltTransaction`
 * recognises (must carry `txID`). Kept opaque here because we don't
 * depend on `tronweb`'s type declarations at the bridge level;
 * consumers who want full type-checking can import `Transaction` from
 * `tronweb` and cast.
 */
export interface TronPrebuiltTransaction {
  /** Non-empty tx hash — the field upstream uses to detect prebuilt shape. */
  txID: string;
  /** Everything else tronweb populates. */
  [key: string]: unknown;
}

/**
 * Minimal subset of a WDK TRON wallet account that this bridge uses.
 *
 * Aligned with `@tetherto/wdk-wallet-tron@^1.0.0-beta.8`'s
 * `WalletAccountTron.sendTransaction(tx)` — the upstream method accepts
 * a prebuilt tronweb `Transaction` (detected via `txID`) and returns
 * `{ hash, fee, activationFee }`. The bridge builds the transaction
 * itself (router calldata OR TransferContract-with-memo) and hands it
 * over verbatim.
 *
 * Previously the SwapDK fork `@swapdk/wdk-wallet-tron` accepted
 * `{ to, value, data, feeLimit, memo }` — that fork is retired as of
 * bridge 0.3.0 in favour of upstream's prebuilt-tx path.
 */
export interface TronWalletAccount {
  /** Returns the base58 TRON address (`T…`). */
  getAddress(): string | Promise<string>;

  /**
   * Sign and broadcast a prebuilt tronweb transaction. `tx.txID` must
   * be set — that's the signal to upstream that the transaction is
   * pre-built and should be signed as-is, without reconstructing.
   */
  sendTransaction(tx: TronPrebuiltTransaction): Promise<{
    hash: string;
    fee: bigint;
    /**
     * Non-zero only when the tx creates a new TRON account (native
     * transfer to an unactivated address). Bridge deposits go to the
     * THORChain inbound vault which is always activated, so this is
     * effectively 0 for our use — surfaced for consumers who want to
     * display it.
     */
    activationFee?: bigint;
  }>;

  /**
   * Optional — when present, the bridge uses it to confirm the TRC-20
   * approval tx before broadcasting the main bridge tx.
   */
  waitForTransaction?(hash: string, timeoutMs?: number): Promise<void>;
}

// ---------------------------------------------------------------------------
// TronWeb (structural subset — we only touch address + transactionBuilder)
// ---------------------------------------------------------------------------

/**
 * Structural subset of the `tronweb` client. Kept nominal so the bridge
 * package doesn't hard-depend on tronweb's type declarations — any
 * object satisfying this shape works (the concrete `TronWeb` instance
 * from `import { TronWeb } from 'tronweb'`, mocks, forks, etc.).
 */
export interface TronWebLike {
  address: {
    toHex(addr: string): string;
  };
  /** Fallback per-tx energy cap when swap-engine doesn't supply one. */
  feeLimit?: number;
  transactionBuilder: {
    /**
     * Build a `TriggerSmartContract` transaction. When `functionSelector`
     * is empty and `options.input` is set, tronweb passes the raw hex
     * as calldata verbatim — the same code path used for the THORChain
     * router `depositWithExpiry` call.
     */
    triggerSmartContract(
      contractAddress: string,
      functionSelector: string,
      options: {
        feeLimit?: number;
        callValue?: number;
        input?: string;
      },
      parameters: Array<{ type: string; value: string | number | bigint }>,
      issuerAddress: string,
    ): Promise<{ transaction: TronPrebuiltTransaction }>;

    /** Build a plain `TransferContract` (native TRX transfer). */
    sendTrx(
      to: string,
      value: number,
      from: string,
    ): Promise<TronPrebuiltTransaction>;

    /**
     * Attach a memo to a `TransferContract` via `raw_data.data`. The
     * memo is part of the tx hash preimage so this MUST be called
     * before signing — the returned tx has a fresh `txID`.
     */
    addUpdateData(
      transaction: TronPrebuiltTransaction,
      data: string,
      encoding?: string,
    ): Promise<TronPrebuiltTransaction>;
  };
}
