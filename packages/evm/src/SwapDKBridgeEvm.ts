// ---------------------------------------------------------------------------
// SwapDKBridgeEvm — WDK bridge protocol module
//
// Extends the standard WDK BridgeProtocol base class.
// Wraps the SwapDK swap-engine REST API to enable cross-chain swaps
// from any EVM source chain to any destination chain supported by
// THORChain, MAYAChain, or Chainflip.
// ---------------------------------------------------------------------------

import { BridgeProtocol } from "@tetherto/wdk-wallet/protocols";

import {
  SwapDKClient,
  SwapDKApiError,
  SwapDKProviderError,
  SwapDKUserError,
  NATIVE_SYMBOL,
  wdkChainToPrefix,
  toHumanDecimal,
  fromHumanDecimal,
  pickBestRoute,
} from "@swapdk/wdk-protocol-bridge-swapdk-common";
import type { QuoteRoute, TrackResponse } from "@swapdk/wdk-protocol-bridge-swapdk-common";
import { toSwapKitAsset, resolveAssetDecimals } from "./asset-map.js";
import type {
  EvmWalletAccount,
  SwapDKBridgeConfig,
  SwapDKBridgeOptions,
  SwapDKBridgeQuoteResult,
  SwapDKBridgeResult,
} from "./types.js";

const TERMINAL_TRACK_STATUSES = new Set(["completed", "refunded", "failed"]);

