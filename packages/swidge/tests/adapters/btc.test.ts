import { describe, it, expect, vi } from "vitest";

import { btcAdapter } from "../../src/adapters/btc.js";
import { adapterFor } from "../../src/adapters/index.js";
import type {
  SwidgeAdapterContext,
  SwidgeBtcAccount,
} from "../../src/adapters/index.js";

// Minimal QuoteRoute fixture. Only fields the BTC adapter reads are
// populated; anything else is left off to keep tests readable.
function makeRoute(
  overrides: Partial<{
    providers: string[];
    inboundAddress: string;
    memo: string;
    sellAmount: string;
    buyAmount: string;
    sellAsset: string;
    buyAsset: string;
    expiration: string;
    fees: Array<{ type: string; amount: string; asset: string }>;
  }> = {},
) {
  return {
    routeId: "route-1",
    providers: overrides.providers ?? ["THORCHAIN"],
    sellAsset: overrides.sellAsset ?? "BTC.BTC",
    sellAmount: overrides.sellAmount ?? "0.01",
    buyAsset: overrides.buyAsset ?? "ETH.ETH",
    expectedBuyAmount: "0.3",
    expectedBuyAmountMaxSlippage: "0.29",
    fees: overrides.fees ?? [],
    targetAddress: overrides.inboundAddress ?? "bc1qVault",
    inboundAddress: overrides.inboundAddress ?? "bc1qVault",
    memo: overrides.memo ?? "=:ETH.ETH:0xRecipient:0/1/0",
    expiration: overrides.expiration ?? "",
    estimatedTime: undefined,
    totalSlippageBps: 0,
  };
}

function makeCtx(
  overrides: Partial<SwidgeAdapterContext> = {},
): SwidgeAdapterContext {
  return {
    fromChain: "bitcoin",
    sourceAddress: "bc1qSource",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    route: makeRoute() as any,
    swapRes: undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: { openBrokerChannel: vi.fn() } as any,
    config: { apiUrl: "https://test", apiKey: "k" },
    options: {
      fromToken: "BTC",
      toToken: "ETH",
      toChain: "ethereum",
      recipient: "0xRecipient",
      fromTokenAmount: 1_000_000n, // 0.01 BTC
    },
    ...overrides,
  };
}

function mockAccount(
  overrides: Partial<SwidgeBtcAccount> = {},
): SwidgeBtcAccount & {
  sendTransaction: ReturnType<typeof vi.fn>;
} {
  return {
    getAddress: () => "bc1qSource",
    sendTransaction: vi.fn().mockResolvedValue({
      hash: "BTCTXHASH123",
      fee: 500n,
    }),
    ...overrides,
  } as SwidgeBtcAccount & { sendTransaction: ReturnType<typeof vi.fn> };
}

// -- registry -------------------------------------------------------------

describe("adapterFor(bitcoin)", () => {
  it("returns btcAdapter and declares family + no-/swap", () => {
    expect(adapterFor("bitcoin")).toBe(btcAdapter);
    expect(btcAdapter.family).toBe("bitcoin");
    expect(btcAdapter.needsSwapResponse).toBe(false);
  });
});

// -- THORChain path ------------------------------------------------------

describe("btcAdapter — THORChain / MAYAChain path", () => {
  it("sends a single tx with the vault address, value in sats, and memo as OP_RETURN", async () => {
    const account = mockAccount();
    const ctx = makeCtx();
    const { hash, transactions } = await btcAdapter.execute(account, ctx);

    expect(account.sendTransaction).toHaveBeenCalledOnce();
    const arg = account.sendTransaction.mock.calls[0][0];
    expect(arg.to).toBe("bc1qVault");
    expect(arg.value).toBe(1_000_000n); // 0.01 BTC → 1,000,000 sats
    expect(arg.memo).toBe("=:ETH.ETH:0xRecipient:0/1/0");

    expect(hash).toBe("BTCTXHASH123");
    expect(transactions).toEqual([
      { hash: "BTCTXHASH123", chain: "bitcoin", type: "source" },
    ]);
  });

  it("threads config.feeRate through to sendTransaction", async () => {
    const account = mockAccount();
    const ctx = makeCtx({
      config: { apiUrl: "https://test", apiKey: "k", feeRate: 15n },
    });
    await btcAdapter.execute(account, ctx);
    expect(account.sendTransaction.mock.calls[0][0].feeRate).toBe(15n);
  });

  it("routes MAYACHAIN provider through the THORChain branch", async () => {
    const account = mockAccount();
    const ctx = makeCtx({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      route: makeRoute({ providers: ["MAYACHAIN"] }) as any,
    });
    await btcAdapter.execute(account, ctx);
    // MAYA memo shape same as THOR — call goes through with memo set.
    expect(account.sendTransaction.mock.calls[0][0].memo).toBeDefined();
  });

  it("throws when the quote has no inboundAddress", async () => {
    const account = mockAccount();
    const ctx = makeCtx({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      route: makeRoute({ inboundAddress: "" }) as any,
    });
    await expect(btcAdapter.execute(account, ctx)).rejects.toThrow(
      /no inboundAddress/,
    );
  });

  it("throws when the quote has no memo (unrouted THORChain deposit refunds)", async () => {
    const account = mockAccount();
    const ctx = makeCtx({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      route: makeRoute({ memo: "" }) as any,
    });
    await expect(btcAdapter.execute(account, ctx)).rejects.toThrow(/no memo/);
  });

  it("throws when the quoted vault has expired", async () => {
    const account = mockAccount();
    const pastEpochSec = String(Math.floor(Date.now() / 1000) - 60);
    const ctx = makeCtx({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      route: makeRoute({ expiration: pastEpochSec }) as any,
    });
    await expect(btcAdapter.execute(account, ctx)).rejects.toThrow(/expired/);
  });
});

