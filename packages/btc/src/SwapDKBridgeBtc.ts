// ---------------------------------------------------------------------------
// SwapDKBridgeBtc — WDK bridge protocol module
//
// Extends the standard WDK BridgeProtocol base class.
// Wraps the SwapDK swap-engine REST API to enable cross-chain swaps from
// Bitcoin (native BTC) as source to any destination chain supported by
// THORChain / MAYAChain / Chainflip.
//
// Two flows, dispatched on the route's provider:
//
//  - THORChain / MAYAChain: classic inbound-vault model. swap-engine
//    surfaces `inboundAddress` + `memo` on the /quote response; the
//    deposit tx pays the vault and carries the memo as an OP_RETURN
//    output. (`/swap` is skipped — it returns 502 for BTC source today,
//    and we already have everything we need from /quote.)
//
//  - Chainflip: deposit-channel model. swap-engine's
//    `/chainflip/broker/channel` allocates a unique deposit address per
//    swap intent, with NO OP_RETURN. The deposit is a plain BTC
//    transfer. Tracking uses Chainflip's v2 swap-status API via the
//    `/track` Chainflip fallback (hash is the primary identifier;
//    `depositAddress` works as a hint while the inbound tx is still in
//    the mempool — see the comment on `utils/track_swapkit.go:119`).
//
// Channel allocation is intentionally deferred to `bridge()` and not
// done in `quoteBridge()`: Chainflip channels consume broker resources
// and have a TTL, so we don't open one for a preview.
// ---------------------------------------------------------------------------

import { BridgeProtocol } from "@tetherto/wdk-wallet/protocols";

import {
  SwapDKClient,
  SwapDKProviderError,
  SwapDKUserError,
  wdkChainToPrefix,
  toHumanDecimal,
  fromHumanDecimal,
  pickBestRoute,
  parseSwapKitAsset,
  isTerminalTrackStatus,
  sleep,
  defaultBuyAsset,
  feeAssetOfType,
  sumFeesOfType,
  assertAllowedSourceChain,
} from "@swapdk/swap-engine-client";
import type {
  BridgeFee,
  BrokerChannelRequest,
  BrokerChannelResponse,
  ChainflipAsset,
  QuoteRoute,
  TrackResponse,
} from "@swapdk/swap-engine-client";

import { toSourceAsset, resolveAssetDecimals } from "./asset-map.js";
import type {
  BtcWalletAccount,
  SwapDKBridgeConfig,
  SwapDKBridgeOptions,
  SwapDKBridgeQuoteResult,
  SwapDKBridgeResult,
} from "./types.js";

const DEFAULT_SOURCE_CHAIN = "bitcoin";
const BTC_ALLOWED_CHAINS: ReadonlySet<string> = new Set([DEFAULT_SOURCE_CHAIN]);

// Providers whose route shape this module knows how to broadcast for.
// THORChain / MAYAChain take the vault + memo path; Chainflip takes the
// broker-channel path.
const THOR_PROVIDERS = new Set(["THORCHAIN", "MAYACHAIN"]);
const CHAINFLIP_PROVIDER = "CHAINFLIP";

type BridgeProviderKind = "thor" | "chainflip";

function classifyProvider(route: QuoteRoute): BridgeProviderKind | undefined {
  const providers = route.providers ?? [];
  if (providers.some((p) => THOR_PROVIDERS.has(p))) return "thor";
  if (providers.includes(CHAINFLIP_PROVIDER)) return "chainflip";
  return undefined;
}

// SwapKit chain prefix → Chainflip's long-form chain name. Mirrors
// `chainflipChainShort` in swap-engine's utils/track_chainflip.go.
const CHAINFLIP_CHAIN_BY_PREFIX: Record<string, string> = {
  BTC: "Bitcoin",
  ETH: "Ethereum",
  ARB: "Arbitrum",
  BASE: "Base",
  SOL: "Solana",
  DOT: "Polkadot",
  ASSETHUB: "AssetHub",
};

function swapKitAssetToChainflip(asset: string): ChainflipAsset {
  const parsed = parseSwapKitAsset(asset);
  if (!parsed) {
    throw new SwapDKUserError(
      `Cannot convert asset "${asset}" to Chainflip notation — not a SwapKit asset string.`,
    );
  }
  const chain = CHAINFLIP_CHAIN_BY_PREFIX[parsed.chain];
  if (!chain) {
    throw new SwapDKUserError(
      `Chainflip does not support chain prefix "${parsed.chain}" (asset: ${asset}).`,
    );
  }
  return { chain, asset: parsed.symbol };
}

