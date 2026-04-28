import { describe, it, expect } from "vitest";
import { buildNativeTransferWithMemo } from "../src/tx-builder.js";

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

const SOURCE_ADDR = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const DEST_ADDR = "EWDUCYGmoYdzPR6zBfTac4QMLfkGjv2kfKtnz2WyamHw";
const MEMO = "=:e:0xdeadbeef:30000:commission/SDK:444/5";

describe("buildNativeTransferWithMemo", () => {
  it("creates a v0 transaction message with two instructions", () => {
    const msg = buildNativeTransferWithMemo({
      source: SOURCE_ADDR,
      destination: DEST_ADDR,
      lamports: 10_000_000n,
      memo: MEMO,
    });

    expect(msg.version).toBe(0);
    expect(Array.isArray(msg.instructions)).toBe(true);
    expect(msg.instructions).toHaveLength(2);
  });

  it("first instruction is System transfer; second is Memo", () => {
    const msg = buildNativeTransferWithMemo({
      source: SOURCE_ADDR,
      destination: DEST_ADDR,
      lamports: 500n,
      memo: MEMO,
    });
    const [transferIx, memoIx] = msg.instructions;

    expect(transferIx.programAddress).toBe(SYSTEM_PROGRAM);
    expect(memoIx.programAddress).toBe(MEMO_PROGRAM);
  });

  it("transfer instruction references source as signer and destination as writable", () => {
    const msg = buildNativeTransferWithMemo({
      source: SOURCE_ADDR,
      destination: DEST_ADDR,
      lamports: 1n,
      memo: "x",
    });
    const transferIx = msg.instructions[0];
    expect(transferIx.accounts).toBeDefined();
    // @ts-expect-error — Instruction generic doesn't narrow here.
    expect(transferIx.accounts?.[0].address).toBe(SOURCE_ADDR);
    // @ts-expect-error
    expect(transferIx.accounts?.[1].address).toBe(DEST_ADDR);
  });

  it("memo instruction carries the memo bytes as data", () => {
    const msg = buildNativeTransferWithMemo({
      source: SOURCE_ADDR,
      destination: DEST_ADDR,
      lamports: 1n,
      memo: MEMO,
    });
    const memoIx = msg.instructions[1];
    const decoded = new TextDecoder().decode(memoIx.data as Uint8Array);
    expect(decoded).toBe(MEMO);
  });

  it("preserves arbitrary lamport amounts (bigint)", () => {
    const msg = buildNativeTransferWithMemo({
      source: SOURCE_ADDR,
      destination: DEST_ADDR,
      lamports: 123_456_789_000n,
      memo: "x",
    });
    const transferIx = msg.instructions[0];
    // Instruction data: [4-byte discriminator][8-byte LE amount].
    const bytes = transferIx.data as Uint8Array;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const amount = dv.getBigUint64(4, true);
    expect(amount).toBe(123_456_789_000n);
  });
});
