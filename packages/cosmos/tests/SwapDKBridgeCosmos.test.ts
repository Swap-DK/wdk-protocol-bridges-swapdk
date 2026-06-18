import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SwapDKBridgeCosmos } from "../src/SwapDKBridgeCosmos.js";
import { BridgeProtocol } from "@tetherto/wdk-wallet/protocols";
import {
  SwapDKUserError,
  SwapDKApiError,
} from "@swapdk/swap-engine-client";
import type {
  CosmosWalletAccount,
  SwapDKBridgeConfig,
} from "../src/types.js";

// --- Helpers ----------------------------------------------------------------

function createMockAccount(
  address = "thor1senderaddressxxxxxxxxxxxxxxxxxxxxxxxxx",
): CosmosWalletAccount & {
  deposit: ReturnType<typeof vi.fn>;
  transfer: ReturnType<typeof vi.fn>;
} {
  return {
    getAddress: () => address,
    deposit: vi.fn().mockResolvedValue({
      hash: "DEPOSITHASH123",
      fee: 2000000n, // 0.02 RUNE in base units
    }),
    transfer: vi.fn().mockResolvedValue({
      hash: "TRANSFERHASH456",
      fee: 2000000n,
    }),
  };
}

const defaultConfig: SwapDKBridgeConfig = {
  apiUrl: "https://api.swapdk.test",
  apiKey: "test-key",
  retries: 0, // disable retries so a single 5xx surfaces directly
};

// Fixtures mirror the real swap-engine contract: amounts are human-decimal
// strings; for cosmos source the route omits `tx` (no client-side calldata).
// Bridge: 1 RUNE → 0.0001 BTC.
function makeQuoteResponse(overrides: Record<string, unknown> = {}) {
  return {
    quoteId: "q1",
    routes: [
      {
        routeId: "r1",
        providers: ["THORCHAIN"],
        sellAsset: "THOR.RUNE",
        sellAmount: "1",
        buyAsset: "BTC.BTC",
        expectedBuyAmount: "0.0001",
        expectedBuyAmountMaxSlippage: "0.000097",
        memo: "=:BTC.BTC:bc1qrecipient:0/1/0",
        fees: [
          { type: "liquidity", amount: "0.02", asset: "THOR.RUNE" },
          { type: "outbound", amount: "0.000005", asset: "BTC.BTC" },
        ],
        estimatedTime: { inbound: 30, swap: 60, outbound: 600, total: 690 },
        totalSlippageBps: 300,
        ...overrides,
      },
    ],
  };
}

// MsgDeposit-style /swap response — THORCHAIN routes return no
// inboundAddress (deposit goes to user's own balance). The targetAddress
// field is also empty for cosmos sources on MsgDeposit per swap-engine.
function makeSwapResponse(overrides: Record<string, unknown> = {}) {
  return {
    sellAsset: "THOR.RUNE",
    sellAmount: "1",
    buyAsset: "BTC.BTC",
    buyAmount: "0.0001",
    routeId: "r1",
    providers: ["THORCHAIN"],
    targetAddress: "",
    memo: "=:BTC.BTC:bc1qrecipient:0/1/0",
    fees: [
      { type: "liquidity", amount: "0.02", asset: "THOR.RUNE" },
    ],
    ...overrides,
  };
}

// MsgSend-style /swap response — MAYACHAIN-routed RUNE→BTC returns
// inboundAddress and targetAddress both set to the inbound vault on
// the source chain, with the swap memo for the protocol to observe.
function makeMayaSendSwapResponse(overrides: Record<string, unknown> = {}) {
  const vault = "thor12qm45uyzg5kk3aw3s5jzew7gkelvg7pdsw9kzg";
  return {
    sellAsset: "THOR.RUNE",
    sellAmount: "100",
    buyAsset: "BTC.BTC",
    buyAmount: "0.00108",
    routeId: "r1",
    providers: ["MAYACHAIN"],
    targetAddress: vault,
    inboundAddress: vault,
    memo: "=:b:bc1qrecipient:104839:sdk/sdk:0/5",
    fees: [
      { type: "liquidity", amount: "8.45", asset: "BTC.BTC" },
      { type: "inbound", amount: "0.02", asset: "THOR.RUNE" },
    ],
    ...overrides,
  };
}

