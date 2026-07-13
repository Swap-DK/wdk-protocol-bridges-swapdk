import { describe, it, expect, vi } from "vitest";

import { evmAdapter } from "../../src/adapters/evm.js";
import { adapterFor } from "../../src/adapters/index.js";
import type {
  SwidgeAdapterContext,
  SwidgeEvmAccount,
} from "../../src/adapters/index.js";

// Minimal swap-engine /swap response for the two branches the EVM
// adapter cares about. Field names match packages/swap-engine-client's
// SwapResponseSchema.
function makeSwapRes(
  overrides: Partial<{
    tx: { to: string; data?: string; value?: string; gas?: string };
    approvalTx: { to: string; data: string; value?: string; gasLimit?: string };
  }> = {},
) {
  return {
    sellAsset: "ETH.ETH",
    sellAmount: "1",
    buyAsset: "BTC.BTC",
    buyAmount: "0.05",
    routeId: "route-1",
    providers: ["THORCHAIN"],
    targetAddress: "0xVault",
    inboundAddress: "0xVault",
    memo: "",
    fees: [],
    tx: overrides.tx ?? {
      to: "0xRouter",
      data: "0xdeadbeef",
      value: "1000000000000000000",
      gas: "200000",
    },
    ...(overrides.approvalTx ? { approvalTx: overrides.approvalTx } : {}),
  };
}

function makeCtx(
  overrides: Partial<SwidgeAdapterContext> = {},
): SwidgeAdapterContext {
  return {
    fromChain: "ethereum",
    sourceAddress: "0xSource",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    route: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    swapRes: makeSwapRes() as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: {} as any,
    config: { apiUrl: "https://test", apiKey: "k" },
    options: {
      fromToken: "ETH",
      toToken: "BTC",
      toChain: "bitcoin",
      recipient: "bc1qxxxxxxxx",
      fromTokenAmount: 10n ** 18n,
    },
    ...overrides,
  };
}

function mockAccount(
  overrides: Partial<SwidgeEvmAccount> = {},
): SwidgeEvmAccount & {
  sendTransaction: ReturnType<typeof vi.fn>;
  waitForTransaction: ReturnType<typeof vi.fn>;
} {
  return {
    sendTransaction: vi.fn().mockResolvedValue({ hash: "0xMainHash" }),
    waitForTransaction: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as SwidgeEvmAccount & {
    sendTransaction: ReturnType<typeof vi.fn>;
    waitForTransaction: ReturnType<typeof vi.fn>;
  };
}

describe("adapterFor", () => {
  it("returns evmAdapter for every EVM swidge chain", () => {
    for (const id of ["ethereum", "arbitrum", "base", "bsc", "avalanche"]) {
      expect(adapterFor(id)).toBe(evmAdapter);
    }
  });

  it("throws for chain ids not registered in chain-map", () => {
    // All five families are now wired. The registry can still surface
    // an "unknown source chain" error for chain ids we haven't added
    // to chain-map (mars, sui, etc.).
    expect(() => adapterFor("mars")).toThrow(/unknown source chain/);
  });

  it("throws on an unknown chain id", () => {
    expect(() => adapterFor("mars")).toThrow(/unknown source chain/);
  });
});

describe("evmAdapter — native source (no approval)", () => {
  it("sends a single tx and returns its hash", async () => {
    const account = mockAccount();
    const { hash, transactions } = await evmAdapter.execute(account, makeCtx());

    expect(account.sendTransaction).toHaveBeenCalledOnce();
    const arg = account.sendTransaction.mock.calls[0][0];
    expect(arg.to).toBe("0xRouter");
    expect(arg.data).toBe("0xdeadbeef");
    expect(arg.value).toBe(1_000_000_000_000_000_000n);
    expect(arg.gas).toBe(200_000n);

    expect(hash).toBe("0xMainHash");
    expect(transactions).toEqual([
      { hash: "0xMainHash", chain: "ethereum", type: "source" },
    ]);
  });

  it("does NOT call waitForTransaction on the source tx", async () => {
    const account = mockAccount();
    await evmAdapter.execute(account, makeCtx());
    expect(account.waitForTransaction).not.toHaveBeenCalled();
  });

  it("accepts a raw hex-string return from sendTransaction", async () => {
    const account = mockAccount({
      sendTransaction: vi.fn().mockResolvedValue("0xRawHex"),
    });
    const { hash } = await evmAdapter.execute(account, makeCtx());
    expect(hash).toBe("0xRawHex");
  });
});

describe("evmAdapter — ERC-20 source (with approval)", () => {
  it("sends approval first, waits, then sends bridge tx", async () => {
    const account = mockAccount({
      sendTransaction: vi
        .fn()
        .mockResolvedValueOnce({ hash: "0xApproveHash" })
        .mockResolvedValueOnce({ hash: "0xBridgeHash" }),
    });
    const ctx = makeCtx({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      swapRes: makeSwapRes({
        approvalTx: {
          to: "0xUSDC",
          data: "0xapproveCall",
          value: "0",
          gasLimit: "60000",
        },
        tx: { to: "0xRouter", data: "0xdeposit", value: "0", gas: "300000" },
      }) as any,
    });

    const { hash, transactions } = await evmAdapter.execute(account, ctx);

    expect(account.sendTransaction).toHaveBeenCalledTimes(2);
    const [approve, main] = account.sendTransaction.mock.calls.map((c) => c[0]);
    expect(approve.to).toBe("0xUSDC");
    expect(approve.data).toBe("0xapproveCall");
    expect(approve.value).toBe(0n);
    expect(approve.gas).toBe(60_000n);

    expect(main.to).toBe("0xRouter");
    expect(main.value).toBe(0n);

    expect(account.waitForTransaction).toHaveBeenCalledOnce();
    expect(account.waitForTransaction.mock.calls[0][0]).toBe("0xApproveHash");

    expect(hash).toBe("0xBridgeHash");
    expect(transactions).toEqual([
      { hash: "0xApproveHash", chain: "ethereum", type: "approval" },
      { hash: "0xBridgeHash", chain: "ethereum", type: "source" },
    ]);
  });

  it("skips waitForTransaction gracefully when the account doesn't expose it", async () => {
    const account = mockAccount({
      sendTransaction: vi
        .fn()
        .mockResolvedValueOnce({ hash: "0xApproveHash" })
        .mockResolvedValueOnce({ hash: "0xBridgeHash" }),
      // undefined waitForTransaction
      waitForTransaction: undefined,
    });
    // Rewire to actually drop waitForTransaction from the mocked shape.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (account as any).waitForTransaction;

    const ctx = makeCtx({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      swapRes: makeSwapRes({
        approvalTx: { to: "0xUSDC", data: "0xa9059cbb", value: "0" },
      }) as any,
    });

    const { hash } = await evmAdapter.execute(account, ctx);
    expect(hash).toBe("0xBridgeHash");
    expect(account.sendTransaction).toHaveBeenCalledTimes(2);
  });
});

describe("evmAdapter — error paths", () => {
  it("throws when swap-engine returns no tx data", async () => {
    const account = mockAccount();
    const ctx = makeCtx({
      swapRes: {
        ...makeSwapRes(),
        tx: undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    });
    await expect(evmAdapter.execute(account, ctx)).rejects.toThrow(
      /no transaction data/,
    );
  });
});
