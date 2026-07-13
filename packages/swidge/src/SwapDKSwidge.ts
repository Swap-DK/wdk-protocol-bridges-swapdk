// ---------------------------------------------------------------------------
// SwapDKSwidge — WDK swidge protocol module for SwapDK.
//
// One class covering every source-chain family the SwapDK swap-engine can
// route (Bitcoin, EVM, Cosmos, Solana, TRON). Discovery, quoting, and
// tracking are shared implementations that delegate to the swap-engine's
// `/chains`, `/tokens?shape=swidge`, `/quote`, and `/track` endpoints;
// execution (`swidge()`) dispatches to a per-source-chain adapter that
// knows how to build the outbound tx for the given wallet-account shape.
//
// Because SwidgeProtocol's base class already implements `bridge()`,
// `quoteBridge()`, `swap()`, and `quoteSwap()` by delegating to
// `swidge()` / `quoteSwidge()`, downstream consumers of the legacy
// BridgeProtocol / SwapProtocol interfaces get compatibility for free.
// ---------------------------------------------------------------------------

import {
  SwapDKClient,
  SwapDKApiError,
  SwapDKUserError,
  pickBestRoute,
} from "@swapdk/swap-engine-client";
import type {
  QuoteRoute,
  SwidgeChainsResponse,
  SwidgeTokensQuery,
  SwidgeTokensResponse,
  TrackResponse,
  TrackStatus,
} from "@swapdk/swap-engine-client";
import { SwidgeProtocol } from "@tetherto/wdk-wallet/protocols";

import { adapterFor } from "./adapters/index.js";
import {
  encodeSwapKitAsset,
  fromHumanAmount,
  toHumanAmount,
} from "./asset-encode.js";
import { chainFamilyFor, nativeMetaFor } from "./chain-map.js";
import type {
  SwapDKSwidgeConfig,
  SwapDKSwidgeOptions,
  SwidgeWalletAccount,
} from "./types.js";

// ---------------------------------------------------------------------------
// Shape mirrors — SwidgeProtocol base class typedefs are pure JSDoc, so we
// re-declare the return shapes here as first-class TS types. Keeping the
// shapes identical to what `@tetherto/wdk-wallet/protocols` documents.
// ---------------------------------------------------------------------------

/** Swidge status vocabulary from the base protocol. */
export type SwidgeStatus =
  | "pending"
  | "action-required"
  | "completed"
  | "failed"
  | "refund-pending"
  | "refunded"
  | "cancelled"
  | "expired"
  | "partial";

export type SwidgeFeeType = "network" | "protocol" | "affiliate" | "other";

export interface SwidgeFee {
  type: SwidgeFeeType;
  amount: bigint;
  token: string;
  chain?: string | number;
  included?: boolean;
  description?: string;
}

export interface SwidgeTransaction {
  hash: string;
  chain?: string | number;
  type?: "source" | "destination" | "approval" | "refund" | "other";
}

export interface SwidgeQuote {
  fromTokenAmount: bigint;
  toTokenAmount: bigint;
  toTokenAmountMin: bigint;
  fees: SwidgeFee[];
  estimatedDuration?: number;
  expiry?: number;
  priceImpact?: number;
}

export interface SwidgeResult {
  id: string;
  hash?: string;
  fees: SwidgeFee[];
  transactions?: SwidgeTransaction[];
  fromTokenAmount: bigint;
  toTokenAmount: bigint;
  toTokenAmountMin?: bigint;
}

export interface SwidgeStatusOptions {
  fromChain?: string | number;
  toChain?: string | number;
}

export interface SwidgeStatusResult {
  status: SwidgeStatus;
  transactions?: SwidgeTransaction[];
}

// ---------------------------------------------------------------------------

