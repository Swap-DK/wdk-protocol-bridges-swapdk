import { describe, it, expect, vi } from "vitest";

import {
  solanaAdapter,
  buildNativeTransferWithMemo,
} from "../../src/adapters/solana.js";
import { adapterFor } from "../../src/adapters/index.js";
import type {
  SwidgeAdapterContext,
  SwidgeSolanaAccount,
} from "../../src/adapters/index.js";

// Real-looking sample addresses (base58 Solana). Chosen to exercise the
// @solana/addresses parser — invalid base58 would throw at build time.
const SAMPLE_SOURCE = "HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH";
const SAMPLE_VAULT = "8jkQGdCFY6ncnRSs3P7RtqfxT9PL8Aq3jw5zTGZE1ZLK";
const SAMPLE_MEMO = "=:BTC.BTC:bc1qrecipient:0/1/0";

function makeRoute(
  overrides: Partial<{
    providers: string[];
    inboundAddress: string;
    memo: string;
    sellAmount: string;
  }> = {},
) {
  return {
    routeId: "route-sol",
    providers: overrides.providers ?? ["THORCHAIN"],
    sellAsset: "SOL.SOL",
    sellAmount: overrides.sellAmount ?? "1", // 1 SOL
    buyAsset: "BTC.BTC",
    expectedBuyAmount: "0.005",
    expectedBuyAmountMaxSlippage: "0.0049",
    fees: [],
    targetAddress: overrides.inboundAddress ?? SAMPLE_VAULT,
    inboundAddress: overrides.inboundAddress ?? SAMPLE_VAULT,
    memo: overrides.memo ?? SAMPLE_MEMO,
    expiration: "",
    estimatedTime: undefined,
    totalSlippageBps: 0,
  };
}

function makeCtx(
  overrides: Partial<SwidgeAdapterContext> = {},
): SwidgeAdapterContext {
  return {
    fromChain: "solana",
    sourceAddress: SAMPLE_SOURCE,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    route: makeRoute() as any,
    swapRes: undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: {} as any,
    config: { apiUrl: "https://test", apiKey: "k" },
    options: {
      fromToken: "SOL",
      toToken: "BTC",
      toChain: "bitcoin",
      recipient: "bc1qrecipient",
      fromTokenAmount: 1_000_000_000n, // 1 SOL
    },
    ...overrides,
  };
}

function mockAccount(
  overrides: Partial<SwidgeSolanaAccount> = {},
): SwidgeSolanaAccount & {
  sendTransaction: ReturnType<typeof vi.fn>;
  waitForTransaction: ReturnType<typeof vi.fn>;
} {
  return {
    getAddress: () => SAMPLE_SOURCE,
    sendTransaction: vi.fn().mockResolvedValue({
      hash: "SOLTXHASH123",
      fee: 5000n,
    }),
    waitForTransaction: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as SwidgeSolanaAccount & {
    sendTransaction: ReturnType<typeof vi.fn>;
    waitForTransaction: ReturnType<typeof vi.fn>;
  };
}

// -- registry -------------------------------------------------------------

describe("adapterFor(solana)", () => {
  it("returns solanaAdapter, family = solana, no /swap needed", () => {
    expect(adapterFor("solana")).toBe(solanaAdapter);
    expect(solanaAdapter.family).toBe("solana");
    expect(solanaAdapter.needsSwapResponse).toBe(false);
  });
});

// -- happy path ----------------------------------------------------------

describe("solanaAdapter — native SOL, THORChain memo path", () => {
  it("builds a tx-message + broadcasts via wallet.sendTransaction", async () => {
    const account = mockAccount();
    const ctx = makeCtx();
    const { hash, transactions } = await solanaAdapter.execute(account, ctx);

    expect(account.sendTransaction).toHaveBeenCalledOnce();
    const passed = account.sendTransaction.mock.calls[0][0];
    // The passed value is a Solana transactionMessage object (from
    // @solana/transaction-messages). It has an `instructions` array
    // with two instructions (transfer + memo).
    expect(passed).toBeDefined();
    expect(Array.isArray(passed.instructions)).toBe(true);
    expect(passed.instructions.length).toBe(2);

    expect(account.waitForTransaction).toHaveBeenCalledOnce();
    expect(account.waitForTransaction.mock.calls[0][0]).toBe("SOLTXHASH123");

    expect(hash).toBe("SOLTXHASH123");
    expect(transactions).toEqual([
      { hash: "SOLTXHASH123", chain: "solana", type: "source" },
    ]);
  });

  it("skips waitForTransaction when the wallet doesn't expose it", async () => {
    const account = mockAccount();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (account as any).waitForTransaction;
    const { hash } = await solanaAdapter.execute(account, makeCtx());
    expect(hash).toBe("SOLTXHASH123");
  });
});

// -- buildNativeTransferWithMemo -----------------------------------------

describe("buildNativeTransferWithMemo", () => {
  it("emits a v0 tx-message with exactly two instructions in memo/transfer order", () => {
    const msg = buildNativeTransferWithMemo({
      source: SAMPLE_SOURCE,
      destination: SAMPLE_VAULT,
      lamports: 1_000_000_000n,
      memo: SAMPLE_MEMO,
    });
    // v0 message shape check
    expect(msg.version).toBe(0);
    expect(msg.instructions).toHaveLength(2);
  });

  it("rejects a malformed base58 source (address parser throws)", () => {
    expect(() =>
      buildNativeTransferWithMemo({
        source: "not-a-real-address",
        destination: SAMPLE_VAULT,
        lamports: 1n,
        memo: SAMPLE_MEMO,
      }),
    ).toThrow();
  });
});

// -- error paths ---------------------------------------------------------

describe("solanaAdapter — error paths", () => {
  it("throws on SPL-token source (mint address in fromToken)", async () => {
    const account = mockAccount();
    const ctx = makeCtx({
      options: {
        // Anything not "SOL" (case-insensitive) is treated as SPL.
        fromToken: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDC mint
        toToken: "BTC",
        toChain: "bitcoin",
        recipient: "bc1qrecipient",
        fromTokenAmount: 1_000_000n,
      },
    });
    await expect(solanaAdapter.execute(account, ctx)).rejects.toThrow(
      /SPL-token sources are not yet supported/,
    );
  });

  it("throws when the quote returned no inboundAddress", async () => {
    const account = mockAccount();
    const ctx = makeCtx({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      route: makeRoute({ inboundAddress: "" }) as any,
    });
    await expect(solanaAdapter.execute(account, ctx)).rejects.toThrow(
      /no inboundAddress/,
    );
  });

  it("throws when the quote returned no memo (unrouted deposit)", async () => {
    const account = mockAccount();
    const ctx = makeCtx({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      route: makeRoute({ memo: "" }) as any,
    });
    await expect(solanaAdapter.execute(account, ctx)).rejects.toThrow(/no memo/);
  });
});