// -- Chainflip path ------------------------------------------------------

describe("btcAdapter — Chainflip path", () => {
  function makeChainflipCtx(
    overrides: Partial<SwidgeAdapterContext> = {},
  ): SwidgeAdapterContext {
    return makeCtx({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      route: makeRoute({
        providers: ["CHAINFLIP"],
        sellAsset: "BTC.BTC",
        buyAsset: "ETH.ETH",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
      client: {
        openBrokerChannel: vi.fn().mockResolvedValue({
          depositAddress: "bc1qBrokerDeposit",
          channelId: "6739624-Bitcoin-2562",
          explorerUrl: "",
          error: "",
        }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      ...overrides,
    });
  }

  it("opens a broker channel, then sends BTC to its deposit address with no memo", async () => {
    const account = mockAccount();
    const ctx = makeChainflipCtx();
    const { hash, transactions } = await btcAdapter.execute(account, ctx);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const openBrokerChannel = (ctx.client as any).openBrokerChannel;
    expect(openBrokerChannel).toHaveBeenCalledOnce();
    const req = openBrokerChannel.mock.calls[0][0];
    expect(req.sellAsset).toEqual({ chain: "Bitcoin", asset: "BTC" });
    expect(req.buyAsset).toEqual({ chain: "Ethereum", asset: "ETH" });
    expect(req.destinationAddress).toBe("0xRecipient");
    expect(req.sellAmount).toBe("0.01"); // human-decimal passthrough
    expect(req.refundParameters.refundAddress).toBe("bc1qSource"); // default = sourceAddress

    expect(account.sendTransaction).toHaveBeenCalledOnce();
    const tx = account.sendTransaction.mock.calls[0][0];
    expect(tx.to).toBe("bc1qBrokerDeposit");
    expect(tx.value).toBe(1_000_000n);
    expect(tx.memo).toBeUndefined();

    expect(hash).toBe("BTCTXHASH123");
    expect(transactions).toEqual([
      { hash: "BTCTXHASH123", chain: "bitcoin", type: "source" },
    ]);
  });

  it("honours options.refundAddress when provided", async () => {
    const account = mockAccount();
    const ctx = makeChainflipCtx({
      options: {
        fromToken: "BTC",
        toToken: "ETH",
        toChain: "ethereum",
        recipient: "0xRecipient",
        refundAddress: "bc1qCustomRefund",
        fromTokenAmount: 1_000_000n,
      },
    });
    await btcAdapter.execute(account, ctx);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const openBrokerChannel = (ctx.client as any).openBrokerChannel;
    const req = openBrokerChannel.mock.calls[0][0];
    expect(req.refundParameters.refundAddress).toBe("bc1qCustomRefund");
  });

  it("requires options.recipient (Chainflip encodes destination in the channel)", async () => {
    const account = mockAccount();
    const ctx = makeChainflipCtx({
      options: {
        fromToken: "BTC",
        toToken: "ETH",
        toChain: "ethereum",
        fromTokenAmount: 1_000_000n,
        // no recipient
      },
    });
    await expect(btcAdapter.execute(account, ctx)).rejects.toThrow(
      /recipient is required/,
    );
  });

  it("rejects DCA config missing chunk interval", async () => {
    const account = mockAccount();
    const ctx = makeChainflipCtx({
      config: {
        apiUrl: "https://test",
        apiKey: "k",
        chainflip: { dcaChunks: 4 },
      },
    });
    await expect(btcAdapter.execute(account, ctx)).rejects.toThrow(
      /dcaChunkInterval is required/,
    );
  });

  it("wires DCA + boost params when both are set", async () => {
    const account = mockAccount();
    const ctx = makeChainflipCtx({
      config: {
        apiUrl: "https://test",
        apiKey: "k",
        chainflip: {
          dcaChunks: 4,
          dcaChunkInterval: 8,
          maxBoostFeeBps: 20,
        },
      },
    });
    await btcAdapter.execute(account, ctx);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req = (ctx.client as any).openBrokerChannel.mock.calls[0][0];
    expect(req.dcaParameters).toEqual({ chunkInterval: 8, numberOfChunks: 4 });
    expect(req.maxBoostFeeBps).toBe(20);
  });
});

// -- unsupported provider ------------------------------------------------

describe("btcAdapter — unsupported provider", () => {
  it("throws when the route has neither a THOR/MAYA nor CHAINFLIP provider", async () => {
    const account = mockAccount();
    const ctx = makeCtx({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      route: makeRoute({ providers: ["UNSUPPORTED"] }) as any,
    });
    await expect(btcAdapter.execute(account, ctx)).rejects.toThrow(
      /unsupported provider/i,
    );
  });
});
