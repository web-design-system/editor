import { test, expect } from "@playwright/test";

for (const width of [1440, 900, 390, 360]) {
  test(`team, system, Foundation and component navigation at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 740 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const teams = [
      { id: 1, slug: "acme" },
      { id: 2, slug: "other-team" },
    ];
    const designSystems = [
      { team_id: 1, git_org: "acme-ui", foundation_repo: "foundation", name: "Acme UI" },
      { team_id: 1, git_org: "acme-mobile", foundation_repo: "foundation", name: "Acme Mobile" },
      { team_id: 2, git_org: "other-org", foundation_repo: "foundation", name: "Other system" },
    ];
    let saved;
    const projects = [
      { team: "acme-ui", repo: "foundation", type: "design-system", name: "Acme UI" },
      { team: "acme-ui", repo: "button", type: "component", name: "Button" },
      ...["Input", "Card", "Dialog", "Badge", "Checkbox"].map((name) => ({
        team: "acme-ui",
        repo: name.toLowerCase(),
        type: "component",
        name,
      })),
    ];
    let createdSystem;
    let createdComponent;
    await page.route("https://cdn.li3.dev/**", (route) =>
      width === 900
        ? route.abort("failed")
        : route.fulfill({
            contentType: "text/javascript",
            body: `export async function load() { if (!customElements.get('code-editor')) customElements.define('code-editor', class extends HTMLElement { value = ''; }); }`,
          }),
    );
    await page.route("**/static/**", (route) => route.fulfill({ status: 200, body: ":root { --brand: blue; }" }));
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      let body = {};
      if (path === "/api/oidc/me") {
        body = { authenticated: true, user: { name: "Alex Morgan" } };
      } else if (path === "/api/teams") {
        if (route.request().method() === "POST") {
          const team = { id: 3, slug: route.request().postDataJSON().slug };
          teams.push(team);
          body = { team };
        } else {
          body = { teams };
        }
      } else if (path === "/api/design-systems") {
        if (route.request().method() === "POST") {
          createdSystem = route.request().postDataJSON();
          designSystems.push({
            team_id: 3,
            git_org: createdSystem.gitOrg,
            foundation_repo: "foundation",
            name: createdSystem.name,
          });
          body = { designSystem: { team: createdSystem.gitOrg } };
        } else {
          body = { designSystems };
        }
      } else if (path === "/api/projects") {
        if (route.request().method() === "POST") {
          createdComponent = route.request().postDataJSON();
          projects.push(createdComponent);
          body = createdComponent;
        } else {
          body = projects;
        }
      } else if (path.startsWith("/api/source/")) {
        if (route.request().method() === "PUT") {
          saved = route.request().postDataJSON();
          body = { revision: "saved", baseRef: "saved" };
        } else {
          body = {
            revision: "original",
            baseRef: "original",
            files: {
              "tokens.css": ":root { --brand: blue; }",
              "styles.css": "body { margin: 0; }",
              "component.json": '{"type":"design-system"}',
              "component.html": '<template component="acme-button"><button>Button</button></template>',
            },
          };
        }
      } else if (path.startsWith("/api/history/")) {
        body = { history: [] };
      }
      await route.fulfill({ json: body });
    });
    await page.goto("http://127.0.0.1:4175/");
    await expect(page.locator(".system-card")).toHaveCount(3);
    await page.getByRole("searchbox", { name: "Find a system" }).fill("mobile");
    await expect(page.locator(".system-card:visible")).toHaveCount(1);
    await page.getByRole("searchbox", { name: "Find a system" }).fill("");
    const searchBounds = await page.getByRole("searchbox", { name: "Find a system" }).boundingBox();
    expect(searchBounds.width).toBeGreaterThan(120);
    await page.screenshot({ path: test.info().outputPath(`landing-${width}.png`), fullPage: true });
    if (width <= 760) {
      await page.locator(".team-drawer > summary").click();
    }
    await page.getByRole("button", { name: "acme 2", exact: true }).click();
    await expect(page.locator(".system-card")).toHaveCount(2);
    await expect(page).toHaveURL(/teamSlug=acme/);
    await page.reload();
    await expect(page.locator(".system-card")).toHaveCount(2);
    await page.getByRole("button", { name: "New design system" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.locator("#system-team")).toHaveValue("acme");
    await page.getByRole("button", { name: "Close dialog" }).click();
    await page.screenshot({ path: test.info().outputPath(`team-${width}.png`), fullPage: true });
    await page.getByRole("link", { name: "Open Acme UI", exact: true }).click();
    await expect(page.locator("#dashboard-title")).toHaveText("Acme UI");
    await expect(page.getByRole("button", { name: "New component" })).toBeEnabled();
    await expect(page.locator("#overview-components .system-card")).toHaveCount(6);
    const foundationBounds = await page.locator(".foundation-card").boundingBox();
    const lastRow = await page.locator("#overview-components .system-card").last().boundingBox();
    expect(foundationBounds.height).toBeLessThanOrEqual(80);
    expect(lastRow.y + lastRow.height).toBeLessThan(740);
    await page.getByRole("searchbox", { name: "Find a component" }).fill("checkbox");
    await expect(page.locator("#overview-components .system-card:visible")).toHaveCount(1);
    await page.getByRole("searchbox", { name: "Find a component" }).fill("no-match");
    await expect(page.locator("#filter-empty")).toBeVisible();
    await page.getByRole("searchbox", { name: "Find a component" }).fill("");
    await page.getByRole("button", { name: "New component" }).click();
    await expect(page.getByRole("dialog", { name: "Create a component" })).toBeVisible();
    await page.getByRole("button", { name: "Close dialog" }).click();
    await page.screenshot({ path: test.info().outputPath(`system-${width}.png`), fullPage: true });
    await page.getByRole("link", { name: /Open Foundation/ }).click();
    await expect(page.getByRole("button", { name: "Save Foundation" })).toBeVisible();
    if (width <= 760) {
      await page.locator(".project-drawer > summary").click();
    }
    await page.getByRole("button", { name: "styles.css", exact: true }).click();
    if (width === 900) {
      await page.getByRole("textbox", { name: "Source code: styles.css", exact: true }).fill("body { margin: 4px; }");
    } else {
      await page.locator("#tokens-editor").evaluate((editor) => {
        editor.value = "body { margin: 4px; }";
        editor.dispatchEvent(new CustomEvent("change", { detail: editor.value }));
      });
    }
    await page.getByRole("button", { name: "tokens.css", exact: true }).click();
    await page.getByRole("button", { name: "Save Foundation" }).click();
    await expect(page.locator("#token-status")).toHaveText("Committed saved.");
    expect(saved.files["tokens.css"]).toContain("--brand: blue");
    expect(saved.files["styles.css"]).toBe("body { margin: 4px; }");
    await page.screenshot({ path: test.info().outputPath(`foundation-${width}.png`), fullPage: true });
    await page.locator(".component-list a").first().click();
    await expect(page.locator("#layer-list button")).toHaveCount(1);
    await page.getByRole("link", { name: "Back to design system" }).click();
    await expect(page.locator("#dashboard-title")).toHaveText("Acme UI");
    if (width <= 760) {
      await page.locator(".team-drawer > summary").click();
    }
    await page.getByRole("button", { name: "New team" }).click();
    await page.getByLabel("Team slug", { exact: true }).fill("new-team");
    await page.getByRole("button", { name: "Create team", exact: true }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(page.locator("#dashboard-title")).toHaveText("new-team");
    await page.getByRole("button", { name: "New design system" }).click();
    await page.getByLabel("Design-system slug", { exact: true }).fill("web");
    await page.getByLabel("Git organization slug", { exact: true }).fill("new-team-web");
    await page.getByLabel("Display name (optional)").fill("Web System");
    await page.getByRole("button", { name: "Create design system", exact: true }).click();
    await expect(page.locator("#dashboard-title")).toHaveText("Web System");
    expect(createdSystem.team).toBe("new-team");
    expect(createdSystem.gitOrg).toBe("new-team-web");
    await page.getByRole("button", { name: "New component" }).click();
    await page.getByLabel("Component name", { exact: true }).fill("New Card");
    await page.getByRole("button", { name: "Create component", exact: true }).click();
    await expect(page.locator("#layer-list button")).toHaveCount(1);
    expect(createdComponent.team).toBe("new-team-web");
    expect(createdComponent.designSystem).toEqual({ team: "new-team-web", repo: "foundation", revision: "latest" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}