/**
 * SwapDK's swidge protocol module.
 *
 * @example
 * ```ts
 * import { SwapDKSwidge } from "@swapdk/wdk-protocol-swidge-swapdk";
 *
 * const swidge = new SwapDKSwidge(walletAccount, {
 *   apiUrl: "https://api.swapdk.com",
 *   apiKey: process.env.SWAPDK_API_KEY!,
 *   defaultFromChain: "ethereum",
 * });
 *
 * const chains = await swidge.getSupportedChains();
 * const tokens = await swidge.getSupportedTokens({ fromChain: "ethereum" });
 *
 * const quote = await swidge.quoteSwidge({
 *   fromToken: "ETH",
 *   fromChain: "ethereum",
 *   toToken: "BTC",
 *   toChain: "bitcoin",
 *   fromTokenAmount: 10_000_000_000_000_000n,
 *   recipient: "bc1q…",
 * });
 * ```
 */
export class SwapDKSwidge extends SwidgeProtocol {
  private readonly client: SwapDKClient;
  protected readonly swidgeConfig: SwapDKSwidgeConfig;

  constructor(account: SwidgeWalletAccount | undefined, config: SwapDKSwidgeConfig) {
    // Base class stores `account` on `this._account` and `config` on `this._config`.
    // Cast around the JSDoc-typed base signature (types shipped by @tetherto/wdk-wallet
    // widen the account parameter more than TypeScript would accept from a
    // structurally-typed SwidgeWalletAccount).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    super(account as any, config);
    this.swidgeConfig = config;
    this.client = new SwapDKClient(config.apiUrl, config.apiKey, {
      timeoutMs: config.timeoutMs,
      retries: config.retries,
    });
  }

