import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.integration.test.ts"],
    // A fresh scaffold has no integration tests yet; the script must still be
    // green so `pnpm turbo run test:integration` does not fail on day one.
    passWithNoTests: true,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
