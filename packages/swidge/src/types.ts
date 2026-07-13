// ---------------------------------------------------------------------------
// SwapDKSwidge public types.
//
// The base `SwidgeOptions` in @tetherto/wdk-wallet/protocols does not carry a
// `fromChain` field (only `toChain`), and its `fromToken` is expected to be
// unambiguous on its own. For SwapDK's multi-family source support (BTC / EVM
// / Cosmos / Solana / TRON) a plain "USDC" identifier can't disambiguate
// between ethereum-USDC and arbitrum-USDC, so we extend the base with an
// explicit `fromChain` — same pattern Orchestra's module uses.
// ---------------------------------------------------------------------------

import type { SwapDKClientConfig } from "@swapdk/swap-engine-client";
import type { SwidgeProtocolConfig } from "@tetherto/wdk-wallet/protocols";

/**
 * Wallet-account interface SwapDKSwidge accepts. This is intentionally a
 * structural subset of `IWalletAccount` from `@tetherto/wdk-wallet` — we
 * only need `getAddress()` for source-address handling and `sendTransaction`
 * for broadcasting. The concrete wallet manager module (e.g.
 * `@tetherto/wdk-wallet-evm`, `@tetherto/wdk-wallet-tron`) supplies these.
 *
 * `sendTransaction` is intentionally typed `unknown`; each source-chain
 * adapter narrows the argument shape internally and validates before
 * dispatching. This keeps the type surface small at the top level.
 */
export interface SwidgeWalletAccount {
  getAddress(): string | Promise<string>;
  sendTransaction(tx: unknown, timeoutMs?: number): Promise<{
    hash: string;
    fee: bigint;
    [key: string]: unknown;
  }>;
}

/**
 * Opaque marker for a prebuilt tronweb `Transaction`. Downstream
 * (`@tetherto/wdk-wallet-tron@^1.0.0-beta.8`) detects the prebuilt
 * shape via `!!tx.txID` and signs + broadcasts it verbatim.
 */
export interface TronPrebuiltTransaction {
  txID: string;
  [key: string]: unknown;
}

/**
 * Structural subset of the `tronweb` client used by the TRON adapter.
 * Any object satisfying this shape works — the concrete `TronWeb`
 * from `import { TronWeb } from 'tronweb'`, forks, or test mocks.
 */
export interface TronWebLike {
  address: { toHex(addr: string): string };
  /** Fallback per-tx energy cap when the swap-engine SwapTx doesn't supply one. */
  feeLimit?: number;
  transactionBuilder: {
    /**
     * Build a `TriggerSmartContract` transaction. When `functionSelector`
     * is empty and `options.input` is set, tronweb passes the raw hex
     * as calldata verbatim — the same code path used for the THORChain
     * router `depositWithExpiry` call and TRC-20 `approve`.
     */
    triggerSmartContract(
      contractAddress: string,
      functionSelector: string,
      options: { feeLimit?: number; callValue?: number; input?: string },
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

/**
 * Configuration for `SwapDKSwidge`.
 *
 * `defaultFromChain` seeds `fromChain` for quoteSwidge / swidge calls that
 * omit it — useful when an instance is bound to a specific source (an
 * `example-wdk-wallet` CLI running with NETWORK=ethereum, for instance).
 * Per-call `fromChain` in options always wins over this default.
 */
export interface SwapDKSwidgeConfig extends SwapDKClientConfig, SwidgeProtocolConfig {
  /** SwapDK swap-engine base URL (e.g. `"https://api.swapdk.com"`). */
  apiUrl: string;
  /** SwapDK API key (sent as `x-api-key`). */
  apiKey: string;
  /** Default source chain when options don't set `fromChain`. Optional. */
  defaultFromChain?: string;
  /**
   * Default slippage (decimal, e.g. 0.03 for 3%) when options don't set
   * either `slippage` or `minAmountOut`. Optional (fallback: 0.03).
   */
  defaultSlippage?: number;
  /**
   * Bitcoin miner-fee rate in sats/vB. Consumed by the BTC adapter for
   * both THORChain-path and Chainflip-path deposits. Optional — when
   * omitted the paired WDK BTC wallet estimates the fee from its
   * connected Electrum backend.
   */
  feeRate?: number | bigint;
  /**
   * TronWeb instance the TRON adapter uses to build the prebuilt
   * transaction (router-contract call or TransferContract-with-memo)
   * before handing it to `wallet.sendTransaction`. Required for TRON
   * sources, ignored otherwise. Pass the same tronweb instance the
   * paired `WalletManagerTron` was constructed with.
   *
   * Structurally typed via `TronWebLike` — a subset covering
   * `address.toHex`, `transactionBuilder.{triggerSmartContract,sendTrx,addUpdateData}`,
   * and an optional `feeLimit` fallback.
   */
  tronWeb?: TronWebLike;
  /** Optional Chainflip-broker-channel defaults for the BTC adapter. */
  chainflip?: {
    /** Refund min-price hex (default: `"0x0"`, no floor). */
    refundMinPrice?: string;
    /** Blocks the broker will retry the refund tx (default: 100). */
    refundRetryDuration?: number;
    /** DCA number of chunks (default: 1, no DCA). */
    dcaChunks?: number;
    /** DCA chunk interval in blocks. Required if `dcaChunks > 1`. */
    dcaChunkInterval?: number;
    /** Max boost fee in basis points (default: 0, no boost). */
    maxBoostFeeBps?: number;
  };
}

/**
 * Extension of the base `SwidgeOptions` with a source-chain field. Kept
 * separate from the module's `SwidgeOptions` re-export so consumers using
 * the base type keep working; consumers that need multi-chain source
 * routing import this instead.
 */
export interface SwapDKSwidgeOptions {
  /**
   * Source token identifier. For native gas coins, the upper-case ticker
   * (`"ETH"`, `"BTC"`, `"TRX"`). For fungibles, the contract address in
   * its chain-native format (EIP-55 hex for EVM, base58 for TRON /
   * Solana). Matches the `token` field returned by `getSupportedTokens`.
   */
  fromToken: string;
  /**
   * Source chain identifier (matches `SwidgeSupportedChain.id`). Required
   * for multi-family source support unless `SwapDKSwidgeConfig.defaultFromChain`
   * is set on the instance. Accepts numeric chain-ids for parity with
   * the base `SwidgeOptions` shape; internally normalized to string.
   */
  fromChain?: string | number;
  /** Destination token identifier — same conventions as `fromToken`. */
  toToken: string;
  /**
   * Destination chain identifier. Omit for same-chain swaps. Accepts
   * numeric chain-ids for parity with the base `SwidgeOptions` shape.
   */
  toChain?: string | number;
  /** Address receiving the destination tokens. */
  recipient?: string;
  /** Address receiving refunds if the route cannot complete. */
  refundAddress?: string;
  /** Slippage tolerance as a decimal (0.01 = 1%). Mutually exclusive with `minAmountOut`. */
  slippage?: number;
  /** Explicit minimum destination amount (base units). Overrides `slippage`. */
  minAmountOut?: bigint | number;
  /** Exact amount to spend (base units of the source token). Mutually exclusive with `toTokenAmount`. */
  fromTokenAmount?: bigint | number;
  /** Exact amount to receive (base units of the destination token). Mutually exclusive with `fromTokenAmount`. */
  toTokenAmount?: bigint | number;
}
