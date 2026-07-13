// ---------------------------------------------------------------------------
// Swidge adapter: EVM source (Ethereum, Arbitrum, Base, BSC, Avalanche, …).
//
// Wraps the WDK EVM wallet account and dispatches:
//   1. An optional ERC-20 approval tx (when the source is a fungible and
//      the swap-engine returned an `approvalTx`).
//   2. The main deposit / router-contract call.
//
// The tx bodies come pre-built from swap-engine (`/swap` response); the
// adapter just coerces field types and forwards through the wallet. Same
// pattern as the legacy `SwapDKBridgeEvm` — this adapter is essentially
// its dispatch loop lifted into a swidge-friendly shape.
// ---------------------------------------------------------------------------

import { SwapDKUserError } from "@swapdk/swap-engine-client";

import type { SwidgeTransaction } from "../SwapDKSwidge.js";
import type {
  SwidgeAdapter,
  SwidgeAdapterContext,
  SwidgeAdapterResult,
} from "./types.js";

/**
 * Structural subset of a WDK EVM wallet account (see
 * `@tetherto/wdk-wallet-evm`'s `WalletAccountEvm`). We only need
 * `sendTransaction` and an optional `waitForTransaction`; getAddress
 * lives on the account too but SwapDKSwidge resolves it upstream and
 * threads through the swap-engine calldata rather than the adapter.
 */
export interface SwidgeEvmAccount {
  sendTransaction(tx: {
    to: string;
    value?: bigint;
    data?: string;
    gas?: bigint;
  }): Promise<string | { hash: string }>;
  waitForTransaction?(hash: string, timeoutMs?: number): Promise<void>;
}

export const evmAdapter: SwidgeAdapter = {
  family: "evm",
  needsSwapResponse: true,

  async execute(
    account: SwidgeEvmAccount,
    ctx: SwidgeAdapterContext,
  ): Promise<SwidgeAdapterResult> {
    const { swapRes, fromChain } = ctx;
    if (!swapRes) {
      throw new SwapDKUserError(
        "SwapDKSwidge (evm): missing /swap response — this is a bug in the swidge module (adapter should have signalled needsSwapResponse=true).",
      );
    }
    const transactions: SwidgeTransaction[] = [];

    // 1. Optional ERC-20 approval leg.
    if (swapRes.approvalTx) {
      const approveResult = await account.sendTransaction({
        to: swapRes.approvalTx.to,
        data: swapRes.approvalTx.data,
        value: swapRes.approvalTx.value
          ? BigInt(swapRes.approvalTx.value)
          : 0n,
        gas: swapRes.approvalTx.gasLimit
          ? BigInt(swapRes.approvalTx.gasLimit)
          : undefined,
      });
      const approveHash = extractHash(approveResult);
      transactions.push({
        hash: approveHash,
        chain: fromChain,
        type: "approval",
      });
      if (account.waitForTransaction) {
        await account.waitForTransaction(approveHash);
      }
    }

    // 2. Main deposit / router call.
    const tx = swapRes.tx;
    if (!tx) {
      throw new SwapDKUserError(
        "SwapDKSwidge (evm): swap-engine returned no transaction data — " +
          "the route may require a manual deposit. Providers: " +
          swapRes.providers.join(", "),
      );
    }

    const sendResult = await account.sendTransaction({
      to: tx.to,
      data: tx.data,
      value: tx.value ? BigInt(tx.value) : 0n,
      gas: tx.gas ? BigInt(tx.gas) : undefined,
    });
    const hash = extractHash(sendResult);
    transactions.push({ hash, chain: fromChain, type: "source" });

    return { hash, transactions };
  },
};

/**
 * WDK EVM wallets diverge on `sendTransaction`'s return shape: some ship
 * the tx hash as a raw hex string, others wrap it as `{ hash }`. Accept
 * both — same handling as `SwapDKBridgeEvm`'s `txHash` helper.
 */
function extractHash(result: string | { hash: string }): string {
  return typeof result === "string" ? result : result.hash;
}
