// ---------------------------------------------------------------------------
// SwapDKSwapEvm — WDK swap protocol module
//
// Extends the standard WDK SwapProtocol base class.
// Handles same-chain EVM swaps (e.g. USDC → WETH on Ethereum) via the
// SwapDK swap-engine REST API.
// ---------------------------------------------------------------------------

import { SwapProtocol } from "@tetherto/wdk-wallet/protocols";
import type { SwapOptions, SwapResult } from "@tetherto/wdk-wallet/protocols";

import {
  SwapDKClient,
  SwapDKApiError,
  SwapDKProviderError,
  SwapDKUserError,
  wdkChainToPrefix,
  toHumanDecimal,
  fromHumanDecimal,
  pickBestRoute,
} from "@swapdk/wdk-protocol-bridge-swapdk-common";
import type { QuoteRoute } from "@swapdk/wdk-protocol-bridge-swapdk-common";
import { toSwapKitAsset, resolveAssetDecimals } from "./asset-map.js";
import type {
  EvmWalletAccount,
  SwapDKBridgeConfig,
  SwapDKSwapResult,
} from "./types.js";

export class SwapDKSwapEvm extends SwapProtocol {
  private readonly client: SwapDKClient;
  private readonly evmAccount: EvmWalletAccount;
  private readonly swapDKConfig: SwapDKBridgeConfig;
  /** WDK source chain this instance was registered for. */
  private sourceChain: string | undefined;

  constructor(account: EvmWalletAccount, config: SwapDKBridgeConfig) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    super(account as any, { swapMaxFee: config.swapMaxFee });
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
  // quoteSwap  — estimate without executing
  // -----------------------------------------------------------------

  async quoteSwap(options: SwapOptions): Promise<Omit<SwapResult, "hash">> {
    this.validateOptions(options);
    const route = await this.fetchRoute(options, false);
    return this.routeToQuoteResult(route, options);
  }

  // -----------------------------------------------------------------
  // swap  — execute the same-chain swap
  // -----------------------------------------------------------------

  async swap(options: SwapOptions): Promise<SwapDKSwapResult> {
    this.validateOptions(options);
    const sourceAddress = await this.evmAccount.getAddress();
    const recipient = options.to ?? sourceAddress;

    // 1. Get quote with tx data
    let route = await this.fetchRoute(options, true, sourceAddress);

    // 2. Enforce swapMaxFee before sending any transaction
    this.assertFeeWithinLimit(route);

    // 3. Call /swap to finalize route and get calldata.
    //    If the routeId has expired, re-quote once and retry.
    let swapRes = await this.client.swap({
      routeId: route.routeId,
      sourceAddress,
      destinationAddress: recipient,
    }).catch(async (err) => {
      if (err instanceof SwapDKApiError && err.isStaleRoute) {
        route = await this.fetchRoute(options, true, sourceAddress);
        this.assertFeeWithinLimit(route);
        return this.client.swap({
          routeId: route.routeId,
          sourceAddress,
          destinationAddress: recipient,
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

    // 5. Send the swap transaction
    const tx = swapRes.tx;
    if (!tx) {
      throw new SwapDKUserError(
        "swap-engine returned no transaction data for same-chain swap. " +
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
    const chain = this.sourceChain ?? "ethereum";
    const sellDecimals = resolveAssetDecimals(chain, options.tokenIn);
    const buyDecimals = resolveAssetDecimals(chain, options.tokenOut);

    return {
      hash,
      fee: tx.gas ? BigInt(tx.gas) : 0n,
      tokenInAmount: fromHumanDecimal(swapRes.sellAmount, sellDecimals),
      tokenOutAmount: fromHumanDecimal(swapRes.buyAmount, buyDecimals),
      approveHash,
    };
  }

  // -----------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------

  private async fetchRoute(
    options: SwapOptions,
    includeTx: boolean,
    sourceAddress?: string,
  ): Promise<QuoteRoute> {
    const addr = sourceAddress ?? await this.evmAccount.getAddress();
    const chain = this.sourceChain ?? "ethereum";

    const sellAsset = toSwapKitAsset(options.tokenIn, chain);
    const buyAsset = toSwapKitAsset(options.tokenOut, chain);
    const sellDecimals = resolveAssetDecimals(chain, options.tokenIn);
    const sellAmount = toHumanDecimal(BigInt(options.tokenInAmount!), sellDecimals);

    const quoteRes = await this.client.quote({
      sellAsset,
      buyAsset,
      sellAmount,
      sourceAddress: addr,
      destinationAddress: options.to ?? addr,
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

  private assertFeeWithinLimit(route: QuoteRoute): void {
    const limit = this.swapDKConfig.swapMaxFee;
    if (limit === undefined) return;

    const fee = route.tx?.gas ? BigInt(route.tx.gas) : 0n;
    if (fee > limit) {
      throw new SwapDKUserError(
        `Estimated fee ${fee} wei exceeds swapMaxFee ${limit} wei`,
      );
    }
  }

  private validateOptions(options: SwapOptions): void {
    if (options.tokenInAmount === undefined) {
      throw new SwapDKUserError(
        "tokenInAmount is required — exact output swaps are not supported",
      );
    }
  }

  private routeToQuoteResult(
    route: QuoteRoute,
    options: SwapOptions,
  ): Omit<SwapResult, "hash"> {
    const chain = this.sourceChain ?? "ethereum";
    const sellDecimals = resolveAssetDecimals(chain, options.tokenIn);
    const buyDecimals = resolveAssetDecimals(chain, options.tokenOut);

    return {
      fee: route.tx?.gas ? BigInt(route.tx.gas) : 0n,
      tokenInAmount: fromHumanDecimal(route.sellAmount, sellDecimals),
      tokenOutAmount: fromHumanDecimal(route.expectedBuyAmount, buyDecimals),
    };
  }
}

