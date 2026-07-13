import { describe, it, expect, vi } from "vitest";

import { tronAdapter } from "../../src/adapters/tron.js";
import { adapterFor } from "../../src/adapters/index.js";
import type {
  SwidgeAdapterContext,
  SwidgeTronAccount,
} from "../../src/adapters/index.js";
import type { TronWebLike } from "../../src/types.js";

const SAMPLE_ROUTER = "TThorRouterxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const SAMPLE_VAULT = "TN6WohfEwrrrSed2PzsjJMNHLaqVGHceLt";
const SAMPLE_USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const SAMPLE_TX_DATA = "0x44bc937b" + "00".repeat(160);
const SAMPLE_APPROVE_DATA = "0x095ea7b3" + "00".repeat(64);
const SAMPLE_MEMO = "=:e:0xFff8:367591:SDK:5";

function makeTronWeb(): TronWebLike & {
  address: { toHex: ReturnType<typeof vi.fn> };
  transactionBuilder: {
    triggerSmartContract: ReturnType<typeof vi.fn>;
    sendTrx: ReturnType<typeof vi.fn>;
    addUpdateData: ReturnType<typeof vi.fn>;
  };
} {
  return {
    address: {
      toHex: vi.fn((addr: string) => "41HEX_" + addr),
    },
    feeLimit: 100_000_000,
    transactionBuilder: {
      triggerSmartContract: vi.fn(
        async (
          contract: string,
          _selector: string,
          options: { feeLimit?: number; callValue?: number; input?: string },
          _params: unknown[],
          issuer: string,
        ) => ({
          transaction: {
            txID: `PREBUILT_CONTRACT_${contract}`,
            _contract: contract,
            _input: options?.input,
            _callValue: options?.callValue ?? 0,
            _feeLimit: options?.feeLimit,
            _issuer: issuer,
          },
        }),
      ),
      sendTrx: vi.fn(async (to: string, value: number, from: string) => ({
        txID: "PREBUILT_TRANSFER_BASE",
        _to: to,
        _value: value,
        _from: from,
      })),
      addUpdateData: vi.fn(
        async (tx: Record<string, unknown>, data: string, encoding?: string) => ({
          ...tx,
          txID: "PREBUILT_TRANSFER_WITHMEMO",
          _memo: data,
          _encoding: encoding,
        }),
      ),
    },
  };
}

function makeSwapRes(
  overrides: Partial<{
    tx: { to: string; data?: string; value?: string; feeLimit?: string; memo?: string };
    approvalTx: { to: string; data: string; value?: string; feeLimit?: string };
  }> = {},
) {
  return {
    sellAsset: "TRON.TRX",
    sellAmount: "20",
    buyAsset: "ETH.ETH",
    buyAmount: "0.00382",
    routeId: "route-1",
    providers: ["THORCHAIN"],
    targetAddress: SAMPLE_ROUTER,
    inboundAddress: SAMPLE_ROUTER,
    memo: "",
    fees: [],
    tx: overrides.tx ?? {
      to: SAMPLE_ROUTER,
      data: SAMPLE_TX_DATA,
      value: "20000000",
      feeLimit: "100000000",
    },
    ...(overrides.approvalTx ? { approvalTx: overrides.approvalTx } : {}),
  };
}

function makeCtx(
  overrides: Partial<SwidgeAdapterContext> = {},
): SwidgeAdapterContext {
  const tronWeb = overrides.config?.tronWeb ?? makeTronWeb();
  return {
    fromChain: "tron",
    sourceAddress: "TUserSourceAddrxxxxxxxxxxxxxxxxxxxx",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    route: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    swapRes: makeSwapRes() as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: {} as any,
    config: {
      apiUrl: "https://test",
      apiKey: "k",
      tronWeb,
      ...(overrides.config ?? {}),
    },
    options: {
      fromToken: "TRX",
      toToken: "ETH",
      toChain: "ethereum",
      recipient: "0xRecipient",
      fromTokenAmount: 20_000_000n,
    },
    ...overrides,
  };
}