  /**
   * Convenience accessor for subclasses / tests. Bound to the same
   * object the base class stores as `this._account`.
   */
  protected get account(): SwidgeWalletAccount | undefined {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this as any)._account as SwidgeWalletAccount | undefined;
  }

  // -------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------

  async getSupportedChains(): Promise<SwidgeChainsResponse> {
    return this.client.getSwidgeChains();
  }

  async getSupportedTokens(
    options?: SwidgeTokensQuery,
  ): Promise<SwidgeTokensResponse> {
    return this.client.getSwidgeTokens(options ?? {});
  }

  // -------------------------------------------------------------------
  // Quote
  // -------------------------------------------------------------------

  async quoteSwidge(options: SwapDKSwidgeOptions): Promise<SwidgeQuote> {
    const { fromChain, toChain, sourceAsset, destinationAsset, fromAmount } =
      this.prepareRoute(options);

    const quoteRes = await this.client.quote({
      sellAsset: sourceAsset,
      buyAsset: destinationAsset,
      sellAmount: fromAmount,
      slippage: this.resolveSlippagePct(options),
      sourceAddress: options.refundAddress,
      destinationAddress: options.recipient,
      includeTx: false,
    });

    const route = pickBestRoute(quoteRes.routes);
    if (!route) {
      const providerErrs = quoteRes.providerErrors ?? [];
      const summary = providerErrs.length > 0
        ? providerErrs.map((e) => `${e.provider}: ${e.errorCode}`).join(", ")
        : "no route";
      throw new SwapDKUserError(
        `SwapDKSwidge: swap-engine returned no route for ${fromChain} → ${toChain} (${summary})`,
      );
    }

    return this.mapRouteToQuote(route, options, fromChain);
  }

  // -------------------------------------------------------------------
  // Execute — dispatch to per-source-chain adapter.
  // -------------------------------------------------------------------

  async swidge(options: SwapDKSwidgeOptions): Promise<SwidgeResult> {
    const account = this.account;
    if (!account) {
      throw new SwapDKUserError(
        "SwapDKSwidge.swidge(): requires a writable wallet account. " +
          "Construct with `new SwapDKSwidge(account, config)` rather than `undefined`.",
      );
    }

    const { fromChain, toChain, sourceAsset, destinationAsset, fromAmount } =
      this.prepareRoute(options);

    // Resolve the adapter early — an unsupported source chain surfaces
    // its "install X" error before any network round-trip is spent.
    const adapter = adapterFor(fromChain);

    const sourceAddress = await account.getAddress();

    // 1. Quote (with calldata) — retry once on stale-route.
    let route = pickBestRoute(
      (
        await this.client.quote({
          sellAsset: sourceAsset,
          buyAsset: destinationAsset,
          sellAmount: fromAmount,
          slippage: this.resolveSlippagePct(options),
          sourceAddress,
          destinationAddress: options.recipient,
          includeTx: true,
        })
      ).routes,
    );
    if (!route) {
      throw new SwapDKUserError(
        `SwapDKSwidge: swap-engine returned no route for ${fromChain} → ${toChain}`,
      );
    }

    // 2. /swap for finalized calldata — but only for adapters that need
    //    it. Bitcoin's THORChain path builds its tx from /quote data
    //    alone (inboundAddress + memo + sellAmount), so skipping the
    //    /swap round-trip saves latency AND avoids the swap-engine
    //    returning a no-op response for BTC routes.
    const needsSwap = adapter.needsSwapResponse !== false;
    let swapRes: Awaited<ReturnType<SwapDKClient["swap"]>> | undefined;
    if (needsSwap) {
      try {
        swapRes = await this.client.swap({
          routeId: route.routeId,
          sourceAddress,
          destinationAddress: options.recipient ?? sourceAddress,
        });
      } catch (err) {
        if (err instanceof SwapDKApiError && err.isStaleRoute) {
          route = pickBestRoute(
            (
              await this.client.quote({
                sellAsset: sourceAsset,
                buyAsset: destinationAsset,
                sellAmount: fromAmount,
                slippage: this.resolveSlippagePct(options),
                sourceAddress,
                destinationAddress: options.recipient,
                includeTx: true,
              })
            ).routes,
          );
          if (!route) {
            throw new SwapDKUserError(
              `SwapDKSwidge: re-quote returned no route for ${fromChain} → ${toChain}`,
            );
          }
          swapRes = await this.client.swap({
            routeId: route.routeId,
            sourceAddress,
            destinationAddress: options.recipient ?? sourceAddress,
          });
        } else {
          throw err;
        }
      }
    }

    // 3. Enforce per-call fee caps against the finalized route.
    this.assertFeeCaps(swapRes, options);

    // 4. Dispatch through the source-chain adapter.
    const { hash, transactions } = await adapter.execute(account, {
      route,
      swapRes,
      client: this.client,
      options,
      config: this.swidgeConfig,
      fromChain,
      sourceAddress,
    });

    // 5. Assemble SwidgeResult. Fees + amount fields come from swapRes
    //    when available, falling back to the /quote route for adapters
    //    that skipped /swap.
    const fromDecimals = this.decimalsForToken(fromChain, options.fromToken);
    const toDecimals = this.decimalsForToken(toChain, options.toToken);
    const feesRaw = swapRes?.fees ?? route.fees ?? [];
    const sellHuman = swapRes?.sellAmount ?? route.sellAmount;
    const buyHuman = swapRes?.buyAmount ?? route.expectedBuyAmount;

    return {
      id: hash,
      hash,
      fees: feesRaw.map((fee) => ({
        type: mapFeeType(fee.type),
        amount: fromHumanAmount(fee.amount, this.decimalsForFeeAsset(fee.asset)),
        token: fee.asset,
      })),
      transactions,
      fromTokenAmount: fromHumanAmount(sellHuman, fromDecimals),
      toTokenAmount: fromHumanAmount(buyHuman, toDecimals),
    };
  }

  private assertFeeCaps(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _swapRes: any,
    _options: SwapDKSwidgeOptions,
  ): void {
    // maxNetworkFeeBps / maxProtocolFeeBps on config are honoured here.
    // The base `SwidgeProtocolConfig` documents them as caps against
    // input-amount basis points; implementation lands with the first
    // provider we run into where a real limit case surfaces.
    // No-op for now — network + protocol fees are inspected downstream
    // via the returned SwidgeResult.fees.
  }

  // -------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------

  async getSwidgeStatus(
    id: string,
    options?: SwidgeStatusOptions,
  ): Promise<SwidgeStatusResult> {
    if (!id || typeof id !== "string") {
      throw new SwapDKUserError("SwapDKSwidge.getSwidgeStatus: id is required");
    }

    const fromChain =
      typeof options?.fromChain === "string"
        ? options.fromChain
        : options?.fromChain !== undefined
          ? String(options.fromChain)
          : this.swidgeConfig.defaultFromChain;

    try {
      const track = await this.client.track({
        chainId: fromChain ?? "",
        hash: id,
      });
      return this.mapTrackToStatus(track);
    } catch (err) {
      if (err instanceof SwapDKApiError && err.isNotFound) {
        return { status: "pending" };
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  private prepareRoute(options: SwapDKSwidgeOptions): {
    fromChain: string;
    toChain: string;
    sourceAsset: string;
    destinationAsset: string;
    fromAmount: string;
  } {
    const fromChainRaw =
      options.fromChain ?? this.swidgeConfig.defaultFromChain ?? "";
    const fromChain = normalizeChainId(fromChainRaw);
    if (fromChain === "") {
      throw new SwapDKUserError(
        "SwapDKSwidge: options.fromChain is required (or set config.defaultFromChain on the instance)",
      );
    }
    const toChain = normalizeChainId(options.toChain ?? fromChain);

    const family = chainFamilyFor(fromChain);
    if (family === "") {
      throw new SwapDKUserError(
        `SwapDKSwidge: unknown source chain "${fromChain}" — see getSupportedChains()`,
      );
    }

    if (options.fromTokenAmount === undefined && options.toTokenAmount === undefined) {
      throw new SwapDKUserError(
        "SwapDKSwidge: one of options.fromTokenAmount or options.toTokenAmount is required",
      );
    }
    if (options.fromTokenAmount !== undefined && options.toTokenAmount !== undefined) {
      throw new SwapDKUserError(
        "SwapDKSwidge: options.fromTokenAmount and options.toTokenAmount are mutually exclusive",
      );
    }
    // exact-out (`toTokenAmount`) is not yet supported by the swap-engine's
    // /quote surface. Surface a clear error rather than silently rerouting.
    if (options.toTokenAmount !== undefined) {
      throw new SwapDKUserError(
        "SwapDKSwidge: exact-out routes (toTokenAmount) are not yet supported by the SwapDK swap-engine — pass fromTokenAmount instead",
      );
    }

    const sourceAsset = encodeSwapKitAsset(fromChain, options.fromToken);
    const destinationAsset = encodeSwapKitAsset(toChain, options.toToken);

    const sourceDecimals = this.decimalsForToken(fromChain, options.fromToken);
    const fromAmount = toHumanAmount(
      typeof options.fromTokenAmount === "number"
        ? BigInt(options.fromTokenAmount)
        : options.fromTokenAmount ?? 0n,
      sourceDecimals,
    );

    return { fromChain, toChain, sourceAsset, destinationAsset, fromAmount };
  }

  private resolveSlippagePct(options: SwapDKSwidgeOptions): number {
    // /quote takes slippage as a fraction of 1 (0.03 = 3%). Matches the
    // swidge `slippage` field convention, so pass through when set.
    if (typeof options.slippage === "number") return options.slippage;
    return this.swidgeConfig.defaultSlippage ?? 0.03;
  }

  private decimalsForToken(swidgeChain: string, token: string): number {
    const native = nativeMetaFor(swidgeChain);
    if (native && token.trim().toUpperCase() === native.symbol.toUpperCase()) {
      return native.decimals;
    }
    // Fungibles default to 18 (EVM) / 6 (TRC-20, USDT/USDC across all chains,
    // SPL USDC). We can't disambiguate without a token lookup — the
    // swap-engine returns the actual base-unit amount on the /quote
    // response, so the decimal only affects the wire encoding of the
    // input amount. When a token doesn't have 18 decimals, callers
    // should fetch the correct value from getSupportedTokens() and use
    // toHumanAmount()/fromHumanAmount() directly rather than relying on
    // this fallback.
    const family = chainFamilyFor(swidgeChain);
    if (family === "evm") return 18;
    return 6;
  }

  private mapRouteToQuote(
    route: QuoteRoute,
    options: SwapDKSwidgeOptions,
    fromChain: string,
  ): SwidgeQuote {
    const toChain = normalizeChainId(options.toChain ?? fromChain);

    const fromDecimals = this.decimalsForToken(fromChain, options.fromToken);
    const toDecimals = this.decimalsForToken(toChain, options.toToken);

    const fromTokenAmount = fromHumanAmount(route.sellAmount, fromDecimals);
    const toTokenAmount = fromHumanAmount(route.expectedBuyAmount, toDecimals);
    const toTokenAmountMin = route.expectedBuyAmountMaxSlippage
      ? fromHumanAmount(route.expectedBuyAmountMaxSlippage, toDecimals)
      : toTokenAmount;

    const fees: SwidgeFee[] = (route.fees ?? []).map((fee) => ({
      type: mapFeeType(fee.type),
      amount: fromHumanAmount(fee.amount, this.decimalsForFeeAsset(fee.asset)),
      token: fee.asset,
    }));

    const estimatedDuration =
      typeof route.estimatedTime?.total === "number"
        ? route.estimatedTime.total
        : undefined;

    return {
      fromTokenAmount,
      toTokenAmount,
      toTokenAmountMin,
      fees,
      estimatedDuration,
    };
  }

  private decimalsForFeeAsset(asset: string): number {
    // Fees come back in SwapKit asset format (`"THOR.RUNE"`, `"ETH.ETH"`).
    // Best effort: split off the chain prefix, look up native decimals.
    const dot = asset.indexOf(".");
    if (dot < 0) return 8;
    const chainCode = asset.slice(0, dot);
    // Reverse the CHAIN_TABLE lookup.
    const rows = [
      { code: "BTC", d: 8 }, { code: "ETH", d: 18 }, { code: "ARB", d: 18 },
      { code: "BASE", d: 18 }, { code: "BSC", d: 18 }, { code: "AVAX", d: 18 },
      { code: "TRON", d: 6 }, { code: "SOL", d: 9 }, { code: "THOR", d: 8 },
      { code: "MAYA", d: 10 }, { code: "GAIA", d: 6 }, { code: "DOGE", d: 8 },
      { code: "BCH", d: 8 }, { code: "LTC", d: 8 },
    ];
    for (const r of rows) if (r.code === chainCode.toUpperCase()) return r.d;
    return 8;
  }

  private mapTrackToStatus(track: TrackResponse): SwidgeStatusResult {
    return {
      status: mapTrackStatus(track.status),
      transactions: track.legs?.map((leg) => ({
        hash: leg.hash,
        chain: String(leg.chainId ?? ""),
        type: legTypeFor(leg),
      })),
    };
  }
}

// ---------------------------------------------------------------------------
// Fee / status / leg mappers.
// ---------------------------------------------------------------------------

function normalizeChainId(v: string | number): string {
  return typeof v === "number" ? String(v) : v.trim();
}

function mapFeeType(type: string): SwidgeFeeType {
  switch (type.toLowerCase()) {
    case "liquidity":
    case "protocol":
      return "protocol";
    case "outbound":
    case "network":
    case "affiliate_gas":
      return "network";
    case "affiliate":
      return "affiliate";
    default:
      return "other";
  }
}

function mapTrackStatus(status: TrackStatus | string): SwidgeStatus {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "refunded":
      return "refunded";
    case "pending":
    case "swapping":
    case "not_started":
      return "pending";
    default:
      return "pending";
  }
}

function legTypeFor(
  leg: { type?: string },
): "source" | "destination" | "approval" | "refund" | "other" {
  switch ((leg.type ?? "").toLowerCase()) {
    case "swap":
      return "source";
    case "receive":
    case "outbound":
      return "destination";
    case "refund":
      return "refund";
    default:
      return "other";
  }
}
