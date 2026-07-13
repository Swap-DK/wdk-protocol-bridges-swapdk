// ---------------------------------------------------------------------------
// Swidge adapter: Solana source.
//
// Builds a Solana `transactionMessage` combining two instructions:
//   1. SystemProgram transfer of `lamports` from source → THORChain inbound vault
//   2. Memo Program instruction carrying the THORChain swap memo
//
// Both come from the /quote response — swap-engine returns
// `route.inboundAddress` (the rotating THORChain SOL vault) and
// `route.memo` (the encoded swap intent). No /swap round-trip needed;
// Solana source is a pure /quote-driven build like Bitcoin's
// THORChain path.
//
// Native SOL only in this MVP. SPL sources are not yet supported —
// they need a different instruction (SPL Token transfer) and an
// associated token account lookup, which is a separate design pass.
//
// The paired wallet is `@tetherto/wdk-wallet-solana` — its
// `sendTransaction` fills in blockhash + fee payer, signs, and
// broadcasts.
// ---------------------------------------------------------------------------

import { SwapDKUserError } from "@swapdk/swap-engine-client";
import { address, type Address } from "@solana/addresses";
import { createNoopSigner } from "@solana/signers";
import {
  appendTransactionMessageInstruction,
  createTransactionMessage,
  type TransactionMessage,
} from "@solana/transaction-messages";
import { getTransferSolInstruction } from "@solana-program/system";
import { getAddMemoInstruction } from "@solana-program/memo";

import { fromHumanAmount } from "../asset-encode.js";
import type { SwidgeTransaction } from "../SwapDKSwidge.js";
import type {
  SwidgeAdapter,
  SwidgeAdapterContext,
  SwidgeAdapterResult,
} from "./types.js";

// SOL native decimals — 1 SOL = 1e9 lamports.
const SOL_DECIMALS = 9;

/**
 * Structural subset of `@tetherto/wdk-wallet-solana`'s
 * `WalletAccountSolana`. The wallet fills in blockhash + fee payer,
 * signs with the account's keypair, and broadcasts.
 */
export interface SwidgeSolanaAccount {
  getAddress(): string | Promise<string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendTransaction(tx: any): Promise<{ hash: string; fee?: bigint }>;
  waitForTransaction?(hash: string): Promise<void>;
}

export const solanaAdapter: SwidgeAdapter = {
  family: "solana",
  // Solana source builds its tx from /quote alone (inboundAddress +
  // memo + sellAmount) — same pattern as Bitcoin's THORChain path.
  needsSwapResponse: false,

  async execute(
    account: SwidgeSolanaAccount,
    ctx: SwidgeAdapterContext,
  ): Promise<SwidgeAdapterResult> {
    const { route, sourceAddress, fromChain, options } = ctx;

    if (isSplToken(options.fromToken)) {
      throw new SwapDKUserError(
        "SwapDKSwidge (solana): SPL-token sources are not yet supported — " +
          "pass `fromToken: \"SOL\"` for native SOL. SPL support requires a " +
          "separate SPL Token instruction path.",
      );
    }

    if (!route.inboundAddress) {
      throw new SwapDKUserError(
        "SwapDKSwidge (solana): swap-engine quote returned no inboundAddress. " +
          `Providers: ${route.providers.join(", ")}`,
      );
    }
    if (!route.memo) {
      throw new SwapDKUserError(
        "SwapDKSwidge (solana): swap-engine quote returned no memo. Without a " +
          "memo the THORChain observer cannot route the deposit and funds " +
          `would be lost. Providers: ${route.providers.join(", ")}`,
      );
    }

    const lamports = fromHumanAmount(route.sellAmount, SOL_DECIMALS);
    const transactionMessage = buildNativeTransferWithMemo({
      source: sourceAddress,
      destination: route.inboundAddress,
      lamports,
      memo: route.memo,
    });

    const result = await account.sendTransaction(transactionMessage);
    if (account.waitForTransaction) {
      await account.waitForTransaction(result.hash);
    }

    const transactions: SwidgeTransaction[] = [
      { hash: result.hash, chain: fromChain, type: "source" },
    ];
    return { hash: result.hash, transactions };
  },
};

// -- helpers -------------------------------------------------------------

/**
 * Best-effort SPL detection: a swidge `fromToken` that isn't "SOL"
 * (case-insensitive) is treated as an SPL mint address. Discovery
 * endpoints return SPL mints in their raw base58 form; native SOL
 * comes back as the uppercase ticker.
 */
function isSplToken(fromToken: string | undefined): boolean {
  if (!fromToken) return false;
  return fromToken.trim().toUpperCase() !== "SOL";
}

/**
 * Build a Solana `transactionMessage` containing:
 *   1. SystemProgram transfer of `lamports` from `source` → `destination`
 *   2. Memo Program instruction carrying `memo` as UTF-8 bytes
 *
 * Lifetime (recent blockhash) + fee payer are NOT set here — the WDK
 * Solana wallet's `sendTransaction` fills both. Pure function; no RPC.
 */
export interface BuildNativeTransferWithMemoArgs {
  source: string;
  destination: string;
  lamports: bigint;
  memo: string;
}

export function buildNativeTransferWithMemo(
  args: BuildNativeTransferWithMemoArgs,
): TransactionMessage {
  const sourceAddr: Address = address(args.source);
  const destAddr: Address = address(args.destination);

  // A NoopSigner is a placeholder with the right shape carrying only
  // the address. The WDK Solana wallet later attaches the real
  // fee-payer signer, which covers the whole tx.
  const sourceSigner = createNoopSigner(sourceAddr);

  const transferIx = getTransferSolInstruction({
    source: sourceSigner,
    destination: destAddr,
    amount: args.lamports,
  });

  const memoIx = getAddMemoInstruction({ memo: args.memo });

  return appendTransactionMessageInstruction(
    memoIx,
    appendTransactionMessageInstruction(
      transferIx,
      createTransactionMessage({ version: 0 }),
    ),
  );
}
