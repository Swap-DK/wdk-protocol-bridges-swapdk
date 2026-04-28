import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SwapDKBridgeEvm } from "../src/SwapDKBridgeEvm.js";
import { BridgeProtocol } from "@tetherto/wdk-wallet/protocols";
import { SwapDKUserError } from "@swapdk/wdk-protocol-bridge-swapdk-common";
import type { EvmWalletAccount, SwapDKBridgeConfig } from "../src/types.js";

// --- Helpers ----------------------------------------------------------------

function createMockAccount(
  address = "0xSenderAddress",
): EvmWalletAccount & {
  sendTransaction: ReturnType<typeof vi.fn>;
  waitForTransaction: ReturnType<typeof vi.fn>;
} {
  return {
    getAddress: () => address,
    sendTransaction: vi.fn().mockResolvedValue("0xTxHash"),
    waitForTransaction: vi.fn().mockResolvedValue(undefined),
  };
}

const defaultConfig: SwapDKBridgeConfig = {
  apiUrl: "https://api.swapdk.test",
  apiKey: "test-key",
};

// Fixtures mirror the real swap-engine contract: sellAmount, buyAmount,
// expectedBuyAmount and fee amounts are all human-decimal strings.
// Bridge: 1 ETH → 0.05 BTC.
function makeQuoteResponse(overrides: Record<string, unknown> = {}) {
  return {
    quoteId: "q1",
    routes: [
      {
        routeId: "r1",
        providers: ["THORCHAIN"],
        sellAsset: "ETH.ETH",
        sellAmount: "1",
        buyAsset: "BTC.BTC",
        expectedBuyAmount: "0.05",
        expectedBuyAmountMaxSlippage: "0.0485",
        fees: [
          { type: "liquidity", amount: "0.001", asset: "ETH.ETH" },
          { type: "network",   amount: "0.0005", asset: "ETH.ETH" },
        ],
        tx: {
          to: "0xRouter",
          data: "0xcalldata",
          value: "1000000000000000000",
          gas: "200000",
        },
        estimatedTime: { inbound: 60, swap: 300, outbound: 60, total: 420 },
        totalSlippageBps: 150,
        ...overrides,
      },
    ],
  };
}

function makeSwapResponse(overrides: Record<string, unknown> = {}) {
  return {
    sellAsset: "ETH.ETH",
    sellAmount: "1",
    buyAsset: "BTC.BTC",
    buyAmount: "0.05",
    routeId: "r1",
    providers: ["THORCHAIN"],
    targetAddress: "0xRouter",
    fees: [
      { type: "liquidity", amount: "0.001", asset: "ETH.ETH" },
    ],
    tx: {
      to: "0xRouter",
      data: "0xcalldata",
      value: "1000000000000000000",
      gas: "200000",
    },
    ...overrides,
  };
}

// --- Tests ------------------------------------------------------------------