function mockAccount(
  overrides: Partial<SwidgeTronAccount> = {},
): SwidgeTronAccount & {
  sendTransaction: ReturnType<typeof vi.fn>;
  waitForTransaction: ReturnType<typeof vi.fn>;
} {
  return {
    getAddress: () => "TUserSourceAddrxxxxxxxxxxxxxxxxxxxx",
    sendTransaction: vi.fn().mockResolvedValue({
      hash: "TRONTXHASH123",
      fee: 100_000_000n,
    }),
    waitForTransaction: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as SwidgeTronAccount & {
    sendTransaction: ReturnType<typeof vi.fn>;
    waitForTransaction: ReturnType<typeof vi.fn>;
  };
}

// -- registry -------------------------------------------------------------

describe("adapterFor(tron)", () => {
  it("returns tronAdapter and declares family + needs /swap", () => {
    expect(adapterFor("tron")).toBe(tronAdapter);
    expect(tronAdapter.family).toBe("tron");
    expect(tronAdapter.needsSwapResponse).toBe(true);
  });
});

// -- router-contract path (native TRX) -----------------------------------

describe("tronAdapter — router-contract path (native TRX)", () => {
  it("builds via triggerSmartContract with raw calldata + callValue = sellAmount SUN", async () => {
    const tronWeb = makeTronWeb();
    const account = mockAccount();
    const ctx = makeCtx({
      config: { apiUrl: "https://t", apiKey: "k", tronWeb },
    });

    const { hash, transactions } = await tronAdapter.execute(account, ctx);

    // triggerSmartContract called once with the router + raw calldata.
    expect(tronWeb.transactionBuilder.triggerSmartContract).toHaveBeenCalledOnce();
    const [contract, selector, options, params, issuer] =
      tronWeb.transactionBuilder.triggerSmartContract.mock.calls[0];
    expect(contract).toBe(SAMPLE_ROUTER);
    expect(selector).toBe("");
    expect(options.callValue).toBe(20_000_000);
    expect(options.feeLimit).toBe(100_000_000);
    expect(options.input).toBe(SAMPLE_TX_DATA.replace(/^0x/, ""));
    expect(params).toEqual([]);
    expect(issuer).toBe("41HEX_TUserSourceAddrxxxxxxxxxxxxxxxxxxxx");

    // Direct-vault builders not touched.
    expect(tronWeb.transactionBuilder.sendTrx).not.toHaveBeenCalled();
    expect(tronWeb.transactionBuilder.addUpdateData).not.toHaveBeenCalled();

    // account.sendTransaction receives the prebuilt tx tronweb produced.
    expect(account.sendTransaction).toHaveBeenCalledOnce();
    const prebuilt = account.sendTransaction.mock.calls[0][0];
    expect(prebuilt.txID).toBe(`PREBUILT_CONTRACT_${SAMPLE_ROUTER}`);

    expect(hash).toBe("TRONTXHASH123");
    expect(transactions).toEqual([
      { hash: "TRONTXHASH123", chain: "tron", type: "source" },
    ]);
  });

  it("falls back to tronWeb.feeLimit when the swap-engine SwapTx omits feeLimit", async () => {
    const tronWeb = makeTronWeb();
    tronWeb.feeLimit = 55_000_000;
    const account = mockAccount();
    const ctx = makeCtx({
      config: { apiUrl: "https://t", apiKey: "k", tronWeb },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      swapRes: makeSwapRes({
        tx: { to: SAMPLE_ROUTER, data: SAMPLE_TX_DATA, value: "20000000" }, // no feeLimit
      }) as any,
    });
    await tronAdapter.execute(account, ctx);
    const [, , options] = tronWeb.transactionBuilder.triggerSmartContract.mock.calls[0];
    expect(options.feeLimit).toBe(55_000_000);
  });
});

// -- direct-vault path (native TRX + memo, no router) --------------------

describe("tronAdapter — direct-vault path (transitional THORChain state)", () => {
  it("builds sendTrx + addUpdateData, memo becomes raw_data.data with fresh txID", async () => {
    const tronWeb = makeTronWeb();
    const account = mockAccount();
    const ctx = makeCtx({
      config: { apiUrl: "https://t", apiKey: "k", tronWeb },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      swapRes: makeSwapRes({
        tx: {
          to: SAMPLE_VAULT,
          value: "20000000",
          data: "",
          memo: SAMPLE_MEMO,
          feeLimit: "30000000",
        },
      }) as any,
    });

    const { hash, transactions } = await tronAdapter.execute(account, ctx);

    // Direct-vault builders wired correctly.
    expect(tronWeb.transactionBuilder.sendTrx).toHaveBeenCalledOnce();
    const [to, value, from] =
      tronWeb.transactionBuilder.sendTrx.mock.calls[0];
    expect(to).toBe(SAMPLE_VAULT);
    expect(value).toBe(20_000_000);
    expect(from).toBe("TUserSourceAddrxxxxxxxxxxxxxxxxxxxx"); // base58, not hex

    expect(tronWeb.transactionBuilder.addUpdateData).toHaveBeenCalledOnce();
    const [baseTx, memo, encoding] =
      tronWeb.transactionBuilder.addUpdateData.mock.calls[0];
    expect(baseTx.txID).toBe("PREBUILT_TRANSFER_BASE");
    expect(memo).toBe(SAMPLE_MEMO);
    expect(encoding).toBe("utf8");

    // Router builder NOT touched.
    expect(tronWeb.transactionBuilder.triggerSmartContract).not.toHaveBeenCalled();

    // account.sendTransaction receives the memo-carrying tx (fresh txID).
    const prebuilt = account.sendTransaction.mock.calls[0][0];
    expect(prebuilt.txID).toBe("PREBUILT_TRANSFER_WITHMEMO");

    expect(hash).toBe("TRONTXHASH123");
    expect(transactions).toEqual([
      { hash: "TRONTXHASH123", chain: "tron", type: "source" },
    ]);
  });
});

// -- TRC-20 approval + router leg ----------------------------------------

describe("tronAdapter — TRC-20 approval leg", () => {
  it("sends approval first, waits, then sends router deposit", async () => {
    const tronWeb = makeTronWeb();
    const account = mockAccount({
      sendTransaction: vi
        .fn()
        .mockResolvedValueOnce({ hash: "TRONAPPROVEHASH", fee: 100_000_000n })
        .mockResolvedValueOnce({ hash: "TRONBRIDGEHASH", fee: 150_000_000n }),
    });
    const ctx = makeCtx({
      config: { apiUrl: "https://t", apiKey: "k", tronWeb },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      swapRes: makeSwapRes({
        approvalTx: {
          to: SAMPLE_USDT,
          data: SAMPLE_APPROVE_DATA,
          value: "0",
          feeLimit: "100000000",
        },
        tx: {
          to: SAMPLE_ROUTER,
          data: SAMPLE_TX_DATA,
          value: "0", // TRC-20 path — tokens come via the allowance, not callValue
          feeLimit: "150000000",
        },
      }) as any,
    });

    const { hash, transactions } = await tronAdapter.execute(account, ctx);

    // Two triggerSmartContract calls (approve + router), no direct-vault path.
    expect(tronWeb.transactionBuilder.triggerSmartContract).toHaveBeenCalledTimes(2);
    expect(tronWeb.transactionBuilder.sendTrx).not.toHaveBeenCalled();

    const [approveContract, , approveOptions] =
      tronWeb.transactionBuilder.triggerSmartContract.mock.calls[0];
    expect(approveContract).toBe(SAMPLE_USDT);
    expect(approveOptions.callValue).toBe(0);
    expect(approveOptions.input).toBe(SAMPLE_APPROVE_DATA.replace(/^0x/, ""));
    expect(approveOptions.feeLimit).toBe(100_000_000);

    const [bridgeContract, , bridgeOptions] =
      tronWeb.transactionBuilder.triggerSmartContract.mock.calls[1];
    expect(bridgeContract).toBe(SAMPLE_ROUTER);
    expect(bridgeOptions.callValue).toBe(0);
    expect(bridgeOptions.feeLimit).toBe(150_000_000);

    // waitForTransaction called on the approval hash.
    expect(account.waitForTransaction).toHaveBeenCalledOnce();
    expect(account.waitForTransaction.mock.calls[0][0]).toBe("TRONAPPROVEHASH");

    // Two account.sendTransaction calls, main hash is the bridge one.
    expect(account.sendTransaction).toHaveBeenCalledTimes(2);
    expect(hash).toBe("TRONBRIDGEHASH");
    expect(transactions).toEqual([
      { hash: "TRONAPPROVEHASH", chain: "tron", type: "approval" },
      { hash: "TRONBRIDGEHASH", chain: "tron", type: "source" },
    ]);
  });
});

// -- error paths ---------------------------------------------------------

describe("tronAdapter — error paths", () => {
  it("throws when config.tronWeb is missing", async () => {
    const account = mockAccount();
    const ctx = makeCtx({
      config: { apiUrl: "https://t", apiKey: "k" },
    });
    await expect(tronAdapter.execute(account, ctx)).rejects.toThrow(
      /config\.tronWeb is required/,
    );
  });

  it("throws when swap-engine returns no tx data", async () => {
    const account = mockAccount();
    const ctx = makeCtx({
      swapRes: {
        ...makeSwapRes(),
        tx: undefined,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    });
    await expect(tronAdapter.execute(account, ctx)).rejects.toThrow(
      /no transaction data/,
    );
  });

  it("throws when the SwapTx has neither data nor memo", async () => {
    const account = mockAccount();
    const ctx = makeCtx({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      swapRes: makeSwapRes({
        tx: { to: SAMPLE_VAULT, value: "20000000", data: "", memo: "" },
      }) as any,
    });
    await expect(tronAdapter.execute(account, ctx)).rejects.toThrow(
      /neither `data` nor `memo`/,
    );
  });
});
