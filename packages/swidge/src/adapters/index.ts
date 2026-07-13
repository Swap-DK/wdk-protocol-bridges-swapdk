// ---------------------------------------------------------------------------
// Adapter registry — one entry per source-chain family.
//
// SwapDKSwidge.swidge() calls `adapterFor(fromChain)` at dispatch time.
// Missing adapters throw a `SwapDKUserError` with a clear next step (usually
// "install the corresponding wallet package"); the discovery methods
// (getSupportedChains / getSupportedTokens) never advertise a source chain
// whose adapter isn't registered here.
// ---------------------------------------------------------------------------

import { SwapDKUserError } from "@swapdk/swap-engine-client";

import { chainFamilyFor } from "../chain-map.js";
import { btcAdapter } from "./btc.js";
import { cosmosAdapter } from "./cosmos.js";
import { evmAdapter } from "./evm.js";
import { solanaAdapter } from "./solana.js";
import { tronAdapter } from "./tron.js";
import type { SwidgeAdapter } from "./types.js";

export type { SwidgeAdapter, SwidgeAdapterContext, SwidgeAdapterResult } from "./types.js";
export type { SwidgeBtcAccount } from "./btc.js";
export type { SwidgeCosmosAccount } from "./cosmos.js";
export type { SwidgeEvmAccount } from "./evm.js";
export type { SwidgeSolanaAccount } from "./solana.js";
export type { SwidgeTronAccount } from "./tron.js";
export { btcAdapter } from "./btc.js";
export { cosmosAdapter } from "./cosmos.js";
export { evmAdapter } from "./evm.js";
export { solanaAdapter } from "./solana.js";
export { tronAdapter } from "./tron.js";

const ADAPTERS_BY_FAMILY: Partial<
  Record<"bitcoin" | "cosmos" | "evm" | "solana" | "tron", SwidgeAdapter>
> = {
  bitcoin: btcAdapter,
  cosmos: cosmosAdapter,
  evm: evmAdapter,
  solana: solanaAdapter,
  tron: tronAdapter,
};

/**
 * Resolve the adapter for a given swidge source chain id. Throws with
 * a clear message when the chain has no adapter yet.
 */
export function adapterFor(swidgeChain: string): SwidgeAdapter {
  const family = chainFamilyFor(swidgeChain);
  if (family === "") {
    throw new SwapDKUserError(
      `SwapDKSwidge: unknown source chain "${swidgeChain}" — see getSupportedChains()`,
    );
  }
  const adapter = ADAPTERS_BY_FAMILY[family];
  if (!adapter) {
    throw new SwapDKUserError(
      `SwapDKSwidge: source chain "${swidgeChain}" (family "${family}") is not yet supported by this package. ` +
        `Currently supported families: ${Object.keys(ADAPTERS_BY_FAMILY).join(", ")}.`,
    );
  }
  return adapter;
}
