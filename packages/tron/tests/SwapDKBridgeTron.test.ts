import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SwapDKBridgeTron } from "../src/SwapDKBridgeTron.js";
import { BridgeProtocol } from "@tetherto/wdk-wallet/protocols";
import {
  SwapDKApiError,
  SwapDKUserError,
  SwapDKProviderError,
} from "@swapdk/swap-engine-client";
import type {
  TronWalletAccount,
  SwapDKBridgeConfig,
} from "../src/types.js";

// --- Helpers ----------------------------------------------------------------

/**
 * Complete TrackResponse fixture. zod (swap-engine-client 0.2.0) rejects
 * partial shapes; real swap-engine /track responses populate every field
 * with zero-value sentinels for unfilled state.
 */
const TRACK_RESPONSE_FIXTURE = {
  chainId: "TRON",
  hash: "0x0",
  block: 0,
  type: "",
  status: "pending",
  trackingStatus: "",
  fromAsset: "",
  fromAmount: "",
  fromAddress: "",
  toAsset: "",
  toAmount: "",
  toAddress: "",
  finalisedAt: 0,
  meta: {},
  legs: [],
};

const SAMPLE_ROUTER = "TThorRouterxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const SAMPLE_USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const SAMPLE_TX_DATA = "0x44bc937b" + "00".repeat(32 * 5);
const SAMPLE_APPROVE_DATA = "0x095ea7b3" + "00".repeat(32 * 2);

function createMockAccount(
  address = "TUserSourceAddrxxxxxxxxxxxxxxxxxxxx",
): TronWalletAccount & {
  sendTransaction: ReturnType<typeof vi.fn>;
  waitForTransaction: ReturnType<typeof vi.fn>;
} {
  return {
    getAddress: () => address,
    sendTransaction: vi.fn().mockResolvedValue({
      hash: "TRONTXHASH123",
      fee: 100_000_000n, // 100 TRX feeLimit echoed back
    }),
    waitForTransaction: vi.fn().mockResolvedValue(undefined),
  };
}

const defaultConfig: SwapDKBridgeConfig = {
  apiUrl: "https://api.swapdk.test",
  apiKey: "test-key",
  retries: 0,
};

// Fixture for the /quote response. Mirrors the real swap-engine TRON
// dispatch output: router-contract calldata in tx.data, feeLimit
// instead of gas/gasPrice, base58 router address.
function makeQuoteResponse(overrides: Record<string, unknown> = {}) {
  return {
    quoteId: "q1",
    routes: [
      {
        routeId: "r1",
        providers: ["THORCHAIN"],
        sellAsset: "TRON.TRX",
        sellAmount: "100",
        buyAsset: "ETH.ETH",
        expectedBuyAmount: "0.00531",
        expectedBuyAmountMaxSlippage: "0.00515",
        targetAddress: SAMPLE_ROUTER,
        inboundAddress: SAMPLE_ROUTER,
        memo: "=:e:0xRecipient:1234:commission/SDK:444/5",
        fees: [
          { type: "liquidity", amount: "0.05",  asset: "TRON.TRX" },
          { type: "outbound",  amount: "0.0001", asset: "ETH.ETH" },
        ],
        estimatedTime: { inbound: 30, swap: 6, outbound: 24, total: 60 },
        totalSlippageBps: 300,
      },
    ],
    ...overrides,
  };
}

// Fixture for /swap response (TRX path — no approvalTx).
function makeSwapResponseTrx(overrides: Record<string, unknown> = {}) {
  return {
    sellAsset: "TRON.TRX",
    sellAmount: "100",
    buyAsset: "ETH.ETH",
    buyAmount: "0.00531",
    routeId: "r1",
    providers: ["THORCHAIN"],
    targetAddress: SAMPLE_ROUTER,
    inboundAddress: SAMPLE_ROUTER,
    memo: "=:e:0xRecipient:1234:commission/SDK:444/5",
    tx: {
      to: SAMPLE_ROUTER,
      from: "TUserSourceAddrxxxxxxxxxxxxxxxxxxxx",
      value: "100000000", // 100 TRX in SUN
      data: SAMPLE_TX_DATA,
      feeLimit: "100000000",
    },
    fees: [
      { type: "liquidity", amount: "0.05",  asset: "TRON.TRX" },
      { type: "outbound",  amount: "0.0001", asset: "ETH.ETH" },
    ],
    ...overrides,
  };
}

