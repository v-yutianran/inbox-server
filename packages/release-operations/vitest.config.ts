import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    hookTimeout: 15_000,
    testTimeout: 15_000,
  },
});