/** Options for {@link SwapDKBridgeBtc.trackBridge}. */
export interface TrackBridgeOptions {
  /**
   * Chainflip deposit-channel address. swap-engine forwards it to
   * Chainflip's v2 swap API as an additional identifier candidate, but
   * **does not** resolve channels by raw deposit address (Chainflip's
   * v2 endpoint limitation — see `utils/track_swapkit.go:119` in
   * swap-engine). In practice this is most useful right after `bridge()`
   * returns, before the BTC tx has been observed in the mempool.
   */
  depositAddress?: string;
}

/** Options for {@link SwapDKBridgeBtc.waitForBridge}. */
export interface WaitForBridgeOptions {
  /** Poll interval in milliseconds (default: 15_000). */
  pollIntervalMs?: number;
  /** Overall timeout in milliseconds (default: 900_000 = 15 min). */
  timeoutMs?: number;
  /** Called once per poll that returns data, useful for progress UI. */
  onUpdate?: (status: TrackResponse) => void;
  /** Chainflip deposit address — see {@link TrackBridgeOptions.depositAddress}. */
  depositAddress?: string;
}

export class SwapDKBridgeBtc extends BridgeProtocol {
  private readonly client: SwapDKClient;
  private readonly btcAccount: BtcWalletAccount;
  private readonly swapDKConfig: SwapDKBridgeConfig;
  /** WDK source chain this instance was registered for. */
  private sourceChain: string = DEFAULT_SOURCE_CHAIN;

  constructor(account: BtcWalletAccount, config: SwapDKBridgeConfig) {
    // BtcWalletAccount is a minimal subset of IWalletAccount — the base
    // class only stores it, never calls it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    super(account as any, { bridgeMaxFee: config.bridgeMaxFee });
    this.btcAccount = account;
    this.swapDKConfig = config;
    this.client = new SwapDKClient(config.apiUrl, config.apiKey, {
      timeoutMs: config.timeoutMs,
      retries: config.retries,
    });
  }

  /**
   * Set the WDK source chain. Only `"bitcoin"` is accepted; supplied here
   * for parity with the EVM / Cosmos bridge modules so the host's
   * `registerProtocol(chain, …)` flow doesn't need to special-case BTC.
   */
  setSourceChain(chain: string): void {
    this.sourceChain = assertAllowedSourceChain(chain, BTC_ALLOWED_CHAINS, "BTC");
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
    const route = await this.fetchBestRoute(options);
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
    const sourceAddress = await this.btcAccount.getAddress();

    const route = await this.fetchBestRoute(options, sourceAddress);

    this.assertFeeWithinLimit(route, options);

    const sellDecimals = resolveAssetDecimals(this.sourceChain, route.sellAsset);
    const tokenInAmount = fromHumanDecimal(route.sellAmount, sellDecimals);
    const buyDecimals = resolveAssetDecimals(options.targetChain, options.tokenOut);
    const tokenOutAmount = fromHumanDecimal(route.expectedBuyAmount, buyDecimals);

    const kind = classifyProvider(route);
    if (kind === "thor") {
      return this.bridgeViaThor(route, options, tokenInAmount, tokenOutAmount);
    }
    if (kind === "chainflip") {
      return this.bridgeViaChainflip(
        route,
        options,
        sourceAddress,
        tokenInAmount,
        tokenOutAmount,
      );
    }
    throw new SwapDKUserError(
      `swap-engine returned an unsupported provider for BTC source: ` +
        `${(route.providers ?? []).join(", ") || "<none>"}. ` +
        `This module supports THORChain, MAYAChain, and Chainflip.`,
    );
  }

  /**
   * THORChain / MAYAChain path: deposit to the rotating Asgard vault
   * with the swap memo as an OP_RETURN output.
   */
  private async bridgeViaThor(
    route: QuoteRoute,
    _options: SwapDKBridgeOptions,
    tokenInAmount: bigint,
    tokenOutAmount: bigint,
  ): Promise<SwapDKBridgeResult> {
    if (!route.inboundAddress) {
      throw new SwapDKUserError(
        "swap-engine quote returned no inboundAddress for THORChain BTC route. " +
          `Providers: ${route.providers.join(", ")}`,
      );
    }
    if (!route.memo) {
      throw new SwapDKUserError(
        "swap-engine quote returned no memo for THORChain BTC route. " +
          "Without an OP_RETURN memo THORChain refunds the deposit. " +
          `Providers: ${route.providers.join(", ")}`,
      );
    }
    if (route.expiration) {
      const expiresAt = Number(route.expiration) * 1000;
      if (Number.isFinite(expiresAt) && expiresAt < Date.now()) {
        throw new SwapDKUserError(
          `Quoted inbound vault has already expired (at ${route.expiration}). ` +
            `Re-quote and try again.`,
        );
      }
    }

    const { hash, fee } = await this.btcAccount.sendTransaction({
      to: route.inboundAddress,
      value: tokenInAmount,
      feeRate: this.swapDKConfig.feeRate,
      memo: route.memo,
    });

    return {
      hash,
      fee,
      bridgeFee: this.sumFees(route.fees, "liquidity"),
      bridgeFeeAsset: feeAssetOfType(route.fees, "liquidity"),
      tokenInAmount,
      tokenOutAmount,
      provider: route.providers[0] ?? "THORCHAIN",
    };
  }