// Fixture for /swap response (TRC-20 USDT path — includes approvalTx).
function makeSwapResponseUsdt(overrides: Record<string, unknown> = {}) {
  return {
    ...makeSwapResponseTrx(),
    sellAsset: `TRON.USDT-${SAMPLE_USDT_CONTRACT}`,
    sellAmount: "10",
    tx: {
      to: SAMPLE_ROUTER,
      from: "TUserSourceAddrxxxxxxxxxxxxxxxxxxxx",
      value: "0", // TRC-20 path uses callValue=0; tokens via approve+pull
      data: SAMPLE_TX_DATA,
      feeLimit: "150000000",
    },
    approvalTx: {
      to: SAMPLE_USDT_CONTRACT,
      from: "TUserSourceAddrxxxxxxxxxxxxxxxxxxxx",
      value: "0",
      data: SAMPLE_APPROVE_DATA,
      feeLimit: "100000000",
    },
    fees: [
      { type: "liquidity", amount: "0.03", asset: `TRON.USDT-${SAMPLE_USDT_CONTRACT}` },
      { type: "outbound",  amount: "0.0001", asset: "ETH.ETH" },
    ],
    ...overrides,
  };
}

describe("SwapDKBridgeTron", () => {
  let account: ReturnType<typeof createMockAccount>;
  let bridge: SwapDKBridgeTron;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    account = createMockAccount();
    bridge = new SwapDKBridgeTron(account, defaultConfig);
    bridge.setSourceChain("tron");

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

  // -- WDK contract ---------------------------------------------------------

  describe("WDK contract", () => {
    it("extends BridgeProtocol from @tetherto/wdk-wallet", () => {
      expect(bridge).toBeInstanceOf(BridgeProtocol);
    });

    it("exposes bridge(), quoteBridge(), trackBridge(), waitForBridge()", () => {
      expect(typeof bridge.bridge).toBe("function");
      expect(typeof bridge.quoteBridge).toBe("function");
      expect(typeof bridge.trackBridge).toBe("function");
      expect(typeof bridge.waitForBridge).toBe("function");
    });
  });

  // -- setSourceChain -------------------------------------------------------

  describe("setSourceChain", () => {
    it("accepts tron", () => {
      expect(() => bridge.setSourceChain("tron")).not.toThrow();
    });

    it("is case-insensitive", () => {
      expect(() => bridge.setSourceChain("Tron")).not.toThrow();
      expect(() => bridge.setSourceChain("TRON")).not.toThrow();
    });

    it("rejects non-TRON chains", () => {
      expect(() => bridge.setSourceChain("ethereum")).toThrow(SwapDKUserError);
      expect(() => bridge.setSourceChain("bitcoin")).toThrow(/Unsupported/);
    });
  });

  // -- quoteBridge ----------------------------------------------------------

  describe("quoteBridge", () => {
    it("returns a quote for TRON.TRX → ETH.ETH", async () => {
      stubFetchResponses(makeQuoteResponse());

      const result = await bridge.quoteBridge({
        targetChain: "ethereum",
        tokenOut: "ETH.ETH",
        amount: 100_000_000n, // 100 TRX
        recipient: "0xRecipientAddr",
      });

      expect(result.tokenInAmount).toBe(100_000_000n);
      // 0.00531 ETH = 5.31e15 wei
      expect(result.tokenOutAmount).toBe(5_310_000_000_000_000n);
      expect(result.providers).toEqual(["THORCHAIN"]);
      expect(result.estimatedTime).toBe(60);
      expect(result.fee).toBe(0n); // pre-broadcast — TRON energy is wallet-side
      // 0.05 TRX = 50_000n SUN
      expect(result.bridgeFee).toBe(50_000n);
      expect(result.bridgeFeeAsset).toBe("TRON.TRX");
    });

    it("sends TRON.TRX as sellAsset with human-decimal sellAmount", async () => {
      stubFetchResponses(makeQuoteResponse());

      await bridge.quoteBridge({
        targetChain: "ethereum",
        tokenOut: "ETH.ETH",
        amount: 100_000_000n,
        recipient: "0xRecipientAddr",
      });

      const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(requestBody.sellAsset).toBe("TRON.TRX");
      expect(requestBody.sellAmount).toBe("100");
      // quote without includeTx — server skips calldata generation.
      expect(requestBody.includeTx).toBe(false);
    });

    it("accepts TRC-20 source token in SwapKit notation", async () => {
      const usdtAsset = `TRON.USDT-${SAMPLE_USDT_CONTRACT}`;
      stubFetchResponses(
        makeQuoteResponse({
          routes: [
            {
              ...makeQuoteResponse().routes[0],
              sellAsset: usdtAsset,
              sellAmount: "10",
            },
          ],
        }),
      );

      await bridge.quoteBridge({
        token: usdtAsset,
        targetChain: "ethereum",
        tokenOut: "ETH.ETH",
        amount: 10_000_000n, // 10 USDT
        recipient: "0xRecipient",
      });

      const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(requestBody.sellAsset).toBe(usdtAsset);
      expect(requestBody.sellAmount).toBe("10");
    });

    it("rejects Chainflip-only TRON routes with a clear error", async () => {
      stubFetchResponses({
        quoteId: "q1",
        routes: [
          {
            ...makeQuoteResponse().routes[0],
            providers: ["CHAINFLIP"],
          },
        ],
      });

      await expect(
        bridge.quoteBridge({
          targetChain: "ethereum",
          tokenOut: "ETH.ETH",
          amount: 100_000_000n,
          recipient: "0xRecipient",
        }),
      ).rejects.toThrow(/CHAINFLIP/);
    });

    it("surfaces SwapDKProviderError when swap-engine returns no usable routes", async () => {
      stubFetchResponses({
        quoteId: "q1",
        routes: [],
        providerErrors: [{ errorCode: "no_pool", provider: "THORCHAIN", message: "no pool" }],
      });

      await expect(
        bridge.quoteBridge({
          targetChain: "ethereum",
          tokenOut: "ETH.ETH",
          amount: 100_000_000n,
          recipient: "0xRecipient",
        }),
      ).rejects.toThrow(SwapDKProviderError);
    });
  });

  // -- bridge (TRX path — no approval) --------------------------------------

  describe("bridge — native TRX", () => {
    it("broadcasts a single router-contract call via wallet.sendTransaction", async () => {
      stubFetchResponses(makeQuoteResponse(), makeSwapResponseTrx());

      const result = await bridge.bridge({
        targetChain: "ethereum",
        tokenOut: "ETH.ETH",
        amount: 100_000_000n,
        recipient: "0xRecipientAddr",
      });

      // Two HTTP calls (/quote and /swap), one wallet broadcast.
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(fetchSpy.mock.calls[0][0]).toContain("/quote");
      expect(fetchSpy.mock.calls[1][0]).toContain("/swap");
      expect(account.sendTransaction).toHaveBeenCalledOnce();
      expect(account.waitForTransaction).not.toHaveBeenCalled();

      const txArgs = account.sendTransaction.mock.calls[0][0];
      expect(txArgs.to).toBe(SAMPLE_ROUTER);
      expect(txArgs.value).toBe(100_000_000n); // 100 TRX SUN as callValue
      expect(txArgs.data).toBe(SAMPLE_TX_DATA);
      expect(txArgs.feeLimit).toBe(100_000_000n);

      expect(result.hash).toBe("TRONTXHASH123");
      expect(result.fee).toBe(100_000_000n); // wallet returns feeLimit-as-cap
      expect(result.tokenInAmount).toBe(100_000_000n);
      expect(result.tokenOutAmount).toBe(5_310_000_000_000_000n);
      expect(result.approveHash).toBeUndefined();
    });

    it("uses includeTx:true on the /quote call", async () => {
      stubFetchResponses(makeQuoteResponse(), makeSwapResponseTrx());

      await bridge.bridge({
        targetChain: "ethereum",
        tokenOut: "ETH.ETH",
        amount: 100_000_000n,
        recipient: "0xRecipient",
      });

      const quoteBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(quoteBody.includeTx).toBe(true);
    });
  });

  // -- bridge (TRC-20 path — with approval) ---------------------------------

  describe("bridge — TRC-20 USDT", () => {
    it("broadcasts approval first, waits, then sends the main bridge tx", async () => {
      stubFetchResponses(
        makeQuoteResponse({
          routes: [
            {
              ...makeQuoteResponse().routes[0],
              sellAsset: `TRON.USDT-${SAMPLE_USDT_CONTRACT}`,
              sellAmount: "10",
            },
          ],
        }),
        makeSwapResponseUsdt(),
      );

      const result = await bridge.bridge({
        token: `TRON.USDT-${SAMPLE_USDT_CONTRACT}`,
        targetChain: "ethereum",
        tokenOut: "ETH.ETH",
        amount: 10_000_000n,
        recipient: "0xRecipient",
      });

      // Two wallet broadcasts: approve, then bridge.
      expect(account.sendTransaction).toHaveBeenCalledTimes(2);

      // First call = approval to USDT contract, no callValue, approve calldata.
      const approveArgs = account.sendTransaction.mock.calls[0][0];
      expect(approveArgs.to).toBe(SAMPLE_USDT_CONTRACT);
      expect(approveArgs.value).toBe(0n);
      expect(approveArgs.data).toBe(SAMPLE_APPROVE_DATA);
      expect(approveArgs.feeLimit).toBe(100_000_000n);

      // We wait for the approval to land before sending the bridge tx.
      expect(account.waitForTransaction).toHaveBeenCalledOnce();
      expect(account.waitForTransaction.mock.calls[0][0]).toBe("TRONTXHASH123");

      // Second call = depositWithExpiry on the router, callValue=0
      // (tokens come via the allowance, not callValue), bridge calldata.
      const bridgeArgs = account.sendTransaction.mock.calls[1][0];
      expect(bridgeArgs.to).toBe(SAMPLE_ROUTER);
      expect(bridgeArgs.value).toBe(0n);
      expect(bridgeArgs.data).toBe(SAMPLE_TX_DATA);
      expect(bridgeArgs.feeLimit).toBe(150_000_000n);

      expect(result.hash).toBe("TRONTXHASH123");
      expect(result.approveHash).toBe("TRONTXHASH123");
      // bridgeFee 0.03 USDT × 1e6 = 30_000n base units (USDT has 6 decimals).
      expect(result.bridgeFee).toBe(30_000n);
      expect(result.bridgeFeeAsset).toBe(`TRON.USDT-${SAMPLE_USDT_CONTRACT}`);
    });
  });

  // -- bridge — other behaviours --------------------------------------------

  describe("bridge — error paths", () => {
    it("re-quotes once on isStaleRoute and retries /swap", async () => {
      // /quote, /swap (stale), /quote (re-quote), /swap (success).
      stubFetchResponses(makeQuoteResponse());
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: () =>
          Promise.resolve({ errorCode: "ROUTE_NOT_FOUND", message: "stale" }),
        text: () =>
          Promise.resolve(
            '{"errorCode":"ROUTE_NOT_FOUND","message":"stale"}',
          ),
      });
      stubFetchResponses(makeQuoteResponse(), makeSwapResponseTrx());

      const result = await bridge.bridge({
        targetChain: "ethereum",
        tokenOut: "ETH.ETH",
        amount: 100_000_000n,
        recipient: "0xRecipient",
      });

      // 4 HTTP calls: quote, swap (fails stale), quote (re-fetch), swap (success).
      expect(fetchSpy).toHaveBeenCalledTimes(4);
      expect(result.hash).toBe("TRONTXHASH123");
    });

    it("throws if /swap returns no tx data", async () => {
      stubFetchResponses(
        makeQuoteResponse(),
        { ...makeSwapResponseTrx(), tx: undefined },
      );

      await expect(
        bridge.bridge({
          targetChain: "ethereum",
          tokenOut: "ETH.ETH",
          amount: 100_000_000n,
          recipient: "0xRecipient",
        }),
      ).rejects.toThrow(/no transaction data/);
    });

    it("enforces bridgeMaxFee against the route's liquidity fee", async () => {
      bridge = new SwapDKBridgeTron(account, {
        ...defaultConfig,
        bridgeMaxFee: 10_000n, // 0.01 TRX cap
      });
      bridge.setSourceChain("tron");
      stubFetchResponses(makeQuoteResponse());

      // liquidity fee = 0.05 TRX = 50_000n SUN > 10_000n cap → throws.
      await expect(
        bridge.bridge({
          targetChain: "ethereum",
          tokenOut: "ETH.ETH",
          amount: 100_000_000n,
          recipient: "0xRecipient",
        }),
      ).rejects.toThrow(/exceeds bridgeMaxFee/);

      // /swap must not have been called.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(account.sendTransaction).not.toHaveBeenCalled();
    });
  });

  // -- trackBridge ----------------------------------------------------------

  describe("trackBridge", () => {
    it("returns parsed TrackResponse on 200", async () => {
      stubFetchResponses({ ...TRACK_RESPONSE_FIXTURE, status: "completed" });
      const status = await bridge.trackBridge("TRONTX1");
      expect(status?.status).toBe("completed");
    });

    it("returns null for 404 track_not_found", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: () =>
          Promise.resolve({ errorCode: "track_not_found", message: "nf" }),
        text: () =>
          Promise.resolve('{"errorCode":"track_not_found","message":"nf"}'),
      });
      const status = await bridge.trackBridge("TRONTX1");
      expect(status).toBeNull();
    });

    it("defaults chainId to 'TRON' in the /track body", async () => {
      stubFetchResponses({ ...TRACK_RESPONSE_FIXTURE, status: "pending" });
      await bridge.trackBridge("TRONTX1");
      const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(requestBody.chainId).toBe("TRON");
      expect(requestBody.hash).toBe("TRONTX1");
    });

    it("passes an explicit chainId override through", async () => {
      stubFetchResponses({ ...TRACK_RESPONSE_FIXTURE, status: "pending" });
      await bridge.trackBridge("TRONTX1", "728126428"); // numeric chainID
      const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(requestBody.chainId).toBe("728126428");
    });

    it("rethrows non-404 SwapDKApiError as-is", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 502,
        json: () =>
          Promise.resolve({ errorCode: "upstream_failed", message: "x" }),
        text: () =>
          Promise.resolve('{"errorCode":"upstream_failed","message":"x"}'),
      });
      await expect(bridge.trackBridge("TRONTX1")).rejects.toThrow(SwapDKApiError);
    });
  });
});
