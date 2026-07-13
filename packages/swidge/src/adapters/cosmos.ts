// ---------------------------------------------------------------------------
// Swidge adapter: Cosmos-family source (THORChain / MAYAChain).
//
// Two broadcast strategies, picked from the /swap response shape:
//
//   - MsgDeposit (protocol-native): swap-engine returns an empty
//     inboundAddress (or one equal to the source address). The user
//     signs `types.MsgDeposit` against their own THORChain / MAYAChain
//     wallet; the protocol's Asgard module observes the memo. This is
//     the case for RUNE-originated swaps routed through THORChain
//     pools (RUNE → BTC via THORChain), or CACAO-originated swaps via
//     MAYAChain.
//
//   - MsgSend (cross-protocol): inboundAddress is a vault on the source
//     chain — funds must be sent there with the memo attached to the
//     tx body. The paired wallet's `transfer()` method emits a
//     `MsgSend` with the memo set. Used for cross-protocol routes
//     (e.g. RUNE → BTC routed via MAYAChain sends RUNE to MAYAChain's
//     THORChain vault).
//
// The paired wallet is `@base58-io/wdk-wallet-cosmos` (once the upstream
// PRs land) or the SwapDK `@swapdk/wdk-wallet-cosmos` fork with
// `deposit()` + memo-in-transfer support today.
// ---------------------------------------------------------------------------

import { SwapDKUserError } from "@swapdk/swap-engine-client";

import type { SwidgeTransaction } from "../SwapDKSwidge.js";
import type {
  SwidgeAdapter,
  SwidgeAdapterContext,
  SwidgeAdapterResult,
} from "./types.js";

/**
 * Native bank-module denom for the Cosmos source chain. Used as the
 * `token` field on the MsgSend cross-protocol path. Mirrors the
 * `nativeDenom` value the paired wallet manager was constructed with.
 */
const NATIVE_DENOM_FOR_CHAIN: Record<string, string> = {
  thorchain: "rune",
  mayachain: "cacao",
};

/**
 * Structural subset of `@base58-io/wdk-wallet-cosmos` / the SwapDK fork.
 * Both `deposit()` (MsgDeposit) and `transfer()` (MsgSend with memo)
 * are required — an unmodified upstream that lacks `deposit()` will
 * fail loudly at execute() time on the THORChain-native path.
 */
export interface SwidgeCosmosAccount {
  getAddress(): string | Promise<string>;

  deposit(
    options: { asset: string; amount: bigint | string; memo: string },
    overrides?: { gas?: string | number },
  ): Promise<{ hash: string; fee: bigint }>;

  transfer(options: {
    token: string;
    recipient: string;
    amount: bigint | string;
    memo?: string;
  }): Promise<{ hash: string; fee: bigint }>;
}

export const cosmosAdapter: SwidgeAdapter = {
  family: "cosmos",
  needsSwapResponse: true,

  async execute(
    account: SwidgeCosmosAccount,
    ctx: SwidgeAdapterContext,
  ): Promise<SwidgeAdapterResult> {
    const { swapRes, sourceAddress, fromChain } = ctx;
    if (!swapRes) {
      throw new SwapDKUserError(
        "SwapDKSwidge (cosmos): missing /swap response — this is a bug in the swidge module (adapter should have signalled needsSwapResponse=true).",
      );
    }
    if (!swapRes.memo) {
      throw new SwapDKUserError(
        "SwapDKSwidge (cosmos): swap-engine returned no routing memo. Without a memo the deposit/transfer cannot be processed and funds would be lost. " +
          `Providers: ${swapRes.providers.join(", ")}`,
      );
    }

    // Sell amount comes through the /swap response in human-decimal
    // form. Wallet.deposit() / wallet.transfer() accept either bigint
    // (base units) or string (human-decimal); we pass the string
    // through unchanged and let the wallet do the decimal conversion.
    // This is deliberate — the wallet knows the chain's native
    // decimals (8 for RUNE, 10 for CACAO), so a client-side conversion
    // here would duplicate that logic.
    const amount = swapRes.sellAmount;

    const inboundVault = detectInboundVault(swapRes, sourceAddress);
    let txResult: { hash: string; fee: bigint };
    if (inboundVault === undefined) {
      // MsgDeposit — protocol-native path.
      txResult = await account.deposit({
        asset: swapRes.sellAsset,
        amount,
        memo: swapRes.memo,
      });
    } else {
      // MsgSend — cross-protocol path.
      const denom = nativeDenomFor(fromChain);
      if (!denom) {
        throw new SwapDKUserError(
          `SwapDKSwidge (cosmos): unsupported source chain "${fromChain}" for MsgSend dispatch. ` +
            `Supported: ${Object.keys(NATIVE_DENOM_FOR_CHAIN).join(", ")}.`,
        );
      }
      txResult = await account.transfer({
        token: denom,
        recipient: inboundVault,
        amount,
        memo: swapRes.memo,
      });
    }

    const transactions: SwidgeTransaction[] = [
      { hash: txResult.hash, chain: fromChain, type: "source" },
    ];
    return { hash: txResult.hash, transactions };
  },
};

// -- helpers -------------------------------------------------------------

/**
 * Returns the inbound vault address for a MsgSend dispatch, or
 * undefined when the route is protocol-native (MsgDeposit). bech32
 * is case-sensitive but addresses sometimes arrive with surrounding
 * whitespace — trim before comparing to the source address.
 */
function detectInboundVault(
  swapRes: { inboundAddress?: string; targetAddress?: string },
  sourceAddress: string,
): string | undefined {
  const candidate = (swapRes.inboundAddress ?? swapRes.targetAddress ?? "").trim();
  if (!candidate) return undefined;
  if (candidate === sourceAddress) return undefined;
  return candidate;
}

function nativeDenomFor(swidgeChain: string): string | undefined {
  return NATIVE_DENOM_FOR_CHAIN[swidgeChain.toLowerCase()];
}
