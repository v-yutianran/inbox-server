import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    hookTimeout: 15_000,
    setupFiles: ["./src/test/setup.ts"],
    testTimeout: 15_000,
  },
});