describe("SwapDKBridgeEvm", () => {
  let account: ReturnType<typeof createMockAccount>;
  let bridge: SwapDKBridgeEvm;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    account = createMockAccount();
    bridge = new SwapDKBridgeEvm(account, defaultConfig);
    bridge.setSourceChain("ethereum");

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

    it("has bridge and quoteBridge methods", () => {
      expect(typeof bridge.bridge).toBe("function");
      expect(typeof bridge.quoteBridge).toBe("function");
    });
  });

  // -- quoteBridge -----------------------------------------------------------

  describe("quoteBridge", () => {
    it("returns a quote result from the best route", async () => {
      stubFetchResponses(makeQuoteResponse());

      const result = await bridge.quoteBridge({
        targetChain: "bitcoin",
        recipient: "bc1qxyz",
        token: "0x0000000000000000000000000000000000000000",
        amount: 1000000000000000000n,
      });

      expect(result.tokenInAmount).toBe(1_000_000_000_000_000_000n); // 1 ETH in wei
      expect(result.tokenOutAmount).toBe(5_000_000n);                 // 0.05 BTC in sat
      expect(result.fee).toBe(200000n);
      expect(result.bridgeFee).toBe(1_000_000_000_000_000n);          // 0.001 ETH in wei
      expect(result.estimatedTime).toBe(420);
      expect(result.providers).toEqual(["THORCHAIN"]);
    });

    it("sends correct sellAsset and buyAsset to the API", async () => {
      stubFetchResponses(makeQuoteResponse());

      await bridge.quoteBridge({
        targetChain: "bitcoin",
        recipient: "bc1qxyz",
        token: "0x0000000000000000000000000000000000000000",
        amount: 1n,
      });

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.sellAsset).toBe("ETH.ETH");
      expect(body.buyAsset).toBe("BTC.BTC");
      expect(body.includeTx).toBe(false);
    });

    it("uses tokenOut when provided", async () => {
      const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
      stubFetchResponses(makeQuoteResponse());

      await bridge.quoteBridge({
        targetChain: "ethereum",
        recipient: "0xRecipient",
        token: "0x0000000000000000000000000000000000000000",
        amount: 1n,
        tokenOut: `ETH.USDC-${USDC}`,
      });

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.buyAsset).toBe(`ETH.USDC-${USDC}`);
    });

    it("resolves ERC-20 symbol from registry and sends correct SwapKit notation", async () => {
      const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
      stubFetchResponses(makeQuoteResponse());

      await bridge.quoteBridge({
        targetChain: "bitcoin",
        recipient: "bc1qxyz",
        token: USDC,
        amount: 1n,
      });

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.sellAsset).toBe(`ETH.USDC-${USDC}`);
    });

    it("accepts number amount (WDK contract allows number | bigint)", async () => {
      stubFetchResponses(makeQuoteResponse());

      const result = await bridge.quoteBridge({
        targetChain: "bitcoin",
        recipient: "bc1qxyz",
        token: "0x0000000000000000000000000000000000000000",
        amount: 10_000_000_000_000_000, // 0.01 ETH in wei, as a number
      });

      expect(result.fee).toBe(200000n);
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      // Converted to human-decimal ETH before reaching swap-engine.
      expect(body.sellAmount).toBe("0.01");
    });

    it("throws SwapDKUserError when amount is undefined", async () => {
      await expect(
        bridge.quoteBridge({
          targetChain: "bitcoin",
          recipient: "bc1qxyz",
          token: "0x0000000000000000000000000000000000000000",
        }),
      ).rejects.toBeInstanceOf(SwapDKUserError);
    });

    it("throws when no routes are returned", async () => {
      stubFetchResponses({ quoteId: "q1", routes: [] });

      await expect(
        bridge.quoteBridge({
          targetChain: "bitcoin",
          recipient: "bc1qxyz",
          token: "0x0000000000000000000000000000000000000000",
          amount: 1n,
        }),
      ).rejects.toThrow("No routes found");
    });

    it("includes provider errors in the error message", async () => {
      stubFetchResponses({
        quoteId: "q1",
        routes: [],
        providerErrors: [
          { errorCode: "NO_ROUTE", provider: "THORCHAIN", message: "no pool" },
        ],
      });

      await expect(
        bridge.quoteBridge({
          targetChain: "bitcoin",
          recipient: "bc1qxyz",
          token: "0x0000000000000000000000000000000000000000",
          amount: 1n,
        }),
      ).rejects.toThrow("THORCHAIN: no pool");
    });

    it("throws for unsupported target chain", async () => {
      await expect(
        bridge.quoteBridge({
          targetChain: "stellar",
          recipient: "GAaaa...",
          token: "0x0000000000000000000000000000000000000000",
          amount: 1n,
        }),
      ).rejects.toThrow("Unsupported WDK chain");
    });

    it("defaults sourceChain to ethereum when not set", async () => {
      const freshBridge = new SwapDKBridgeEvm(account, defaultConfig);
      stubFetchResponses(makeQuoteResponse());

      await freshBridge.quoteBridge({
        targetChain: "bitcoin",
        recipient: "bc1qxyz",
        token: "0x0000000000000000000000000000000000000000",
        amount: 1n,
      });

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.sellAsset).toBe("ETH.ETH");
    });

    it("picks the best route when swap-engine returns a zero-quote route first", async () => {
      // Reproduces real swap-engine behaviour: MAYACHAIN route with
      // expectedBuyAmount "0" returned before the actual CHAINFLIP quote.
      const res = makeQuoteResponse();
      res.routes = [
        { ...res.routes[0], providers: ["MAYACHAIN"], routeId: "maya", expectedBuyAmount: "0" },
        { ...res.routes[0], providers: ["CHAINFLIP"], routeId: "chainflip", expectedBuyAmount: "0.05" },
      ];
      stubFetchResponses(res);

      const result = await bridge.quoteBridge({
        targetChain: "bitcoin",
        recipient: "bc1qxyz",
        token: "0x0000000000000000000000000000000000000000",
        amount: 1n,
      });

      expect(result.providers).toEqual(["CHAINFLIP"]);
      expect(result.tokenOutAmount).toBe(5_000_000n); // 0.05 BTC in sat
    });

    it("throws SwapDKProviderError when all routes have zero amount", async () => {
      const res = makeQuoteResponse();
      res.routes = [
        { ...res.routes[0], expectedBuyAmount: "0" },
        { ...res.routes[0], expectedBuyAmount: "0" },
      ];
      stubFetchResponses(res);

      await expect(
        bridge.quoteBridge({
          targetChain: "bitcoin",
          recipient: "bc1qxyz",
          token: "0x0000000000000000000000000000000000000000",
          amount: 1n,
        }),
      ).rejects.toThrow("No routes found");
    });
  });

  // -- bridge ----------------------------------------------------------------

  describe("bridge", () => {
    it("executes the full bridge flow", async () => {
      const swapRes = makeSwapResponse();
      stubFetchResponses(makeQuoteResponse(), swapRes);

      const result = await bridge.bridge({
        targetChain: "bitcoin",
        recipient: "bc1qxyz",
        token: "0x0000000000000000000000000000000000000000",
        amount: 1000000000000000000n,
      });

      expect(result.hash).toBe("0xTxHash");
      expect(result.tokenInAmount).toBe(1_000_000_000_000_000_000n);
      expect(result.tokenOutAmount).toBe(5_000_000n);
      expect(result.fee).toBe(200000n);
      expect(result.bridgeFee).toBe(1_000_000_000_000_000n);
      expect(result.approveHash).toBeUndefined();

      // sendTransaction called once (bridge tx only, no approval)
      expect(account.sendTransaction).toHaveBeenCalledOnce();
      expect(account.sendTransaction).toHaveBeenCalledWith({
        to: "0xRouter",
        data: "0xcalldata",
        value: 1000000000000000000n,
        gas: 200000n,
      });
    });

    it("sends approve tx and waits before bridge tx", async () => {
      account.sendTransaction
        .mockResolvedValueOnce("0xApproveHash")
        .mockResolvedValueOnce("0xBridgeHash");

      const swapRes = makeSwapResponse({
        approvalTx: {
          to: "0xToken",
          data: "0xapprove",
          gasLimit: "60000",
        },
      });
      stubFetchResponses(makeQuoteResponse(), swapRes);

      const result = await bridge.bridge({
        targetChain: "bitcoin",
        recipient: "bc1qxyz",
        token: "0x0000000000000000000000000000000000000000",
        amount: 1000000000000000000n,
      });

      expect(result.approveHash).toBe("0xApproveHash");
      expect(result.hash).toBe("0xBridgeHash");

      // waitForTransaction called with approve hash
      expect(account.waitForTransaction).toHaveBeenCalledWith("0xApproveHash");

      // sendTransaction called twice: approve + bridge
      expect(account.sendTransaction).toHaveBeenCalledTimes(2);
      expect(account.sendTransaction.mock.calls[0][0]).toEqual({
        to: "0xToken",
        data: "0xapprove",
        value: 0n,
        gas: 60000n,
      });
    });

    it("proceeds without waiting if waitForTransaction is not implemented", async () => {
      const simpleAccount: EvmWalletAccount = {
        getAddress: () => "0xSender",
        sendTransaction: vi.fn()
          .mockResolvedValueOnce("0xApproveHash")
          .mockResolvedValueOnce("0xBridgeHash"),
      };
      const simpleBridge = new SwapDKBridgeEvm(simpleAccount, defaultConfig);
      simpleBridge.setSourceChain("ethereum");

      const swapRes = makeSwapResponse({
        approvalTx: { to: "0xToken", data: "0xapprove" },
      });
      stubFetchResponses(makeQuoteResponse(), swapRes);

      const result = await simpleBridge.bridge({
        targetChain: "bitcoin",
        recipient: "bc1qxyz",
        token: "0x0000000000000000000000000000000000000000",
        amount: 1n,
      });

      expect(result.approveHash).toBe("0xApproveHash");
      expect(result.hash).toBe("0xBridgeHash");
    });

    it("throws SwapDKUserError when amount is undefined", async () => {
      await expect(
        bridge.bridge({
          targetChain: "bitcoin",
          recipient: "bc1qxyz",
          token: "0x0000000000000000000000000000000000000000",
        }),
      ).rejects.toBeInstanceOf(SwapDKUserError);
    });

    it("throws when swap-engine returns no tx data", async () => {
      const swapRes = makeSwapResponse({ tx: undefined });
      stubFetchResponses(makeQuoteResponse(), swapRes);

      await expect(
        bridge.bridge({
          targetChain: "bitcoin",
          recipient: "bc1qxyz",
          token: "0x0000000000000000000000000000000000000000",
          amount: 1n,
        }),
      ).rejects.toThrow("no transaction data");
    });

    it("calls /swap with correct routeId and addresses", async () => {
      stubFetchResponses(makeQuoteResponse(), makeSwapResponse());

      await bridge.bridge({
        targetChain: "bitcoin",
        recipient: "bc1qxyz",
        token: "0x0000000000000000000000000000000000000000",
        amount: 1n,
      });

      // Second fetch call is /swap
      const swapBody = JSON.parse(fetchSpy.mock.calls[1][1].body);
      expect(swapBody.routeId).toBe("r1");
      expect(swapBody.sourceAddress).toBe("0xSenderAddress");
      expect(swapBody.destinationAddress).toBe("bc1qxyz");
    });

    it("sets fee to 0n when swap response has no gas", async () => {
      const swapRes = makeSwapResponse({ tx: { to: "0xRouter", data: "0xcalldata" } });
      stubFetchResponses(makeQuoteResponse(), swapRes);

      const result = await bridge.bridge({
        targetChain: "bitcoin",
        recipient: "bc1qxyz",
        token: "0x0000000000000000000000000000000000000000",
        amount: 1n,
      });

      expect(result.fee).toBe(0n);
    });
  });

  describe("quoteBridge — fee fallback", () => {
    it("sets fee to 0n when quote route has no tx gas", async () => {
      const quoteRes = makeQuoteResponse({ tx: { to: "0xRouter" } });
      stubFetchResponses(quoteRes);

      const result = await bridge.quoteBridge({
        targetChain: "bitcoin",
        recipient: "bc1qxyz",
        token: "0x0000000000000000000000000000000000000000",
        amount: 1n,
      });

      expect(result.fee).toBe(0n);
    });

    it("sets fee to 0n when quote route has no tx at all", async () => {
      const quoteRes = makeQuoteResponse({ tx: undefined });
      stubFetchResponses(quoteRes);

      const result = await bridge.quoteBridge({
        targetChain: "bitcoin",
        recipient: "bc1qxyz",
        token: "0x0000000000000000000000000000000000000000",
        amount: 1n,
      });

      expect(result.fee).toBe(0n);
    });
  });

  describe("slippage", () => {
    it("uses default slippage of 300 bps when not configured", async () => {
      stubFetchResponses(makeQuoteResponse());

      await bridge.quoteBridge({
        targetChain: "bitcoin",
        recipient: "bc1qxyz",
        token: "0x0000000000000000000000000000000000000000",
        amount: 1n,
      });

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.slippage).toBe(300);
    });

    it("uses custom slippage when configured", async () => {
      const customBridge = new SwapDKBridgeEvm(account, {
        ...defaultConfig,
        slippageBps: 100,
      });
      customBridge.setSourceChain("ethereum");
      stubFetchResponses(makeQuoteResponse());

      await customBridge.quoteBridge({
        targetChain: "bitcoin",
        recipient: "bc1qxyz",
        token: "0x0000000000000000000000000000000000000000",
        amount: 1n,
      });

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.slippage).toBe(100);
    });
  });

  describe("bridgeMaxFee enforcement", () => {
    it("throws SwapDKUserError when estimated fee exceeds bridgeMaxFee", async () => {
      const strictBridge = new SwapDKBridgeEvm(account, {
        ...defaultConfig,
        bridgeMaxFee: 100n, // very low limit
      });
      strictBridge.setSourceChain("ethereum");
      // route has gas: "200000" → fee = 200000n > 100n
      stubFetchResponses(makeQuoteResponse());

      await expect(
        strictBridge.bridge({
          targetChain: "bitcoin",
          recipient: "bc1qxyz",
          token: "0x0000000000000000000000000000000000000000",
          amount: 1n,
        }),
      ).rejects.toBeInstanceOf(SwapDKUserError);
    });

    it("does not throw when fee is within bridgeMaxFee", async () => {
      const strictBridge = new SwapDKBridgeEvm(account, {
        ...defaultConfig,
        bridgeMaxFee: 1_000_000n, // well above gas: "200000"
      });
      strictBridge.setSourceChain("ethereum");
      stubFetchResponses(makeQuoteResponse(), makeSwapResponse());

      await expect(
        strictBridge.bridge({
          targetChain: "bitcoin",
          recipient: "bc1qxyz",
          token: "0x0000000000000000000000000000000000000000",
          amount: 1n,
        }),
      ).resolves.toBeDefined();
    });

    it("does not throw when bridgeMaxFee is not set", async () => {
      stubFetchResponses(makeQuoteResponse(), makeSwapResponse());

      await expect(
        bridge.bridge({
          targetChain: "bitcoin",
          recipient: "bc1qxyz",
          token: "0x0000000000000000000000000000000000000000",
          amount: 1n,
        }),
      ).resolves.toBeDefined();
    });
  });

  describe("re-quote on stale routeId", () => {
    it("re-quotes and retries /swap when routeId is stale (404)", async () => {
      // First quote → stale route error on swap → second quote → swap succeeds
      stubFetchResponses(makeQuoteResponse()); // first /quote
      fetchSpy.mockResolvedValueOnce({        // /swap → 404 stale
        ok: false,
        status: 404,
        json: () => Promise.resolve({ message: "not found" }),
        text: () => Promise.resolve(""),
      });
      stubFetchResponses(makeQuoteResponse()); // re-quote
      stubFetchResponses(makeSwapResponse()); // retry /swap

      const result = await bridge.bridge({
        targetChain: "bitcoin",
        recipient: "bc1qxyz",
        token: "0x0000000000000000000000000000000000000000",
        amount: 1n,
      });

      expect(result.hash).toBe("0xTxHash");
      // 4 fetch calls: /quote, /swap (404), /quote, /swap (ok)
      expect(fetchSpy).toHaveBeenCalledTimes(4);
    });

    it("does not retry on non-stale errors", async () => {
      stubFetchResponses(makeQuoteResponse());
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ errorCode: "BAD_PARAM", message: "invalid" }),
        text: () => Promise.resolve(JSON.stringify({ errorCode: "BAD_PARAM", message: "invalid" })),
      });

      await expect(
        bridge.bridge({
          targetChain: "bitcoin",
          recipient: "bc1qxyz",
          token: "0x0000000000000000000000000000000000000000",
          amount: 1n,
        }),
      ).rejects.toThrow("BAD_PARAM");

      expect(fetchSpy).toHaveBeenCalledTimes(2); // /quote + /swap only
    });
  });
});
