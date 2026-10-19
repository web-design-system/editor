import { test, expect } from "@playwright/test";

for (const width of [1440, 900, 390]) {
  test(`studio edits selected layers and saves canonical source at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("https://cdn.li3.dev/**", (route) =>
      route.fulfill({
        contentType: "text/javascript",
        body: `export async function load() { customElements.define('code-editor', class extends HTMLElement { value = ''; }); }`,
      }),
    );
    let saved;
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      let body = {};
      if (path === "/api/oidc/me") {
        body = { authenticated: true, user: { name: "Studio tester" } };
      } else if (path === "/api/projects") {
        body = [{ team: "demo", repo: "button", name: "Button", type: "component" }];
      } else if (path.startsWith("/api/source/")) {
        if (route.request().method() === "PUT") {
          saved = route.request().postDataJSON();
          body = { revision: "abc123", baseRef: "abc123", sourceMode: "git" };
        } else {
          body = {
            baseRef: "original",
            revision: "original",
            sourceMode: "git",
            files: {
              "component.html":
                '<template component="demo-button"><button class="flex items-center gap-2 px-4 py-3 bg-blue-600 text-white rounded-lg"><span>Get Started</span></button><script setup>const x = 1;</script></template>',
              "styles.css": "button { border:0; font:500 16px system-ui; }",
              "stories.html": "<demo-button></demo-button>",
            },
          };
        }
      } else if (path.startsWith("/api/history/")) {
        body = { history: [] };
      } else if (path.startsWith("/api/publish/")) {
        body = { revision: "abc123" };
      }
      await route.fulfill({ json: body });
    });
    await page.goto("http://127.0.0.1:4175/?team=demo&repo=button");
    await expect(page.locator("#layer-list button")).toHaveCount(2);
    const preview = page.frameLocator("#draft-preview");
    await expect(preview.locator("button")).toBeVisible();
    await page.locator("#layer-list button").nth(1).click();
    await page.getByLabel("Text", { exact: true }).fill("#ff0000");
    await page.getByLabel("Text", { exact: true }).press("Tab");
    await expect(preview.locator("span[data-studio-node]")).toHaveCSS("color", "rgb(255, 0, 0)");
    await page.getByRole("button", { name: "Save Component", exact: true }).click();
    await expect(page.locator("#draft-state")).toContainText("Committed");
    expect(saved.baseRef).toBe("original");
    expect(saved.files["component.html"]).toContain("color: rgb(255, 0, 0)");
    expect(saved.files["component.html"]).toContain("const x = 1;");
    expect(saved.files["stories.html"]).toBe("<demo-button></demo-button>");
    await page.getByRole("tab", { name: "Code", exact: true }).click();
    await expect(page.locator(".code-surface")).toBeVisible();
    await expect(page.locator(".design-surface")).toBeVisible();
    await page.getByRole("tab", { name: "Design", exact: true }).click();
    await page.getByRole("button", { name: "Zoom in", exact: true }).click();
    await expect(page.locator("#zoom-reset")).toHaveText("125%");
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(page.locator(".studio-nav")).toHaveCSS("visibility", "hidden");
    await expect(page.locator(".studio-inspector")).toHaveCSS("visibility", "hidden");
    await expect(preview.locator("[data-studio-selected]")).toHaveCount(0);
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(page.locator(".studio-nav")).toHaveCSS("visibility", "visible");
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(page.locator("#draft-state")).toContainText("Published");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
    await page.screenshot({ path: test.info().outputPath(`studio-${width}.png`), fullPage: true });
  });
}
