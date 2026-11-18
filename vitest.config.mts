import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Migration tests replay every migration on in-memory Postgres; under parallel load they
    // run close to the 5 s default, so give them headroom instead of flaking.
    testTimeout: 30_000,
    // beforeAll hooks build a migrated PGlite database per file and share the same load.
    hookTimeout: 30_000,
  },
});