// MAYACHAIN-routed quote that pairs with makeMayaSendSwapResponse.
function makeMayaQuoteResponse(overrides: Record<string, unknown> = {}) {
  return {
    quoteId: "q-maya",
    routes: [
      {
        routeId: "r1",
        providers: ["MAYACHAIN"],
        sellAsset: "THOR.RUNE",
        sellAmount: "100",
        buyAsset: "BTC.BTC",
        expectedBuyAmount: "0.00108",
        expectedBuyAmountMaxSlippage: "0.00104",
        memo: "=:b:bc1qrecipient:104839:sdk/sdk:0/5",
        targetAddress: "thor12qm45uyzg5kk3aw3s5jzew7gkelvg7pdsw9kzg",
        inboundAddress: "thor12qm45uyzg5kk3aw3s5jzew7gkelvg7pdsw9kzg",
        fees: [
          { type: "liquidity", amount: "8.45", asset: "BTC.BTC" },
          { type: "inbound", amount: "0.02", asset: "THOR.RUNE" },
        ],
        estimatedTime: { inbound: 30, swap: 6, outbound: 600, total: 636 },
        totalSlippageBps: 0,
        ...overrides,
      },
    ],
  };
}

// --- Tests ------------------------------------------------------------------

describe("SwapDKBridgeCosmos", () => {
  let account: ReturnType<typeof createMockAccount>;
  let bridge: SwapDKBridgeCosmos;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    account = createMockAccount();
    bridge = new SwapDKBridgeCosmos(account, defaultConfig);
    bridge.setSourceChain("thorchain");

    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetchResponses(...responses: unknown[]) {
    for (const body of responses) {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(JSON.stringify(body)),
      });
    }
  }

  // -- WDK contract compliance -----------------------------------------------

  describe("WDK contract", () => {
    it("extends BridgeProtocol from @tetherto/wdk-wallet", () => {
      expect(bridge).toBeInstanceOf(BridgeProtocol);
    });

    it("exposes bridge() and quoteBridge()", () => {
      expect(typeof bridge.bridge).toBe("function");
      expect(typeof bridge.quoteBridge).toBe("function");
    });
  });

  // -- setSourceChain ---------------------------------------------------------

  describe("setSourceChain", () => {
    it("accepts thorchain and mayachain", () => {
      expect(() => bridge.setSourceChain("thorchain")).not.toThrow();
      expect(() => bridge.setSourceChain("mayachain")).not.toThrow();
    });

    it("is case-insensitive", () => {
      expect(() => bridge.setSourceChain("THORCHAIN")).not.toThrow();
      expect(() => bridge.setSourceChain("MayaChain")).not.toThrow();
    });

    it("rejects unsupported chains", () => {
      expect(() => bridge.setSourceChain("ethereum")).toThrow(SwapDKUserError);
      expect(() => bridge.setSourceChain("cosmoshub")).toThrow(/Unsupported/);
    });
  });

  // -- quoteBridge -----------------------------------------------------------

  describe("quoteBridge", () => {
    it("returns a quote for THOR.RUNE → BTC.BTC", async () => {
      stubFetchResponses(makeQuoteResponse());

      const result = await bridge.quoteBridge({
        token: "native",
        targetChain: "bitcoin",
        amount: 100000000n, // 1 RUNE = 1e8 base units
        recipient: "bc1qrecipient",
      });

      // 1 RUNE → 100_000_000n in 8 decimals
      expect(result.tokenInAmount).toBe(100000000n);
      // 0.0001 BTC → 10_000n in 8 decimals
      expect(result.tokenOutAmount).toBe(10000n);
      expect(result.providers).toEqual(["THORCHAIN"]);
      expect(result.estimatedTime).toBe(690);
      // No source tx gas — fee on the route is 0n.
      expect(result.fee).toBe(0n);
      // bridgeFee from "liquidity" entry: 0.02 RUNE → 2_000_000n
      expect(result.bridgeFee).toBe(2000000n);
    });

    it("forwards the SwapKit form when token is given as 'THOR.RUNE'", async () => {
      stubFetchResponses(makeQuoteResponse());

      await bridge.quoteBridge({
        token: "THOR.RUNE",
        targetChain: "bitcoin",
        amount: 100000000n,
        recipient: "bc1qrecipient",
      });

      const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(requestBody.sellAsset).toBe("THOR.RUNE");
      expect(requestBody.buyAsset).toBe("BTC.BTC");
      expect(requestBody.sellAmount).toBe("1"); // 1e8 base → "1" human
    });

    it("uses CACAO decimals (10) when source is mayachain", async () => {
      bridge.setSourceChain("mayachain");
      stubFetchResponses(
        makeQuoteResponse({ sellAsset: "MAYA.CACAO", sellAmount: "1.5" }),
      );

      await bridge.quoteBridge({
        token: "native",
        targetChain: "bitcoin",
        amount: 15000000000n, // 1.5 CACAO = 1.5e10 base units
        recipient: "bc1qrecipient",
      });

      const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(requestBody.sellAsset).toBe("MAYA.CACAO");
      expect(requestBody.sellAmount).toBe("1.5");
    });

    it("throws when amount is missing", async () => {
      await expect(
        bridge.quoteBridge({
          token: "native",
          targetChain: "bitcoin",
          recipient: "bc1qrecipient",
        } as never),
      ).rejects.toThrow(/amount is required/);
    });
  });

  // -- bridge ----------------------------------------------------------------

  describe("bridge", () => {
    it("calls walletAccount.deposit() with the memo from /swap", async () => {
      stubFetchResponses(makeQuoteResponse(), makeSwapResponse());

      const result = await bridge.bridge({
        token: "native",
        targetChain: "bitcoin",
        amount: 100000000n,
        recipient: "bc1qrecipient",
      });

      expect(account.deposit).toHaveBeenCalledTimes(1);
      const depositArgs = account.deposit.mock.calls[0][0];
      expect(depositArgs).toEqual({
        asset: "THOR.RUNE",
        amount: 100000000n,
        memo: "=:BTC.BTC:bc1qrecipient:0/1/0",
      });

      expect(result.hash).toBe("DEPOSITHASH123");
      expect(result.fee).toBe(2000000n);
      expect(result.tokenInAmount).toBe(100000000n);
      expect(result.tokenOutAmount).toBe(10000n);
    });

    it("hits /quote then /swap (in that order, both POST)", async () => {
      stubFetchResponses(makeQuoteResponse(), makeSwapResponse());

      await bridge.bridge({
        token: "native",
        targetChain: "bitcoin",
        amount: 100000000n,
        recipient: "bc1qrecipient",
      });

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(fetchSpy.mock.calls[0][0]).toContain("/quote");
      expect(fetchSpy.mock.calls[1][0]).toContain("/swap");
      expect(fetchSpy.mock.calls[0][1].method).toBe("POST");
      expect(fetchSpy.mock.calls[1][1].method).toBe("POST");
    });

    it("throws when /swap returns no memo (would risk funds loss)", async () => {
      stubFetchResponses(
        makeQuoteResponse(),
        makeSwapResponse({ memo: undefined }),
      );

      await expect(
        bridge.bridge({
          token: "native",
          targetChain: "bitcoin",
          amount: 100000000n,
          recipient: "bc1qrecipient",
        }),
      ).rejects.toThrow(/no swap memo/);
      expect(account.deposit).not.toHaveBeenCalled();
      expect(account.transfer).not.toHaveBeenCalled();
    });

    it("re-quotes once when /swap returns a stale-route error", async () => {
      stubFetchResponses(makeQuoteResponse());
      // First /swap call → 410 stale route
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 410,
        json: () => Promise.resolve({ errorCode: "ROUTE_EXPIRED" }),
        text: () => Promise.resolve('{"errorCode":"ROUTE_EXPIRED"}'),
      });
      // Re-quote then /swap succeeds
      stubFetchResponses(makeQuoteResponse(), makeSwapResponse());

      const result = await bridge.bridge({
        token: "native",
        targetChain: "bitcoin",
        amount: 100000000n,
        recipient: "bc1qrecipient",
      });

      expect(result.hash).toBe("DEPOSITHASH123");
      // 1 quote + 1 stale swap + 1 re-quote + 1 swap = 4 calls
      expect(fetchSpy).toHaveBeenCalledTimes(4);
    });

    it("enforces bridgeMaxFee against the route's liquidity fee", async () => {
      const cappedBridge = new SwapDKBridgeCosmos(account, {
        ...defaultConfig,
        bridgeMaxFee: 1000000n, // 0.01 RUNE — lower than the 0.02 RUNE fee
      });
      cappedBridge.setSourceChain("thorchain");
      stubFetchResponses(makeQuoteResponse());

      await expect(
        cappedBridge.bridge({
          token: "native",
          targetChain: "bitcoin",
          amount: 100000000n,
          recipient: "bc1qrecipient",
        }),
      ).rejects.toThrow(/exceeds bridgeMaxFee/);
      expect(account.deposit).not.toHaveBeenCalled();
      expect(account.transfer).not.toHaveBeenCalled();
    });

    // -- MsgSend dispatch (MAYACHAIN-routed RUNE swaps) ---------------------

    it("calls walletAccount.transfer() when /swap returns inboundAddress (MsgSend route)", async () => {
      stubFetchResponses(makeMayaQuoteResponse(), makeMayaSendSwapResponse());

      const result = await bridge.bridge({
        token: "native",
        targetChain: "bitcoin",
        amount: 10000000000n, // 100 RUNE
        recipient: "bc1qrecipient",
      });

      // deposit() must NOT be called for MsgSend routes — broadcasting
      // a MsgDeposit instead of MsgSend would route through the wrong
      // protocol's pools.
      expect(account.deposit).not.toHaveBeenCalled();

      expect(account.transfer).toHaveBeenCalledTimes(1);
      const transferArgs = account.transfer.mock.calls[0][0];
      expect(transferArgs).toEqual({
        token: "rune", // bank-module denom for THORChain
        recipient: "thor12qm45uyzg5kk3aw3s5jzew7gkelvg7pdsw9kzg",
        amount: 10000000000n,
        memo: "=:b:bc1qrecipient:104839:sdk/sdk:0/5",
      });

      expect(result.hash).toBe("TRANSFERHASH456");
      expect(result.fee).toBe(2000000n);
    });

    it("uses cacao denom when source is mayachain on a MsgSend route", async () => {
      bridge.setSourceChain("mayachain");
      stubFetchResponses(
        makeMayaQuoteResponse({
          sellAsset: "MAYA.CACAO",
          sellAmount: "100",
          // mock a hypothetical MAYA → THORChain MsgSend (vault on MAYA)
          inboundAddress: "maya1vault000000000000000000000000000000000",
          targetAddress: "maya1vault000000000000000000000000000000000",
        }),
        makeMayaSendSwapResponse({
          sellAsset: "MAYA.CACAO",
          sellAmount: "100",
          inboundAddress: "maya1vault000000000000000000000000000000000",
          targetAddress: "maya1vault000000000000000000000000000000000",
        }),
      );

      await bridge.bridge({
        token: "native",
        targetChain: "bitcoin",
        amount: 1000000000000n, // 100 CACAO (1e10 base units * 100)
        recipient: "bc1qrecipient",
      });

      const transferArgs = account.transfer.mock.calls[0][0];
      expect(transferArgs.token).toBe("cacao");
    });

    it("treats inboundAddress equal to source as MsgDeposit (not MsgSend)", async () => {
      // Defensive: if swap-engine ever echoes the source address as the
      // inboundAddress (would be a swap-engine bug), don't accidentally
      // treat it as a MsgSend self-transfer.
      const sourceAddress = "thor1senderaddressxxxxxxxxxxxxxxxxxxxxxxxxx";
      stubFetchResponses(
        makeQuoteResponse(),
        makeSwapResponse({
          inboundAddress: sourceAddress,
          targetAddress: sourceAddress,
        }),
      );

      await bridge.bridge({
        token: "native",
        targetChain: "bitcoin",
        amount: 100000000n,
        recipient: "bc1qrecipient",
      });

      expect(account.deposit).toHaveBeenCalledTimes(1);
      expect(account.transfer).not.toHaveBeenCalled();
    });
  });

  // -- trackBridge -----------------------------------------------------------

  describe("trackBridge", () => {
    it("uses the source chain prefix as default chainId", async () => {
      stubFetchResponses({
        chainId: "THOR",
        hash: "ABC",
        block: 123,
        type: "swap",
        status: "completed",
        trackingStatus: "completed",
        fromAsset: "THOR.RUNE",
        fromAmount: "1",
        fromAddress: "thor1...",
        toAsset: "BTC.BTC",
        toAmount: "0.0001",
        toAddress: "bc1q...",
        finalisedAt: 1700000000,
      });

      const result = await bridge.trackBridge("ABC");

      expect(result?.status).toBe("completed");
      const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(requestBody.chainId).toBe("THOR");
      expect(requestBody.hash).toBe("ABC");
    });

    it("returns null on 404 (not yet indexed)", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ errorCode: "track_not_found" }),
        text: () => Promise.resolve('{"errorCode":"track_not_found"}'),
      });

      const result = await bridge.trackBridge("UNKNOWNHASH");
      expect(result).toBeNull();
    });

    it("rethrows non-404 errors", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ errorCode: "INTERNAL" }),
        text: () => Promise.resolve('{"errorCode":"INTERNAL"}'),
      });

      await expect(bridge.trackBridge("ABC")).rejects.toThrow(SwapDKApiError);
    });

    it("uses MAYA prefix when source is mayachain", async () => {
      bridge.setSourceChain("mayachain");
      stubFetchResponses({
        chainId: "MAYA",
        hash: "ABC",
        block: 123,
        type: "swap",
        status: "completed",
        trackingStatus: "completed",
        fromAsset: "MAYA.CACAO",
        fromAmount: "1",
        fromAddress: "maya1...",
        toAsset: "ETH.ETH",
        toAmount: "0.001",
        toAddress: "0x...",
        finalisedAt: 1700000000,
      });

      await bridge.trackBridge("ABC");
      const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(requestBody.chainId).toBe("MAYA");
    });
  });
});
