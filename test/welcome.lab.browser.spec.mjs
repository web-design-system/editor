import { test, expect } from "@playwright/test";

// Opt-in: uses the deployed lab's registered OIDC client, never production or mock APIs.
test.describe("deployed Auth Lab welcome journey", () => {
  test.skip(process.env.WDS_LAB_SMOKE !== "true", "Set WDS_LAB_SMOKE=true and AUTH_LAB_KEY to test the deployed lab.");
  for (const width of [360, 1440]) {
    test(`welcome, sign-in, workspace and sign-out at ${width}px`, async ({ page, context }) => {
      if (!process.env.AUTH_LAB_KEY) {
        throw new Error("AUTH_LAB_KEY is required for the lab smoke test.");
      }
      await page.setViewportSize({ width, height: 740 });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      let authorization = false;
      let pkce = false;
      let callback = false;
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.origin === "https://auth.lab.apphor.de" && url.pathname === "/authorize") {
          authorization = true;
          pkce = url.searchParams.get("code_challenge_method") === "S256";
        }
        if (url.origin === "https://wds.lab.apphor.de" && url.pathname === "/auth/callback") {
          callback = true;
        }
      });
      try {
        await page.goto("https://wds.lab.apphor.de/");
        await expect(page.locator("#guest-welcome")).toBeVisible();
        await expect(page.locator("#dashboard-layout")).toBeHidden();
        await expect(page.getByRole("link", { name: "Get started" })).toHaveCount(1);
        const unauthorized = await context.request.get("https://wds.lab.apphor.de/api/teams");
        expect(unauthorized.status()).toBe(401);
        await page.screenshot({ path: test.info().outputPath(`lab-welcome-${width}.png`), fullPage: true });

        // Playwright's context request cookie jar is shared with this browser context.
        const login = await context.request.post("https://auth.lab.apphor.de/__test__/login", {
          data: { key: process.env.AUTH_LAB_KEY },
        });
        expect(login.ok()).toBe(true);
        await page.getByRole("link", { name: "Get started" }).click();
        await page.waitForURL((url) => url.origin === "https://wds.lab.apphor.de" && url.pathname === "/");
        await expect(page.locator("#dashboard-layout")).toBeVisible();
        await expect(page.locator("#guest-welcome")).toBeHidden();
        expect(authorization && pkce && callback).toBe(true);
        const me = await context.request.get("https://wds.lab.apphor.de/api/oidc/me");
        expect((await me.json()).authenticated).toBe(true);
        expect((await context.request.get("https://wds.lab.apphor.de/api/teams")).status()).toBe(200);
        expect((await context.request.get("https://wds.lab.apphor.de/api/design-systems")).status()).toBe(200);
        await expect(page.locator("#system-grid .loading")).toHaveCount(0);
        await page.screenshot({ path: test.info().outputPath(`lab-workspace-${width}.png`), fullPage: true });
        await page.getByRole("link", { name: "Sign out", exact: true }).click();
        await expect(page.locator("#guest-welcome")).toBeVisible();
        const signedOut = await context.request.get("https://wds.lab.apphor.de/api/oidc/me");
        expect((await signedOut.json()).authenticated).toBe(false);
        expect(errors).toEqual([]);
      } finally {
        // Session cleanup only; this test creates no clients, teams or repositories.
        await context.request.get("https://wds.lab.apphor.de/api/oidc/logout");
        const cleanup = await context.request.delete("https://auth.lab.apphor.de/api/v1/profile");
        expect([202, 401]).toContain(cleanup.status());
      }
    });
  }
});
