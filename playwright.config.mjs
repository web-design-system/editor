import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test",
  testMatch: "**/*.browser.spec.mjs",
  webServer: {
    command: "PORT=4175 node server.mjs",
    url: "http://127.0.0.1:4175",
    reuseExistingServer: true,
  },
});
