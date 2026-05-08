# SwapDK WDK protocol bridges

Monorepo for [SwapDK](https://swapdk.com) WDK protocol bridge modules.

Each package under `packages/` is published to npm independently, with shared infrastructure factored into `@swapdk/wdk-protocol-bridge-swapdk-common`.

## Packages

| Package | Source chain(s) | Latest version |
|---|---|---|
| [`@swapdk/wdk-protocol-bridge-swapdk-common`](./packages/common) | — (shared infra) | 0.1.2 |
| [`@swapdk/wdk-protocol-bridge-swapdk-evm`](./packages/evm) | Ethereum, Arbitrum, Base, BSC, Avalanche, Optimism, Polygon | 1.0.1 |
| [`@swapdk/wdk-protocol-bridge-swapdk-solana`](./packages/solana) | Solana (native SOL) | 0.1.0 |
| [`@swapdk/wdk-protocol-bridge-swapdk-cosmos`](./packages/cosmos) | THORChain (RUNE), MAYAChain (CACAO) | 0.1.0 |

Specific per-package status (validation stage, in-flight items, blocked) is in [`STATUS.md`](./STATUS.md).

Each package's README has the user-facing documentation. The repository-level docs below are for contributors and maintainers.

## Layout

```
wdk-protocol-bridges-swapdk/
├── packages/
│   ├── common/   # Shared HTTP client, error types, asset utils, token registry
│   ├── evm/      # EVM source bridge + same-chain swap
│   ├── solana/   # Solana source bridge (native SOL)
│   └── cosmos/   # THORChain / MAYAChain source bridge (MsgDeposit)
├── docs/         # Research notes (BTC source, Solana source, etc.)
├── examples/     # End-to-end WDK app scaffolds per source chain
└── package.json  # Workspaces config
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
npm publish -w @swapdk/wdk-protocol-bridge-swapdk-common --access public
npm publish -w @swapdk/wdk-protocol-bridge-swapdk-evm    --access public
npm publish -w @swapdk/wdk-protocol-bridge-swapdk-solana --access public
npm publish -w @swapdk/wdk-protocol-bridge-swapdk-cosmos --access public
```

`common` must be published before consuming packages that depend on a new version of it; otherwise npm rejects the dependency range.

For changelog discipline, [changesets](https://github.com/changesets/changesets) is configured under [`.changeset/`](./.changeset/README.md):

```bash
npx changeset                # record an intent (which package, severity, summary)
npx changeset version        # bump versions + regenerate per-package CHANGELOG.md
```

## License

MIT
