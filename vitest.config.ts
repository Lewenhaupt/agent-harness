import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./src/__tests__/setup-env.ts"],
    include: ["src/**/*.test.ts", "pi-web-plugins/**/*.test.js"],
  },
});
