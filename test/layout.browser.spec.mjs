import { test, expect } from "@playwright/test";

for (const width of [390, 1440]) {
  test(`dashboard layout fills the viewport at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route("https://cdn.li3.dev/**", (route) =>
      route.fulfill({
        contentType: "text/javascript",
        body: `export async function load(url) {
          if (url !== '/components/ui.html' || customElements.get('wds-dashboard-layout')) return;
          customElements.define('wds-dashboard-layout', class extends HTMLElement {
            connectedCallback() {
              if (this.shadowRoot) return;
              const root = this.attachShadow({ mode: 'open' });
              root.innerHTML = '<style>:host{display:block}.layout{display:grid;grid-template-columns:220px minmax(0,1fr);min-height:100dvh}slot{display:contents}@media(max-width:760px){.layout{display:block}}</style><div class="layout"><slot name="sidebar"></slot><slot name="main"></slot></div>';
            }
          });
        }`,
      }),
    );
    await page.route("**/api/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      const body =
        path === "/api/oidc/me"
          ? { authenticated: true, user: { name: "Test User" } }
          : path === "/api/teams"
            ? { teams: [{ id: 1, slug: "acme" }] }
            : path === "/api/design-systems"
              ? { designSystems: [{ team_id: 1, git_org: "acme", foundation_repo: "foundation", name: "Acme" }] }
              : {};
      return route.fulfill({ json: body });
    });

    await page.goto("http://127.0.0.1:4175/");
    await expect(page.locator("#dashboard-layout")).toHaveAttribute("aria-busy", "false");
    const main = await page.locator(".dashboard-main").boundingBox();
    expect(main).not.toBeNull();
    expect(main.width).toBeGreaterThan(width === 390 ? 380 : 1100);
  });
}
