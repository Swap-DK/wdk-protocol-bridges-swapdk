import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SwapDKClient } from "@swapdk/swap-engine-client";
import { SwapDKApiError, SwapDKNetworkError } from "@swapdk/swap-engine-client";

const API_URL = "https://api.swapdk.test";
const API_KEY = "test-key";

/**
 * Complete TrackResponse fixture. zod (added in swap-engine-client 0.2.0)
 * rejects partial shapes — every required field must be present. Real
 * swap-engine /track responses populate these as zero-value sentinels for
 * unfilled state ("" for unknown addresses, 0 for not-yet-finalised),
 * so this fixture mirrors that.
 */
const TRACK_RESPONSE_FIXTURE = {
  chainId: "ETH",
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

describe("SwapDKClient", () => {
  let client: SwapDKClient;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new SwapDKClient(API_URL, API_KEY, { retries: 0 });
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(body: unknown, status = 200) {
    fetchSpy.mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    });
  }

  describe("quote", () => {
    it("sends POST to /quote with correct headers", async () => {
      const responseBody = { quoteId: "q1", routes: [] };
      stubFetch(responseBody);

      const req = {
        sellAsset: "ETH.ETH",
        buyAsset: "BTC.BTC",
        sellAmount: "1000000000000000000",
      };
      const result = await client.quote(req);

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe(`${API_URL}/quote`);
      expect(init.method).toBe("POST");
      expect(init.headers["Content-Type"]).toBe("application/json");
      expect(init.headers["x-api-key"]).toBe(API_KEY);
      expect(JSON.parse(init.body)).toEqual(req);
      expect(result).toEqual(responseBody);
    });

    it("strips trailing slashes from apiUrl", async () => {
      const clientSlash = new SwapDKClient(API_URL + "///", API_KEY, { retries: 0 });
      stubFetch({ quoteId: "q1", routes: [] });

      await clientSlash.quote({ sellAsset: "ETH.ETH", buyAsset: "BTC.BTC", sellAmount: "1" });

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toBe(`${API_URL}/quote`);
    });

    it("passes AbortSignal to fetch", async () => {
      stubFetch({ quoteId: "q1", routes: [] });

      await client.quote({ sellAsset: "ETH.ETH", buyAsset: "BTC.BTC", sellAmount: "1" });

      const [, init] = fetchSpy.mock.calls[0];
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });
  });

  describe("track", () => {
    it("sends POST to /track with hash + chainId in the body", async () => {
      stubFetch({ ...TRACK_RESPONSE_FIXTURE, status: "completed" });

      await client.track({ hash: "0xabc", chainId: "ETH" });

      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe(`${API_URL}/track`);
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({ hash: "0xabc", chainId: "ETH" });
    });

    it("threads depositAddress through to the request body", async () => {
      stubFetch({ ...TRACK_RESPONSE_FIXTURE, status: "swapping" });

      await client.track({
        hash: "0xabc",
        chainId: "BTC",
        depositAddress: "bc1qchainfliprandomdepositchanneladdr",
      });

      const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(requestBody.depositAddress).toBe("bc1qchainfliprandomdepositchanneladdr");
    });

    it("accepts depositAddress alone (no hash)", async () => {
      stubFetch({ ...TRACK_RESPONSE_FIXTURE, status: "not_started" });

      await client.track({ depositAddress: "bc1qstandalone" });

      const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(requestBody.depositAddress).toBe("bc1qstandalone");
      expect(requestBody.hash).toBeUndefined();
    });
  });

  describe("openBrokerChannel", () => {
    it("sends POST to /chainflip/broker/channel with the request shape verbatim", async () => {
      const responseBody = {
        depositAddress: "bc1qchainflipdepositxxxxxxxxxxxxxxxx",
        channelId: "6739624-Bitcoin-2562",
        explorerUrl: "https://scan.chainflip.io/channels/6739624-Bitcoin-2562",
        error: "",
      };
      stubFetch(responseBody);

      const req = {
        sellAsset: { chain: "Bitcoin", asset: "BTC" },
        buyAsset:  { chain: "Ethereum", asset: "ETH" },
        destinationAddress: "0xRecipientAddrxxxxxxxxxxxxxxxxxxx",
        refundParameters: {
          refundAddress: "bc1qrefundaddressxxxxxxxxxxxxxxxxxx",
          minPrice: "0x0",
          retryDuration: 100,
        },
      };

      const result = await client.openBrokerChannel(req);

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe(`${API_URL}/chainflip/broker/channel`);
      expect(init.method).toBe("POST");
      expect(init.headers["x-api-key"]).toBe(API_KEY);
      expect(JSON.parse(init.body)).toEqual(req);
      expect(result).toEqual(responseBody);
    });

    it("passes sellAmount through to the broker channel request (arms min-deposit guard)", async () => {
      stubFetch({
        depositAddress: "bc1qchainflipdepositxxxxxxxxxxxxxxxx",
        channelId: "7000000-Bitcoin-2",
        explorerUrl: "",
        error: "",
      });

      // sellAmount must reach swap-engine so CheckChainflipMinimumDeposit
      // can pre-reject sub-min channels. Chainflip does NOT refund
      // sub-minimum deposits; without this field the guard is dormant.
      const req = {
        sellAsset: { chain: "Bitcoin", asset: "BTC" },
        buyAsset:  { chain: "Ethereum", asset: "ETH" },
        destinationAddress: "0xRecipient",
        refundParameters: { refundAddress: "bc1qrefund" },
        sellAmount: "0.0007",
      };

      await client.openBrokerChannel(req);

      const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(requestBody.sellAmount).toBe("0.0007");
    });

    it("passes through optional dca/affiliate/boost fields when supplied", async () => {
      stubFetch({
        depositAddress: "bc1qchainflipdepositxxxxxxxxxxxxxxxx",
        channelId: "7000000-Bitcoin-1",
        explorerUrl: "",
        error: "",
      });

      const req = {
        sellAsset: { chain: "Bitcoin", asset: "BTC" },
        buyAsset:  { chain: "Ethereum", asset: "USDC" },
        destinationAddress: "0xRecipient",
        refundParameters: { refundAddress: "bc1qrefund" },
        dcaParameters: { chunkInterval: 2, numberOfChunks: 4 },
        maxBoostFeeBps: 30,
        affiliateFees: [{ brokerAddress: "cFAffiliateXyz", feeBps: 10 }],
      };

      await client.openBrokerChannel(req);

      const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(requestBody.dcaParameters).toEqual({ chunkInterval: 2, numberOfChunks: 4 });
      expect(requestBody.maxBoostFeeBps).toBe(30);
      expect(requestBody.affiliateFees).toEqual([{ brokerAddress: "cFAffiliateXyz", feeBps: 10 }]);
    });

    it("surfaces SwapDKApiError on 4xx (e.g. missing refundAddress)", async () => {
      stubFetch(
        { error: "refundParameters.refundAddress is required for Chainflip" },
        400,
      );

      const req = {
        sellAsset: { chain: "Bitcoin", asset: "BTC" },
        buyAsset:  { chain: "Ethereum", asset: "ETH" },
        destinationAddress: "0xRecipient",
      };

      await expect(client.openBrokerChannel(req)).rejects.toThrow(SwapDKApiError);
    });
  });

  describe("swap", () => {
    it("sends POST to /swap", async () => {
      const responseBody = {
        sellAsset: "ETH.ETH",
        sellAmount: "1",
        buyAsset: "BTC.BTC",
        buyAmount: "100",
        routeId: "r1",
        providers: ["THORCHAIN"],
        targetAddress: "0x123",
        fees: [],
      };
      stubFetch(responseBody);

      const req = {
        routeId: "r1",
        sourceAddress: "0xabc",
        destinationAddress: "bc1qxyz",
      };
      const result = await client.swap(req);

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toBe(`${API_URL}/swap`);
      expect(result).toEqual(responseBody);
    });
  });

  describe("error handling", () => {
    it("throws SwapDKApiError on 4xx with status and path", async () => {
      stubFetch({ errorCode: "BAD_PARAM", message: "invalid asset" }, 400);

      const err = await client
        .quote({ sellAsset: "X", buyAsset: "Y", sellAmount: "0" })
        .catch((e) => e);

      expect(err).toBeInstanceOf(SwapDKApiError);
      expect(err.status).toBe(400);
      expect(err.path).toBe("/quote");
      expect(err.errorCode).toBe("BAD_PARAM");
      expect(err.message).toContain("SwapDK API error 400 on /quote");
    });

    it("throws SwapDKApiError on 5xx (no retries)", async () => {
      stubFetch({ message: "internal error" }, 500);

      const err = await client
        .quote({ sellAsset: "X", buyAsset: "Y", sellAmount: "0" })
        .catch((e) => e);

      expect(err).toBeInstanceOf(SwapDKApiError);
      expect(err.status).toBe(500);
    });

    it("marks 404 as stale route", async () => {
      stubFetch({ message: "not found" }, 404);

      const err = await client
        .swap({ routeId: "old", sourceAddress: "0x", destinationAddress: "0x" })
        .catch((e) => e);

      expect(err).toBeInstanceOf(SwapDKApiError);
      expect(err.isStaleRoute).toBe(true);
    });

    it("marks 410 as stale route", async () => {
      stubFetch({ message: "gone" }, 410);

      const err = await client
        .swap({ routeId: "old", sourceAddress: "0x", destinationAddress: "0x" })
        .catch((e) => e);

      expect(err).toBeInstanceOf(SwapDKApiError);
      expect(err.isStaleRoute).toBe(true);
    });

    it("marks STALE_ROUTE errorCode as stale route", async () => {
      stubFetch({ errorCode: "STALE_ROUTE", message: "expired" }, 400);

      const err = await client
        .swap({ routeId: "old", sourceAddress: "0x", destinationAddress: "0x" })
        .catch((e) => e);

      expect(err).toBeInstanceOf(SwapDKApiError);
      expect(err.isStaleRoute).toBe(true);
    });

    it("throws SwapDKNetworkError on fetch failure after exhausting retries", async () => {
      fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));

      const err = await client
        .quote({ sellAsset: "X", buyAsset: "Y", sellAmount: "0" })
        .catch((e) => e);

      expect(err).toBeInstanceOf(SwapDKNetworkError);
      expect(err.message).toContain("/quote");
    });
  });

  describe("retry behaviour", () => {
    it("retries on 5xx up to the configured limit", async () => {
      const retryClient = new SwapDKClient(API_URL, API_KEY, { retries: 2, timeoutMs: 5000 });

      // Two 503s then success
      for (let i = 0; i < 2; i++) {
        fetchSpy.mockResolvedValueOnce({
          ok: false,
          status: 503,
          json: () => Promise.resolve({ message: "unavailable" }),
          text: () => Promise.resolve(""),
        });
      }
      stubFetch({ quoteId: "q1", routes: [] });

      const result = await retryClient.quote({ sellAsset: "ETH.ETH", buyAsset: "BTC.BTC", sellAmount: "1" });

      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(result).toEqual({ quoteId: "q1", routes: [] });
    });

    it("does not retry on 4xx", async () => {
      const retryClient = new SwapDKClient(API_URL, API_KEY, { retries: 2 });
      stubFetch({ message: "bad request" }, 400);

      await expect(
        retryClient.quote({ sellAsset: "X", buyAsset: "Y", sellAmount: "0" }),
      ).rejects.toBeInstanceOf(SwapDKApiError);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("retries on network error up to the configured limit", async () => {
      const retryClient = new SwapDKClient(API_URL, API_KEY, { retries: 1, timeoutMs: 5000 });

      fetchSpy.mockRejectedValueOnce(new Error("timeout"));
      stubFetch({ quoteId: "q1", routes: [] });

      const result = await retryClient.quote({ sellAsset: "ETH.ETH", buyAsset: "BTC.BTC", sellAmount: "1" });

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ quoteId: "q1", routes: [] });
    });

    // Opening a Chainflip deposit channel is non-idempotent: a 5xx (or a
    // network drop) may mean the broker already allocated the channel and
    // the response was lost. Retrying would allocate a second channel the
    // caller never sees — funds sent to it would be unrecoverable. See
    // SwapDKClient.NON_IDEMPOTENT_PATHS.
    const brokerReq = {
      sellAsset: { chain: "Bitcoin", asset: "BTC" },
      buyAsset:  { chain: "Ethereum", asset: "ETH" },
      destinationAddress: "0xRecipient",
      refundParameters: { refundAddress: "bc1qrefund" },
    };

    it("does not retry /chainflip/broker/channel on 5xx", async () => {
      const retryClient = new SwapDKClient(API_URL, API_KEY, { retries: 3, timeoutMs: 5000 });
      stubFetch({ message: "broker unreachable" }, 503);

      await expect(retryClient.openBrokerChannel(brokerReq)).rejects.toBeInstanceOf(SwapDKApiError);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("does not retry /chainflip/broker/channel on network error", async () => {
      const retryClient = new SwapDKClient(API_URL, API_KEY, { retries: 3, timeoutMs: 5000 });
      fetchSpy.mockRejectedValue(new Error("ECONNRESET"));

      await expect(retryClient.openBrokerChannel(brokerReq)).rejects.toBeInstanceOf(SwapDKNetworkError);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });
});
