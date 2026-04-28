import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

// Resolve the common package to its TS source, so tests in EVM / Solana
// don't require `npm run build -w common` before they can run. Production
// consumers (npm-installed) will use the published `dist/` from package.json
// `main`/`exports` — this alias only affects in-repo tests and `tsx`-driven
// scripts.
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@swapdk\/wdk-protocol-bridge-swapdk-common$/,
        replacement: path.resolve(here, "packages/common/src/index.ts"),
      },
    ],
  },
  test: {
    // Discover tests in every workspace package's tests/ folder.
    include: ["packages/*/tests/**/*.test.ts"],
  },
});
