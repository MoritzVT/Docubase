import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: [
      "tests/firestore.rules.test.ts",
      "**/node_modules/**",
      "src-tauri/**",
      "native/**",
      "functions/**",
    ],
  },
});
