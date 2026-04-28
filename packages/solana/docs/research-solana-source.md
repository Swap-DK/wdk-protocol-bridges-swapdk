# Research: Solana as a source chain

> **Status (2026-04-23):** Shipped in v0.1.0 — native SOL source works
> end-to-end via THORChain. SPL-token source is a known gap tracked in
> the roadmap.

## Goal

Build `@swapdk/wdk-protocol-bridge-swapdk-solana` so a WDK app can swap
native SOL (eventually also SPL tokens) to any destination asset
supported by swap-engine (ETH, USDC on EVM chains, BTC, LTC, DOGE,
TRON). Routing is via THORChain (and potentially MAYAChain), mirroring
the EVM source module's architecture.

## swap-engine side — works

Live `/quote` against `dev-api.swapdk.com` with `sellAsset: "SOL.SOL"`:

```bash
curl -X POST "$DEV_URL/quote" -H "x-api-key: $DEV_KEY" -H "Content-Type: application/json" -d '{
  "sellAsset": "SOL.SOL",
  "buyAsset":  "ETH.ETH",
  "sellAmount": "1",
  "sourceAddress":      "7xKXtg…",
  "destinationAddress": "0x…",
  "slippage": 300,
  "includeTx": true
}'
```

Response (abridged):

```json
{
  "routes": [{
    "providers": ["THORCHAIN"],
    "sellAsset": "SOL.SOL",
    "sellAmount": "1",
    "buyAsset": "ETH.ETH",
    "expectedBuyAmount": "0.03668193",
    "inboundAddress":    "EWDUCYGmoYdzPR6zBfTac4QMLfkGjv2kfKtnz2WyamHw",
    "targetAddress":     "EWDUCYGmoYdzPR6zBfTac4QMLfkGjv2kfKtnz2WyamHw",
    "expiration":        "1776954529",
    "memo":              "=:e:0xe89E…:3558147:commission/SDK:0/5",
    "fees":              [ /* inbound / liquidity / affiliate / service / outbound */ ],
    "estimatedTime":     { "total": 60, "inbound": 30, "swap": 6, "outbound": 24 }
  }]
}
```

Shape is identical to the BTC case (we documented that in
`../../wdk-protocol-bridge-swapdk-evm/docs/research-btc-source.md`):
`inboundAddress` + `memo` + `expiration` carry everything the client
needs to construct a deposit transaction. `/swap` is unused for Solana
source — there's no EVM-style `tx` calldata to prepare.

`estimatedTime.inbound` is ~30 s for SOL vs ~600 s for BTC, which is
why `waitForBridge` on this module defaults to a 5 s poll interval
instead of 15 s.

## WDK side — unblocked

