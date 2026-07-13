// ---------------------------------------------------------------------------
// Shared shape for source-chain adapters.
//
// Each adapter takes the /swap response from swap-engine and the source
// wallet account, dispatches the outbound transaction(s), and returns the
// data SwapDKSwidge needs to build its `SwidgeResult` (primary tx hash,
// per-tx list, and any auxiliary results the source chain produces —
// approval tx for ERC-20, activation fee for TRON, etc.).
//
// Adapters are intentionally isolated from the swap-engine HTTP layer:
// SwapDKSwidge fetches the /swap response and hands the parsed tx to the
// adapter's `execute()`. This keeps the adapter's dependency surface small
// (only the paired wallet account interface + a few internal helpers).
// ---------------------------------------------------------------------------

import type {
  QuoteRoute,
  SwapDKClient,
  SwapResponse,
} from "@swapdk/swap-engine-client";

import type { SwidgeTransaction } from "../SwapDKSwidge.js";
import type { SwapDKSwidgeConfig, SwapDKSwidgeOptions } from "../types.js";

/**
 * Context threaded from SwapDKSwidge into the adapter.
 *
 * `route` is the best route selected from /quote — every adapter has
 * this. `swapRes` is the finalized /swap response with calldata; it's
 * populated only when SwapDKSwidge determined the family needs it (EVM,
 * Cosmos-MsgSend, TRON — all need calldata from /swap). Bitcoin's
 * THORChain path constructs its tx directly from `route.inboundAddress`
 * + `route.memo` so `swapRes` is omitted for that adapter.
 *
 * `client` gives the adapter access to additional endpoints — currently
 * only `openBrokerChannel` (Chainflip); most adapters won't touch it.
 *
 * `sourceAddress` is pre-resolved from `account.getAddress()` — some
 * adapters need it for /swap parameters or refund addresses; pre-
 * resolving avoids duplicate calls.
 */
export interface SwidgeAdapterContext {
  route: QuoteRoute;
  swapRes?: SwapResponse;
  client: SwapDKClient;
  options: SwapDKSwidgeOptions;
  config: SwapDKSwidgeConfig;
  fromChain: string;
  sourceAddress: string;
}

/**
 * Result an adapter produces. `hash` is the primary source-chain
 * transaction hash — surfaced on `SwidgeResult.hash` for the caller.
 * `transactions` is the full per-tx list including any approval /
 * auxiliary steps; SwapDKSwidge writes it verbatim into
 * `SwidgeResult.transactions`.
 */
export interface SwidgeAdapterResult {
  hash: string;
  transactions: SwidgeTransaction[];
}

/**
 * Common interface every source-chain adapter implements. Adapters are
 * chain-family-specific — one per {btc, cosmos, evm, solana, tron}.
 */
export interface SwidgeAdapter {
  /**
   * Chain family this adapter handles. Matches the `family` return
   * value from `chainFamilyFor()` in chain-map.ts.
   */
  readonly family: "bitcoin" | "cosmos" | "evm" | "solana" | "tron";

  /**
   * Whether SwapDKSwidge should fetch the /swap response before
   * dispatching. Adapters that build their tx from /quote data alone
   * (Bitcoin's THORChain path) return `false`; adapters that need
   * finalized calldata (EVM, Cosmos-MsgSend, TRON) return `true`.
   *
   * Default (undefined) is treated as `true` to preserve backwards
   * compatibility with the initial EVM-only shape.
   */
  readonly needsSwapResponse?: boolean;

  /**
   * Dispatch the outbound transaction(s). Adapters are expected to
   * throw a `SwapDKUserError` on caller-fixable problems (missing
   * calldata, unsupported route shape) and a `SwapDKError` subclass
   * on transport failures.
   */
  execute(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    account: any,
    ctx: SwidgeAdapterContext,
  ): Promise<SwidgeAdapterResult>;
}
