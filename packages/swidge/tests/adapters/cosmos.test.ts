import { describe, it, expect, vi } from "vitest";

import { cosmosAdapter } from "../../src/adapters/cosmos.js";
import { adapterFor } from "../../src/adapters/index.js";
import type {
  SwidgeAdapterContext,
  SwidgeCosmosAccount,
} from "../../src/adapters/index.js";

const SAMPLE_MEMO = "=:BTC.BTC:bc1qrecipient:0/1/0";
const SAMPLE_SOURCE_ADDR = "thor1sourcexxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const SAMPLE_VAULT = "maya1vaultxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

function makeSwapRes(
  overrides: Partial<{
    memo: string;
    inboundAddress: string;
    targetAddress: string;
    sellAsset: string;
    sellAmount: string;
    providers: string[];
  }> = {},
) {
  return {
    sellAsset: overrides.sellAsset ?? "THOR.RUNE",
    sellAmount: overrides.sellAmount ?? "10",
    buyAsset: "BTC.BTC",
    buyAmount: "0.001",
    routeId: "route-1",
    providers: overrides.providers ?? ["THORCHAIN"],
    targetAddress: overrides.targetAddress ?? "",
    inboundAddress: overrides.inboundAddress ?? "",
    memo: overrides.memo ?? SAMPLE_MEMO,
    fees: [],
    tx: undefined,
  };
}

function makeCtx(
  overrides: Partial<SwidgeAdapterContext> = {},
): SwidgeAdapterContext {
  return {
    fromChain: "thorchain",
    sourceAddress: SAMPLE_SOURCE_ADDR,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    route: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    swapRes: makeSwapRes() as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: {} as any,
    config: { apiUrl: "https://test", apiKey: "k" },
    options: {
      fromToken: "RUNE",
      toToken: "BTC",
      toChain: "bitcoin",
      recipient: "bc1qrecipient",
      fromTokenAmount: 10_00000000n,
    },
    ...overrides,
  };
}

function mockAccount(
  overrides: Partial<SwidgeCosmosAccount> = {},
): SwidgeCosmosAccount & {
  deposit: ReturnType<typeof vi.fn>;
  transfer: ReturnType<typeof vi.fn>;
} {
  return {
    getAddress: () => SAMPLE_SOURCE_ADDR,
    deposit: vi.fn().mockResolvedValue({ hash: "COSMOSDEPHASH", fee: 1_000n }),
    transfer: vi.fn().mockResolvedValue({ hash: "COSMOSSENDHASH", fee: 2_000n }),
    ...overrides,
  } as SwidgeCosmosAccount & {
    deposit: ReturnType<typeof vi.fn>;
    transfer: ReturnType<typeof vi.fn>;
  };
}

// -- registry -------------------------------------------------------------

describe("adapterFor(thorchain / mayachain)", () => {
  it("returns cosmosAdapter for both cosmos-family swidge chains", () => {
    expect(adapterFor("thorchain")).toBe(cosmosAdapter);
    expect(adapterFor("mayachain")).toBe(cosmosAdapter);
    expect(cosmosAdapter.family).toBe("cosmos");
    expect(cosmosAdapter.needsSwapResponse).toBe(true);
  });
});

// -- MsgDeposit path (protocol-native) -----------------------------------

