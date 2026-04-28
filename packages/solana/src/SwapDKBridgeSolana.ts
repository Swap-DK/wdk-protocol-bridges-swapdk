// ---------------------------------------------------------------------------
// SwapDKBridgeSolana — WDK bridge protocol module (Solana as source).
//
// Extends the standard WDK BridgeProtocol. Wraps the SwapDK swap-engine
// REST API to enable cross-chain swaps from native SOL (and, via
// `registerToken`, SPL tokens) to any destination chain supported by
// THORChain, MAYAChain, or Chainflip.
//
// Unlike the EVM module, the SwapDK swap-engine does NOT prepare a
// signed-ready `tx` payload for Solana source — instead it returns
// `inboundAddress` (the THORChain vault) and `memo` (routing instruction).
// This client constructs a Solana transaction with:
//   1. SystemProgram transfer `sellAmount` SOL to `inboundAddress`
//   2. Memo Program instruction carrying `memo`
// and delegates signing + broadcast to the WDK Solana wallet.
// ---------------------------------------------------------------------------

import { BridgeProtocol } from "@tetherto/wdk-wallet/protocols";

import { SwapDKClient } from "@swapdk/wdk-protocol-bridge-swapdk-common";
import {
  SwapDKApiError,
  SwapDKProviderError,
  SwapDKUserError,
} from "@swapdk/wdk-protocol-bridge-swapdk-common";
import { toSwapKitAsset, resolveAssetDecimals } from "./asset-map.js";
import {
  NATIVE_SYMBOL,
  wdkChainToPrefix,
  toHumanDecimal,
  fromHumanDecimal,
  pickBestRoute,
} from "@swapdk/wdk-protocol-bridge-swapdk-common";
import { buildNativeTransferWithMemo } from "./tx-builder.js";
import type { QuoteRoute, TrackResponse } from "@swapdk/wdk-protocol-bridge-swapdk-common";
import type {
  SolanaWalletAccount,
  SwapDKBridgeConfig,
  SwapDKBridgeOptions,
  SwapDKBridgeQuoteResult,
  SwapDKBridgeResult,
} from "./types.js";

const SOLANA_CHAIN = "solana";
const SOLANA_PREFIX = "SOL";

/**
 * Base transaction fee on Solana mainnet for our bridge tx shape.
 *
 * Solana charges 5 000 lamports per signature (currently the runtime's
 * fixed base fee). Our bridge transactions are single-signer (the user's
 * wallet signs as both fee payer and SystemProgram transfer source — same
 * address), so the base fee is exactly one signature's worth.
 *
 * This module's `tx-builder.ts` does NOT add a `ComputeBudgetProgram`
 * priority-fee instruction, so the constant is accurate for what we
 * broadcast. If a caller wraps this module with custom priority-fee
 * logic, the wallet's actual returned fee may differ — `bridge()`
 * still returns the post-broadcast fee from the wallet so it remains
 * the source of truth for accounting.
 */
export const SOLANA_BASE_FEE_LAMPORTS = 5_000n;

const TERMINAL_TRACK_STATUSES = new Set(["completed", "refunded", "failed"]);

