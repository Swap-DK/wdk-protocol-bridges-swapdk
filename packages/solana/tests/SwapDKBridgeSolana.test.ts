import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SwapDKBridgeSolana } from "../src/SwapDKBridgeSolana.js";
import { BridgeProtocol } from "@tetherto/wdk-wallet/protocols";
import { SwapDKUserError, SwapDKApiError } from "@swapdk/wdk-protocol-bridge-swapdk-common";
import type { SolanaWalletAccount, SwapDKBridgeConfig, TrackResponse } from "../src/types.js";

const SOURCE_ADDR = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const INBOUND_VAULT = "EWDUCYGmoYdzPR6zBfTac4QMLfkGjv2kfKtnz2WyamHw";

function makeAccount() {
  return {
    getAddress: () => SOURCE_ADDR,
    sendTransaction: vi.fn().mockResolvedValue({ hash: "0xSolTxHash", fee: 5000n }),
    waitForTransaction: vi.fn().mockResolvedValue(undefined),
  } as SolanaWalletAccount & {
    sendTransaction: ReturnType<typeof vi.fn>;
    waitForTransaction: ReturnType<typeof vi.fn>;
  };
}

const cfg: SwapDKBridgeConfig = {
  apiUrl: "https://api.swapdk.test",
  apiKey: "test-key",
  retries: 0,
};

function makeQuoteResponse(overrides: Record<string, unknown> = {}) {
  return {
    quoteId: "q1",
    routes: [
      {
        routeId: "r1",
        providers: ["THORCHAIN"],
        sellAsset: "SOL.SOL",
        sellAmount: "1",
        buyAsset: "ETH.ETH",
        expectedBuyAmount: "0.03",
        expectedBuyAmountMaxSlippage: "0.0291",
        inboundAddress: INBOUND_VAULT,
        targetAddress: INBOUND_VAULT,
        expiration: "1776954529",
        memo: "=:e:0xe89E…:29100:commission/SDK:444/5",
        fees: [
          { type: "inbound", amount: "0", asset: "SOL.SOL" },
          { type: "liquidity", amount: "0.00005", asset: "ETH.ETH" },
        ],
        estimatedTime: { inbound: 30, swap: 6, outbound: 24, total: 60 },
        totalSlippageBps: 100,
        ...overrides,
      },
    ],
  };
}

function makeTrackResponse(overrides: Partial<TrackResponse> = {}): TrackResponse {
  return {
    chainId: "SOL",
    hash: "0xSolTxHash",
    block: 10,
    type: "swap",
    status: "pending",
    trackingStatus: "pending",
    fromAsset: "SOL~SOL",
    fromAmount: "1",
    fromAddress: SOURCE_ADDR,
    toAsset: "ETH~ETH",
    toAmount: "0.03",
    toAddress: "0xe89E",
    finalisedAt: -1,
    meta: { provider: "THORCHAIN", providerAction: "swap" },
    payload: {},
    legs: [],
    ...overrides,
  };
}

