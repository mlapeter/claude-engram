import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Don't pick up stale test copies inside agent worktrees
    exclude: [...configDefaults.exclude, "**/.claude/**"],
  },
});
