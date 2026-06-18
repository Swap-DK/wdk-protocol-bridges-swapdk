// ---------------------------------------------------------------------------
// SwapDKBridgeCosmos — WDK bridge protocol module
//
// Extends the standard WDK BridgeProtocol base class.
// Wraps the SwapDK swap-engine REST API to enable cross-chain swaps from
// THORChain (RUNE) or MAYAChain (CACAO) as source to any destination
// supported by swap-engine.
//
// Source-side broadcast goes through a `types.MsgDeposit` — the wallet's
// `deposit({ asset, amount, memo })` method. Memo is supplied by
// swap-engine's /swap response.
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

import { toSwapKitAsset, resolveAssetDecimals } from "./asset-map.js";
import type {
  CosmosWalletAccount,
  SwapDKBridgeConfig,
  SwapDKBridgeOptions,
  SwapDKBridgeQuoteResult,
  SwapDKBridgeResult,
} from "./types.js";

const DEFAULT_SOURCE_CHAIN = "thorchain";
const SUPPORTED_SOURCE_CHAINS = new Set(["thorchain", "mayachain"]);

/** Options for {@link SwapDKBridgeCosmos.waitForBridge}. */
export interface WaitForBridgeOptions {
  /** Poll interval in milliseconds (default: 15_000). */
  pollIntervalMs?: number;
  /** Overall timeout in milliseconds (default: 600_000 = 10 min). */
  timeoutMs?: number;
  /** Called once per poll that returns data, useful for progress UI. */
  onUpdate?: (status: TrackResponse) => void;
}

export class SwapDKBridgeCosmos extends BridgeProtocol {
  private readonly client: SwapDKClient;
  private readonly cosmosAccount: CosmosWalletAccount;
  private readonly swapDKConfig: SwapDKBridgeConfig;
  /** WDK source chain this instance was registered for. */
  private sourceChain: string = DEFAULT_SOURCE_CHAIN;

  constructor(account: CosmosWalletAccount, config: SwapDKBridgeConfig) {
    // The standard WDK BridgeProtocolConfig only carries `bridgeMaxFee`.
    // The account is cast because CosmosWalletAccount is a minimal subset
    // of IWalletAccount — the base class only stores it, never calls it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    super(account as any, { bridgeMaxFee: config.bridgeMaxFee });
    this.cosmosAccount = account;
    this.swapDKConfig = config;
    this.client = new SwapDKClient(config.apiUrl, config.apiKey, {
      timeoutMs: config.timeoutMs,
      retries: config.retries,
    });
  }

  /**
   * Set the WDK source chain (called by the host when registering via
   * `registerProtocol(chain, …)`). Accepts `"thorchain"` or `"mayachain"`;
   * defaults to `"thorchain"`.
   */
  setSourceChain(chain: string): void {
    this.sourceChain = assertAllowedSourceChain(chain, SUPPORTED_SOURCE_CHAINS, "Cosmos");
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
    const sourceAddress = await this.getAddress();

    // 1. Get quote (no calldata for cosmos source — broadcast is constructed
    //    locally by `walletAccount.deposit()` from the memo).
    let route = await this.fetchBestRoute(options, false, sourceAddress);

    // 2. Enforce bridgeMaxFee against the route's reported liquidity fee.
    this.assertFeeWithinLimit(route, options);

    // 3. Call /swap to finalize the route, get the canonical memo and the
    //    sell amount in human-decimal form. If the routeId has expired,
    //    re-quote once and retry.
    const swapRes = await this.client
      .swap({
        routeId: route.routeId,
        sourceAddress,
        destinationAddress: options.recipient,
      })
      .catch(async (err) => {
        if (err instanceof SwapDKApiError && err.isStaleRoute) {
          route = await this.fetchBestRoute(options, false, sourceAddress);
          this.assertFeeWithinLimit(route, options);
          return this.client.swap({
            routeId: route.routeId,
            sourceAddress,
            destinationAddress: options.recipient,
          });
        }
        throw err;
      });

    // 4. Validate response shape and pick the broadcast strategy.
    //
    // swap-engine returns memo at the top level. Two route shapes are
    // possible for a cosmos source:
    //
    //   - MsgDeposit:  inboundAddress empty (or == source). The user
    //                  signs `types.MsgDeposit` against their own
    //                  THORChain/MAYAChain wallet; the protocol's
    //                  Asgard module observes the memo. This is the
    //                  THORChain-native path (e.g. RUNE → BTC routed
    //                  through THORChain pools).
    //
    //   - MsgSend:     inboundAddress is a vault on the source chain
    //                  (e.g. MAYAChain's THORChain inbound vault for
    //                  a RUNE → BTC swap routed through MAYAChain).
    //                  The user broadcasts a Cosmos-bank MsgSend with
    //                  the swap memo attached to the tx body.
    if (!swapRes.memo) {
      throw new SwapDKUserError(
        "swap-engine returned no swap memo for this route. " +
          "Without a memo the deposit/transfer cannot be processed " +
          "and funds would be lost. The route may be invalid or the " +
          `sell amount may be below the route's minimum. Providers: ${swapRes.providers.join(", ")}`,
      );
    }

    const sellDecimals = resolveAssetDecimals(this.sourceChain, swapRes.sellAsset);
    const tokenInAmount = fromHumanDecimal(swapRes.sellAmount, sellDecimals);

    // 5. Dispatch to deposit() or transfer() based on the route.
    const inboundVault = this.detectInboundVault(swapRes, sourceAddress);
    let txResult: { hash: string; fee: bigint };
    if (inboundVault === undefined) {
      // MsgDeposit — protocol-native path (deposit goes to user's own balance).
      txResult = await this.cosmosAccount.deposit({
        asset: swapRes.sellAsset,
        amount: tokenInAmount,
        memo: swapRes.memo,
      });
    } else {
      // MsgSend — cross-protocol path (deposit goes to inbound vault).
      txResult = await this.cosmosAccount.transfer({
        token: this.nativeDenomForSource(),
        recipient: inboundVault,
        amount: tokenInAmount,
        memo: swapRes.memo,
      });
    }

    // 6. Build result
    const buyDecimals = resolveAssetDecimals(options.targetChain, options.tokenOut);
    const tokenOutAmount = fromHumanDecimal(swapRes.buyAmount, buyDecimals);
    const bridgeFee = this.sumFees(swapRes.fees, "liquidity");

    return {
      hash: txResult.hash,
      fee: txResult.fee,
      bridgeFee,
      bridgeFeeAsset: feeAssetOfType(swapRes.fees, "liquidity"),
      tokenInAmount,
      tokenOutAmount,
    };
  }

