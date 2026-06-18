import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SwapDKBridgeBtc } from "../src/SwapDKBridgeBtc.js";
import { BridgeProtocol } from "@tetherto/wdk-wallet/protocols";
import {
  SwapDKUserError,
  SwapDKProviderError,
} from "@swapdk/swap-engine-client";
import type {
  BtcWalletAccount,
  SwapDKBridgeConfig,
} from "../src/types.js";

// --- Helpers ----------------------------------------------------------------

/**
 * Complete TrackResponse fixture. zod (swap-engine-client 0.2.0) rejects
 * partial shapes; real swap-engine /track responses populate every field
 * with zero-value sentinels for unfilled state ("" for unknown
 * addresses, 0 for not-yet-finalised), so the fixture mirrors that.
 */
const TRACK_RESPONSE_FIXTURE = {
  chainId: "BTC",
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


function createMockAccount(
  address = "bc1qsenderaddressxxxxxxxxxxxxxxxxxxx",
): BtcWalletAccount & {
  sendTransaction: ReturnType<typeof vi.fn>;
} {
  return {
    getAddress: () => address,
    sendTransaction: vi.fn().mockResolvedValue({
      hash: "BTCTXHASH1234",
      fee: 5000n, // 5000 sats
    }),
  };
}

const defaultConfig: SwapDKBridgeConfig = {
  apiUrl: "https://api.swapdk.test",
  apiKey: "test-key",
  retries: 0,
};

// Fixture mirroring the real swap-engine BTC source `/quote` response:
// amounts are human-decimal strings; the route omits `tx` (we build the
// PSBT locally) and instead carries `inboundAddress` + `memo`.
function makeQuoteResponse(overrides: Record<string, unknown> = {}) {
  return {
    quoteId: "q1",
    routes: [
      {
        routeId: "r1",
        providers: ["THORCHAIN"],
        sellAsset: "BTC.BTC",
        sellAmount: "0.01",
        buyAsset: "ETH.ETH",
        expectedBuyAmount: "0.33324564",
        expectedBuyAmountMaxSlippage: "0.32324827",
        inboundAddress: "bc1qayml3n2nyavx0saqjpkz07h0wcpdum59uegwr9",
        targetAddress: "bc1qayml3n2nyavx0saqjpkz07h0wcpdum59uegwr9",
        expiration: String(Math.floor(Date.now() / 1000) + 3600),
        memo: "=:e:0xRecipientAddrxxxxxxxxxxxxxxxxxxxxxxxx:32324827:commission/SDK:444/5",
        fees: [
          { type: "liquidity", amount: "0.0001",  asset: "BTC.BTC" },
          { type: "outbound",  amount: "0.00005", asset: "ETH.ETH" },
        ],
        estimatedTime: { inbound: 600, swap: 6, outbound: 24, total: 630 },
        totalSlippageBps: 300,
      },
    ],
    ...overrides,
  };
}

describe("SwapDKBridgeBtc", () => {
  let account: ReturnType<typeof createMockAccount>;
  let bridge: SwapDKBridgeBtc;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    account = createMockAccount();
    bridge = new SwapDKBridgeBtc(account, defaultConfig);
    bridge.setSourceChain("bitcoin");

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
    it("accepts bitcoin", () => {
      expect(() => bridge.setSourceChain("bitcoin")).not.toThrow();
    });

    it("is case-insensitive", () => {
      expect(() => bridge.setSourceChain("Bitcoin")).not.toThrow();
      expect(() => bridge.setSourceChain("BITCOIN")).not.toThrow();
    });

    it("rejects non-BTC chains", () => {
      expect(() => bridge.setSourceChain("ethereum")).toThrow(SwapDKUserError);
      expect(() => bridge.setSourceChain("thorchain")).toThrow(/Unsupported/);
    });
  });

  // -- quoteBridge ----------------------------------------------------------

  describe("quoteBridge", () => {
    it("returns a quote for BTC.BTC → ETH.ETH", async () => {
      stubFetchResponses(makeQuoteResponse());

      const result = await bridge.quoteBridge({
        targetChain: "ethereum",
        tokenOut: "ETH.ETH",
        amount: 1_000_000n, // 0.01 BTC
        recipient: "0xRecipientAddr",
      });

      // 0.01 BTC → 1_000_000 sats
      expect(result.tokenInAmount).toBe(1_000_000n);
      // 0.33324564 ETH → 333_245_640_000_000_000n in 18 decimals
      expect(result.tokenOutAmount).toBe(333_245_640_000_000_000n);
      expect(result.providers).toEqual(["THORCHAIN"]);
      expect(result.estimatedTime).toBe(630);
      // No source tx fee pre-broadcast.
      expect(result.fee).toBe(0n);
      // bridgeFee from "liquidity" entry: 0.0001 BTC → 10_000n
      expect(result.bridgeFee).toBe(10_000n);
      // Inbound vault + memo are surfaced for UI / debugging.
      expect(result.inboundAddress).toBe("bc1qayml3n2nyavx0saqjpkz07h0wcpdum59uegwr9");
      expect(result.memo).toContain("=:e:");
    });

    it("sends BTC.BTC as the sell asset with human-decimal sellAmount", async () => {
      stubFetchResponses(makeQuoteResponse());

      await bridge.quoteBridge({
        targetChain: "ethereum",
        tokenOut: "ETH.ETH",
        amount: 1_000_000n,
        recipient: "0xRecipientAddr",
      });

      const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(requestBody.sellAsset).toBe("BTC.BTC");
      expect(requestBody.sellAmount).toBe("0.01");
      // includeTx must be false — swap-engine doesn't build BTC PSBTs.
      expect(requestBody.includeTx).toBe(false);
    });

    it("rejects unsupported source token", async () => {
      // Don't stub fetch — should throw before any HTTP call.
      await expect(
        bridge.quoteBridge({
          token: "BTC.USDT-0xabc",
          targetChain: "ethereum",
          tokenOut: "ETH.ETH",
          amount: 1_000_000n,
          recipient: "0xRecipient",
        }),
      ).rejects.toThrow(SwapDKUserError);
    });

    it("returns a quote for a Chainflip-only route (no inboundAddress/memo)", async () => {
      // Chainflip channels are allocated per-swap by /chainflip/broker/channel,
      // not surfaced on /quote. quoteBridge mustn't open a channel — it
      // would consume broker resources just for a preview. Inbound +
      // memo come back empty; bridge() handles channel allocation.
      stubFetchResponses({
        quoteId: "q1",
        routes: [
          {
            ...makeQuoteResponse().routes[0],
            providers: ["CHAINFLIP"],
            inboundAddress: undefined,
            targetAddress: undefined,
            memo: undefined,
            expiration: undefined,
          },
        ],
      });

      const result = await bridge.quoteBridge({
        targetChain: "ethereum",
        tokenOut: "ETH.ETH",
        amount: 1_000_000n,
        recipient: "0xRecipient",
      });
      expect(result.providers).toEqual(["CHAINFLIP"]);
      expect(result.inboundAddress).toBeUndefined();
      expect(result.memo).toBeUndefined();
      // Quote did not call the broker channel endpoint.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0][0]).toContain("/quote");
    });

    it("picks the best route by expectedBuyAmount regardless of provider", async () => {
      // Both providers are now first-class; pickBestRoute ranks purely
      // by output amount. (Was previously THORChain-only via 0.1.1
      // filter; 0.2.0 dispatches to either path.)
      const thor = {
        ...makeQuoteResponse().routes[0],
        providers: ["THORCHAIN"],
        expectedBuyAmount: "0.30000000",
      };
      const chainflip = {
        ...makeQuoteResponse().routes[0],
        routeId: "r2",
        providers: ["CHAINFLIP"],
        expectedBuyAmount: "0.40000000",
        inboundAddress: undefined,
        memo: undefined,
        expiration: undefined,
      };
      stubFetchResponses({ quoteId: "q1", routes: [chainflip, thor] });

      const result = await bridge.quoteBridge({
        targetChain: "ethereum",
        tokenOut: "ETH.ETH",
        amount: 1_000_000n,
        recipient: "0xRecipient",
      });
      // Chainflip wins because it offers higher output.
      expect(result.providers).toEqual(["CHAINFLIP"]);
      expect(result.tokenOutAmount).toBe(400_000_000_000_000_000n);
    });

    it("rejects unknown providers with a clear error", async () => {
      stubFetchResponses({
        quoteId: "q1",
        routes: [
          {
            ...makeQuoteResponse().routes[0],
            providers: ["NEAR_INTENTS"],
          },
        ],
      });

      await expect(
        bridge.quoteBridge({
          targetChain: "ethereum",
          tokenOut: "ETH.ETH",
          amount: 1_000_000n,
          recipient: "0xRecipient",
        }),
      ).rejects.toThrow(/unsupported provider/i);
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
          amount: 1_000_000n,
          recipient: "0xRecipient",
        }),
      ).rejects.toThrow(SwapDKProviderError);
    });
  });

  // -- bridge ---------------------------------------------------------------

  describe("bridge", () => {
    it("broadcasts the BTC tx with the route's inboundAddress + memo (THORChain path)", async () => {
      stubFetchResponses(makeQuoteResponse());

      const result = await bridge.bridge({
        targetChain: "ethereum",
        tokenOut: "ETH.ETH",
        amount: 1_000_000n,
        recipient: "0xRecipientAddr",
      });

      expect(account.sendTransaction).toHaveBeenCalledOnce();
      const args = account.sendTransaction.mock.calls[0][0];
      expect(args.to).toBe("bc1qayml3n2nyavx0saqjpkz07h0wcpdum59uegwr9");
      expect(args.value).toBe(1_000_000n);
      expect(args.memo).toContain("=:e:");

      expect(result.hash).toBe("BTCTXHASH1234");
      expect(result.fee).toBe(5000n); // from the mock wallet
      expect(result.tokenInAmount).toBe(1_000_000n);
      expect(result.tokenOutAmount).toBe(333_245_640_000_000_000n);
      expect(result.provider).toBe("THORCHAIN");
      // Chainflip-only fields stay undefined for the THORChain path.
      expect(result.depositAddress).toBeUndefined();
      expect(result.channelId).toBeUndefined();
    });

    it("threads feeRate through to sendTransaction when configured", async () => {
      bridge = new SwapDKBridgeBtc(account, { ...defaultConfig, feeRate: 20 });
      bridge.setSourceChain("bitcoin");
      stubFetchResponses(makeQuoteResponse());

      await bridge.bridge({
        targetChain: "ethereum",
        tokenOut: "ETH.ETH",
        amount: 1_000_000n,
        recipient: "0xRecipientAddr",
      });

      const args = account.sendTransaction.mock.calls[0][0];
      expect(args.feeRate).toBe(20);
    });

    it("throws if the route has no inboundAddress", async () => {
      stubFetchResponses({
        quoteId: "q1",
        routes: [
          {
            ...makeQuoteResponse().routes[0],
            inboundAddress: undefined,
            targetAddress: undefined,
          },
        ],
      });

      await expect(
        bridge.bridge({
          targetChain: "ethereum",
          tokenOut: "ETH.ETH",
          amount: 1_000_000n,
          recipient: "0xRecipient",
        }),
      ).rejects.toThrow(/no inboundAddress/);
    });

    it("throws if the route has no memo", async () => {
      stubFetchResponses({
        quoteId: "q1",
        routes: [{ ...makeQuoteResponse().routes[0], memo: undefined }],
      });

      await expect(
        bridge.bridge({
          targetChain: "ethereum",
          tokenOut: "ETH.ETH",
          amount: 1_000_000n,
          recipient: "0xRecipient",
        }),
      ).rejects.toThrow(/no memo/);
    });

    it("throws when the inbound vault has already expired", async () => {
      const expired = String(Math.floor(Date.now() / 1000) - 60);
      stubFetchResponses({
        quoteId: "q1",
        routes: [{ ...makeQuoteResponse().routes[0], expiration: expired }],
      });

      await expect(
        bridge.bridge({
          targetChain: "ethereum",
          tokenOut: "ETH.ETH",
          amount: 1_000_000n,
          recipient: "0xRecipient",
        }),
      ).rejects.toThrow(/expired/);
    });

    it("enforces bridgeMaxFee against the route's liquidity fee", async () => {
      bridge = new SwapDKBridgeBtc(account, { ...defaultConfig, bridgeMaxFee: 5_000n });
      bridge.setSourceChain("bitcoin");
      stubFetchResponses(makeQuoteResponse());

      // liquidity fee = 0.0001 BTC = 10_000 sats > 5_000 cap → throws
      await expect(
        bridge.bridge({
          targetChain: "ethereum",
          tokenOut: "ETH.ETH",
          amount: 1_000_000n,
          recipient: "0xRecipient",
        }),
      ).rejects.toThrow(/exceeds bridgeMaxFee/);

      // Wallet must not have been called.
      expect(account.sendTransaction).not.toHaveBeenCalled();
    });
  });

  // -- bridge (Chainflip path) ---------------------------------------------

  describe("bridge — Chainflip path", () => {
    function makeChainflipRoute(overrides: Record<string, unknown> = {}) {
      return {
        quoteId: "q1",
        routes: [
          {
            ...makeQuoteResponse().routes[0],
            providers: ["CHAINFLIP"],
            inboundAddress: undefined,
            targetAddress: undefined,
            memo: undefined,
            expiration: undefined,
            ...overrides,
          },
        ],
      };
    }

    const channelResponse = {
      depositAddress: "bc1qchainflipchanneladdrxxxxxxxxxxxx",
      channelId: "6739624-Bitcoin-2562",
      explorerUrl: "https://scan.chainflip.io/channels/6739624-Bitcoin-2562",
      error: "",
    };

    it("opens a broker channel and broadcasts a plain BTC tx (no memo)", async () => {
      stubFetchResponses(makeChainflipRoute(), channelResponse);

      const result = await bridge.bridge({
        targetChain: "ethereum",
        tokenOut: "ETH.ETH",
        amount: 1_000_000n,
        recipient: "0xRecipientAddr",
      });

      // Two HTTP calls: /quote then /chainflip/broker/channel.
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(fetchSpy.mock.calls[0][0]).toContain("/quote");
      expect(fetchSpy.mock.calls[1][0]).toContain("/chainflip/broker/channel");

      // Deposit goes to the channel-allocated address, no memo.
      const txArgs = account.sendTransaction.mock.calls[0][0];
      expect(txArgs.to).toBe(channelResponse.depositAddress);
      expect(txArgs.value).toBe(1_000_000n);
      expect(txArgs.memo).toBeUndefined();

      // Result surfaces Chainflip-specific identifiers.
      expect(result.provider).toBe("CHAINFLIP");
      expect(result.depositAddress).toBe(channelResponse.depositAddress);
      expect(result.channelId).toBe(channelResponse.channelId);
    });

    it("builds the broker-channel request with Chainflip asset notation", async () => {
      stubFetchResponses(makeChainflipRoute(), channelResponse);

      await bridge.bridge({
        targetChain: "ethereum",
        tokenOut: "ETH.ETH",
        amount: 1_000_000n,
        recipient: "0xRecipientAddr",
      });

      const channelBody = JSON.parse(fetchSpy.mock.calls[1][1].body);
      expect(channelBody.sellAsset).toEqual({ chain: "Bitcoin", asset: "BTC" });
      expect(channelBody.buyAsset).toEqual({ chain: "Ethereum", asset: "ETH" });
      expect(channelBody.destinationAddress).toBe("0xRecipientAddr");
    });

    it("passes route.sellAmount to the broker channel request", async () => {
      // Chainflip doesn't refund sub-minimum deposits; the broker-channel
      // controller pre-checks against minimum_deposit_amount only when
      // sellAmount is present. Without this thread-through the guard
      // added in 40b246b is dormant.
      stubFetchResponses(makeChainflipRoute(), channelResponse);

      await bridge.bridge({
        targetChain: "ethereum",
        tokenOut: "ETH.ETH",
        amount: 1_000_000n,
        recipient: "0xRecipientAddr",
      });

      const channelBody = JSON.parse(fetchSpy.mock.calls[1][1].body);
      // makeChainflipRoute() defaults sellAmount to "0.01" — see the
      // ChainflipRoute fixture at the top of this file.
      expect(channelBody.sellAmount).toBe("0.01");
    });

    it("defaults refundAddress to the sender's BTC address", async () => {
      stubFetchResponses(makeChainflipRoute(), channelResponse);

      await bridge.bridge({
        targetChain: "ethereum",
        tokenOut: "ETH.ETH",
        amount: 1_000_000n,
        recipient: "0xRecipient",
      });

      const channelBody = JSON.parse(fetchSpy.mock.calls[1][1].body);
      expect(channelBody.refundParameters.refundAddress).toBe(await account.getAddress());
      expect(channelBody.refundParameters.minPrice).toBe("0x0");
      expect(channelBody.refundParameters.retryDuration).toBe(100);
    });

    it("propagates a caller-supplied refundAddress override", async () => {
      stubFetchResponses(makeChainflipRoute(), channelResponse);

      await bridge.bridge({
        targetChain: "ethereum",
        tokenOut: "ETH.ETH",
        amount: 1_000_000n,
        recipient: "0xRecipient",
        refundAddress: "bc1qcoldstoragexxxxxxxxxxxxxxxxxxxxx",
        refundMinPrice: "0xFF",
        refundRetryDuration: 250,
      });

      const channelBody = JSON.parse(fetchSpy.mock.calls[1][1].body);
      expect(channelBody.refundParameters.refundAddress).toBe(
        "bc1qcoldstoragexxxxxxxxxxxxxxxxxxxxx",
      );
      expect(channelBody.refundParameters.minPrice).toBe("0xFF");
      expect(channelBody.refundParameters.retryDuration).toBe(250);
    });

    it("threads DCA + boost options into the broker channel request", async () => {
      stubFetchResponses(makeChainflipRoute(), channelResponse);

      await bridge.bridge({
        targetChain: "ethereum",
        tokenOut: "ETH.ETH",
        amount: 1_000_000n,
        recipient: "0xRecipient",
        dcaChunks: 4,
        dcaChunkInterval: 2,
        maxBoostFeeBps: 30,
      });

      const channelBody = JSON.parse(fetchSpy.mock.calls[1][1].body);
      expect(channelBody.dcaParameters).toEqual({
        chunkInterval: 2,
        numberOfChunks: 4,
      });
      expect(channelBody.maxBoostFeeBps).toBe(30);
    });

    it("omits DCA / boost from the request when not supplied", async () => {
      stubFetchResponses(makeChainflipRoute(), channelResponse);

      await bridge.bridge({
        targetChain: "ethereum",
        tokenOut: "ETH.ETH",
        amount: 1_000_000n,
        recipient: "0xRecipient",
      });

      const channelBody = JSON.parse(fetchSpy.mock.calls[1][1].body);
      expect(channelBody.dcaParameters).toBeUndefined();
      expect(channelBody.maxBoostFeeBps).toBeUndefined();
    });

    it("rejects dcaChunks > 1 without dcaChunkInterval", async () => {
      stubFetchResponses(makeChainflipRoute());

      await expect(
        bridge.bridge({
          targetChain: "ethereum",
          tokenOut: "ETH.ETH",
          amount: 1_000_000n,
          recipient: "0xRecipient",
          dcaChunks: 4,
        }),
      ).rejects.toThrow(/dcaChunkInterval/);
    });

    it("resolves USDC liquidity-fee decimals correctly (regression: was 18, must be 6)", async () => {
      // swap-engine reports Chainflip liquidity fees in USDC
      // (`ChainflipIntermediateUSDCAsset` = ETH.USDC-0xA0b8…). A bug
      // in the SwapKit-prefix vs WDK-chain-name lookup made the
      // registry miss and fall back to 18 decimals → 0.16 USDC was
      // surfaced as 1.6×10^17 base units. Asset string contains the
      // contract address in MIXED CASE (matches swap-engine's
      // ChainflipIntermediateUSDCAsset() output exactly).
      stubFetchResponses({
        quoteId: "q1",
        routes: [
          {
            ...makeQuoteResponse().routes[0],
            providers: ["CHAINFLIP"],
            inboundAddress: undefined,
            targetAddress: undefined,
            memo: undefined,
            expiration: undefined,
            fees: [
              {
                type: "liquidity",
                amount: "0.163111",
                asset: "ETH.USDC-0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
              },
            ],
          },
        ],
      });

      const result = await bridge.quoteBridge({
        targetChain: "ethereum",
        tokenOut: "ETH.ETH",
        amount: 1_000_000n,
        recipient: "0xRecipient",
      });

      // 0.163111 USDC × 1e6 = 163_111n base units (USDC has 6 decimals).
      expect(result.bridgeFee).toBe(163_111n);
      // Asset is surfaced verbatim so the caller can format the value
      // with the right decimals / currency label.
      expect(result.bridgeFeeAsset).toBe(
        "ETH.USDC-0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      );
    });

    it("enforces bridgeMaxFee on the Chainflip path too", async () => {
      bridge = new SwapDKBridgeBtc(account, { ...defaultConfig, bridgeMaxFee: 5_000n });
      bridge.setSourceChain("bitcoin");
      stubFetchResponses(makeChainflipRoute());

      await expect(
        bridge.bridge({
          targetChain: "ethereum",
          tokenOut: "ETH.ETH",
          amount: 1_000_000n,
          recipient: "0xRecipient",
        }),
      ).rejects.toThrow(/exceeds bridgeMaxFee/);

      // Channel must not have been opened.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(account.sendTransaction).not.toHaveBeenCalled();
    });
  });

  // -- trackBridge ----------------------------------------------------------

  describe("trackBridge", () => {
    it("returns the parsed body on 200", async () => {
      stubFetchResponses({ ...TRACK_RESPONSE_FIXTURE, status: "completed" });
      const status = await bridge.trackBridge("BTCTX1");
      expect(status?.status).toBe("completed");
    });

    it("returns null for 404 'track_not_found' (not-yet-indexed deposit)", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ errorCode: "track_not_found", message: "not found" }),
        text: () => Promise.resolve('{"errorCode":"track_not_found","message":"not found"}'),
      });
      const status = await bridge.trackBridge("BTCTX1");
      expect(status).toBeNull();
    });

    it("defaults chainId to 'BTC' in the /track body", async () => {
      stubFetchResponses({ ...TRACK_RESPONSE_FIXTURE, status: "pending" });
      await bridge.trackBridge("BTCTX1");
      const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(requestBody.chainId).toBe("BTC");
      expect(requestBody.hash).toBe("BTCTX1");
    });

    it("threads Chainflip depositAddress into the /track body", async () => {
      stubFetchResponses({ ...TRACK_RESPONSE_FIXTURE, status: "swapping" });
      await bridge.trackBridge("BTCTX1", undefined, {
        depositAddress: "bc1qchainflipchanneladdrxxxxxxxxxxxx",
      });
      const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(requestBody.hash).toBe("BTCTX1");
      expect(requestBody.depositAddress).toBe("bc1qchainflipchanneladdrxxxxxxxxxxxx");
    });

    it("accepts empty hash + depositAddress alone (pre-confirmation Chainflip lookup)", async () => {
      stubFetchResponses({ ...TRACK_RESPONSE_FIXTURE, status: "not_started" });
      await bridge.trackBridge("", undefined, {
        depositAddress: "bc1qchainflipchanneladdrxxxxxxxxxxxx",
      });
      const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(requestBody.hash).toBeUndefined();
      expect(requestBody.chainId).toBeUndefined();
      expect(requestBody.depositAddress).toBe("bc1qchainflipchanneladdrxxxxxxxxxxxx");
    });
  });
});
