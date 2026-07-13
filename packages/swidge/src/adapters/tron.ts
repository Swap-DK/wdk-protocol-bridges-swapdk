// ---------------------------------------------------------------------------
// Swidge adapter: TRON source.
//
// Two tx shapes swap-engine may emit for TRON, picked from the /swap
// response:
//
//   - Router path (default): `tx.data` carries `depositWithExpiry`
//     calldata, `tx.to` is the router contract, `tx.memo` is empty.
//     Adapter builds a `TriggerSmartContract` with raw calldata via
//     `tronWeb.transactionBuilder.triggerSmartContract(to, "", { input }, [], ownerHex)`.
//
//   - Direct-vault path: `tx.data` is empty, `tx.memo` carries the
//     routing memo. Used when THORChain has the TRON pool unhalted for
//     trading but the router contract isn't deployed (transitional
//     state observed mid-2026). Adapter builds a `TransferContract` via
//     `sendTrx()` + attaches the memo through `addUpdateData()` — the
//     latter recomputes `txID` because the memo is part of the tx hash
//     preimage.
//
// For TRC-20 sources, swap-engine emits an `approvalTx` alongside the
// main tx; adapter dispatches it first, waits for confirmation, then
// sends the router call. Same pattern as `SwapDKBridgeTron`.
//
// Requires a `tronWeb` instance on `SwapDKSwidgeConfig.tronWeb`. Pass
// the same tronweb instance the paired `WalletManagerTron` was built
// with — the adapter only reads from it (address encoding, feeLimit
// fallback, transactionBuilder), no key material is exchanged.
// ---------------------------------------------------------------------------

import { SwapDKUserError } from "@swapdk/swap-engine-client";

import type { SwidgeTransaction } from "../SwapDKSwidge.js";
import type { TronPrebuiltTransaction, TronWebLike } from "../types.js";
import type {
  SwidgeAdapter,
  SwidgeAdapterContext,
  SwidgeAdapterResult,
} from "./types.js";

/**
 * Structural subset of `@tetherto/wdk-wallet-tron@^1.0.0-beta.8`'s
 * `WalletAccountTron`. Adapter never touches key material — only
 * `getAddress()` (base58) and `sendTransaction(prebuiltTx)`.
 */
export interface SwidgeTronAccount {
  getAddress(): string | Promise<string>;
  sendTransaction(tx: TronPrebuiltTransaction): Promise<{
    hash: string;
    fee: bigint;
    activationFee?: bigint;
  }>;
  waitForTransaction?(hash: string, timeoutMs?: number): Promise<void>;
}

export const tronAdapter: SwidgeAdapter = {
  family: "tron",
  needsSwapResponse: true,

  async execute(
    account: SwidgeTronAccount,
    ctx: SwidgeAdapterContext,
  ): Promise<SwidgeAdapterResult> {
    const { swapRes, config, sourceAddress, fromChain } = ctx;
    if (!swapRes) {
      throw new SwapDKUserError(
        "SwapDKSwidge (tron): missing /swap response — this is a bug in the swidge module (adapter should have signalled needsSwapResponse=true).",
      );
    }
    const tronWeb = config.tronWeb;
    if (!tronWeb) {
      throw new SwapDKUserError(
        "SwapDKSwidge (tron): config.tronWeb is required. Pass the tronweb instance the paired WalletManagerTron was constructed with.",
      );
    }

    const sourceAddressHex = tronWeb.address.toHex(sourceAddress);
    const transactions: SwidgeTransaction[] = [];

    // 1. TRC-20 approval leg, when present.
    if (swapRes.approvalTx) {
      const approvePrebuilt = await buildContractCallTx(tronWeb, {
        to: swapRes.approvalTx.to,
        data: swapRes.approvalTx.data,
        value: swapRes.approvalTx.value,
        feeLimit: swapRes.approvalTx.feeLimit,
        ownerHex: sourceAddressHex,
      });
      const approveResult = await account.sendTransaction(approvePrebuilt);
      transactions.push({
        hash: approveResult.hash,
        chain: fromChain,
        type: "approval",
      });
      if (account.waitForTransaction) {
        await account.waitForTransaction(approveResult.hash);
      }
    }

    // 2. Main leg — dispatch on tx.data (router) vs tx.memo (direct vault).
    const tx = swapRes.tx;
    if (!tx) {
      throw new SwapDKUserError(
        "SwapDKSwidge (tron): swap-engine returned no transaction data. " +
          `Providers: ${swapRes.providers.join(", ")}`,
      );
    }

    let prebuilt: TronPrebuiltTransaction;
    if (tx.data && tx.data !== "") {
      prebuilt = await buildContractCallTx(tronWeb, {
        to: tx.to,
        data: tx.data,
        value: tx.value,
        feeLimit: tx.feeLimit,
        ownerHex: sourceAddressHex,
      });
    } else if (tx.memo && tx.memo !== "") {
      prebuilt = await buildTransferWithMemoTx(tronWeb, {
        to: tx.to,
        value: tx.value,
        memo: tx.memo,
        ownerAddress: sourceAddress,
      });
    } else {
      throw new SwapDKUserError(
        "SwapDKSwidge (tron): swap-engine returned a SwapTx with neither `data` nor `memo` — cannot dispatch. " +
          `Providers: ${swapRes.providers.join(", ")}`,
      );
    }

    const sendResult = await account.sendTransaction(prebuilt);
    transactions.push({
      hash: sendResult.hash,
      chain: fromChain,
      type: "source",
    });

    return { hash: sendResult.hash, transactions };
  },
};

// -- prebuilt-tx builders (shared with the legacy SwapDKBridgeTron) ------

async function buildContractCallTx(
  tronWeb: TronWebLike,
  args: {
    to: string;
    data: string | undefined;
    value: string | undefined;
    feeLimit: string | undefined;
    ownerHex: string;
  },
): Promise<TronPrebuiltTransaction> {
  if (!args.data) {
    throw new SwapDKUserError(
      "SwapDKSwidge (tron): buildContractCallTx requires `data` (ABI calldata)",
    );
  }
  const inputHex = String(args.data).replace(/^0x/, "");
  const callValue =
    args.value !== undefined && args.value !== "" ? Number(args.value) : 0;
  const energyCap =
    args.feeLimit !== undefined && args.feeLimit !== ""
      ? Number(args.feeLimit)
      : tronWeb.feeLimit;

  const { transaction } = await tronWeb.transactionBuilder.triggerSmartContract(
    args.to,
    "", // functionSelector empty → options.input carries the raw calldata
    { feeLimit: energyCap, callValue, input: inputHex },
    [],
    args.ownerHex,
  );
  return transaction;
}

async function buildTransferWithMemoTx(
  tronWeb: TronWebLike,
  args: {
    to: string;
    value: string | undefined;
    memo: string;
    ownerAddress: string;
  },
): Promise<TronPrebuiltTransaction> {
  const sun =
    args.value !== undefined && args.value !== "" ? Number(args.value) : 0;
  const transferTx = await tronWeb.transactionBuilder.sendTrx(
    args.to,
    sun,
    args.ownerAddress,
  );
  return await tronWeb.transactionBuilder.addUpdateData(
    transferTx,
    args.memo,
    "utf8",
  );
}
