import { test, expect } from "@playwright/test";

for (const width of [1440, 900, 612, 390]) {
  test(`studio edits selected layers and saves canonical source at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => message.text().includes("studio layer parse") && console.log(message.text()));
    await page.route("https://at-li3.static.apphor.de/**", (route) =>
      route.fulfill({
        contentType: "text/javascript",
        body: `export async function load() { customElements.define('code-editor', class extends HTMLElement { value = ''; }); }`,
      }),
    );
    let saved;
    let rejectNextSave = false;
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      let body = {};
      if (path === "/api/oidc/me") {
        body = {
          authenticated: true,
          user:
            width === 900
              ? { name: "Build Agent", role: "agent", email: "private@example.test" }
              : {
                  name: "Studio tester",
                  email: "studio@example.test",
                  photo: "data:image/gif;base64,R0lGODlhAQABAAAAACw=",
                },
        };
      } else if (path === "/api/projects") {
        body = [{ team: "demo", repo: "button", name: "Button", type: "component" }];
      } else if (path.startsWith("/api/source/")) {
        if (route.request().method() === "PUT") {
          saved = route.request().postDataJSON();
          if (rejectNextSave) {
            rejectNextSave = false;
            await route.fulfill({
              status: 400,
              json: { error: "Relative imports and assets must remain inside the repository.", file: "styles.css" },
            });
            return;
          }
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
    await expect(page.locator(".back-link")).toHaveCount(0);
    await expect(page.locator(".brand-mark")).toHaveText("W");
    await expect(page.locator("#workspace-name")).toContainText(/demo\s*\/\s*Button/);
    if (width === 900) {
      await expect(page.locator(".user-avatar")).toHaveText("Ag");
      await expect(page.locator(".user-copy")).not.toContainText("private@example.test");
    } else {
      await expect(page.locator(".user-avatar img")).toHaveAttribute("src", /^data:image/);
      await expect(page.locator(".user-copy")).toContainText("studio@example.test");
    }
    if (width < 640) {
      await page.getByRole("button", { name: "Open layers" }).click();
      await expect(page.locator("#project-content")).toHaveClass(/mobile-nav-open/);
    }
    await expect(page.locator("#publish-source")).toBeDisabled();
    await expect(page.locator("#publish-source .publish-indicator")).toHaveClass(/bg-transparent/);
    await expect(page.locator(".studio-heading [role='tablist']")).toBeVisible();
    await expect(page.locator(".mode-bar [role='tablist']")).toHaveCount(0);
    await expect(page.locator("#source-editor")).toHaveJSProperty(
      "value",
      '<template component="demo-button"><button class="flex items-center gap-2 px-4 py-3 bg-blue-600 text-white rounded-lg"><span>Get Started</span></button><script setup>const x = 1;</script></template>',
    );
    await expect(page.locator("#layer-list button")).toHaveCount(2);
    await expect(page.locator(".studio-nav")).toContainText("Layers");
    await expect(page.locator(".studio-nav")).not.toContainText("Project files");
    await expect(page.locator(".studio-nav")).not.toContainText("Current component");
    await expect(page.getByText("Include component.mjs")).toHaveCount(0);
    const preview = page.frameLocator("#draft-preview");
    await expect(preview.locator("button")).toBeVisible();
    await page.locator("#layer-list button").nth(1).click();
    if (width < 640) {
      await page.keyboard.press("Escape");
      await expect(page.locator("#project-content")).not.toHaveClass(/mobile-nav-open/);
    }
    await page.getByLabel("Text", { exact: true }).fill("#ff0000");
    await page.getByLabel("Text", { exact: true }).press("Tab");
    await expect(preview.locator("span[data-studio-node]")).toHaveCSS("color", "rgb(255, 0, 0)");
    if (width < 640) {
      await page.getByRole("button", { name: "Open layers" }).click();
    }
    await page.locator("#layer-list button").first().click();
    if (width < 640) {
      await page.keyboard.press("Escape");
    }
    await expect(page.locator('.property-toggle[aria-label="Display"] [data-value="flex"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.locator("#publish-source")).toBeDisabled();
    if (width === 1440) {
      rejectNextSave = true;
    }
    await page.getByRole("button", { name: "Save Component", exact: true }).click();
    if (width === 1440) {
      await expect(page.locator("#save-feedback")).toBeVisible();
      await expect(page.locator("#save-feedback")).toContainText("File: styles.css");
      await page.getByRole("button", { name: "Save Component", exact: true }).click();
    }
    await expect(page.locator("#save-feedback")).toContainText("Committed");
    await expect(page.locator("#publish-source")).toBeEnabled();
    expect(saved.baseRef).toBe("original");
    expect(saved.files["component.html"]).toContain("color: rgb(255, 0, 0)");
    expect(saved.files["component.html"]).toContain("const x = 1;");
    expect(saved.files["stories.html"]).toBe("<demo-button></demo-button>");
    await page.getByRole("tab", { name: /^Code/ }).click();
    await expect(page.locator(".code-surface")).toBeVisible();
    await expect(page.locator(".design-surface")).toBeHidden();
    await expect(page.locator(".studio-nav")).toBeVisible();
    await expect(page.locator(".studio-inspector")).toBeHidden();
    await expect(page.getByRole("tab", { name: "component.html", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByRole("tab", { name: "styles.css", exact: true })).toBeVisible();
    await expect(page.locator("#source-editor")).toHaveJSProperty(
      "value",
      '<template component="demo-button"><button class="flex items-center gap-2 px-4 py-3 bg-blue-600 text-white rounded-lg"><span style="color: rgb(255, 0, 0);">Get Started</span></button><script setup="">const x = 1;</script></template>',
    );
    await expect(page.getByRole("tab", { name: "stories.html", exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "stories.html", exact: true }).click();
    await expect(page.locator("#source-editor")).toHaveJSProperty("value", "<demo-button></demo-button>");
    await page.getByRole("tab", { name: "styles.css", exact: true }).click();
    await page.getByRole("tab", { name: "component.html", exact: true }).click();
    await page.getByRole("tab", { name: "Design", exact: true }).click();
    await expect(page.locator(".design-surface")).toBeVisible();
    await page.getByRole("button", { name: "Zoom in", exact: true }).click();
    await expect(page.locator("#zoom-reset")).toHaveText("125%");
    await page.getByRole("button", { name: "Reset zoom" }).click();
    await expect(page.locator("#zoom-reset")).toHaveText("100%");
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(page.locator("#publish-result")).toContainText("Published");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
    await page.screenshot({ path: test.info().outputPath(`studio-${width}.png`), fullPage: true });
  });
}

test("a late component load cannot replace the preferences view", async ({ page }) => {
  await page.route("https://at-li3.static.apphor.de/**", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `export async function load() { customElements.define('code-editor', class extends HTMLElement { value = ''; }); }`,
    }),
  );
  let releaseSource;
  const heldSource = new Promise((resolve) => {
    releaseSource = resolve;
  });
  let sourceStarted;
  const sourceStartedPromise = new Promise((resolve) => {
    sourceStarted = resolve;
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body = {};
    if (path === "/api/oidc/me") {
      body = { authenticated: true, user: { name: "Studio tester" } };
    } else if (path === "/api/projects") {
      body = [{ team: "demo", repo: "button", name: "Button", type: "component" }];
    } else if (path === "/api/teams") {
      body = { teams: [{ id: 1, slug: "demo" }] };
    } else if (path === "/api/design-systems") {
      body = { designSystems: [] };
    } else if (path === "/api/source/demo/button") {
      sourceStarted();
      await heldSource;
      body = { baseRef: "source-ref", revision: "source-ref", files: { "component.html": "<h1>Late source</h1>" } };
    }
    await route.fulfill({ json: body });
  });
  await page.goto("http://127.0.0.1:4175/?team=demo&repo=button");
  await sourceStartedPromise;
  await page.locator("#sidebar-user-card").click();
  await expect(page.locator("#preferences-view")).toBeVisible();
  releaseSource();
  await expect(page.locator("#preferences-view")).toBeVisible();
  await expect(page.locator("#source-editor")).toHaveCount(0);
});
