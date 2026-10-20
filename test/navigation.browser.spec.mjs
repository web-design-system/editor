import { test, expect } from "@playwright/test";

for (const width of [1440, 360]) {
  test(`guest welcome and sign-in error at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 740 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/oidc/me", (route) => route.fulfill({ json: { authenticated: false } }));
    await page.goto("http://127.0.0.1:4175/");
    await expect(page.getByRole("heading", { name: "A home for your team’s UX" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Get started" })).toHaveAttribute("href", "/api/oidc/login");
    await expect(page.locator('a[href="/api/oidc/login"]')).toHaveCount(1);
    await expect(page.locator("#landing > .header")).toHaveCount(0);
    await expect(page.locator(".welcome-eyebrow, .preview-caption")).toHaveCount(0);
    await expect(page.getByText("Tokens · Components · Code")).toHaveCount(0);
    await expect(page.locator("#dashboard-layout")).toBeHidden();
    await expect(page.getByRole("searchbox", { name: "Find a system" })).toBeHidden();
    await expect(page.locator("#notice")).toBeHidden();
    await expect(page.locator("#welcome-error")).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width === 360) {
      const welcome = await page.locator("#guest-welcome").boundingBox();
      expect(welcome.y + welcome.height).toBeLessThanOrEqual(740);
    } else {
      const lineCount = await page.locator("#welcome-title").evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return range.getClientRects().length;
      });
      expect(lineCount).toBe(1);
    }
    await page.screenshot({ path: test.info().outputPath(`guest-${width}.png`), fullPage: true });

    await page.goto("http://127.0.0.1:4175/?auth_error=1");
    await expect(page.locator("#welcome-error")).toBeVisible();
    await expect(page.locator("#welcome-error")).toContainText("couldn’t complete sign-in");
    await expect(page.getByRole("link", { name: "Get started" })).toHaveAttribute("href", "/api/oidc/login");
    await page.screenshot({ path: test.info().outputPath(`guest-auth-error-${width}.png`), fullPage: true });

    await page.goto("http://127.0.0.1:4175/?team=acme&repo=button");
    await expect(page.locator("#welcome-error")).toContainText("Sign in to open this project");
    await expect(page.locator("#welcome-footnote")).toContainText("project link");
    expect(errors).toEqual([]);
  });
}

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
    let foundationPublished = false;
    await page.route("https://cdn.li3.dev/**", (route) =>
      width === 900
        ? route.abort("failed")
        : route.fulfill({
            contentType: "text/javascript",
            body: `export async function load() { if (!customElements.get('code-editor')) customElements.define('code-editor', class extends HTMLElement { value = ''; }); }`,
          }),
    );
    await page.route("**/static/**", (route) =>
      route.fulfill({ status: foundationPublished ? 200 : 404, body: ":root { --brand: blue; }" }),
    );
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
          const legacyFoundation = width === 1440 && path.endsWith("/acme-ui/foundation");
          const resetFile = legacyFoundation
            ? { "styles.css": "body { margin: 0; }" }
            : { "reset.css": "body { margin: 0; }" };
          body = {
            revision: "original",
            baseRef: "original",
            files: {
              "tokens.css": ":root { --brand: blue; }",
              ...resetFile,
              "component.json": '{"type":"design-system"}',
              "component.html": '<template component="acme-button"><button>Button</button></template>',
            },
          };
        }
      } else if (path.startsWith("/api/history/")) {
        body = { history: [] };
      } else if (path.startsWith("/api/publish/")) {
        foundationPublished = true;
        body = { revision: "published" };
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
    await page.evaluate(() => {
      if (!customElements.get("wds-repository-card")) {
        customElements.define("wds-repository-card", class extends HTMLElement {});
      }
    });
    await page.getByRole("link", { name: "Open Acme UI", exact: true }).click();
    await expect(page.locator("#dashboard-title")).toHaveText("Acme UI");
    await expect(page.getByRole("link", { name: "All design systems" })).toHaveAttribute("href", "/");
    await expect(page.locator("#foundation-setup")).toBeVisible();
    await expect(page.locator("#foundation-setup")).toContainText("Define your design tokens");
    await expect(page.locator("#foundation-setup")).toContainText(
      "Give your design system the foundation it needs: the colors, spacing, or any tokens used by all components.",
    );
    await expect(page.locator("#foundation-setup")).not.toContainText("Add your values to tokens.css");
    await expect(page.locator("#component-area")).toBeHidden();
    await expect(page.locator("#component-count")).toBeHidden();
    await expect(page.getByRole("searchbox", { name: "Find a component" })).toBeHidden();
    await expect(page.getByRole("button", { name: "New component" })).toHaveCount(0);
    await expect(page.locator(".foundation-card")).toBeHidden();
    await page.screenshot({ path: test.info().outputPath(`system-foundation-setup-${width}.png`), fullPage: true });
    await expect(page.locator(".setup-action")).toHaveText("Create Design Foundation →");
    await page.locator(".setup-action").click();
    await expect(page).toHaveURL(/team=acme-ui&repo=foundation/);
    await expect(page.getByRole("button", { name: "Save Foundation" })).toBeVisible();
    if (width <= 760) {
      await page.locator(".project-drawer > summary").click();
    }
    if (width === 1440) {
      await expect(page.getByRole("button", { name: "Save Foundation" })).toBeEnabled();
    } else {
      await expect(page.getByRole("button", { name: "Save Foundation" })).toBeDisabled();
    }
    await expect(page.getByRole("textbox", { name: "Describe your changes" })).toBeVisible();
    await expect(page.getByLabel("Public tokens.css URL")).toHaveValue(
      /^http:\/\/127\.0\.0\.1:4175\/static\/acme-ui\/foundation\/latest\/tokens\.css$/,
    );
    await expect(page.getByLabel("Public reset.css URL")).toHaveValue(
      /^http:\/\/127\.0\.0\.1:4175\/static\/acme-ui\/foundation\/latest\/reset\.css$/,
    );
    await page.getByRole("button", { name: "reset.css", exact: true }).click();
    if (width === 900) {
      await page.getByRole("textbox", { name: "Source code: reset.css", exact: true }).fill("body { margin: 4px; }");
    } else {
      await page.locator("#tokens-editor").evaluate((editor) => {
        editor.value = "body { margin: 4px; }";
        editor.dispatchEvent(new CustomEvent("change", { detail: editor.value }));
      });
    }
    await expect(page.getByRole("button", { name: "Save Foundation" })).toBeEnabled();
    await page.getByRole("button", { name: "tokens.css", exact: true }).click();
    await page.getByRole("button", { name: "Save Foundation" }).click();
    await expect(page.locator("#token-status")).toBeEmpty();
    await expect(page.getByRole("button", { name: "Save Foundation" })).toBeDisabled();
    expect(saved.files["tokens.css"]).toContain("--brand: blue");
    expect(saved.files["reset.css"]).toBe("body { margin: 4px; }");
    if (width === 1440) {
      expect(saved.deleteFiles).toEqual(["styles.css"]);
    }
    await page.getByRole("button", { name: "Publish latest" }).click();
    await expect(page.locator("#foundation-state")).toContainText("Published");
    await expect(page.locator("#token-publication-state")).toContainText("tokens.css is available");
    await page.screenshot({ path: test.info().outputPath(`foundation-${width}.png`), fullPage: true });
    await page.locator(".component-list a").first().click();
    await expect(page.locator("#layer-list button")).toHaveCount(1);
    await page.getByRole("link", { name: "Back to design system" }).click();
    await expect(page.locator("#dashboard-title")).toHaveText("Acme UI");
    await expect(page.locator(".foundation-card")).toBeVisible();
    await expect(page.locator("#foundation-setup")).toBeHidden();
    await expect(page.locator("#component-area")).toBeVisible();
    await expect(page.getByRole("button", { name: "New component" })).toBeEnabled();
    await expect(page.locator("#overview-components .system-card")).toHaveCount(6);
    const searchRow = await page.locator(".component-toolbar").boundingBox();
    const searchInput = await page.getByRole("searchbox", { name: "Find a component" }).boundingBox();
    const createButton = await page.getByRole("button", { name: "New component" }).boundingBox();
    expect(Math.abs(searchInput.y - createButton.y)).toBeLessThan(3);
    expect(searchInput.x + searchInput.width).toBeLessThanOrEqual(createButton.x);
    expect(searchRow.height).toBeLessThan(60);
    await page.getByRole("searchbox", { name: "Find a component" }).fill("checkbox");
    await expect(page.locator("#overview-components .system-card:visible")).toHaveCount(1);
    await page.getByRole("searchbox", { name: "Find a component" }).fill("no-match");
    await expect(page.locator("#system-grid #filter-empty")).toBeVisible();
    await page.getByRole("searchbox", { name: "Find a component" }).fill("");
    await page.getByRole("button", { name: "New component" }).click();
    await expect(page.getByRole("dialog", { name: "Create a component" })).toBeVisible();
    await page.getByRole("button", { name: "Close dialog" }).click();
    await page.screenshot({ path: test.info().outputPath(`system-${width}.png`), fullPage: true });
    if (width <= 760) {
      await page.locator(".team-drawer > summary").click();
    }
    await page.getByRole("button", { name: "New team" }).click();
    await page.getByLabel("Team slug", { exact: true }).fill("new-team");
    await page.getByRole("button", { name: "Create team", exact: true }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(page.locator("#dashboard-title")).toHaveText("new-team");
    await expect(page.locator("#first-system-empty")).toBeVisible();
    await page.getByPlaceholder("Name").fill("Web System");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.locator("#dashboard-title")).toHaveText("Web System");
    expect(createdSystem.team).toBe("new-team");
    expect(createdSystem.gitOrg).toBe("web-system-new-team");
    await expect(page.getByText("FIRST COMPONENT", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Create your first component" })).toBeVisible();
    await expect(page.getByText("Give your design system its first reusable building block.")).toBeVisible();
    await expect(page.getByRole("searchbox", { name: "Find a component" })).toBeHidden();
    await expect(page.getByRole("button", { name: "New component" })).toBeHidden();
    await page.screenshot({ path: test.info().outputPath(`first-component-${width}.png`), fullPage: true });
    await page.getByRole("textbox", { name: "Component name" }).fill("New Card");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.locator("#layer-list button")).toHaveCount(1);
    expect(createdComponent.team).toBe("web-system-new-team");
    expect(createdComponent.designSystem).toEqual({
      team: "web-system-new-team",
      repo: "foundation",
      revision: "latest",
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}
