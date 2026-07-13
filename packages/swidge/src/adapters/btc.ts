// ---------------------------------------------------------------------------
// Swidge adapter: Bitcoin source.
//
// Two provider paths, picked from the route's `providers[]`:
//
//   - THORChain / MAYAChain: deposit to the rotating Asgard vault with
//     the swap memo as an OP_RETURN output. Tx params come from the
//     /quote response (`inboundAddress`, `memo`, `sellAmount`) — no
//     /swap call needed. The paired BTC wallet's `sendTransaction`
//     accepts an optional `memo` field and appends it as OP_RETURN.
//
//   - Chainflip: broker-channel model. Adapter opens a channel via
//     swap-engine's `/chainflip/broker/channel`, receives a
//     per-swap-intent deposit address, and sends a plain BTC transfer
//     there (no memo — the address itself encodes the intent).
//
// Same dispatch pattern the legacy `SwapDKBridgeBtc` uses; this adapter
// is that dispatch loop lifted into a swidge-friendly shape.
// ---------------------------------------------------------------------------

import { SwapDKUserError } from "@swapdk/swap-engine-client";
import type {
  BrokerChannelRequest,
  ChainflipAsset,
  QuoteRoute,
} from "@swapdk/swap-engine-client";

import { fromHumanAmount } from "../asset-encode.js";
import type { SwidgeTransaction } from "../SwapDKSwidge.js";
import type {
  SwidgeAdapter,
  SwidgeAdapterContext,
  SwidgeAdapterResult,
} from "./types.js";

// BTC's native decimals; sats-per-BTC = 1e8.
const BTC_DECIMALS = 8;

const THOR_PROVIDERS = new Set(["THORCHAIN", "MAYACHAIN"]);
const CHAINFLIP_PROVIDER = "CHAINFLIP";

/**
 * Structural subset of `@tetherto/wdk-wallet-btc` (or the SwapDK fork).
 * The `memo` field is a SwapDK fork addition; when running against
 * unmodified upstream `@tetherto/wdk-wallet-btc` (which lacks memo
 * support until the pending upstream PR lands) the adapter throws
 * loudly at `sendTransaction()` time on THORChain routes.
 */
export interface SwidgeBtcAccount {
  getAddress(): string | Promise<string>;
  sendTransaction(options: {
    to: string;
    value: bigint;
    feeRate?: number | bigint;
    confirmationTarget?: number;
    memo?: string | Uint8Array;
  }): Promise<{ hash: string; fee: bigint }>;
}

// SwapKit chain prefix → Chainflip's long-form chain name. Mirrors the
// `CHAINFLIP_CHAIN_BY_PREFIX` map in packages/btc/src/SwapDKBridgeBtc.ts
// and `chainflipChainShort` in swap-engine's utils/track_chainflip.go.
const CHAINFLIP_CHAIN_BY_PREFIX: Record<string, string> = {
  BTC: "Bitcoin",
  ETH: "Ethereum",
  ARB: "Arbitrum",
  BASE: "Base",
  SOL: "Solana",
  DOT: "Polkadot",
  ASSETHUB: "AssetHub",
};

export const btcAdapter: SwidgeAdapter = {
  family: "bitcoin",
  // BTC's THORChain path builds its tx from /quote alone; the Chainflip
  // path uses /chainflip/broker/channel. Neither needs /swap.
  needsSwapResponse: false,

  async execute(
    account: SwidgeBtcAccount,
    ctx: SwidgeAdapterContext,
  ): Promise<SwidgeAdapterResult> {
    const { route } = ctx;
    const kind = classifyProvider(route);
    if (kind === "thor") {
      return dispatchThor(account, ctx);
    }
    if (kind === "chainflip") {
      return dispatchChainflip(account, ctx);
    }
    throw new SwapDKUserError(
      "SwapDKSwidge (btc): unsupported provider(s) on route: " +
        `${(route.providers ?? []).join(", ") || "<none>"}. ` +
        "Supported: THORCHAIN, MAYACHAIN, CHAINFLIP.",
    );
  },
};

// -- dispatch branches ---------------------------------------------------

