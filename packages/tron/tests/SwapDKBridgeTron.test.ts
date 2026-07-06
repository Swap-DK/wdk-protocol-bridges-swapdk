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

// Structural mock of the tronweb subset the bridge touches (see
// `TronWebLike` in src/types.ts). Each builder call returns a distinct
// `txID` so tests can verify the correct prebuilt tx reached
// `account.sendTransaction`.
function createMockTronWeb() {
  return {
    address: {
      // Base58 → hex conversion is not exercised in the bridge beyond
      // being handed to `triggerSmartContract` as the issuer address.
      // We return a deterministic stub so assertions can pin the exact
      // value passed through.
      toHex: vi.fn((addr: string) => "41HEX_" + addr),
    },
    feeLimit: 100_000_000,
    transactionBuilder: {
      triggerSmartContract: vi.fn(
        async (
          contract: string,
          _selector: string,
          options: { feeLimit?: number; callValue?: number; input?: string },
          _params: unknown[],
          issuer: string,
        ) => ({
          transaction: {
            txID: `PREBUILT_CONTRACT_${contract}`,
            _contract: contract,
            _input: options?.input,
            _callValue: options?.callValue ?? 0,
            _feeLimit: options?.feeLimit,
            _issuer: issuer,
          },
        }),
      ),
      sendTrx: vi.fn(async (to: string, value: number, from: string) => ({
        txID: "PREBUILT_TRANSFER_BASE",
        _to: to,
        _value: value,
        _from: from,
      })),
      addUpdateData: vi.fn(
        async (tx: Record<string, unknown>, data: string, encoding?: string) => ({
          ...tx,
          txID: "PREBUILT_TRANSFER_WITHMEMO",
          _memo: data,
          _encoding: encoding,
        }),
      ),
    },
  };
}

// Default config is rebuilt in beforeEach so each test gets fresh spies.
let defaultConfig: SwapDKBridgeConfig;
let tronWebMock: ReturnType<typeof createMockTronWeb>;

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