function isTerminalTrackStatus(status: string): boolean {
  return TERMINAL_TRACK_STATUSES.has(status);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Options for {@link SwapDKBridgeSolana.waitForBridge}. */
export interface WaitForBridgeOptions {
  /** Poll interval in milliseconds (default: 5_000 — Solana slots are fast). */
  pollIntervalMs?: number;
  /** Overall timeout in milliseconds (default: 600_000 = 10 min). */
  timeoutMs?: number;
  /** Called once per poll that returns data, useful for progress UI. */
  onUpdate?: (status: TrackResponse) => void;
}

export class SwapDKBridgeSolana extends BridgeProtocol {
  private readonly client: SwapDKClient;
  private readonly solanaAccount: SolanaWalletAccount;
  private readonly swapDKConfig: SwapDKBridgeConfig;

  constructor(account: SolanaWalletAccount, config: SwapDKBridgeConfig) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    super(account as any, { bridgeMaxFee: config.bridgeMaxFee });
    this.solanaAccount = account;
    this.swapDKConfig = config;
    this.client = new SwapDKClient(config.apiUrl, config.apiKey, {
      timeoutMs: config.timeoutMs,
      retries: config.retries,
    });
  }

  /**
   * No-op for API parity with the EVM module — the source chain for
   * `SwapDKBridgeSolana` is fixed at "solana".
   */
  setSourceChain(_chain: string): void {
    // intentional: single-source module
  }

  // -----------------------------------------------------------------
  // quoteBridge  — estimate without executing
  // -----------------------------------------------------------------

  async quoteBridge(
    options: SwapDKBridgeOptions,
  ): Promise<SwapDKBridgeQuoteResult> {
    if (options.amount === undefined) {
      throw new SwapDKUserError("amount is required for quoteBridge");
    }
    const route = await this.fetchBestRoute(options);
    return this.routeToQuoteResult(route, options);
  }

  // -----------------------------------------------------------------
  // bridge  — execute the cross-chain swap
  // -----------------------------------------------------------------

  async bridge(
    options: SwapDKBridgeOptions,
  ): Promise<SwapDKBridgeResult> {
    if (options.amount === undefined) {
      throw new SwapDKUserError("amount is required for bridge");
    }

    // Only native SOL is supported in this MVP. SPL source requires
    // a different instruction (SPL Token transfer) and is tracked
    // separately in the roadmap.
    if (options.token && options.token !== "") {
      throw new SwapDKUserError(
        "SPL-token source is not yet supported — pass an empty string to bridge native SOL",
      );
    }

    // 1. Enforce bridgeMaxFee BEFORE we touch the wallet. Solana fees
    //    are deterministic for our tx shape (1 signature, no priority
    //    instruction), so checking against SOLANA_BASE_FEE_LAMPORTS
    //    pre-broadcast is accurate and gives the same UX as the EVM
    //    module's pre-broadcast bridgeMaxFee check.
    this.assertFeeWithinLimit(SOLANA_BASE_FEE_LAMPORTS);

    const sourceAddress = await this.solanaAccount.getAddress();

    // 2. Fetch the best route and pull out inboundAddress + memo.
    const route = await this.fetchBestRoute(options, sourceAddress);
    const inboundAddress = route.inboundAddress;
    const memo = route.memo;
    if (!inboundAddress || !memo) {
      throw new SwapDKUserError(
        "swap-engine returned no inboundAddress/memo for this Solana route — " +
        `providers: ${route.providers.join(", ")}`,
      );
    }

    // 3. Build the transaction message (transfer + memo) and hand it to
    //    the wallet for signing + broadcast. The wallet fills in
    //    blockhash and fee payer.
    const sellDecimals = resolveAssetDecimals(SOLANA_CHAIN, options.token);
    const lamports = BigInt(options.amount);

    const transactionMessage = buildNativeTransferWithMemo({
      source: sourceAddress,
      destination: inboundAddress,
      lamports,
      memo,
    });

    // 4. Send. The WDK Solana wallet's sendTransaction:
    //    - sees `instructions` array → adds blockhash + fee payer,
    //    - signs with the account's keypair,
    //    - broadcasts and returns { hash, fee }.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await this.solanaAccount.sendTransaction(transactionMessage as any);

    // 5. Optionally wait for confirmation if the wallet supports it.
    if (this.solanaAccount.waitForTransaction) {
      await this.solanaAccount.waitForTransaction(result.hash);
    }

    const buyDecimals = resolveAssetDecimals(options.targetChain, options.tokenOut);

    return {
      // Wallet returns the actual fee (may include any priority fees a
      // custom wallet wrapper added). The pre-broadcast check above
      // protects against fee runaway in the common (no-priority) case;
      // we surface the actual paid fee here for accounting.
      hash: result.hash,
      fee: result.fee ?? SOLANA_BASE_FEE_LAMPORTS,
      bridgeFee: this.sumFees(route.fees, "liquidity"),
      tokenInAmount: fromHumanDecimal(route.sellAmount, sellDecimals),
      tokenOutAmount: fromHumanDecimal(route.expectedBuyAmount, buyDecimals),
    };
  }

  // -----------------------------------------------------------------
  // trackBridge  — one-shot status lookup
  // -----------------------------------------------------------------

  async trackBridge(
    hash: string,
    chainId?: string,
  ): Promise<TrackResponse | null> {
    const resolvedChainId = chainId ?? SOLANA_PREFIX;
    try {
      return await this.client.track({ hash, chainId: resolvedChainId });
    } catch (err) {
      if (err instanceof SwapDKApiError && err.isNotFound) {
        return null;
      }
      throw err;
    }
  }

  // -----------------------------------------------------------------
  // waitForBridge  — poll until terminal state
  // -----------------------------------------------------------------

  async waitForBridge(
    hash: string,
    chainId?: string,
    opts: WaitForBridgeOptions = {},
  ): Promise<TrackResponse> {
    const pollInterval = opts.pollIntervalMs ?? 5_000;
    const timeoutMs = opts.timeoutMs ?? 600_000;
    const deadline = Date.now() + timeoutMs;

    let last: TrackResponse | null = null;
    while (Date.now() < deadline) {
      const current = await this.trackBridge(hash, chainId);
      if (current) {
        last = current;
        opts.onUpdate?.(current);
        if (isTerminalTrackStatus(current.status)) {
          return current;
        }
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(pollInterval, remaining));
    }

    throw new SwapDKUserError(
      `Timed out after ${timeoutMs}ms waiting for bridge ${hash}` +
        ` (last status: ${last?.status ?? "not-found"})`,
    );
  }

  // -----------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------

  private async fetchBestRoute(
    options: SwapDKBridgeOptions,
    sourceAddressOverride?: string,
  ): Promise<QuoteRoute> {
    const addr = sourceAddressOverride ?? await this.solanaAccount.getAddress();

    const sellAsset = toSwapKitAsset(options.token, SOLANA_CHAIN);
    const buyAsset = options.tokenOut
      ? toSwapKitAsset(options.tokenOut, options.targetChain)
      : this.defaultBuyAsset(options.targetChain);

    const sellDecimals = resolveAssetDecimals(SOLANA_CHAIN, options.token);

    const quoteRes = await this.client.quote({
      sellAsset,
      buyAsset,
      sellAmount: toHumanDecimal(BigInt(options.amount!), sellDecimals),
      sourceAddress: addr,
      destinationAddress: options.recipient,
      slippage: this.swapDKConfig.slippageBps ?? 300,
      includeTx: false,
    });

    const best = pickBestRoute(quoteRes.routes);
    if (!best) {
      throw new SwapDKProviderError(
        sellAsset,
        buyAsset,
        quoteRes.providerErrors ?? [],
      );
    }
    return best;
  }

  private defaultBuyAsset(targetChain: string): string {
    const prefix = wdkChainToPrefix(targetChain);
    const symbol = NATIVE_SYMBOL[prefix];
    if (!symbol) {
      throw new SwapDKUserError(`No default buy asset for chain: ${targetChain}`);
    }
    return `${prefix}.${symbol}`;
  }

  private assertFeeWithinLimit(fee: bigint): void {
    const limit = this.swapDKConfig.bridgeMaxFee;
    if (limit === undefined) return;
    if (fee > limit) {
      throw new SwapDKUserError(
        `Transaction fee ${fee} lamports exceeds bridgeMaxFee ${limit} lamports`,
      );
    }
  }

  private routeToQuoteResult(
    route: QuoteRoute,
    options: SwapDKBridgeOptions,
  ): SwapDKBridgeQuoteResult {
    const sellDecimals = resolveAssetDecimals(SOLANA_CHAIN, options.token);
    const buyDecimals = resolveAssetDecimals(options.targetChain, options.tokenOut);
    const bridgeFee = this.sumFees(route.fees, "liquidity");

    return {
      // Solana base fee is deterministic for our 1-signature tx shape
      // (no priority/jito instruction). Returned here so callers can
      // surface a meaningful number in their UIs and so `bridgeMaxFee`
      // is enforceable pre-broadcast against the same constant.
      fee: SOLANA_BASE_FEE_LAMPORTS,
      bridgeFee,
      tokenInAmount: fromHumanDecimal(route.sellAmount, sellDecimals),
      tokenOutAmount: fromHumanDecimal(route.expectedBuyAmount, buyDecimals),
      estimatedTime: route.estimatedTime?.total,
      providers: route.providers,
      inboundAddress: route.inboundAddress,
      memo: route.memo,
      expiration: route.expiration ? Number(route.expiration) : undefined,
    };
  }

  private sumFees(
    fees: Array<{ type: string; amount: string; asset?: string }>,
    feeType: string,
  ): bigint {
    return fees
      .filter((f) => f.type === feeType)
      .reduce((sum, f) => {
        let decimals = 18;
        if (f.asset) {
          try {
            decimals = resolveAssetDecimals(SOLANA_CHAIN, f.asset);
          } catch {
            // unknown asset — 18 is a reasonable default.
          }
        }
        try {
          return sum + fromHumanDecimal(f.amount, decimals);
        } catch {
          return sum;
        }
      }, 0n);
  }
}
