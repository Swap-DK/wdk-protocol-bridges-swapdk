// ---------------------------------------------------------------------------
// Network-mocked coverage for SwapDKSwidge — the class layer between
// swap-engine HTTP endpoints and the source-chain adapters.
//
// Adapter unit tests (see tests/adapters/*.test.ts) cover the tx-building
// side. This file covers the HTTP-shaped interactions:
//   - getSupportedChains / getSupportedTokens (GET proxies)
//   - quoteSwidge (POST /quote + response mapping to SwidgeQuote)
//   - getSwidgeStatus (POST /track + status mapping)
//   - swidge() end-to-end (POST /quote → POST /swap → adapter → SwidgeResult)
//
// Only fetch is stubbed; adapters run for real, so this also exercises
// the wiring between context assembly in SwapDKSwidge.swidge() and each
// adapter's execute() shape.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SwapDKSwidge } from "../src/SwapDKSwidge.js";

const API = "https://api.swapdk.test";
const KEY = "test-key";

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

describe("SwapDKSwidge — HTTP layer", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // -- discovery -----------------------------------------------------------

  describe("getSupportedChains / getSupportedTokens", () => {
    it("proxies GET /chains and returns the swidge-native array", async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse([
          { id: "ethereum", name: "Ethereum", type: "evm", nativeToken: "ETH" },
          { id: "bitcoin", name: "Bitcoin", type: "bitcoin", nativeToken: "BTC" },
        ]),
      );
      const swidge = new SwapDKSwidge(undefined, { apiUrl: API, apiKey: KEY });
      const chains = await swidge.getSupportedChains();
      expect(chains).toHaveLength(2);
      expect(chains[0]).toEqual({
        id: "ethereum",
        name: "Ethereum",
        type: "evm",
        nativeToken: "ETH",
      });

      // Verify: fetch hit /chains, GET method, x-api-key set.
      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe(`${API}/chains`);
      expect(init.method).toBe("GET");
      expect(init.headers["x-api-key"]).toBe(KEY);
    });

    it("threads getSupportedTokens filters into ?shape=swidge&…", async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse([
          {
            token: "ETH",
            chain: "ethereum",
            symbol: "ETH",
            decimals: 18,
          },
        ]),
      );
      const swidge = new SwapDKSwidge(undefined, { apiUrl: API, apiKey: KEY });
      await swidge.getSupportedTokens({ fromChain: "ethereum" });

      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain(`${API}/tokens?`);
      expect(url).toContain("shape=swidge");
      expect(url).toContain("fromChain=ethereum");
    });

    it("passes no options through as ?shape=swidge alone", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse([]));
      const swidge = new SwapDKSwidge(undefined, { apiUrl: API, apiKey: KEY });
      await swidge.getSupportedTokens();
      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toBe(`${API}/tokens?shape=swidge`);
    });
  });

  // -- quoteSwidge --------------------------------------------------------

  describe("quoteSwidge", () => {
    function makeQuoteResp(
      overrides: Partial<{
        sellAmount: string;
        expectedBuyAmount: string;
        expectedBuyAmountMaxSlippage: string;
        fees: Array<{ type: string; amount: string; asset: string }>;
        totalSlippageBps: number;
        estimatedTimeTotal: number;
      }> = {},
    ) {
      return {
        quoteId: "q-1",
        routes: [
          {
            routeId: "r-1",
            providers: ["THORCHAIN"],
            sellAsset: "ETH.ETH",
            sellAmount: overrides.sellAmount ?? "0.5",
            buyAsset: "BTC.BTC",
            expectedBuyAmount: overrides.expectedBuyAmount ?? "0.01",
            expectedBuyAmountMaxSlippage:
              overrides.expectedBuyAmountMaxSlippage ?? "0.0097",
            fees: overrides.fees ?? [
              { type: "liquidity", amount: "0.001", asset: "ETH.ETH" },
              { type: "outbound", amount: "0.00005", asset: "BTC.BTC" },
            ],
            targetAddress: "0xVault",
            inboundAddress: "0xVault",
            memo: "",
            estimatedTime: {
              inbound: 30,
              swap: 60,
              outbound: (overrides.estimatedTimeTotal ?? 900) - 90,
              total: overrides.estimatedTimeTotal ?? 900,
            },
            totalSlippageBps: overrides.totalSlippageBps ?? 300,
          },
        ],
      };
    }

    it("posts to /quote and maps the best route into a SwidgeQuote", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(makeQuoteResp()));
      const swidge = new SwapDKSwidge(undefined, { apiUrl: API, apiKey: KEY });

      const quote = await swidge.quoteSwidge({
        fromToken: "ETH",
        fromChain: "ethereum",
        toToken: "BTC",
        toChain: "bitcoin",
        fromTokenAmount: 500_000_000_000_000_000n, // 0.5 ETH
        recipient: "bc1qrecipient",
      });

      // Amount fields — sellAmount "0.5" @ 18 dec, buyAmount "0.01" @ 8 dec.
      expect(quote.fromTokenAmount).toBe(500_000_000_000_000_000n);
      expect(quote.toTokenAmount).toBe(1_000_000n); // 0.01 BTC → 1,000,000 sats
      expect(quote.toTokenAmountMin).toBe(970_000n); // 0.0097 BTC → 970,000 sats

      // Fees mapped: liquidity → protocol, outbound → network.
      expect(quote.fees).toHaveLength(2);
      expect(quote.fees[0].type).toBe("protocol");
      expect(quote.fees[0].token).toBe("ETH.ETH");
      expect(quote.fees[1].type).toBe("network");
      expect(quote.fees[1].token).toBe("BTC.BTC");

      expect(quote.estimatedDuration).toBe(900);

      // Request check: POST /quote, includeTx:false, chain-qualified sellAsset.
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe(`${API}/quote`);
      expect(init.method).toBe("POST");
      const body = JSON.parse(init.body);
      expect(body.sellAsset).toBe("ETH.ETH");
      expect(body.buyAsset).toBe("BTC.BTC");
      expect(body.sellAmount).toBe("0.5");
      expect(body.destinationAddress).toBe("bc1qrecipient");
      expect(body.includeTx).toBe(false);
      // Slippage translated from swidge decimal (spec: 0.03 = 3%) to
      // swap-engine basis-points integer (300 = 3%). Server rejects a
      // decimal payload as `400 invalid request`; this assertion is
      // the regression guard for that.
      expect(body.slippage).toBe(300);
    });

    it("translates SwidgeOptions.slippage (decimal) to swap-engine basis points (integer)", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(makeQuoteResp()));
      const swidge = new SwapDKSwidge(undefined, { apiUrl: API, apiKey: KEY });
      await swidge.quoteSwidge({
        fromToken: "ETH",
        fromChain: "ethereum",
        toToken: "BTC",
        toChain: "bitcoin",
        fromTokenAmount: 500_000_000_000_000_000n,
        slippage: 0.01, // 1% decimal → 100 bps integer
      });
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.slippage).toBe(100);
    });

    it("uses defaultSlippage from config when options omit slippage", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(makeQuoteResp()));
      const swidge = new SwapDKSwidge(undefined, {
        apiUrl: API,
        apiKey: KEY,
        defaultSlippage: 0.005, // 0.5% decimal → 50 bps
      });
      await swidge.quoteSwidge({
        fromToken: "ETH",
        fromChain: "ethereum",
        toToken: "BTC",
        toChain: "bitcoin",
        fromTokenAmount: 500_000_000_000_000_000n,
      });
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.slippage).toBe(50);
    });

    it("encodes ERC-20 fromToken as CHAIN.T-<address> SwapKit identifier", async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          quoteId: "q-1",
          routes: [
            {
              routeId: "r-1",
              providers: ["THORCHAIN"],
              sellAsset: "ETH.USDC-0xA0b86991C6218b36C1d19D4a2e9Eb0cE3606eB48",
              sellAmount: "100",
              buyAsset: "BTC.BTC",
              expectedBuyAmount: "0.001",
              expectedBuyAmountMaxSlippage: "0.00097",
              fees: [],
              targetAddress: "0xVault",
              inboundAddress: "0xVault",
              memo: "",
              estimatedTime: { inbound: 30, swap: 60, outbound: 510, total: 600 },
              totalSlippageBps: 100,
            },
          ],
        }),
      );
      const swidge = new SwapDKSwidge(undefined, { apiUrl: API, apiKey: KEY });
      await swidge.quoteSwidge({
        fromToken: "0xA0b86991C6218b36C1d19D4a2e9Eb0cE3606eB48",
        fromChain: "ethereum",
        toToken: "BTC",
        toChain: "bitcoin",
        fromTokenAmount: 100_000_000n, // 100 USDC (6 dec)
      });
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      // Placeholder ticker "T" then the address — swap-engine's parser
      // reads only the address suffix.
      expect(body.sellAsset).toBe(
        "ETH.T-0xA0b86991C6218b36C1d19D4a2e9Eb0cE3606eB48",
      );
    });

    it("uses defaultFromChain from config when options omit fromChain", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(makeQuoteResp()));
      const swidge = new SwapDKSwidge(undefined, {
        apiUrl: API,
        apiKey: KEY,
        defaultFromChain: "ethereum",
      });
      await swidge.quoteSwidge({
        fromToken: "ETH",
        toToken: "BTC",
        toChain: "bitcoin",
        fromTokenAmount: 500_000_000_000_000_000n,
      });
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.sellAsset).toBe("ETH.ETH");
    });

    it("rejects when neither options.fromChain nor config.defaultFromChain is set", async () => {
      const swidge = new SwapDKSwidge(undefined, { apiUrl: API, apiKey: KEY });
      await expect(
        swidge.quoteSwidge({
          fromToken: "ETH",
          toToken: "BTC",
          toChain: "bitcoin",
          fromTokenAmount: 500_000_000_000_000_000n,
        }),
      ).rejects.toThrow(/fromChain is required/);
    });

    it("rejects exact-out (toTokenAmount) as unsupported by swap-engine", async () => {
      const swidge = new SwapDKSwidge(undefined, { apiUrl: API, apiKey: KEY });
      await expect(
        swidge.quoteSwidge({
          fromToken: "ETH",
          fromChain: "ethereum",
          toToken: "BTC",
          toChain: "bitcoin",
          toTokenAmount: 1_000_000n,
        }),
      ).rejects.toThrow(/exact-out.*not yet supported/);
    });

    it("surfaces SwapDKUserError when swap-engine returns no usable route", async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          quoteId: "q-1",
          routes: [],
          providerErrors: [
            { errorCode: "no_pool", provider: "THORCHAIN", message: "no pool" },
          ],
        }),
      );
      const swidge = new SwapDKSwidge(undefined, { apiUrl: API, apiKey: KEY });
      await expect(
        swidge.quoteSwidge({
          fromToken: "ETH",
          fromChain: "ethereum",
          toToken: "BTC",
          toChain: "bitcoin",
          fromTokenAmount: 500_000_000_000_000_000n,
        }),
      ).rejects.toThrow(/no route/);
    });
  });

  // -- getSwidgeStatus ----------------------------------------------------

  describe("getSwidgeStatus", () => {
    function makeTrackResp(overrides: Partial<{
      status: string;
      legs: Array<{ hash: string; chainId: string; type: string }>;
    }> = {}) {
      return {
        chainId: "ETH",
        hash: "0xhash",
        block: 12345,
        type: "swap",
        status: overrides.status ?? "completed",
        trackingStatus: overrides.status ?? "completed",
        fromAsset: "ETH.ETH",
        fromAmount: "0.5",
        fromAddress: "0xSender",
        toAsset: "BTC.BTC",
        toAmount: "0.01",
        toAddress: "bc1qrecipient",
        finalisedAt: 1_700_000_000,
        legs: overrides.legs ?? [
          { hash: "0xsource", chainId: "ETH", type: "swap", status: "completed",
            trackingStatus: "completed", fromAsset: "ETH.ETH", fromAmount: "0.5",
            fromAddress: "0xSender", toAsset: "ETH.ETH", toAmount: "0.5",
            toAddress: "0xVault", block: 12345, finalisedAt: 1_700_000_000 },
          { hash: "0xoutbound", chainId: "BTC", type: "outbound", status: "completed",
            trackingStatus: "completed", fromAsset: "BTC.BTC", fromAmount: "0.01",
            fromAddress: "bc1qvault", toAsset: "BTC.BTC", toAmount: "0.01",
            toAddress: "bc1qrecipient", block: 800000, finalisedAt: 1_700_000_100 },
        ],
      };
    }

    it("maps status='completed' + legs to SwidgeStatusResult", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(makeTrackResp()));
      const swidge = new SwapDKSwidge(undefined, { apiUrl: API, apiKey: KEY });
      const status = await swidge.getSwidgeStatus("0xhash", { fromChain: "ethereum" });
      expect(status.status).toBe("completed");
      expect(status.transactions).toHaveLength(2);
      expect(status.transactions?.[0].hash).toBe("0xsource");
      expect(status.transactions?.[0].type).toBe("source");
      expect(status.transactions?.[1].hash).toBe("0xoutbound");
      expect(status.transactions?.[1].type).toBe("destination");
    });

    it.each([
      ["pending", "pending"],
      ["swapping", "pending"],
      ["not_started", "pending"],
      ["failed", "failed"],
      ["refunded", "refunded"],
    ])("maps track status %o → swidge status %o", async (trackStatus, expected) => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(makeTrackResp({ status: trackStatus })),
      );
      const swidge = new SwapDKSwidge(undefined, { apiUrl: API, apiKey: KEY });
      const status = await swidge.getSwidgeStatus("0xhash");
      expect(status.status).toBe(expected);
    });

    it("returns { status: 'pending' } on track_not_found (transient early-state)", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: () =>
          Promise.resolve({ errorCode: "track_not_found", message: "nf" }),
        text: () =>
          Promise.resolve('{"errorCode":"track_not_found","message":"nf"}'),
      });
      const swidge = new SwapDKSwidge(undefined, { apiUrl: API, apiKey: KEY });
      const status = await swidge.getSwidgeStatus("0xhash");
      expect(status.status).toBe("pending");
      expect(status.transactions).toBeUndefined();
    });

    it("rejects on empty id", async () => {
      const swidge = new SwapDKSwidge(undefined, { apiUrl: API, apiKey: KEY });
      await expect(swidge.getSwidgeStatus("")).rejects.toThrow(/id is required/);
    });
  });

  // -- swidge() end-to-end (EVM source) -----------------------------------

  describe("swidge() end-to-end (EVM source)", () => {
    function makeQuoteResp() {
      return {
        quoteId: "q-1",
        routes: [
          {
            routeId: "r-1",
            providers: ["THORCHAIN"],
            sellAsset: "ETH.ETH",
            sellAmount: "0.5",
            buyAsset: "BTC.BTC",
            expectedBuyAmount: "0.01",
            expectedBuyAmountMaxSlippage: "0.0097",
            fees: [
              { type: "liquidity", amount: "0.001", asset: "ETH.ETH" },
              { type: "outbound", amount: "0.00005", asset: "BTC.BTC" },
            ],
            targetAddress: "0xRouter",
            inboundAddress: "0xRouter",
            memo: "",
            estimatedTime: { inbound: 30, swap: 60, outbound: 810, total: 900 },
            totalSlippageBps: 300,
          },
        ],
      };
    }

    function makeSwapResp(overrides: Partial<{
      approvalTx: { to: string; data: string; value?: string; gasLimit?: string };
      txData: string;
    }> = {}) {
      return {
        sellAsset: "ETH.ETH",
        sellAmount: "0.5",
        buyAsset: "BTC.BTC",
        buyAmount: "0.01",
        routeId: "r-1",
        providers: ["THORCHAIN"],
        targetAddress: "0xRouter",
        inboundAddress: "0xRouter",
        memo: "",
        fees: [
          { type: "liquidity", amount: "0.001", asset: "ETH.ETH" },
          { type: "outbound", amount: "0.00005", asset: "BTC.BTC" },
        ],
        tx: {
          to: "0xRouter",
          data: overrides.txData ?? "0xdeposit",
          value: "500000000000000000",
          gas: "200000",
        },
        ...(overrides.approvalTx ? { approvalTx: overrides.approvalTx } : {}),
      };
    }

    function mockEvmAccount() {
      return {
        getAddress: () => "0xSender",
        sendTransaction: vi.fn().mockResolvedValue({ hash: "0xTxHash" }),
        waitForTransaction: vi.fn().mockResolvedValue(undefined),
      };
    }

    it("runs /quote → /swap → adapter.sendTransaction and returns SwidgeResult", async () => {
      fetchSpy
        .mockResolvedValueOnce(jsonResponse(makeQuoteResp()))
        .mockResolvedValueOnce(jsonResponse(makeSwapResp()));

      const account = mockEvmAccount();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const swidge = new SwapDKSwidge(account as any, { apiUrl: API, apiKey: KEY });

      const result = await swidge.swidge({
        fromToken: "ETH",
        fromChain: "ethereum",
        toToken: "BTC",
        toChain: "bitcoin",
        fromTokenAmount: 500_000_000_000_000_000n,
        recipient: "bc1qrecipient",
      });

      // Two HTTP calls (quote + swap), one wallet broadcast.
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(fetchSpy.mock.calls[0][0]).toBe(`${API}/quote`);
      expect(fetchSpy.mock.calls[1][0]).toBe(`${API}/swap`);
      expect(account.sendTransaction).toHaveBeenCalledOnce();
      const txArg = account.sendTransaction.mock.calls[0][0];
      expect(txArg.to).toBe("0xRouter");
      expect(txArg.data).toBe("0xdeposit");
      expect(txArg.value).toBe(500_000_000_000_000_000n);
      expect(txArg.gas).toBe(200_000n);

      // SwidgeResult shape.
      expect(result.hash).toBe("0xTxHash");
      expect(result.id).toBe("0xTxHash");
      expect(result.fromTokenAmount).toBe(500_000_000_000_000_000n);
      expect(result.toTokenAmount).toBe(1_000_000n);
      expect(result.transactions).toEqual([
        { hash: "0xTxHash", chain: "ethereum", type: "source" },
      ]);
      expect(result.fees).toHaveLength(2);
    });

    it("does two broadcasts (approve + main) when swap-engine returns approvalTx", async () => {
      fetchSpy
        .mockResolvedValueOnce(jsonResponse(makeQuoteResp()))
        .mockResolvedValueOnce(
          jsonResponse(
            makeSwapResp({
              approvalTx: {
                to: "0xUSDC",
                data: "0xapprove",
                value: "0",
                gasLimit: "60000",
              },
            }),
          ),
        );

      const account = mockEvmAccount();
      account.sendTransaction = vi
        .fn()
        .mockResolvedValueOnce({ hash: "0xApproveHash" })
        .mockResolvedValueOnce({ hash: "0xBridgeHash" });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const swidge = new SwapDKSwidge(account as any, { apiUrl: API, apiKey: KEY });
      const result = await swidge.swidge({
        fromToken: "ETH",
        fromChain: "ethereum",
        toToken: "BTC",
        toChain: "bitcoin",
        fromTokenAmount: 500_000_000_000_000_000n,
        recipient: "bc1qrecipient",
      });

      expect(account.sendTransaction).toHaveBeenCalledTimes(2);
      expect(account.waitForTransaction).toHaveBeenCalledWith("0xApproveHash");
      expect(result.hash).toBe("0xBridgeHash");
      expect(result.transactions).toEqual([
        { hash: "0xApproveHash", chain: "ethereum", type: "approval" },
        { hash: "0xBridgeHash", chain: "ethereum", type: "source" },
      ]);
    });

    it("re-quotes once on isStaleRoute and retries /swap", async () => {
      fetchSpy
        // 1st /quote
        .mockResolvedValueOnce(jsonResponse(makeQuoteResp()))
        // 1st /swap → stale
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          json: () =>
            Promise.resolve({ errorCode: "ROUTE_NOT_FOUND", message: "stale" }),
          text: () =>
            Promise.resolve('{"errorCode":"ROUTE_NOT_FOUND","message":"stale"}'),
        })
        // Re-quote
        .mockResolvedValueOnce(jsonResponse(makeQuoteResp()))
        // 2nd /swap succeeds
        .mockResolvedValueOnce(jsonResponse(makeSwapResp()));

      const account = mockEvmAccount();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const swidge = new SwapDKSwidge(account as any, { apiUrl: API, apiKey: KEY });
      const result = await swidge.swidge({
        fromToken: "ETH",
        fromChain: "ethereum",
        toToken: "BTC",
        toChain: "bitcoin",
        fromTokenAmount: 500_000_000_000_000_000n,
        recipient: "bc1qrecipient",
      });

      // 4 HTTP calls total.
      expect(fetchSpy).toHaveBeenCalledTimes(4);
      expect(result.hash).toBe("0xTxHash");
    });

    it("throws when swap-engine's /swap response has no tx (EVM adapter surfaces)", async () => {
      fetchSpy
        .mockResolvedValueOnce(jsonResponse(makeQuoteResp()))
        .mockResolvedValueOnce(
          jsonResponse({ ...makeSwapResp(), tx: undefined }),
        );

      const account = mockEvmAccount();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const swidge = new SwapDKSwidge(account as any, { apiUrl: API, apiKey: KEY });
      await expect(
        swidge.swidge({
          fromToken: "ETH",
          fromChain: "ethereum",
          toToken: "BTC",
          toChain: "bitcoin",
          fromTokenAmount: 500_000_000_000_000_000n,
          recipient: "bc1qrecipient",
        }),
      ).rejects.toThrow(/no transaction data/);
    });

    it("skips /swap for a BTC source and dispatches from /quote alone", async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          quoteId: "q-1",
          routes: [
            {
              routeId: "r-btc",
              providers: ["THORCHAIN"],
              sellAsset: "BTC.BTC",
              sellAmount: "0.01",
              buyAsset: "ETH.ETH",
              expectedBuyAmount: "0.3",
              expectedBuyAmountMaxSlippage: "0.29",
              fees: [],
              targetAddress: "bc1qVault",
              inboundAddress: "bc1qVault",
              memo: "=:ETH.ETH:0xRecipient:0/1/0",
              estimatedTime: { inbound: 30, swap: 60, outbound: 510, total: 600 },
              totalSlippageBps: 100,
            },
          ],
        }),
      );

      const btcAccount = {
        getAddress: () => "bc1qsource",
        sendTransaction: vi
          .fn()
          .mockResolvedValue({ hash: "BTCTXHASH", fee: 500n }),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const swidge = new SwapDKSwidge(btcAccount as any, {
        apiUrl: API,
        apiKey: KEY,
      });

      const result = await swidge.swidge({
        fromToken: "BTC",
        fromChain: "bitcoin",
        toToken: "ETH",
        toChain: "ethereum",
        fromTokenAmount: 1_000_000n,
        recipient: "0xRecipient",
      });

      // Only ONE HTTP call — /quote. No /swap because BTC's adapter
      // declares needsSwapResponse: false.
      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(fetchSpy.mock.calls[0][0]).toBe(`${API}/quote`);
      expect(btcAccount.sendTransaction).toHaveBeenCalledOnce();
      const btcTx = btcAccount.sendTransaction.mock.calls[0][0];
      expect(btcTx.to).toBe("bc1qVault");
      expect(btcTx.memo).toBe("=:ETH.ETH:0xRecipient:0/1/0");
      expect(btcTx.value).toBe(1_000_000n); // 0.01 BTC → 1,000,000 sats

      expect(result.hash).toBe("BTCTXHASH");
      // SwidgeResult amount fields fall back to /quote when /swap wasn't fetched.
      expect(result.fromTokenAmount).toBe(1_000_000n);
      expect(result.toTokenAmount).toBe(300_000_000_000_000_000n); // 0.3 ETH in wei
    });

    it("rejects when constructed without an account (read-only mode)", async () => {
      const swidge = new SwapDKSwidge(undefined, { apiUrl: API, apiKey: KEY });
      await expect(
        swidge.swidge({
          fromToken: "ETH",
          fromChain: "ethereum",
          toToken: "BTC",
          toChain: "bitcoin",
          fromTokenAmount: 1n,
        }),
      ).rejects.toThrow(/writable wallet account/);
    });
  });
});
