// ---------------------------------------------------------------------------
// SwapDKBridgeTron — WDK bridge protocol module
//
// Extends the standard WDK BridgeProtocol base class.
// Wraps the SwapDK swap-engine REST API to enable cross-chain swaps from
// TRON (native TRX, TRC-20 USDT/USDC) as source to any destination
// supported by THORChain or MAYAChain.
//
// TRON inbound on THORChain uses the same router-contract pattern as
// EVM (`depositWithExpiry(vault, asset, amount, memo, expiration)`),
// just with base58 addresses and SUN as the value unit. swap-engine's
// TRON dispatch (utils/swap_engine.go) returns:
//   - `tx.to` — base58 router address (tronweb consumes directly)
//   - `tx.data` — full ABI-encoded calldata (selector + args)
//   - `tx.value` — callValue (SUN, decimal string)
//   - `tx.feeLimit` — SUN cap on energy
//   - `approvalTx` — populated for TRC-20 sells (TRC-20 `approve(router, amount)`)
//
// The wallet (`@swapdk/wdk-wallet-tron`) accepts these as
// `sendTransaction({ to, value, data, feeLimit })` and emits a
// TriggerSmartContract with the raw calldata. Chainflip routes for
// TRON source aren't supported in v1 (different deposit-channel model
// — pending separate research).
// ---------------------------------------------------------------------------

import { BridgeProtocol } from "@tetherto/wdk-wallet/protocols";

import {
  SwapDKClient,
  SwapDKApiError,
  SwapDKProviderError,
  SwapDKUserError,
  wdkChainToPrefix,
  toHumanDecimal,
  fromHumanDecimal,
  pickBestRoute,
  isTerminalTrackStatus,
  sleep,
  defaultBuyAsset,
  feeAssetOfType,
  sumFeesOfType,
  assertAllowedSourceChain,
} from "@swapdk/swap-engine-client";
import type {
  BridgeFee,
  QuoteRoute,
  TrackResponse,
} from "@swapdk/swap-engine-client";

import { toSourceAsset, resolveAssetDecimals } from "./asset-map.js";
import type {
  TronWalletAccount,
  SwapDKBridgeConfig,
  SwapDKBridgeOptions,
  SwapDKBridgeQuoteResult,
  SwapDKBridgeResult,
} from "./types.js";

const DEFAULT_SOURCE_CHAIN = "tron";
const TRON_ALLOWED_CHAINS: ReadonlySet<string> = new Set([DEFAULT_SOURCE_CHAIN]);

// Providers whose TRON inbound flow matches what this module knows
// how to broadcast: a router-contract call (THORChain `depositWithExpiry`,
// MAYAChain equivalent). Chainflip TRON source uses a deposit-channel
// model we haven't wired yet — quotes that come back exclusively from
// Chainflip are rejected upfront with a clear error.
const SUPPORTED_PROVIDERS = new Set(["THORCHAIN", "MAYACHAIN"]);

function hasSupportedProvider(route: QuoteRoute): boolean {
  return route.providers?.some((p) => SUPPORTED_PROVIDERS.has(p)) ?? false;
}

/** Options for {@link SwapDKBridgeTron.waitForBridge}. */
export interface WaitForBridgeOptions {
  /** Poll interval in milliseconds (default: 15_000). */
  pollIntervalMs?: number;
  /** Overall timeout in milliseconds (default: 600_000 = 10 min). */
  timeoutMs?: number;
  /** Called once per poll that returns data, useful for progress UI. */
  onUpdate?: (status: TrackResponse) => void;
}

export class SwapDKBridgeTron extends BridgeProtocol {
  private readonly client: SwapDKClient;
  private readonly tronAccount: TronWalletAccount;
  private readonly swapDKConfig: SwapDKBridgeConfig;
  /** WDK source chain this instance was registered for. */
  private sourceChain: string = DEFAULT_SOURCE_CHAIN;

  constructor(account: TronWalletAccount, config: SwapDKBridgeConfig) {
    // TronWalletAccount is a minimal subset of IWalletAccount — the
    // base class only stores it, never calls it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    super(account as any, { bridgeMaxFee: config.bridgeMaxFee });
    this.tronAccount = account;
    this.swapDKConfig = config;
    this.client = new SwapDKClient(config.apiUrl, config.apiKey, {
      timeoutMs: config.timeoutMs,
      retries: config.retries,
    });
  }

  /**
   * Set the WDK source chain. Only `"tron"` is accepted; supplied here
   * for parity with the other bridge modules so the host's
   * `registerProtocol(chain, …)` flow doesn't need to special-case TRON.
   */
  setSourceChain(chain: string): void {
    this.sourceChain = assertAllowedSourceChain(chain, TRON_ALLOWED_CHAINS, "TRON");
  }