describe("cosmosAdapter — MsgDeposit path", () => {
  it("routes empty inboundAddress through wallet.deposit()", async () => {
    const account = mockAccount();
    const ctx = makeCtx();
    const { hash, transactions } = await cosmosAdapter.execute(account, ctx);

    expect(account.deposit).toHaveBeenCalledOnce();
    const arg = account.deposit.mock.calls[0][0];
    expect(arg.asset).toBe("THOR.RUNE");
    expect(arg.amount).toBe("10"); // human-decimal passthrough
    expect(arg.memo).toBe(SAMPLE_MEMO);

    expect(account.transfer).not.toHaveBeenCalled();
    expect(hash).toBe("COSMOSDEPHASH");
    expect(transactions).toEqual([
      { hash: "COSMOSDEPHASH", chain: "thorchain", type: "source" },
    ]);
  });

  it("treats inboundAddress == sourceAddress as protocol-native (MsgDeposit)", async () => {
    const account = mockAccount();
    const ctx = makeCtx({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      swapRes: makeSwapRes({ inboundAddress: SAMPLE_SOURCE_ADDR }) as any,
    });
    await cosmosAdapter.execute(account, ctx);
    expect(account.deposit).toHaveBeenCalledOnce();
    expect(account.transfer).not.toHaveBeenCalled();
  });

  it("trims surrounding whitespace on inboundAddress before comparison", async () => {
    const account = mockAccount();
    const ctx = makeCtx({
      swapRes: makeSwapRes({
        inboundAddress: `  ${SAMPLE_SOURCE_ADDR}  `,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
    });
    await cosmosAdapter.execute(account, ctx);
    expect(account.deposit).toHaveBeenCalledOnce();
  });
});

// -- MsgSend path (cross-protocol) ---------------------------------------

describe("cosmosAdapter — MsgSend path", () => {
  it("routes non-source inboundAddress through wallet.transfer() with the native denom", async () => {
    const account = mockAccount();
    const ctx = makeCtx({
      fromChain: "mayachain",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      swapRes: makeSwapRes({
        sellAsset: "MAYA.CACAO",
        inboundAddress: SAMPLE_VAULT,
      }) as any,
    });
    const { hash, transactions } = await cosmosAdapter.execute(account, ctx);

    expect(account.transfer).toHaveBeenCalledOnce();
    const arg = account.transfer.mock.calls[0][0];
    expect(arg.token).toBe("cacao");
    expect(arg.recipient).toBe(SAMPLE_VAULT);
    expect(arg.amount).toBe("10");
    expect(arg.memo).toBe(SAMPLE_MEMO);

    expect(account.deposit).not.toHaveBeenCalled();
    expect(hash).toBe("COSMOSSENDHASH");
    expect(transactions).toEqual([
      { hash: "COSMOSSENDHASH", chain: "mayachain", type: "source" },
    ]);
  });

  it("uses 'rune' as native denom for a thorchain source doing MsgSend", async () => {
    const account = mockAccount();
    const ctx = makeCtx({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      swapRes: makeSwapRes({ inboundAddress: SAMPLE_VAULT }) as any,
    });
    await cosmosAdapter.execute(account, ctx);
    expect(account.transfer.mock.calls[0][0].token).toBe("rune");
  });

  it("treats empty inboundAddress AND empty targetAddress as MsgDeposit", async () => {
    // detectInboundVault uses nullish coalescing on both fields — swap-engine
    // populates them as strings (never null/undefined), so a route with both
    // empty means "protocol-native, route through user's own account".
    const account = mockAccount();
    const ctx = makeCtx({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      swapRes: makeSwapRes({ inboundAddress: "", targetAddress: "" }) as any,
    });
    await cosmosAdapter.execute(account, ctx);
    expect(account.deposit).toHaveBeenCalledOnce();
    expect(account.transfer).not.toHaveBeenCalled();
  });

  it("throws for an unsupported cosmos-family source when MsgSend is required", async () => {
    const account = mockAccount();
    const ctx = makeCtx({
      fromChain: "cosmoshub", // not in NATIVE_DENOM_FOR_CHAIN
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      swapRes: makeSwapRes({ inboundAddress: SAMPLE_VAULT }) as any,
    });
    await expect(cosmosAdapter.execute(account, ctx)).rejects.toThrow(
      /unsupported source chain "cosmoshub"/i,
    );
  });
});

// -- error paths ---------------------------------------------------------

describe("cosmosAdapter — error paths", () => {
  it("throws when swap-engine returned no memo (deposit would be lost)", async () => {
    const account = mockAccount();
    const ctx = makeCtx({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      swapRes: makeSwapRes({ memo: "" }) as any,
    });
    await expect(cosmosAdapter.execute(account, ctx)).rejects.toThrow(
      /no routing memo/,
    );
  });

  it("throws when swap-engine returned no response at all", async () => {
    const account = mockAccount();
    const ctx = makeCtx({ swapRes: undefined });
    await expect(cosmosAdapter.execute(account, ctx)).rejects.toThrow(
      /missing \/swap response/,
    );
  });
});