// Fixture for /swap response — direct-vault deposit shape used when
// THORChain has the TRON pool unhalted for trading but no router
// contract deployed. tx.data is empty, tx.memo carries the routing
// instruction, and tx.to is the vault (not a router).
const SAMPLE_VAULT = "TN6WohfEwrrrSed2PzsjJMNHLaqVGHceLt";
const SAMPLE_MEMO = "=:e:0xFff8:367591:SDK:5";
function makeSwapResponseTrxDirectVault(overrides: Record<string, unknown> = {}) {
  return {
    sellAsset: "TRON.TRX",
    sellAmount: "100",
    buyAsset: "ETH.ETH",
    buyAmount: "0.00531",
    routeId: "r1",
    providers: ["THORCHAIN"],
    targetAddress: SAMPLE_VAULT,
    inboundAddress: SAMPLE_VAULT,
    memo: SAMPLE_MEMO,
    tx: {
      to: SAMPLE_VAULT,
      from: "TUserSourceAddrxxxxxxxxxxxxxxxxxxxx",
      value: "100000000", // 100 TRX in SUN
      data: "",           // empty — direct vault transfer, not contract call
      memo: SAMPLE_MEMO,  // routing instruction → raw_data.data on the tx
      feeLimit: "30000000",
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
    tronWebMock = createMockTronWeb();
    defaultConfig = {
      apiUrl: "https://api.swapdk.test",
      apiKey: "test-key",
      retries: 0,
      tronWeb: tronWebMock,
    };
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

      // Bridge should have driven tronweb.transactionBuilder to build
      // the router-contract call: raw calldata via `options.input`,
      // callValue = full sell amount (SUN), feeLimit = SwapTx.feeLimit,
      // issuer = hex-encoded source address.
      expect(tronWebMock.transactionBuilder.triggerSmartContract)
        .toHaveBeenCalledOnce();
      const [contract, selector, options, params, issuer] =
        tronWebMock.transactionBuilder.triggerSmartContract.mock.calls[0];
      expect(contract).toBe(SAMPLE_ROUTER);
      expect(selector).toBe(""); // empty selector = tronweb uses raw options.input
      expect(options.callValue).toBe(100_000_000); // 100 TRX SUN
      expect(options.feeLimit).toBe(100_000_000);
      expect(options.input).toBe(SAMPLE_TX_DATA.replace(/^0x/, ""));
      expect(params).toEqual([]);
      expect(issuer).toBe("41HEX_TUserSourceAddrxxxxxxxxxxxxxxxxxxxx");

      // account.sendTransaction receives the prebuilt tx tronweb produced.
      const prebuilt = account.sendTransaction.mock.calls[0][0];
      expect(prebuilt.txID).toBe(`PREBUILT_CONTRACT_${SAMPLE_ROUTER}`);
      // The direct-vault builders must NOT have been touched.
      expect(tronWebMock.transactionBuilder.sendTrx).not.toHaveBeenCalled();
      expect(tronWebMock.transactionBuilder.addUpdateData).not.toHaveBeenCalled();

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

  // -- bridge (native TRX, direct-vault deposit) ----------------------------
  //
  // Transitional THORChain state mid-2026: TRON pool unhalted for
  // trading but router contract missing from inbound_addresses.
  // swap-engine emits a SwapTx with `data: ""` and `memo` set; the
  // bridge module must thread `memo` through to the wallet so it
  // builds a TransferContract (with memo embedded in raw_data.data)
  // rather than a TriggerSmartContract.
  describe("bridge — native TRX, direct-vault path", () => {
    it("builds a TransferContract-with-memo tx and hands it to wallet.sendTransaction", async () => {
      stubFetchResponses(makeQuoteResponse(), makeSwapResponseTrxDirectVault());

      const result = await bridge.bridge({
        targetChain: "ethereum",
        tokenOut: "ETH.ETH",
        amount: 100_000_000n,
        recipient: "0xFff8",
      });

      // Bridge should build a TRX transfer to the vault (base58 to,
      // full sellAmount as SUN, base58 from), then attach the memo as
      // raw_data.data via addUpdateData(tx, memo, "utf8").
      expect(tronWebMock.transactionBuilder.sendTrx).toHaveBeenCalledOnce();
      const [to, value, from] =
        tronWebMock.transactionBuilder.sendTrx.mock.calls[0];
      expect(to).toBe(SAMPLE_VAULT);
      expect(value).toBe(100_000_000); // full sellAmount, not callValue
      expect(from).toBe("TUserSourceAddrxxxxxxxxxxxxxxxxxxxx"); // base58, not hex

      expect(tronWebMock.transactionBuilder.addUpdateData).toHaveBeenCalledOnce();
      const [baseTx, memo, encoding] =
        tronWebMock.transactionBuilder.addUpdateData.mock.calls[0];
      expect(baseTx.txID).toBe("PREBUILT_TRANSFER_BASE");
      expect(memo).toBe(SAMPLE_MEMO);
      expect(encoding).toBe("utf8");

      // The router builder must NOT have fired for a direct-vault route.
      expect(tronWebMock.transactionBuilder.triggerSmartContract)
        .not.toHaveBeenCalled();

      // account.sendTransaction receives the memo-carrying tx (fresh txID).
      expect(account.sendTransaction).toHaveBeenCalledOnce();
      const prebuilt = account.sendTransaction.mock.calls[0][0];
      expect(prebuilt.txID).toBe("PREBUILT_TRANSFER_WITHMEMO");
      expect(prebuilt._memo).toBe(SAMPLE_MEMO);

      expect(result.hash).toBe("TRONTXHASH123");
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

      // Two triggerSmartContract calls (approve + bridge), no direct-vault path.
      expect(tronWebMock.transactionBuilder.triggerSmartContract)
        .toHaveBeenCalledTimes(2);
      expect(tronWebMock.transactionBuilder.sendTrx).not.toHaveBeenCalled();

      // First call = approval to USDT contract, callValue=0, approve calldata.
      const [approveContract, , approveOptions] =
        tronWebMock.transactionBuilder.triggerSmartContract.mock.calls[0];
      expect(approveContract).toBe(SAMPLE_USDT_CONTRACT);
      expect(approveOptions.callValue).toBe(0);
      expect(approveOptions.input).toBe(SAMPLE_APPROVE_DATA.replace(/^0x/, ""));
      expect(approveOptions.feeLimit).toBe(100_000_000);
      // account.sendTransaction call #0 = the prebuilt approve tx.
      expect(account.sendTransaction.mock.calls[0][0].txID)
        .toBe(`PREBUILT_CONTRACT_${SAMPLE_USDT_CONTRACT}`);

      // We wait for the approval to land before sending the bridge tx.
      expect(account.waitForTransaction).toHaveBeenCalledOnce();
      expect(account.waitForTransaction.mock.calls[0][0]).toBe("TRONTXHASH123");

      // Second call = depositWithExpiry on the router, callValue=0
      // (tokens come via the allowance, not callValue), bridge calldata.
      const [bridgeContract, , bridgeOptions] =
        tronWebMock.transactionBuilder.triggerSmartContract.mock.calls[1];
      expect(bridgeContract).toBe(SAMPLE_ROUTER);
      expect(bridgeOptions.callValue).toBe(0);
      expect(bridgeOptions.input).toBe(SAMPLE_TX_DATA.replace(/^0x/, ""));
      expect(bridgeOptions.feeLimit).toBe(150_000_000);
      expect(account.sendTransaction.mock.calls[1][0].txID)
        .toBe(`PREBUILT_CONTRACT_${SAMPLE_ROUTER}`);

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