  // -----------------------------------------------------------------
  // quoteBridge — estimate without executing
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
  // bridge — execute the cross-chain swap
  // -----------------------------------------------------------------

  async bridge(
    options: SwapDKBridgeOptions,
  ): Promise<SwapDKBridgeResult> {
    if (options.amount === undefined) {
      throw new SwapDKUserError("amount is required for bridge");
    }
    const sourceAddress = await this.tronAccount.getAddress();

    // 1. Get quote with tx data (includeTx:true asks swap-engine to
    //    populate `tx` with the router-contract calldata).
    let route = await this.fetchBestRoute(options, true, sourceAddress);

    // 2. Enforce bridgeMaxFee before any transaction goes out.
    this.assertFeeWithinLimit(route);

    // 3. Call /swap to finalise the route. On TRON, /swap returns the
    //    same calldata shape as /quote (`tx` + optional `approvalTx`);
    //    its purpose is to lock the inboundAddress at the moment of
    //    broadcast and to refresh stale quotes. We re-quote once on
    //    SwapDKApiError.isStaleRoute and retry.
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

    // 4. Send TRC-20 approval if needed and wait for confirmation. The
    //    router has to pull `amount` of the TRC-20 from the user, so
    //    the allowance must land on-chain before the deposit tx.
    let approveHash: string | undefined;
    if (swapRes.approvalTx) {
      const approveResult = await this.tronAccount.sendTransaction({
        to: swapRes.approvalTx.to,
        value: swapRes.approvalTx.value
          ? BigInt(swapRes.approvalTx.value)
          : 0n,
        data: swapRes.approvalTx.data,
        feeLimit: swapRes.approvalTx.feeLimit
          ? BigInt(swapRes.approvalTx.feeLimit)
          : undefined,
      });
      approveHash = approveResult.hash;

      if (this.tronAccount.waitForTransaction) {
        await this.tronAccount.waitForTransaction(approveHash);
      }
    }

    // 5. Send the bridge / swap transaction (router.depositWithExpiry).
    const tx = swapRes.tx;
    if (!tx) {
      throw new SwapDKUserError(
        "swap-engine returned no transaction data for TRON source. " +
          `Providers: ${swapRes.providers.join(", ")}`,
      );
    }

    const sendResult = await this.tronAccount.sendTransaction({
      to: tx.to,
      value: tx.value ? BigInt(tx.value) : 0n,
      data: tx.data,
      feeLimit: tx.feeLimit ? BigInt(tx.feeLimit) : undefined,
    });

    // 6. Build result. For TRON, `fee` is the SUN cap the wallet
    //    committed to (the actual energy burn is bounded by feeLimit
    //    and known only after the tx lands on-chain — the wallet
    //    surfaces feeLimit as the conservative upper bound).
    const sellDecimals = resolveAssetDecimals(this.sourceChain, swapRes.sellAsset);
    const buyDecimals = resolveAssetDecimals(options.targetChain, options.tokenOut);
    const bridgeFee = this.sumFees(swapRes.fees, "liquidity");

    return {
      hash: sendResult.hash,
      fee: sendResult.fee,
      bridgeFee,
      bridgeFeeAsset: feeAssetOfType(swapRes.fees, "liquidity"),
      tokenInAmount: fromHumanDecimal(swapRes.sellAmount, sellDecimals),
      tokenOutAmount: fromHumanDecimal(swapRes.buyAmount, buyDecimals),
      approveHash,
    };
  }

  // -----------------------------------------------------------------
  // trackBridge — one-shot status lookup
  // -----------------------------------------------------------------

  /**
   * Look up the current status of a cross-chain bridge transaction.
   *
   * Uses swap-engine's `/track` endpoint, which queries THORChain and
   * MAYAChain Midgard. Returns `null` if the hash isn't (yet) indexed —
   * the normal state briefly after `bridge()` returns, before the
   * deposit confirms on TRON and is observed by THORChain.
   *
   * TRON inbound confirmation typically takes ~30 seconds (1-2 TRON
   * blocks), so the `null` window is shorter than BTC's.
   *
   * @param hash     TRON tx hash (as returned by `bridge()`).
   * @param chainId  Source chain ID. Defaults to `"TRON"`.
   */
  async trackBridge(
    hash: string,
    chainId?: string,
  ): Promise<TrackResponse | null> {
    const resolvedChainId = chainId ?? wdkChainToPrefix(this.sourceChain);
    return this.client.trackOrNotFound({ hash, chainId: resolvedChainId });
  }

  // -----------------------------------------------------------------
  // waitForBridge — poll until terminal state
  // -----------------------------------------------------------------