describe("SwapDKBridgeSolana", () => {
  let account: ReturnType<typeof makeAccount>;
  let bridge: SwapDKBridgeSolana;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    account = makeAccount();
    bridge = new SwapDKBridgeSolana(account, cfg);
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function stub(body: unknown, status = 200) {
    fetchSpy.mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    });
  }

  describe("WDK contract", () => {
    it("extends BridgeProtocol", () => {
      expect(bridge).toBeInstanceOf(BridgeProtocol);
    });

    it("has bridge / quoteBridge methods", () => {
      expect(typeof bridge.bridge).toBe("function");
      expect(typeof bridge.quoteBridge).toBe("function");
    });
  });

  describe("quoteBridge", () => {
    it("sends correct sellAsset / buyAsset / sellAmount (human-decimal)", async () => {
      stub(makeQuoteResponse());

      await bridge.quoteBridge({
        targetChain: "ethereum",
        recipient: "0xe89E",
        token: "",
        amount: 1_000_000_000n, // 1 SOL in lamports
      });

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.sellAsset).toBe("SOL.SOL");
      expect(body.buyAsset).toBe("ETH.ETH");
      expect(body.sellAmount).toBe("1");
      expect(body.includeTx).toBe(false);
    });

    it("returns parsed amounts + inboundAddress + memo + expiration + fee", async () => {
      stub(makeQuoteResponse());

      const result = await bridge.quoteBridge({
        targetChain: "ethereum",
        recipient: "0xe89E",
        token: "",
        amount: 1_000_000_000n,
      });

      expect(result.tokenInAmount).toBe(1_000_000_000n); // 1 SOL in lamports
      expect(result.tokenOutAmount).toBe(30_000_000_000_000_000n); // 0.03 ETH in wei
      expect(result.fee).toBe(5_000n);                    // SOLANA_BASE_FEE_LAMPORTS
      expect(result.inboundAddress).toBe(INBOUND_VAULT);
      expect(result.memo).toContain("=:e:");
      expect(result.expiration).toBe(1776954529);
      expect(result.estimatedTime).toBe(60);
      expect(result.providers).toEqual(["THORCHAIN"]);
    });

    it("throws SwapDKUserError when amount is undefined", async () => {
      await expect(
        bridge.quoteBridge({
          targetChain: "ethereum",
          recipient: "0xe89E",
          token: "",
        }),
      ).rejects.toBeInstanceOf(SwapDKUserError);
    });

    it("picks best route, not routes[0]", async () => {
      const res = makeQuoteResponse();
      res.routes = [
        { ...res.routes[0], routeId: "zero", expectedBuyAmount: "0" },
        { ...res.routes[0], routeId: "good", expectedBuyAmount: "0.03" },
      ];
      stub(res);

      const result = await bridge.quoteBridge({
        targetChain: "ethereum",
        recipient: "0xe89E",
        token: "",
        amount: 1_000_000_000n,
      });
      expect(result.tokenOutAmount).toBe(30_000_000_000_000_000n);
    });
  });

  describe("bridge", () => {
    it("rejects SPL source (MVP is native SOL only)", async () => {
      await expect(
        bridge.bridge({
          targetChain: "ethereum",
          recipient: "0xe89E",
          token: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          amount: 100_000n,
        }),
      ).rejects.toBeInstanceOf(SwapDKUserError);
    });

    it("sends a transactionMessage (instructions array) to the wallet", async () => {
      stub(makeQuoteResponse());

      const result = await bridge.bridge({
        targetChain: "ethereum",
        recipient: "0xe89E",
        token: "",
        amount: 1_000_000_000n,
      });

      expect(account.sendTransaction).toHaveBeenCalledOnce();
      const txArg = account.sendTransaction.mock.calls[0][0];
      expect(Array.isArray(txArg.instructions)).toBe(true);
      expect(txArg.instructions).toHaveLength(2);
      // Transfer (SystemProgram) + memo (Memo Program).
      expect(txArg.instructions[0].programAddress).toBe("11111111111111111111111111111111");
      expect(txArg.instructions[1].programAddress).toBe("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

      expect(result.hash).toBe("0xSolTxHash");
      expect(result.fee).toBe(5000n);
      expect(result.tokenInAmount).toBe(1_000_000_000n);
      expect(result.tokenOutAmount).toBe(30_000_000_000_000_000n);
    });

    it("awaits the wallet's waitForTransaction when provided", async () => {
      stub(makeQuoteResponse());
      await bridge.bridge({
        targetChain: "ethereum",
        recipient: "0xe89E",
        token: "",
        amount: 1_000_000_000n,
      });
      expect(account.waitForTransaction).toHaveBeenCalledWith("0xSolTxHash");
    });

    it("throws SwapDKUserError when route has no inboundAddress/memo", async () => {
      const res = makeQuoteResponse();
      res.routes[0].inboundAddress = undefined as unknown as string;
      res.routes[0].memo = undefined as unknown as string;
      stub(res);

      await expect(
        bridge.bridge({
          targetChain: "ethereum",
          recipient: "0xe89E",
          token: "",
          amount: 1_000_000_000n,
        }),
      ).rejects.toThrow("no inboundAddress/memo");
    });

    it("enforces bridgeMaxFee pre-broadcast against SOLANA_BASE_FEE_LAMPORTS", async () => {
      const strict = new SwapDKBridgeSolana(account, { ...cfg, bridgeMaxFee: 100n });
      // No /quote stub: pre-broadcast check must throw before any HTTP call.

      await expect(
        strict.bridge({
          targetChain: "ethereum",
          recipient: "0xe89E",
          token: "",
          amount: 1_000_000_000n,
        }),
      ).rejects.toBeInstanceOf(SwapDKUserError);

      // Critical assertion: we never reached the wallet or swap-engine.
      expect(account.sendTransaction).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("does not enforce bridgeMaxFee when the limit is at or above the base fee", async () => {
      const lenient = new SwapDKBridgeSolana(account, { ...cfg, bridgeMaxFee: 5_000n });
      stub(makeQuoteResponse());

      const result = await lenient.bridge({
        targetChain: "ethereum",
        recipient: "0xe89E",
        token: "",
        amount: 1_000_000_000n,
      });
      expect(result.hash).toBe("0xSolTxHash");
    });
  });

  describe("trackBridge + waitForBridge", () => {
    it("defaults chainId to SOL", async () => {
      stub(makeTrackResponse({ status: "completed" }));
      await bridge.trackBridge("0xSolTxHash");
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.chainId).toBe("SOL");
    });

    it("trackBridge returns null on 404 track_not_found", async () => {
      stub({ error: "track_not_found", message: "not found" }, 404);
      const result = await bridge.trackBridge("0xSolTxHash");
      expect(result).toBeNull();
    });

    it("trackBridge propagates non-404 errors", async () => {
      stub({ error: "track_failed", message: "upstream" }, 502);
      await expect(bridge.trackBridge("0xSolTxHash")).rejects.toBeInstanceOf(SwapDKApiError);
    });

    it("waitForBridge resolves on terminal status", async () => {
      stub(makeTrackResponse({ status: "pending" }));
      stub(makeTrackResponse({ status: "completed" }));

      vi.useFakeTimers();
      const promise = bridge.waitForBridge("0xSolTxHash", undefined, {
        pollIntervalMs: 500,
        timeoutMs: 10_000,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      const final = await promise;
      expect(final.status).toBe("completed");
    });

    it("waitForBridge times out", async () => {
      for (let i = 0; i < 20; i++) stub(makeTrackResponse({ status: "pending" }));

      vi.useFakeTimers();
      const promise = bridge.waitForBridge("0xSolTxHash", undefined, {
        pollIntervalMs: 1_000,
        timeoutMs: 2_500,
      });
      const caught = promise.catch((e) => e);
      await vi.advanceTimersByTimeAsync(3_000);
      const err = await caught;
      expect(err).toBeInstanceOf(SwapDKUserError);
    });
  });
});
