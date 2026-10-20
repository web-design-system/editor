import { test, expect } from "@playwright/test";

for (const width of [390, 1440]) {
  test(`first design-system empty state waits for loaded data and creates at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const designSystems = [{ team_id: 1, git_org: "nanico-system", foundation_repo: "foundation", name: "Nanico" }];
    let created;
    await page.route("https://cdn.li3.dev/**", (route) =>
      route.fulfill({
        contentType: "text/javascript",
        body: "export async function load() {}",
      }),
    );
    await page.route("**/static/**", (route) => route.fulfill({ status: 404 }));
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      let body = {};
      if (path === "/api/oidc/me") {
        body = { authenticated: true, user: { name: "Test User" } };
      } else if (path === "/api/teams") {
        body = {
          teams: [
            { id: 1, slug: "nanico" },
            { id: 2, slug: "wds" },
          ],
        };
      } else if (path === "/api/design-systems") {
        if (route.request().method() === "POST") {
          created = route.request().postDataJSON();
          designSystems.push({
            team_id: 2,
            git_org: created.gitOrg,
            foundation_repo: "foundation",
            name: created.name,
          });
          body = { designSystem: { team: created.gitOrg } };
        } else {
          await new Promise((resolve) => setTimeout(resolve, 350));
          body = { designSystems };
        }
      }
      await route.fulfill({ json: body });
    });

    await page.goto("http://127.0.0.1:4175/?teamSlug=wds");
    await expect(page.locator("#system-grid .loading")).toBeVisible();
    await expect(page.locator("#first-system-empty")).toBeHidden();
    await expect(page.locator("#first-system-empty")).toBeVisible();
    await expect(page.locator("#dashboard-layout")).toBeHidden();
    await expect(page.getByRole("heading", { name: "Create your first design system." })).toBeVisible();
    await expect(page.getByPlaceholder("Name")).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`first-system-empty-${width}.png`), fullPage: true });
    await page.getByPlaceholder("Name").fill("WDS Components");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page).toHaveURL(/\?system=wds-components-wds$/);
    expect(created).toEqual({
      team: "wds",
      slug: "wds-components-wds",
      gitOrg: "wds-components-wds",
      name: "WDS Components",
      type: "design-system",
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