  /**
   * Poll `/track` until the bridge reaches a terminal state
   * (`completed`, `refunded`, or `failed`), or until `timeoutMs` elapses.
   *
   * Default timeout is 10 min — TRON inbound is fast (~30s) but the
   * destination chain may add latency.
   *
   * @throws {SwapDKUserError} when the timeout elapses.
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
    const addr = sourceAddress ?? (await this.tronAccount.getAddress());

    const sellAsset = toSourceAsset(options.token, this.sourceChain);
    const buyAsset = options.tokenOut
      ? this.normaliseBuyAsset(options.tokenOut, options.targetChain)
      : defaultBuyAsset(options.targetChain);

    const sellDecimals = resolveAssetDecimals(this.sourceChain, sellAsset);

    const quoteRes = await this.client.quote({
      sellAsset,
      buyAsset,
      sellAmount: toHumanDecimal(BigInt(options.amount!), sellDecimals),
      sourceAddress: addr,
      destinationAddress: options.recipient,
      slippage: this.swapDKConfig.slippageBps ?? 300,
      includeTx,
    });

    // Filter to providers whose flow we can broadcast. Chainflip TRON
    // source uses a different inbound model — surface a clear error
    // upfront rather than failing inside `bridge()` on missing tx
    // calldata.
    const supported = quoteRes.routes.filter(hasSupportedProvider);
    const best = pickBestRoute(supported);
    if (!best) {
      const rejected = quoteRes.routes.filter((r) => !hasSupportedProvider(r));
      if (rejected.length > 0 && quoteRes.routes.length > 0) {
        const seen = Array.from(
          new Set(rejected.flatMap((r) => r.providers ?? [])),
        ).join(", ");
        throw new SwapDKUserError(
          `TRON source bridge currently supports only THORChain / MAYAChain ` +
            `routes; swap-engine returned ${seen} for ${sellAsset} → ${buyAsset}. ` +
            `Chainflip TRON source uses a different (deposit-channel) flow ` +
            `that this module hasn't wired yet.`,
        );
      }
      throw new SwapDKProviderError(
        sellAsset,
        buyAsset,
        quoteRes.providerErrors ?? [],
      );
    }
    return best;
  }

  /**
   * Normalise the `tokenOut` argument to a SwapKit asset string. If
   * it already contains a `.`, treat it as SwapKit notation and pass
   * through. Otherwise prefix it with the SwapKit prefix of the
   * target chain.
   */
  private normaliseBuyAsset(token: string, targetChain: string): string {
    if (token.includes(".")) return token;
    const prefix = wdkChainToPrefix(targetChain);
    return `${prefix}.${token}`;
  }

  /**
   * Enforce `bridgeMaxFee`.
   *
   * For TRON source the route's `tx` doesn't carry an estimated
   * source-tx fee (TRON's energy/bandwidth model has no pre-broadcast
   * equivalent of EVM's gas × gasPrice), so we use the sum of
   * `liquidity` fees from the route's `fees` array as the proxy. The
   * actual on-chain TRON fee is capped separately by `feeLimit` on
   * the contract call.
   */
  private assertFeeWithinLimit(route: QuoteRoute): void {
    const limit = this.swapDKConfig.bridgeMaxFee;
    if (limit === undefined) return;

    const fee = this.sumFees(route.fees, "liquidity");
    if (fee > limit) {
      throw new SwapDKUserError(
        `Estimated bridge fee ${fee} exceeds bridgeMaxFee ${limit} ` +
          `(source: ${this.sourceChain})`,
      );
    }
  }

  private routeToQuoteResult(
    route: QuoteRoute,
    options: SwapDKBridgeOptions,
  ): SwapDKBridgeQuoteResult {
    const sellDecimals = resolveAssetDecimals(this.sourceChain, route.sellAsset);
    const buyDecimals = resolveAssetDecimals(options.targetChain, options.tokenOut);
    const bridgeFee = this.sumFees(route.fees, "liquidity");

    return {
      // No source-tx fee estimate is available pre-broadcast (TRON
      // energy burn is computed at execution time, capped by
      // feeLimit). Set to 0n so the WDK contract still resolves.
      fee: 0n,
      bridgeFee,
      bridgeFeeAsset: feeAssetOfType(route.fees, "liquidity"),
      tokenInAmount: fromHumanDecimal(route.sellAmount, sellDecimals),
      tokenOutAmount: fromHumanDecimal(route.expectedBuyAmount, buyDecimals),
      estimatedTime: route.estimatedTime?.total,
      providers: route.providers,
    };
  }

  /** Sum the route's liquidity-type fees, scoped to TRON's 6-decimal fallback. */
  private sumFees(
    fees: BridgeFee[],
    feeType: string,
  ): bigint {
    return sumFeesOfType(fees, feeType, {
      resolveDecimals: resolveAssetDecimals,
      sourceChain: this.sourceChain,
      fallbackDecimals: 6,
    });
  }
}