  /**
   * Inspect a `/swap` response to decide between MsgDeposit and MsgSend.
   *
   * Returns the inbound vault address if the route requires a MsgSend
   * (i.e. funds must be sent to a non-source address), or `undefined`
   * if it's a protocol-native MsgDeposit. Trims and case-normalises
   * the address comparison since bech32 is case-sensitive but addresses
   * are sometimes returned with surrounding whitespace.
   */
  private detectInboundVault(
    swapRes: { inboundAddress?: string; targetAddress?: string },
    sourceAddress: string,
  ): string | undefined {
    const candidate = (swapRes.inboundAddress ?? swapRes.targetAddress ?? "").trim();
    if (!candidate) return undefined;
    if (candidate === sourceAddress) return undefined;
    return candidate;
  }

  /**
   * Native bank-module denom for the active source chain. Used as the
   * `token` field on the MsgSend dispatch — `rune` for THORChain,
   * `cacao` for MAYAChain. Mirrors the `nativeDenom` in the wallet
   * presets so consumers don't have to wire the same constant twice.
   */
  private nativeDenomForSource(): string {
    return this.sourceChain === "mayachain" ? "cacao" : "rune";
  }

  // -----------------------------------------------------------------
  // trackBridge — one-shot status lookup
  // -----------------------------------------------------------------

  /**
   * Look up the current status of a cross-chain bridge transaction.
   *
   * Uses swap-engine's `/track` endpoint, which queries THORChain and
   * MAYAChain Midgard. Returns `null` if the hash isn't (yet) indexed —
   * the normal state briefly after `bridge()` returns, before the deposit
   * is observed.
   *
   * @param hash     Source-chain tx hash (as returned by `bridge()`).
   * @param chainId  Source chain ID. Defaults to the SwapKit prefix of
   *                 the active source chain (`"THOR"` or `"MAYA"`).
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
    const addr = sourceAddress ?? (await this.getAddress());

    const sellAsset = toSwapKitAsset(options.token, this.sourceChain);
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
   * Normalise the `tokenOut` argument to a SwapKit asset string.
   *
   * If already in `CHAIN.SYMBOL[-ADDR]` form, returned verbatim. If passed
   * as a bare contract address, prefixed with the SwapKit prefix of the
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
   * For Cosmos sources, the route's `tx.gas` field is empty (we don't
   * ship pre-built calldata), so we use the sum of `liquidity` fees from
   * the route's `fees` array as the proxy. This is best-effort; the
   * actual on-chain fee charged by the wallet's gasPrice is separate
   * and bounded by the wallet's own `transferMaxFee`.
   */
  private assertFeeWithinLimit(
    route: QuoteRoute,
    options: SwapDKBridgeOptions,
  ): void {
    const limit = this.swapDKConfig.bridgeMaxFee;
    if (limit === undefined) return;

    const fee = this.sumFees(route.fees, "liquidity");
    if (fee > limit) {
      throw new SwapDKUserError(
        `Estimated bridge fee ${fee} exceeds bridgeMaxFee ${limit} ` +
          `(source: ${this.sourceChain}, target: ${options.targetChain})`,
      );
    }
  }

  private async getAddress(): Promise<string> {
    return this.cosmosAccount.getAddress();
  }

  private routeToQuoteResult(
    route: QuoteRoute,
    options: SwapDKBridgeOptions,
  ): SwapDKBridgeQuoteResult {
    const sellDecimals = resolveAssetDecimals(this.sourceChain, route.sellAsset);
    const buyDecimals = resolveAssetDecimals(options.targetChain, options.tokenOut);
    const bridgeFee = this.sumFees(route.fees, "liquidity");

    return {
      // No source-tx gas estimate is available pre-broadcast (the wallet
      // uses its own gasPrice * gasLimit at signing time); set to 0n so
      // the WDK contract still resolves.
      fee: 0n,
      bridgeFee,
      bridgeFeeAsset: feeAssetOfType(route.fees, "liquidity"),
      tokenInAmount: fromHumanDecimal(route.sellAmount, sellDecimals),
      tokenOutAmount: fromHumanDecimal(route.expectedBuyAmount, buyDecimals),
      estimatedTime: route.estimatedTime?.total,
      providers: route.providers,
    };
  }

  /** Sum the route's liquidity-type fees with cosmos's 8-decimal fallback (RUNE precision). */
  private sumFees(
    fees: BridgeFee[],
    feeType: string,
  ): bigint {
    return sumFeesOfType(fees, feeType, {
      resolveDecimals: resolveAssetDecimals,
      sourceChain: this.sourceChain,
      fallbackDecimals: 8,
    });
  }
}