  /**
   * Chainflip path: open a deposit channel via the broker API and
   * broadcast a plain BTC transfer to the allocated address. No
   * OP_RETURN.
   */
  private async bridgeViaChainflip(
    route: QuoteRoute,
    options: SwapDKBridgeOptions,
    sourceAddress: string,
    tokenInAmount: bigint,
    tokenOutAmount: bigint,
  ): Promise<SwapDKBridgeResult> {
    const channel = await this.openBrokerChannel(route, options, sourceAddress);

    const { hash, fee } = await this.btcAccount.sendTransaction({
      to: channel.depositAddress,
      value: tokenInAmount,
      feeRate: this.swapDKConfig.feeRate,
      // No memo for Chainflip — the deposit address itself encodes
      // the swap intent.
    });

    return {
      hash,
      fee,
      bridgeFee: this.sumFees(route.fees, "liquidity"),
      bridgeFeeAsset: feeAssetOfType(route.fees, "liquidity"),
      tokenInAmount,
      tokenOutAmount,
      provider: CHAINFLIP_PROVIDER,
      depositAddress: channel.depositAddress,
      channelId: channel.channelId,
    };
  }

  /**
   * Build the broker-channel request from a route + caller options and
   * call swap-engine's `/chainflip/broker/channel`. Defaults:
   *   - refundAddress  = caller's `account.getAddress()`
   *   - refundMinPrice = `"0x0"` (no price floor)
   *   - refundRetryDuration = 100 blocks
   *   - dcaChunks = 1 (no DCA)
   *   - maxBoostFeeBps = 0 (boost disabled)
   */
  private async openBrokerChannel(
    route: QuoteRoute,
    options: SwapDKBridgeOptions,
    sourceAddress: string,
  ): Promise<BrokerChannelResponse> {
    const req: BrokerChannelRequest = {
      sellAsset: swapKitAssetToChainflip(route.sellAsset),
      buyAsset: swapKitAssetToChainflip(route.buyAsset),
      destinationAddress: options.recipient,
      // Pass sellAmount through so swap-engine's broker-channel
      // controller can run CheckChainflipMinimumDeposit against the
      // broker's IngressEgressEnvironment. Sub-min deposits are
      // unrecoverable on Chainflip — without this field the server-
      // side guard added in 40b246b is dormant. `route.sellAmount` is
      // already in the human-decimal format swap-engine expects.
      sellAmount: route.sellAmount,
      refundParameters: {
        refundAddress: options.refundAddress ?? sourceAddress,
        minPrice: options.refundMinPrice ?? "0x0",
        retryDuration: options.refundRetryDuration ?? 100,
      },
    };

    if (options.dcaChunks !== undefined && options.dcaChunks > 1) {
      if (options.dcaChunkInterval === undefined) {
        throw new SwapDKUserError(
          "dcaChunkInterval is required when dcaChunks > 1",
        );
      }
      req.dcaParameters = {
        chunkInterval: options.dcaChunkInterval,
        numberOfChunks: options.dcaChunks,
      };
    }

    if (options.maxBoostFeeBps !== undefined && options.maxBoostFeeBps > 0) {
      req.maxBoostFeeBps = options.maxBoostFeeBps;
    }

    return await this.client.openBrokerChannel(req);
  }

  // -----------------------------------------------------------------
  // trackBridge — one-shot status lookup
  // -----------------------------------------------------------------

  /**
   * Look up the current status of a cross-chain bridge transaction.
   *
   * swap-engine's `/track` queries Midgard (THORChain / MAYAChain)
   * first, then falls back to Chainflip's v2 swap API. Returns `null`
   * if neither has indexed the swap yet — the normal state briefly
   * after `bridge()` returns, before the deposit confirms in a BTC
   * block.
   *
   * BTC inbound confirmation typically takes 1 block (~10 min), so
   * expect `null` for the first ~10-15 minutes.
   *
   * @param hash     BTC tx hash (as returned by `bridge()`). Pass an
   *                 empty string when only a `depositAddress` is known.
   * @param chainId  Source chain ID. Defaults to `"BTC"`.
   * @param opts     Extra identifiers — currently only Chainflip's
   *                 `depositAddress`.
   */
  async trackBridge(
    hash: string,
    chainId?: string,
    opts: TrackBridgeOptions = {},
  ): Promise<TrackResponse | null> {
    const resolvedChainId = chainId ?? wdkChainToPrefix(this.sourceChain);
    return this.client.trackOrNotFound({
      hash: hash || undefined,
      chainId: hash ? resolvedChainId : undefined,
      depositAddress: opts.depositAddress,
    });
  }

