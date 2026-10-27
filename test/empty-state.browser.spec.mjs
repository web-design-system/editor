import { test, expect } from "@playwright/test";

for (const width of [390, 1440]) {
  test(`first design-system empty state waits for loaded data and creates at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const designSystems = [{ team_id: 1, git_org: "nanico-system", foundation_repo: "foundation", name: "Nanico" }];
    let created;
    await page.route("https://at-li3.static.apphor.de/**", (route) =>
      route.fulfill({
        contentType: "text/javascript",
        body: `export async function load(url) {
          if (url !== '/components/ui.html' || customElements.get('wds-dashboard-layout')) return;
          customElements.define('wds-dashboard-layout', class extends HTMLElement {
            connectedCallback() {
              if (this.shadowRoot) return;
              const root = this.attachShadow({ mode: 'open' });
              root.innerHTML = '<link rel="stylesheet" href="/css/tailwind.css"><div class="grid min-h-dvh grid-cols-[220px_minmax(0,1fr)] max-[760px]:block"><slot name="sidebar" class="contents"></slot><slot name="main" class="contents"></slot></div>';
            }
          });
        }`,
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
    await expect(page.locator("#dashboard-layout")).toBeVisible();
    await expect(page.locator("#dashboard-content")).toBeHidden();
    await expect(page.locator(width > 760 ? "#team-list" : "#team-navigation-label")).toBeVisible();
    if (width > 760) {
      const sidebar = await page.locator(".workspace-sidebar").boundingBox();
      expect(sidebar.x).toBe(0);
      expect(sidebar.width).toBe(220);
    }
    await expect(page.getByRole("heading", { name: "Create your first design system." })).toBeVisible();
    await expect(page.getByPlaceholder("Name")).toBeVisible();
    await page.getByPlaceholder("Name").fill("WDS Components");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page).toHaveURL(/teamSlug=wds&system=wds-components-wds/);
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
