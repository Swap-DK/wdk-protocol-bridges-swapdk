import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SwapDKClient } from "@swapdk/wdk-protocol-bridge-swapdk-common";
import { SwapDKApiError, SwapDKNetworkError } from "@swapdk/wdk-protocol-bridge-swapdk-common";

const API_URL = "https://api.swapdk.test";
const API_KEY = "test-key";

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
  });
});