  // -----------------------------------------------------------------
  // waitForBridge — poll until terminal state
  // -----------------------------------------------------------------

  /**
   * Poll `/track` until the bridge reaches a terminal state
   * (`completed`, `refunded`, or `failed`), or until `timeoutMs` elapses.
   *
   * Default timeout is 15 min — BTC inbound confirmation alone is ~10 min.
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
    const timeoutMs = opts.timeoutMs ?? 900_000;
    const deadline = Date.now() + timeoutMs;

    let last: TrackResponse | null = null;
    while (Date.now() < deadline) {
      const current = await this.trackBridge(hash, chainId, {
        depositAddress: opts.depositAddress,
      });
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
      `Timed out after ${timeoutMs}ms waiting for bridge ${hash || opts.depositAddress || "<unknown>"}` +
        ` (last status: ${last?.status ?? "not-found"})`,
    );
  }

  // -----------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------

  private async fetchBestRoute(
    options: SwapDKBridgeOptions,
    sourceAddress?: string,
  ): Promise<QuoteRoute> {
    const addr = sourceAddress ?? (await this.btcAccount.getAddress());

    const sellAsset = toSourceAsset(options.token, this.sourceChain);
    const buyAsset = options.tokenOut
      ? this.normaliseBuyAsset(options.tokenOut, options.targetChain)
      : defaultBuyAsset(options.targetChain);

    const sellDecimals = resolveAssetDecimals(this.sourceChain, sellAsset);

    // `includeTx: false` — swap-engine can't construct a BTC PSBT for us,
    // the wallet does that locally. Asking for tx data would also push
    // the route into the /swap call path which returns 502 for BTC.
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
    if (!classifyProvider(best)) {
      throw new SwapDKUserError(
        `swap-engine returned an unsupported provider for BTC source: ` +
          `${(best.providers ?? []).join(", ") || "<none>"}. ` +
          `This module supports THORChain, MAYAChain, and Chainflip.`,
      );
    }
    return best;
  }

  /**
   * Normalise the `tokenOut` argument to a SwapKit asset string. If it
   * already contains a `.`, treat it as SwapKit notation and pass through.
   * Otherwise prefix it with the SwapKit prefix of the target chain.
   */
  private normaliseBuyAsset(token: string, targetChain: string): string {
    if (token.includes(".")) return token;
    const prefix = wdkChainToPrefix(targetChain);
    return `${prefix}.${token}`;
  }

  /**
   * Enforce `bridgeMaxFee`.
   *
   * For BTC source there's no pre-built calldata, so we use the sum of
   * `liquidity` fees from the route's `fees` array as the proxy. The
   * actual on-chain BTC fee is bounded separately by the wallet's own
   * coin-selection and `feeRate`.
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

  private routeToQuoteResult(
    route: QuoteRoute,
    options: SwapDKBridgeOptions,
  ): SwapDKBridgeQuoteResult {
    const sellDecimals = resolveAssetDecimals(this.sourceChain, route.sellAsset);
    const buyDecimals = resolveAssetDecimals(options.targetChain, options.tokenOut);
    const bridgeFee = this.sumFees(route.fees, "liquidity");

    return {
      // No source-tx fee estimate is available pre-broadcast (BTC fee is
      // computed by the wallet from UTXOs + feeRate at signing time);
      // set to 0n so the WDK contract still resolves.
      fee: 0n,
      bridgeFee,
      bridgeFeeAsset: feeAssetOfType(route.fees, "liquidity"),
      tokenInAmount: fromHumanDecimal(route.sellAmount, sellDecimals),
      tokenOutAmount: fromHumanDecimal(route.expectedBuyAmount, buyDecimals),
      estimatedTime: route.estimatedTime?.total,
      providers: route.providers,
      // inboundAddress + memo only populated for THORChain. For
      // Chainflip we don't open the channel here (it'd consume broker
      // resources just for a preview); the channel + depositAddress
      // are allocated at execution time inside bridge().
      inboundAddress: route.inboundAddress,
      memo: route.memo,
      expiration: route.expiration,
    };
  }

  /** Sum the route's liquidity-type fees, scoped to BTC's 8-decimal fallback. */
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