async function dispatchThor(
  account: SwidgeBtcAccount,
  ctx: SwidgeAdapterContext,
): Promise<SwidgeAdapterResult> {
  const { route, config, fromChain } = ctx;

  if (!route.inboundAddress) {
    throw new SwapDKUserError(
      "SwapDKSwidge (btc/thor): swap-engine quote returned no inboundAddress. " +
        `Providers: ${route.providers.join(", ")}`,
    );
  }
  if (!route.memo) {
    throw new SwapDKUserError(
      "SwapDKSwidge (btc/thor): swap-engine quote returned no memo. Without an " +
        "OP_RETURN memo THORChain refunds the deposit. Providers: " +
        route.providers.join(", "),
    );
  }
  if (route.expiration) {
    const expiresAt = Number(route.expiration) * 1000;
    if (Number.isFinite(expiresAt) && expiresAt < Date.now()) {
      throw new SwapDKUserError(
        `SwapDKSwidge (btc/thor): quoted inbound vault expired at ${route.expiration}. Re-quote and try again.`,
      );
    }
  }

  const value = fromHumanAmount(route.sellAmount, BTC_DECIMALS);
  const { hash } = await account.sendTransaction({
    to: route.inboundAddress,
    value,
    feeRate: config.feeRate,
    memo: route.memo,
  });

  const transactions: SwidgeTransaction[] = [
    { hash, chain: fromChain, type: "source" },
  ];
  return { hash, transactions };
}

async function dispatchChainflip(
  account: SwidgeBtcAccount,
  ctx: SwidgeAdapterContext,
): Promise<SwidgeAdapterResult> {
  const { route, client, options, config, fromChain, sourceAddress } = ctx;

  if (!options.recipient) {
    throw new SwapDKUserError(
      "SwapDKSwidge (btc/chainflip): options.recipient is required — Chainflip " +
        "encodes the destination in the broker-channel deposit address.",
    );
  }

  const req: BrokerChannelRequest = {
    sellAsset: swapKitAssetToChainflip(route.sellAsset),
    buyAsset: swapKitAssetToChainflip(route.buyAsset),
    destinationAddress: options.recipient,
    // sellAmount surfaces swap-engine's `CheckChainflipMinimumDeposit`
    // guard — sub-min deposits are unrecoverable on Chainflip, so we
    // want the pre-flight check on the server before allocating a
    // channel.
    sellAmount: route.sellAmount,
    refundParameters: {
      refundAddress: options.refundAddress ?? sourceAddress,
      minPrice: config.chainflip?.refundMinPrice ?? "0x0",
      retryDuration: config.chainflip?.refundRetryDuration ?? 100,
    },
  };

  const dcaChunks = config.chainflip?.dcaChunks ?? 1;
  if (dcaChunks > 1) {
    if (config.chainflip?.dcaChunkInterval === undefined) {
      throw new SwapDKUserError(
        "SwapDKSwidge (btc/chainflip): config.chainflip.dcaChunkInterval is required when dcaChunks > 1",
      );
    }
    req.dcaParameters = {
      chunkInterval: config.chainflip.dcaChunkInterval,
      numberOfChunks: dcaChunks,
    };
  }

  const maxBoostFeeBps = config.chainflip?.maxBoostFeeBps ?? 0;
  if (maxBoostFeeBps > 0) {
    req.maxBoostFeeBps = maxBoostFeeBps;
  }

  const channel = await client.openBrokerChannel(req);

  const value = fromHumanAmount(route.sellAmount, BTC_DECIMALS);
  const { hash } = await account.sendTransaction({
    to: channel.depositAddress,
    value,
    feeRate: config.feeRate,
    // No memo on Chainflip — the deposit address encodes the intent.
  });

  const transactions: SwidgeTransaction[] = [
    { hash, chain: fromChain, type: "source" },
  ];
  return { hash, transactions };
}

// -- helpers -------------------------------------------------------------

function classifyProvider(route: QuoteRoute): "thor" | "chainflip" | undefined {
  const providers = route.providers ?? [];
  if (providers.some((p) => THOR_PROVIDERS.has(p))) return "thor";
  if (providers.includes(CHAINFLIP_PROVIDER)) return "chainflip";
  return undefined;
}

function swapKitAssetToChainflip(asset: string): ChainflipAsset {
  const dot = asset.indexOf(".");
  if (dot < 0) {
    throw new SwapDKUserError(
      `SwapDKSwidge (btc/chainflip): cannot convert asset "${asset}" to Chainflip notation — not a SwapKit asset string.`,
    );
  }
  const chainPrefix = asset.slice(0, dot).toUpperCase();
  const rest = asset.slice(dot + 1);
  const dash = rest.indexOf("-");
  const symbol = dash < 0 ? rest : rest.slice(0, dash);
  const chain = CHAINFLIP_CHAIN_BY_PREFIX[chainPrefix];
  if (!chain) {
    throw new SwapDKUserError(
      `SwapDKSwidge (btc/chainflip): Chainflip does not support chain prefix "${chainPrefix}" (asset: ${asset}).`,
    );
  }
  return { chain, asset: symbol.toUpperCase() };
}
