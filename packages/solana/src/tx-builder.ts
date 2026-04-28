// ---------------------------------------------------------------------------
// tx-builder.ts — build Solana transaction messages for THORChain-style
// bridges: a native-SOL (or SPL) transfer to the inbound vault, plus a
// Memo Program instruction carrying the THORChain swap memo.
//
// Designed so that the resulting object can be passed straight into
// `@tetherto/wdk-wallet-solana`'s `WalletAccountSolana.sendTransaction`.
// That method fills in blockhash + fee payer if not set, then signs and
// broadcasts. We therefore only need to construct the instructions and
// leave lifetime / fee-payer handling to the wallet.
// ---------------------------------------------------------------------------

import { address, type Address } from "@solana/addresses";
import { createNoopSigner } from "@solana/signers";
import {
  appendTransactionMessageInstruction,
  createTransactionMessage,
  type TransactionMessage,
} from "@solana/transaction-messages";
import { getTransferSolInstruction } from "@solana-program/system";
import { getAddMemoInstruction } from "@solana-program/memo";

/**
 * Arguments for building a native-SOL deposit transaction with memo.
 */
export interface BuildNativeTransferWithMemoArgs {
  /** Sender's Solana address (base58). */
  source: string;
  /** Recipient (THORChain inbound vault) address (base58). */
  destination: string;
  /** Amount in lamports (1 SOL = 1e9 lamports). */
  lamports: bigint;
  /** THORChain memo string to attach via the Memo Program. */
  memo: string;
}

/**
 * Build a Solana `transactionMessage` containing:
 *  1. SystemProgram transfer of `lamports` from `source` to `destination`
 *  2. Memo Program instruction carrying `memo` as UTF-8 bytes
 *
 * Lifetime (recent blockhash) and fee payer are NOT set here — the WDK
 * Solana wallet's `sendTransaction` fills both. That means this function
 * is pure (no RPC calls), easily unit-testable, and safe to retry.
 *
 * The Memo Program takes no accounts (except optional signer accounts,
 * which we don't use). Its instruction data is just the raw memo bytes.
 * THORChain memos are ASCII and well under the Solana tx-size limit.
 */
export function buildNativeTransferWithMemo(
  args: BuildNativeTransferWithMemoArgs,
): TransactionMessage {
  const sourceAddr: Address = address(args.source);
  const destAddr: Address = address(args.destination);

  // A NoopSigner is a placeholder with the right shape that carries only
  // the address. The WDK Solana wallet later calls
  // `setTransactionMessageFeePayerSigner(realSigner, tx)` — the real
  // fee-payer signer covers the whole tx, so the source slot here doesn't
  // need to sign independently for a same-address transfer.
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
