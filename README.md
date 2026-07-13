# SwapDK WDK protocol bridges + swidge

Monorepo for [SwapDK](https://swapdk.com) WDK protocol modules. Ships the new [`@swapdk/wdk-protocol-swidge-swapdk`](./packages/swidge) — a single-class implementation of the WDK [swidge interface](https://docs.wdk.tether.io/sdk/swidge-modules/) covering all five source-chain families — alongside the original per-source-chain bridge packages under `IBridgeProtocol` / `ISwapProtocol`.

Each package under `packages/` is published to npm independently. The shared HTTP client, error hierarchy, asset utilities, and zod-validated wire schemas live in [`@swapdk/swap-engine-client`](./packages/swap-engine-client) — a first-class package consumed by both SwapDK distribution channels (the WDK modules in this monorepo, and the wagmi-native `@swapdk/wagmidk`).

## Packages

**Swidge module (preferred for new integrations):**

| Package | Interface | Source chains | Latest version |
|---|---|---|---|
| [`@swapdk/wdk-protocol-swidge-swapdk`](./packages/swidge) | `ISwidgeProtocol` | Bitcoin, EVM, Cosmos, Solana, TRON (single class) | 1.0.0-alpha.1 |

**Legacy bridge modules (still supported, no new features):**

| Package | Interface | Source chain(s) | Latest version |
|---|---|---|---|
| [`@swapdk/wdk-protocol-bridge-swapdk-evm`](./packages/evm) | `IBridgeProtocol` + `ISwapProtocol` | Ethereum, Arbitrum, Base, BSC, Avalanche, Optimism, Polygon | 1.1.1 |
| [`@swapdk/wdk-protocol-bridge-swapdk-solana`](./packages/solana) | `IBridgeProtocol` | Solana (native SOL) | 0.2.1 |
| [`@swapdk/wdk-protocol-bridge-swapdk-cosmos`](./packages/cosmos) | `IBridgeProtocol` | THORChain (RUNE), MAYAChain (CACAO) | 0.2.1 |
| [`@swapdk/wdk-protocol-bridge-swapdk-btc`](./packages/btc) | `IBridgeProtocol` | Bitcoin (THORChain memo + Chainflip broker channel) | 0.2.2 |
| [`@swapdk/wdk-protocol-bridge-swapdk-tron`](./packages/tron) | `IBridgeProtocol` | TRON (TRX + TRC-20 USDT) | 0.3.0 |

**Shared infrastructure:**

| Package | Purpose | Latest version |
|---|---|---|
| [`@swapdk/swap-engine-client`](./packages/swap-engine-client) | HTTP client + zod schemas + errors + asset utils; consumed by every SwapDK distribution channel | 0.3.0 |

The swidge module is the direction the WDK ecosystem is moving in — [`docs.wdk.tether.io/sdk/swidge-modules`](https://docs.wdk.tether.io/sdk/swidge-modules/) documents the shared interface. Existing consumers of the legacy bridge modules can keep using them (bug fixes will land), and the `SwidgeProtocol` base class ships legacy compatibility shims — `bridge/quoteBridge/swap/quoteSwap` still work on the swidge module because the base class delegates to `swidge/quoteSwidge`.

Specific per-package status (validation stage, in-flight items, blocked) is in [`STATUS.md`](./STATUS.md).

Each package's README has the user-facing documentation. The repository-level docs below are for contributors and maintainers.

## Layout

```
wdk-protocol-bridges-swapdk/
├── packages/
│   ├── swidge/               # Unified swidge module — ISwidgeProtocol, 5 source families in one class
│   ├── swap-engine-client/   # Shared HTTP client + zod schemas, error types, asset utils, token registry
│   ├── evm/                  # Legacy EVM source bridge + same-chain swap
│   ├── solana/               # Legacy Solana source bridge (native SOL)
│   ├── cosmos/               # Legacy THORChain / MAYAChain source bridge (MsgDeposit)
│   ├── btc/                  # Legacy Bitcoin source bridge (OP_RETURN memo + Chainflip channel)
│   └── tron/                 # Legacy TRON source bridge (router contract, TRX + TRC-20)
├── docs/                     # Research notes (BTC source, Solana source, etc.)
└── package.json              # Workspaces config
```

## Working in the monorepo

```bash
# One-time
npm install                 # installs all workspaces

# Across the whole repo
npm run build               # compiles every package's tsc to its own dist/
npm run lint                # type-checks every package
npm test                    # runs vitest with workspace awareness

# Scoped to a single package — build/lint
npm run build -w @swapdk/wdk-protocol-bridge-swapdk-evm
npm run lint  -w @swapdk/wdk-protocol-bridge-swapdk-evm

# Scoped tests — vitest config lives at the root, so filter from there
npm test -- packages/solana
```

## Releasing

Per-package, manually, after a clean `npm install` + `npm run build` + `npm test`:

```bash
npm publish -w @swapdk/swap-engine-client                --access public
npm publish -w @swapdk/wdk-protocol-swidge-swapdk        --access public
npm publish -w @swapdk/wdk-protocol-bridge-swapdk-evm    --access public
npm publish -w @swapdk/wdk-protocol-bridge-swapdk-solana --access public
npm publish -w @swapdk/wdk-protocol-bridge-swapdk-cosmos --access public
npm publish -w @swapdk/wdk-protocol-bridge-swapdk-btc    --access public
npm publish -w @swapdk/wdk-protocol-bridge-swapdk-tron   --access public
```

`swap-engine-client` must be published before consuming packages that depend on a new version of it; otherwise npm rejects the dependency range.

For changelog discipline, [changesets](https://github.com/changesets/changesets) is configured under [`.changeset/`](./.changeset/README.md):

```bash
npx changeset                # record an intent (which package, severity, summary)
npx changeset version        # bump versions + regenerate per-package CHANGELOG.md
```

## License

MIT