Inspected `@tetherto/wdk-wallet-solana@1.0.0-beta.7`
([source](https://github.com/tetherto/wdk-wallet-solana)).

### Stack

- `@solana/addresses`, `@solana/transaction-messages`, `@solana/transactions`,
  `@solana/signers`, `@solana/keys` — the modern Solana Web3.js v2 stack.
- `@solana-program/system`, `@solana-program/token` — the new program
  clients (Codama-generated).
- `@tetherto/wdk-failover-provider` — their HTTP RPC with failover.

### The critical API surface

[`WalletAccountSolana.sendTransaction`](https://github.com/tetherto/wdk-wallet-solana/blob/main/src/wallet-account-solana.js),
line 213 in beta.7:

```js
async sendTransaction (tx) {
  // ...
  let transactionMessage = tx

  // Handle native token transfer { to, value } convenience
  if (tx.to !== undefined && tx.value !== undefined) {
    transactionMessage = await this._buildNativeTransferTransactionMessage(tx.to, tx.value)
  }

  if (Array.isArray(transactionMessage.instructions)) {
    transactionMessage = await this._ensureLifetime(transactionMessage)
    await this._assertFeePayer(transactionMessage)
    transactionMessage = setTransactionMessageFeePayerSigner(this._signer, transactionMessage)
  }

  const fee = await this._getTransactionFee(transactionMessage)
  const signedtransaction = await signTransactionMessageWithSigners(transactionMessage)
  const encodedTransaction = getBase64EncodedWireTransaction(signedtransaction)
  const signature = await this._rpc.sendTransaction(encodedTransaction, { encoding: 'base64' }).send()

  return { hash: signature, fee }
}
```

The `if (Array.isArray(transactionMessage.instructions))` branch is the
flex point. Pass any `TransactionMessage` with an `instructions` array
and the wallet:

1. fills in a recent blockhash if missing,
2. sets the fee payer signer to the wallet's keypair,
3. signs + broadcasts,
4. returns `{ hash, fee }`.

For our THORChain flow we need two instructions in the same transaction:

1. **`SystemProgram` transfer** of `sellAmount` lamports from the
   user's address to `inboundAddress`.
2. **Memo Program** instruction carrying the THORChain `memo` bytes.

Both instruction clients are on npm as first-party Solana program
packages:

- `@solana-program/system@0.12.0` — `getTransferSolInstruction({ source, destination, amount })`
- `@solana-program/memo@0.11.0`   — `getAddMemoInstruction({ memo })`

See `src/tx-builder.ts` (`buildNativeTransferWithMemo`) for the
assembly. The function is pure (no RPC calls) and returns a v0
`TransactionMessage` ready for `sendTransaction`.

### NoopSigner detail

`getTransferSolInstruction` requires `source: TransactionSigner`. We
don't have the real signer at tx-build time — it's in the wallet. We
use `createNoopSigner(sourceAddr)` from `@solana/signers`, which
produces a placeholder with the right TypeScript shape carrying only
the address. When the wallet runs
`setTransactionMessageFeePayerSigner(realSigner, tx)` and
`signTransactionMessageWithSigners`, the real keypair signs the whole
transaction — since the fee payer and the transfer source are the
same address here, one signature authorises both.

### Memo format + size budget

Example memo returned by swap-engine for SOL → ETH:
`=:e:0xe89E630553e63EA65b65F1cA2ea2C50cCA8f3E54:3558147:commission/SDK:0/5`
(~70 ASCII bytes). The Memo Program itself has no upper limit beyond
the Solana transaction size limit (1232 bytes), which is three orders
of magnitude above any THORChain memo we've seen. No size concern.

## Comparison with BTC source

| Aspect | BTC via THORChain | Solana via THORChain |
|---|---|---|
| swap-engine `/quote` shape | `inboundAddress` + `memo` | `inboundAddress` + `memo` |
| How the memo rides | OP_RETURN output | Memo Program instruction |
| Upstream wallet's tx API | `sendTransaction({ to, value })` only, no OP_RETURN → **blocker** | `sendTransaction({ instructions })` accepts arbitrary instructions → **unblocked** |
| MVP coverage | not shipped | native SOL done; SPL pending |

The structural insight: Solana's instruction-based transaction model
maps onto THORChain's "deposit + memo" pattern more cleanly than
Bitcoin's UTXO model, and the upstream wallet exposes that flexibility.

## SPL-source — open work

For an SPL-token source we'd add a sibling builder:

```
buildSPLTransferWithMemo({
  source,           // Solana address (user)
  destination,      // Solana address (THOR vault, same as for native)
  mint,             // SPL mint address
  amountBase,       // bigint in the token's base units
  memo,             // THORChain memo
})
```

Composition would be:

1. Resolve / derive the associated token account (ATA) for `source`
   holding `mint` (`@solana-program/token`'s
   `getAssociatedTokenAccountInstructions` helper).
2. Resolve / derive the destination ATA. If it doesn't exist, include
   `getCreateAssociatedTokenInstruction` at the cost of ~2 000 000
   extra lamports of rent.
3. Emit `getTransferCheckedInstruction` or `getTransferInstruction`
   from `@solana-program/token` for `amountBase` from source-ATA to
   destination-ATA.
4. Append the Memo Program instruction.

Two additional knobs versus the native case:

- The transfer instruction's `authority` must be the source ATA's owner,
  which is the wallet (same signer as fee payer) — so still one
  signature.
- THORChain's SPL coverage is narrower than native SOL. At the time of
  this writing THORChain supports USDC and USDT on Solana. swap-engine
  will surface a `providers: []` / `SwapDKProviderError` for unsupported
  mints.

This work is tracked in the roadmap; not scoped into v0.1.

## Reproduction

Research snapshot:

- `@tetherto/wdk-wallet-solana@1.0.0-beta.7`.
- `@solana-program/memo@0.11.0`, `@solana-program/system@0.12.0`.
- `@solana/addresses@6.8.0`, `@solana/transaction-messages@6.8.0`,
  `@solana/signers@6.8.0`.
- swap-engine `/quote` for SOL source confirmed on `dev-api.swapdk.com`
  2026-04-23.

Sanity check (after any upstream bump):

```bash
npm pack @tetherto/wdk-wallet-solana
tar -xzf tetherto-wdk-wallet-solana-*.tgz
grep -n "instructions\|sendTransaction\|_buildNativeTransferTransactionMessage" \
  package/src/wallet-account-solana.js
```

Our tx-builder's invariants are verified by the unit test
`tests/tx-builder.test.ts`, which decodes the emitted instructions
and asserts:

- both `programAddress` values,
- the memo bytes round-trip through `TextDecoder`,
- the transfer instruction's amount is the right little-endian u64
  at the correct offset in the instruction data.
