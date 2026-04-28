import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SwapDKSwapEvm } from "../src/SwapDKSwapEvm.js";
import { SwapProtocol } from "@tetherto/wdk-wallet/protocols";
import { SwapDKUserError, SwapDKProviderError } from "@swapdk/wdk-protocol-bridge-swapdk-common";
import type { EvmWalletAccount, SwapDKBridgeConfig } from "../src/types.js";

// --- Helpers ----------------------------------------------------------------

function createMockAccount(address = "0xSender"): EvmWalletAccount & {
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

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

// Fixtures mirror the real swap-engine contract: sellAmount, buyAmount,
// expectedBuyAmount and fee amounts are all human-decimal strings.
// Swap: 1 USDC → 0.0005 WETH (round numbers for easy verification).
function makeQuoteResponse(overrides: Record<string, unknown> = {}) {
  return {
    quoteId: "q1",
    routes: [
      {
        routeId: "r1",
        providers: ["THORCHAIN"],
        sellAsset: `ETH.USDC-${USDC}`,
        sellAmount: "1",
        buyAsset: `ETH.WETH-${WETH}`,
        expectedBuyAmount: "0.0005",
        expectedBuyAmountMaxSlippage: "0.000485",
        fees: [{ type: "liquidity", amount: "0.005", asset: `ETH.USDC-${USDC}` }],
        tx: {
          to: "0xRouter",
          data: "0xcalldata",
          value: "0",
          gas: "150000",
        },
        estimatedTime: { inbound: 0, swap: 60, outbound: 0, total: 60 },
        totalSlippageBps: 150,
        ...overrides,
      },
    ],
  };
}

function makeSwapResponse(overrides: Record<string, unknown> = {}) {
  return {
    sellAsset: `ETH.USDC-${USDC}`,
    sellAmount: "1",
    buyAsset: `ETH.WETH-${WETH}`,
    buyAmount: "0.0005",
    routeId: "r1",
    providers: ["THORCHAIN"],
    targetAddress: "0xRouter",
    fees: [{ type: "liquidity", amount: "0.005", asset: `ETH.USDC-${USDC}` }],
    tx: {
      to: "0xRouter",
      data: "0xcalldata",
      value: "0",
      gas: "150000",
    },
    ...overrides,
  };
}

// --- Tests ------------------------------------------------------------------

describe("SwapDKSwapEvm", () => {
  let account: ReturnType<typeof createMockAccount>;
  let swap: SwapDKSwapEvm;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    account = createMockAccount();
    swap = new SwapDKSwapEvm(account, defaultConfig);
    swap.setSourceChain("ethereum");

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

  describe("WDK contract", () => {
    it("extends SwapProtocol from @tetherto/wdk-wallet", () => {
      expect(swap).toBeInstanceOf(SwapProtocol);
    });

    it("has swap and quoteSwap methods", () => {
      expect(typeof swap.swap).toBe("function");
      expect(typeof swap.quoteSwap).toBe("function");
    });
  });

  describe("quoteSwap", () => {
    it("returns fee, tokenInAmount and tokenOutAmount", async () => {
      stubFetchResponses(makeQuoteResponse());

      const result = await swap.quoteSwap({
        tokenIn: USDC,
        tokenOut: WETH,
        tokenInAmount: 1_000_000n,
      });

      expect(result.fee).toBe(150000n);
      expect(result.tokenInAmount).toBe(1000000n);
      expect(result.tokenOutAmount).toBe(500000000000000n);
    });

    it("sends correct sellAsset and buyAsset on the same chain", async () => {
      stubFetchResponses(makeQuoteResponse());

      await swap.quoteSwap({ tokenIn: USDC, tokenOut: WETH, tokenInAmount: 1n });

      const quoteBody = JSON.parse(
        fetchSpy.mock.calls.find((c: unknown[]) =>
          (c[0] as string).endsWith("/quote"),
        )![1].body,
      );
      expect(quoteBody.sellAsset).toBe(`ETH.USDC-${USDC}`);
      expect(quoteBody.buyAsset).toBe(`ETH.WETH-${WETH}`);
      expect(quoteBody.includeTx).toBe(false);
    });

    it("returns fee 0n when route has no tx gas", async () => {
      stubFetchResponses(makeQuoteResponse({ tx: { to: "0xRouter", data: "0x" } }));

      const result = await swap.quoteSwap({ tokenIn: USDC, tokenOut: WETH, tokenInAmount: 1n });

      expect(result.fee).toBe(0n);
    });

    it("sends native token as CHAIN.SYMBOL without address suffix", async () => {
      const NATIVE = "0x0000000000000000000000000000000000000000";
      stubFetchResponses(makeQuoteResponse());

      await swap.quoteSwap({ tokenIn: NATIVE, tokenOut: WETH, tokenInAmount: 1n });

      const quoteBody = JSON.parse(
        fetchSpy.mock.calls.find((c: unknown[]) =>
          (c[0] as string).endsWith("/quote"),
        )![1].body,
      );
      expect(quoteBody.sellAsset).toBe("ETH.ETH");
    });

    it("throws SwapDKUserError when tokenInAmount is missing", async () => {
      await expect(
        swap.quoteSwap({ tokenIn: USDC, tokenOut: WETH }),
      ).rejects.toBeInstanceOf(SwapDKUserError);
    });

    it("throws SwapDKProviderError when no routes found", async () => {
      stubFetchResponses({
        quoteId: "q1",
        routes: [],
        providerErrors: [{ errorCode: "NO_POOL", provider: "THORCHAIN", message: "no pool" }],
      });

      await expect(
        swap.quoteSwap({ tokenIn: USDC, tokenOut: WETH, tokenInAmount: 1n }),
      ).rejects.toBeInstanceOf(SwapDKProviderError);
    });

    it("throws SwapDKProviderError when no routes and no providerErrors", async () => {
      stubFetchResponses({ quoteId: "q1", routes: [] });

      await expect(
        swap.quoteSwap({ tokenIn: USDC, tokenOut: WETH, tokenInAmount: 1n }),
      ).rejects.toBeInstanceOf(SwapDKProviderError);
    });

    it("defaults sourceChain to ethereum when setSourceChain was not called", async () => {
      const freshSwap = new SwapDKSwapEvm(account, defaultConfig);
      stubFetchResponses(makeQuoteResponse());

      await freshSwap.quoteSwap({ tokenIn: USDC, tokenOut: WETH, tokenInAmount: 1n });

      const body = JSON.parse(
        fetchSpy.mock.calls.find((c: unknown[]) =>
          (c[0] as string).endsWith("/quote"),
        )![1].body,
      );
      expect(body.sellAsset).toMatch(/^ETH\./);
    });

    it("sends native tokenOut as CHAIN.SYMBOL", async () => {
      const NATIVE = "0x0000000000000000000000000000000000000000";
      stubFetchResponses(makeQuoteResponse());

      await swap.quoteSwap({ tokenIn: USDC, tokenOut: NATIVE, tokenInAmount: 1n });

      const body = JSON.parse(
        fetchSpy.mock.calls.find((c: unknown[]) =>
          (c[0] as string).endsWith("/quote"),
        )![1].body,
      );
      expect(body.buyAsset).toBe("ETH.ETH");
    });

    it("picks the best route when swap-engine returns a zero-quote route first", async () => {
      // Reproduces live swap-engine behaviour for same-chain USDC → WETH:
      // MAYACHAIN returns a zero-quote route before the real CHAINFLIP one.
      const res = makeQuoteResponse();
      res.routes = [
        { ...res.routes[0], providers: ["MAYACHAIN"], routeId: "maya", expectedBuyAmount: "0" },
        { ...res.routes[0], providers: ["CHAINFLIP"], routeId: "chainflip", expectedBuyAmount: "0.0005" },
      ];
      stubFetchResponses(res);

      const result = await swap.quoteSwap({
        tokenIn: USDC,
        tokenOut: WETH,
        tokenInAmount: 1_000_000n,
      });

      expect(result.tokenOutAmount).toBe(500_000_000_000_000n); // 0.0005 WETH in wei
    });

    it("throws SwapDKProviderError when all routes have zero amount", async () => {
      const res = makeQuoteResponse();
      res.routes = [
        { ...res.routes[0], expectedBuyAmount: "0" },
        { ...res.routes[0], expectedBuyAmount: "0" },
      ];
      stubFetchResponses(res);

      await expect(
        swap.quoteSwap({ tokenIn: USDC, tokenOut: WETH, tokenInAmount: 1n }),
      ).rejects.toBeInstanceOf(SwapDKProviderError);
    });
  });

  describe("swap", () => {
    it("executes the full same-chain swap flow", async () => {
      stubFetchResponses(makeQuoteResponse(), makeSwapResponse());

      const result = await swap.swap({
        tokenIn: USDC,
        tokenOut: WETH,
        tokenInAmount: 1_000_000n,
      });

      expect(result.hash).toBe("0xTxHash");
      expect(result.tokenInAmount).toBe(1000000n);
      expect(result.tokenOutAmount).toBe(500000000000000n);
      expect(result.fee).toBe(150000n);
      expect(result.approveHash).toBeUndefined();
      expect(account.sendTransaction).toHaveBeenCalledOnce();
    });

    it("uses sender address as recipient by default", async () => {
      stubFetchResponses(makeQuoteResponse(), makeSwapResponse());

      await swap.swap({ tokenIn: USDC, tokenOut: WETH, tokenInAmount: 1n });

      const swapBody = JSON.parse(fetchSpy.mock.calls[1][1].body);
      expect(swapBody.destinationAddress).toBe("0xSender");
    });

    it("uses custom recipient when to is provided", async () => {
      stubFetchResponses(makeQuoteResponse(), makeSwapResponse());

      await swap.swap({
        tokenIn: USDC,
        tokenOut: WETH,
        tokenInAmount: 1n,
        to: "0xRecipient",
      });

      const swapBody = JSON.parse(fetchSpy.mock.calls[1][1].body);
      expect(swapBody.destinationAddress).toBe("0xRecipient");
    });

    it("sends approve tx and waits before swap tx", async () => {
      account.sendTransaction
        .mockResolvedValueOnce("0xApproveHash")
        .mockResolvedValueOnce("0xSwapHash");

      stubFetchResponses(
        makeQuoteResponse(),
        makeSwapResponse({
          approvalTx: { to: "0xToken", data: "0xapprove", gasLimit: "50000" },
        }),
      );

      const result = await swap.swap({
        tokenIn: USDC,
        tokenOut: WETH,
        tokenInAmount: 1n,
      });

      expect(result.approveHash).toBe("0xApproveHash");
      expect(result.hash).toBe("0xSwapHash");
      expect(account.waitForTransaction).toHaveBeenCalledWith("0xApproveHash");
    });

    it("throws SwapDKUserError when no tx data returned", async () => {
      stubFetchResponses(makeQuoteResponse(), makeSwapResponse({ tx: undefined }));

      await expect(
        swap.swap({ tokenIn: USDC, tokenOut: WETH, tokenInAmount: 1n }),
      ).rejects.toBeInstanceOf(SwapDKUserError);
    });

    it("does not retry on non-stale errors from /swap", async () => {
      stubFetchResponses(makeQuoteResponse());
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ errorCode: "BAD_PARAM", message: "invalid" }),
        text: () => Promise.resolve(JSON.stringify({ errorCode: "BAD_PARAM", message: "invalid" })),
      });

      await expect(
        swap.swap({ tokenIn: USDC, tokenOut: WETH, tokenInAmount: 1n }),
      ).rejects.toThrow("BAD_PARAM");

      expect(fetchSpy).toHaveBeenCalledTimes(2); // /quote + /swap only
    });

    it("proceeds without waitForTransaction when it is not implemented", async () => {
      const simpleAccount: EvmWalletAccount = {
        getAddress: () => "0xSender",
        sendTransaction: vi.fn()
          .mockResolvedValueOnce("0xApproveHash")
          .mockResolvedValueOnce("0xSwapHash"),
      };
      const simpleSwap = new SwapDKSwapEvm(simpleAccount, defaultConfig);
      simpleSwap.setSourceChain("ethereum");

      stubFetchResponses(
        makeQuoteResponse(),
        makeSwapResponse({ approvalTx: { to: "0xToken", data: "0xapprove" } }),
      );

      const result = await simpleSwap.swap({ tokenIn: USDC, tokenOut: WETH, tokenInAmount: 1n });
      expect(result.approveHash).toBe("0xApproveHash");
      expect(result.hash).toBe("0xSwapHash");
    });

    it("handles approvalTx with a non-zero value", async () => {
      account.sendTransaction
        .mockResolvedValueOnce("0xApproveHash")
        .mockResolvedValueOnce("0xSwapHash");

      stubFetchResponses(
        makeQuoteResponse(),
        makeSwapResponse({
          approvalTx: { to: "0xToken", data: "0xapprove", value: "1000", gasLimit: "50000" },
        }),
      );

      const result = await swap.swap({ tokenIn: USDC, tokenOut: WETH, tokenInAmount: 1n });

      expect(account.sendTransaction.mock.calls[0][0]).toMatchObject({ value: 1000n });
      expect(result.approveHash).toBe("0xApproveHash");
    });

    it("returns fee 0n and sends value 0n when tx has no gas or value", async () => {
      stubFetchResponses(
        makeQuoteResponse(),
        makeSwapResponse({ tx: { to: "0xRouter", data: "0xcalldata" } }),
      );

      const result = await swap.swap({ tokenIn: USDC, tokenOut: WETH, tokenInAmount: 1n });

      expect(result.fee).toBe(0n);
      expect(account.sendTransaction.mock.calls[0][0]).toMatchObject({ value: 0n, gas: undefined });
    });

    it("re-quotes and retries when routeId is stale", async () => {
      stubFetchResponses(makeQuoteResponse());
      fetchSpy.mockResolvedValueOnce({
        ok: false, status: 404,
        json: () => Promise.resolve({ message: "not found" }),
        text: () => Promise.resolve(""),
      });
      stubFetchResponses(makeQuoteResponse(), makeSwapResponse());

      const result = await swap.swap({
        tokenIn: USDC,
        tokenOut: WETH,
        tokenInAmount: 1n,
      });

      expect(result.hash).toBe("0xTxHash");
      expect(fetchSpy).toHaveBeenCalledTimes(4);
    });
  });

  describe("swapMaxFee enforcement", () => {
    it("throws SwapDKUserError when fee exceeds swapMaxFee", async () => {
      const strictSwap = new SwapDKSwapEvm(account, {
        ...defaultConfig,
        swapMaxFee: 100n, // route has gas: "150000"
      });
      strictSwap.setSourceChain("ethereum");
      stubFetchResponses(makeQuoteResponse());

      await expect(
        strictSwap.swap({ tokenIn: USDC, tokenOut: WETH, tokenInAmount: 1n }),
      ).rejects.toBeInstanceOf(SwapDKUserError);
    });

    it("does not throw when fee is within swapMaxFee", async () => {
      const strictSwap = new SwapDKSwapEvm(account, {
        ...defaultConfig,
        swapMaxFee: 500_000n,
      });
      strictSwap.setSourceChain("ethereum");
      stubFetchResponses(makeQuoteResponse(), makeSwapResponse());

      await expect(
        strictSwap.swap({ tokenIn: USDC, tokenOut: WETH, tokenInAmount: 1n }),
      ).resolves.toBeDefined();
    });
  });
});