function isTerminalTrackStatus(status: string): boolean {
  return TERMINAL_TRACK_STATUSES.has(status);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Options for {@link SwapDKBridgeEvm.waitForBridge}. */
export interface WaitForBridgeOptions {
  /** Poll interval in milliseconds (default: 15_000). */
  pollIntervalMs?: number;
  /** Overall timeout in milliseconds (default: 600_000 = 10 min). */
  timeoutMs?: number;
  /** Called once per poll that returns data, useful for progress UI. */
  onUpdate?: (status: TrackResponse) => void;
}

export class SwapDKBridgeEvm extends BridgeProtocol {
  private readonly client: SwapDKClient;
  private readonly evmAccount: EvmWalletAccount;
  private readonly swapDKConfig: SwapDKBridgeConfig;
  /** WDK source chain this instance was registered for. */
  private sourceChain: string | undefined;

  constructor(account: EvmWalletAccount, config: SwapDKBridgeConfig) {
    // Pass WDK-standard BridgeProtocolConfig to the base class.
    // The account is cast because EvmWalletAccount is a minimal subset
    // of IWalletAccount — the base class only stores it, never calls it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    super(account as any, { bridgeMaxFee: config.bridgeMaxFee });
    this.evmAccount = account;
    this.swapDKConfig = config;
    this.client = new SwapDKClient(config.apiUrl, config.apiKey, {
      timeoutMs: config.timeoutMs,
      retries: config.retries,
    });
  }

  /**
   * Set the WDK source chain (called by the host when registering
   * via `registerProtocol(chain, …)`). Falls back to "ethereum".
   */
  setSourceChain(chain: string): void {
    this.sourceChain = chain;
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
    const route = await this.fetchBestRoute(options, false);
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
    const sourceAddress = await this.getAddress();

    // 1. Get quote with tx data
    let route = await this.fetchBestRoute(options, true, sourceAddress);

    // 2. Enforce bridgeMaxFee before sending any transaction
    this.assertFeeWithinLimit(route);

    // 3. Call /swap to finalize route and get calldata.
    //    If the routeId has expired, re-quote once and retry.
    let swapRes = await this.client.swap({
      routeId: route.routeId,
      sourceAddress,
      destinationAddress: options.recipient,
    }).catch(async (err) => {
      if (err instanceof SwapDKApiError && err.isStaleRoute) {
        route = await this.fetchBestRoute(options, true, sourceAddress);
        this.assertFeeWithinLimit(route);
        return this.client.swap({
          routeId: route.routeId,
          sourceAddress,
          destinationAddress: options.recipient,
        });
      }
      throw err;
    });

    // 4. Send ERC-20 approval if needed and wait for confirmation
    let approveHash: string | undefined;
    if (swapRes.approvalTx) {
      approveHash = await this.evmAccount.sendTransaction({
        to: swapRes.approvalTx.to,
        data: swapRes.approvalTx.data,
        value: swapRes.approvalTx.value
          ? BigInt(swapRes.approvalTx.value)
          : 0n,
        gas: swapRes.approvalTx.gasLimit
          ? BigInt(swapRes.approvalTx.gasLimit)
          : undefined,
      });

      if (this.evmAccount.waitForTransaction) {
        await this.evmAccount.waitForTransaction(approveHash);
      }
    }

    // 5. Send the bridge / swap transaction
    const tx = swapRes.tx;
    if (!tx) {
      throw new SwapDKUserError(
        "swap-engine returned no transaction data — " +
        "the route may require a manual deposit (memo-based). " +
        `Providers: ${swapRes.providers.join(", ")}`,
      );
    }

    const hash = await this.evmAccount.sendTransaction({
      to: tx.to,
      data: tx.data,
      value: tx.value ? BigInt(tx.value) : 0n,
      gas: tx.gas ? BigInt(tx.gas) : undefined,
    });

    // 6. Build result
    const fee = tx.gas ? BigInt(tx.gas) : 0n;
    const srcChain = this.sourceChain ?? "ethereum";
    const sellDecimals = resolveAssetDecimals(srcChain, options.token);
    const buyDecimals = resolveAssetDecimals(options.targetChain, options.tokenOut);
    const bridgeFee = this.sumFees(swapRes.fees, "liquidity");

    return {
      hash,
      fee,
      bridgeFee,
      tokenInAmount: fromHumanDecimal(swapRes.sellAmount, sellDecimals),
      tokenOutAmount: fromHumanDecimal(swapRes.buyAmount, buyDecimals),
      approveHash,
    };
  }

  // -----------------------------------------------------------------
  // trackBridge  — one-shot status lookup
  // -----------------------------------------------------------------

  /**
   * Look up the current status of a cross-chain bridge transaction.
   *
   * Uses swap-engine's `/track` endpoint, which queries THORChain and
   * MAYAChain Midgard for the given hash. Returns `null` if the hash
   * isn't (yet) indexed by either — this is the 404 case and is the
   * normal state briefly after `bridge()` returns before the deposit
   * is observed.
   *
   * Note: tracking is limited to THORChain and MAYAChain routes on the
   * swap-engine side. Chainflip-routed bridges will consistently return
   * `null`.
   *
   * @param hash     Source-chain tx hash (as returned by `bridge()`).
   * @param chainId  Source chain ID string. Defaults to the SwapKit
   *                 prefix of the source chain (e.g. "ETH"), which
   *                 swap-engine accepts.
   * @returns Tracking data, or `null` when the hash is not in Midgard.
   */
  async trackBridge(
    hash: string,
    chainId?: string,
  ): Promise<TrackResponse | null> {
    const resolvedChainId = chainId ?? wdkChainToPrefix(this.sourceChain ?? "ethereum");
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

  /**
   * Poll `/track` until the bridge reaches a terminal state
   * (`completed`, `refunded`, or `failed`), or until `timeoutMs` elapses.
   *
   * The first poll is immediate; subsequent polls are spaced by
   * `pollIntervalMs` (default 15 s). `onUpdate` fires for every
   * non-null status update, which is useful for progress UIs.
   *
   * @throws {SwapDKUserError} when the timeout elapses without reaching
   *         a terminal state.
   * @throws Propagates any non-404 HTTP error from `/track`.
   */
  async waitForBridge(
    hash: string,
    chainId?: string,
    opts: WaitForBridgeOptions = {},
  ): Promise<TrackResponse> {
    const pollInterval = opts.pollIntervalMs ?? 15_000;
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
      // Wait before next poll, but not past the deadline.
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
    includeTx: boolean,
    sourceAddress?: string,
  ): Promise<QuoteRoute> {
    const addr = sourceAddress ?? await this.getAddress();
    const srcChain = this.sourceChain ?? "ethereum";

    const sellAsset = toSwapKitAsset(options.token, srcChain);
    const buyAsset = options.tokenOut
      ? toSwapKitAsset(options.tokenOut, options.targetChain)
      : this.defaultBuyAsset(options.targetChain);

    const sellDecimals = resolveAssetDecimals(srcChain, options.token);

    const quoteRes = await this.client.quote({
      sellAsset,
      buyAsset,
      sellAmount: toHumanDecimal(BigInt(options.amount!), sellDecimals),
      sourceAddress: addr,
      destinationAddress: options.recipient,
      slippage: this.swapDKConfig.slippageBps ?? 300,
      includeTx,
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

  /**
   * When no explicit tokenOut is given, default to the native asset
   * of the target chain (e.g. "BTC.BTC" for bitcoin).
   */
  private defaultBuyAsset(targetChain: string): string {
    const prefix = wdkChainToPrefix(targetChain);
    const symbol = NATIVE_SYMBOL[prefix];
    if (!symbol) {
      throw new SwapDKUserError(`No default buy asset for chain: ${targetChain}`);
    }
    return `${prefix}.${symbol}`;
  }

  private assertFeeWithinLimit(route: QuoteRoute): void {
    const limit = this.swapDKConfig.bridgeMaxFee;
    if (limit === undefined) return;

    const fee = route.tx?.gas ? BigInt(route.tx.gas) : 0n;
    if (fee > limit) {
      throw new SwapDKUserError(
        `Estimated fee ${fee} wei exceeds bridgeMaxFee ${limit} wei`,
      );
    }
  }

  private async getAddress(): Promise<string> {
    return this.evmAccount.getAddress();
  }

  private routeToQuoteResult(
    route: QuoteRoute,
    options: SwapDKBridgeOptions,
  ): SwapDKBridgeQuoteResult {
    const fee = route.tx?.gas ? BigInt(route.tx.gas) : 0n;
    const srcChain = this.sourceChain ?? "ethereum";
    const sellDecimals = resolveAssetDecimals(srcChain, options.token);
    const buyDecimals = resolveAssetDecimals(options.targetChain, options.tokenOut);
    const bridgeFee = this.sumFees(route.fees, "liquidity");

    return {
      fee,
      bridgeFee,
      tokenInAmount: fromHumanDecimal(route.sellAmount, sellDecimals),
      tokenOutAmount: fromHumanDecimal(route.expectedBuyAmount, buyDecimals),
      estimatedTime: route.estimatedTime?.total,
      providers: route.providers,
    };
  }

  /**
   * Sum fees of a given type, best-effort.
   *
   * swap-engine returns fee amounts in mixed formats across providers
   * (some human-decimal, some scaled). This method parses each amount
   * via `fromHumanDecimal` using the fee's `asset` to resolve decimals.
   * Unknown assets fall back to 18 decimals. Unparseable entries are
   * skipped — the returned value is informational, not authoritative.
   */
  private sumFees(
    fees: Array<{ type: string; amount: string; asset?: string }>,
    feeType: string,
  ): bigint {
    return fees
      .filter((f) => f.type === feeType)
      .reduce((sum, f) => {
        let decimals = 18;
        if (f.asset) {
          // `resolveAssetDecimals` derives the chain from the SwapKit
          // notation itself when the input contains ".", so any fallback
          // wdkChain works here.
          try {
            decimals = resolveAssetDecimals("ethereum", f.asset);
          } catch {
            // Unknown asset — 18 is a reasonable default for EVM fees.
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

