import { test, expect } from "@playwright/test";

for (const width of [1440, 360]) {
  test(`guest welcome and sign-in error at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 740 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.stack || error.message));
    page.on("console", (message) => {
      if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) {
        errors.push(`console: ${message.text()}`);
      }
    });
    page.on("requestfailed", (request) => {
      if (new URL(request.url()).origin === "http://127.0.0.1:4175") {
        errors.push(`request failed: ${request.method()} ${request.url()}`);
      }
    });
    await page.route("**/api/oidc/me", (route) => route.fulfill({ json: { authenticated: false } }));
    await page.goto("http://127.0.0.1:4175/");
    await expect(page.getByRole("heading", { level: 1, name: "Web Design System Studio" })).toHaveCount(1);
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
    page.on("pageerror", (error) => errors.push(error.stack || error.message));
    page.on("console", (message) => {
      if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) {
        errors.push(`console: ${message.text()}`);
      }
    });
    page.on("requestfailed", (request) => {
      if (new URL(request.url()).origin === "http://127.0.0.1:4175") {
        errors.push(`request failed: ${request.method()} ${request.url()}`);
      }
    });
    page.on("response", (response) => {
      const url = new URL(response.url());
      const expectedUnpublishedFoundation =
        response.status() === 404 && url.pathname === "/static/acme-ui/foundation/latest/tokens.css";
      if (response.status() >= 400 && !expectedUnpublishedFoundation) {
        errors.push(`HTTP ${response.status()}: ${response.url()}`);
      }
    });
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
    let pausePublication = false;
    let notifyPublicationRequest;
    let releasePublicationResponse;
    const publicationRequestStarted = new Promise((resolve) => {
      notifyPublicationRequest = resolve;
    });
    let documentNavigations = 0;
    page.on("request", (request) => {
      if (request.isNavigationRequest() && request.resourceType() === "document") {
        documentNavigations += 1;
      }
    });
    await page.route("https://at-li3.static.apphor.de/**", (route) =>
      width === 900
        ? route.abort("failed")
        : route.fulfill({
            contentType: "text/javascript",
            body: `export async function load() { if (!customElements.get('code-editor')) customElements.define('code-editor', class extends HTMLElement { value = ''; }); }`,
          }),
    );
    await page.route("**/static/**", async (route) => {
      if (pausePublication) {
        pausePublication = false;
        notifyPublicationRequest();
        await new Promise((resolve) => {
          releasePublicationResponse = resolve;
        });
      }
      await route.fulfill({ status: foundationPublished ? 200 : 404, body: ":root { --brand: blue; }" });
    });
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
    await expect(page.locator(".team-card")).toHaveCount(2);
    await expect(page.getByRole("link", { name: /Workspace overview/ })).toHaveCount(0);
    await expect(page.locator(".team-card").first()).toContainText("Unknown members · 2 design systems");
    await expect(page.locator(".team-card").first()).not.toContainText("Team ·");
    await expect(page.locator(".team-card").first().locator(":scope > *")).toHaveCount(2);
    await expect(page.locator("#dashboard-breadcrumbs")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "New design system" })).toBeHidden();
    await page.screenshot({ path: test.info().outputPath(`landing-${width}.png`), fullPage: true });
    await page.getByRole("link", { name: /acme/ }).first().click();
    await expect(page.locator(".system-card")).toHaveCount(2);
    await expect(page.locator("#teams-title")).toHaveText("Design systems");
    await expect(page.locator(".workspace-sidebar")).toBeHidden();
    await expect(page.getByRole("button", { name: "New design system" })).toBeVisible();
    await expect(page.locator(".team-card").first()).toHaveCSS("min-height", "0px");
    await expect(page.locator(".sidebar-create")).toHaveText("＋ New system");
    await page.getByRole("button", { name: "New design system" }).click();
    await expect(page.getByRole("dialog", { name: "Create a design system" })).toBeVisible();
    await expect(page.locator("#system-form")).toBeVisible();
    await expect(page.locator("#system-team")).toHaveValue("acme");
    await page.getByRole("button", { name: "Close dialog" }).click();
    await expect(page.locator("#team-list")).toContainText("Acme UI");
    await expect(page).toHaveURL(/teamSlug=acme/);
    expect(documentNavigations).toBe(1);
    await page.reload();
    await expect(page.locator(".system-card")).toHaveCount(2);
    await expect(page.locator("#page-deck > wds-page-layer")).toHaveCount(1);
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
    pausePublication = true;
    await page.locator("#system-grid .system-card").filter({ hasText: "Acme UI" }).click();
    await publicationRequestStarted;
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("wds:navigate", { detail: "/" })));
    await expect(page.locator("#dashboard-title")).toHaveText("Your teams");
    releasePublicationResponse();
    await expect(page).toHaveTitle("Your teams · Workbench");
    await page.locator("#system-grid .team-card").filter({ hasText: "acme" }).click();
    await expect(page.locator(".system-card")).toHaveCount(2);
    await page.locator("#system-grid .system-card").filter({ hasText: "Acme UI" }).click();
    await expect(page.locator("#dashboard-title")).toHaveText("Acme UI");
    await expect(page.locator("#page-deck > .page-layer--snapshot")).toHaveCount(1);
    const previousLayer = page.getByRole("link", { name: "Return to acme" });
    await expect(previousLayer).toBeVisible();
    await expect(page.locator(".page-layer--snapshot .page-layer-snapshot-content .system-card")).toHaveCount(2);
    await expect(page.locator("#active-page-layer")).toHaveCSS("box-shadow", /rgba/);
    const mainLayout = await page.evaluate(() => {
      const selectors = ["#dashboard-layout", "wds-dashboard-layout", ".dashboard-main", "#page-deck"];
      return selectors.map((selector) => {
        const element = document.querySelector(selector);
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {
          selector,
          margin: style.margin,
          padding: style.padding,
          width: rect.width,
          height: rect.height,
        };
      });
    });
    expect(mainLayout.map(({ margin, padding }) => [margin, padding])).toEqual([
      ["0px", "0px"],
      ["0px", "0px"],
      ["0px", "0px"],
      ["64px 0px 0px", "0px"],
    ]);
    expect(mainLayout.at(-1).width).toBe(width);
    expect(mainLayout.at(-1).height).toBe(676);
    const cardGeometry = await page.evaluate(() => {
      const active = document.querySelector("#active-page-layer").getBoundingClientRect();
      const snapshot = document.querySelector(".page-layer--snapshot").getBoundingClientRect();
      return {
        activeStyle: {
          layer: getComputedStyle(document.querySelector("#active-page-layer")).getPropertyValue("--layer"),
          layerCount: getComputedStyle(document.querySelector("#active-page-layer")).getPropertyValue("--layer-count"),
          top: getComputedStyle(document.querySelector("#active-page-layer")).top,
          left: getComputedStyle(document.querySelector("#active-page-layer")).left,
          right: getComputedStyle(document.querySelector("#active-page-layer")).right,
        },
        snapshotStyle: {
          layer: getComputedStyle(document.querySelector(".page-layer--snapshot")).getPropertyValue("--layer"),
          layerCount: getComputedStyle(document.querySelector(".page-layer--snapshot")).getPropertyValue(
            "--layer-count",
          ),
          top: getComputedStyle(document.querySelector(".page-layer--snapshot")).top,
          left: getComputedStyle(document.querySelector(".page-layer--snapshot")).left,
          right: getComputedStyle(document.querySelector(".page-layer--snapshot")).right,
        },
        activeTop: active.top,
        activeBottom: active.bottom,
        snapshotTop: snapshot.top,
        snapshotBottom: snapshot.bottom,
      };
    });
    expect(cardGeometry.activeStyle).toEqual({ layer: "2", layerCount: "2", top: "64px", left: "32px", right: "16px" });
    expect(cardGeometry.snapshotStyle).toEqual({
      layer: "1",
      layerCount: "2",
      top: "32px",
      left: "16px",
      right: "32px",
    });
    expect(cardGeometry.activeTop).toBeGreaterThan(cardGeometry.snapshotTop);
    expect(cardGeometry.activeTop).toBeLessThan(cardGeometry.snapshotBottom);
    const accountPanel = await page.locator("#sidebar-user-card").boundingBox();
    expect(accountPanel.x + accountPanel.width).toBeCloseTo(width - 16, 0);
    expect(accountPanel.y + accountPanel.height).toBeLessThan(cardGeometry.snapshotTop);
    await expect(page.locator("#page-deck .page-layer--snapshot #sidebar-user-card")).toHaveCount(0);
    await expect(page.getByText("Workbench", { exact: true })).toHaveCount(0);
    await expect(page.locator(".page-layer--snapshot [id]")).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath(`deck-${width}.png`), fullPage: true });
    await previousLayer.click();
    await expect(page).toHaveURL(/teamSlug=acme$/);
    await expect(page.locator("#page-deck > .page-layer--snapshot")).toHaveCount(0);
    await expect(page.locator("#active-page-layer")).toBeFocused();
    await page.locator("#system-grid .system-card").filter({ hasText: "Acme UI" }).click();
    await expect(page.locator("#dashboard-title")).toHaveText("Acme UI");
    const backToTeam = page.getByRole("link", { name: "Return to acme" });
    await backToTeam.focus();
    await expect(backToTeam).toBeFocused();
    await backToTeam.press("Enter");
    await expect(page).toHaveURL(/teamSlug=acme$/);
    await expect(page.locator("#active-page-layer")).toBeFocused();
    await page.locator("#system-grid .system-card").filter({ hasText: "Acme UI" }).click();
    await expect(page.locator("#dashboard-title")).toHaveText("Acme UI");
    expect(documentNavigations).toBe(2);
    await page.goBack();
    await expect(page).toHaveURL(/teamSlug=acme$/);
    await page.goForward();
    await expect(page.locator("#dashboard-title")).toHaveText("Acme UI");
    await expect(page.locator("#active-page-layer #foundation-setup")).toBeVisible();
    await expect(page.getByRole("link", { name: "All design systems" })).toHaveCount(0);
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
    await expect(page.locator("#active-page-layer")).toHaveAttribute("aria-current", "page");
    await expect(page.locator("#page-deck > .page-layer--snapshot")).toHaveCount(2);
    await expect(page.locator("#active-page-layer #workspace")).toBeVisible();
    await expect(page.locator(".nav-context[href]")).toHaveCount(0);
    await expect(page.locator("#active-page-layer #project-content")).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`editor-deck-${width}.png`), fullPage: true });
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("link", { name: "Return to acme", exact: true }).click();
    await expect(page).toHaveURL(/teamSlug=acme$/);
    await expect(page.locator("#page-deck > .page-layer--snapshot")).toHaveCount(0);
    await expect(page.locator("#active-page-layer")).toBeFocused();
    await page.locator("#system-grid .system-card").filter({ hasText: "Acme UI" }).click();
    await expect(page.locator(".setup-action")).toBeVisible();
    await page.locator(".setup-action").click();
    await expect(page).toHaveURL(/team=acme-ui&repo=foundation/);
    await expect(page.locator("#page-deck > .page-layer--snapshot")).toHaveCount(2);
    await expect(page.getByRole("button", { name: "Save Foundation" })).toBeVisible();
    if (width <= 760) {
      await page.locator("#active-page-layer .project-drawer > summary").click();
    }
    if (width === 1440) {
      await expect(page.getByRole("button", { name: "Save Foundation" })).toBeEnabled();
    } else {
      await expect(page.getByRole("button", { name: "Save Foundation" })).toBeDisabled();
    }
    await expect(page.getByRole("textbox", { name: "Describe your changes" })).toBeVisible();
    await expect(page.locator("#active-page-layer").getByLabel("Public tokens.css URL")).toHaveValue(
      /^http:\/\/127\.0\.0\.1:4175\/static\/acme-ui\/foundation\/latest\/tokens\.css$/,
    );
    await expect(page.locator("#active-page-layer").getByLabel("Public reset.css URL")).toHaveValue(
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
    await expect(
      page.locator(".page-layer--snapshot").last().locator(".page-layer-snapshot-content .foundation-layout"),
    ).toHaveCount(1);
    await expect(page.locator(".page-layer--snapshot .page-layer-snapshot-content").first()).toHaveJSProperty(
      "inert",
      true,
    );
    const unsafeSnapshotNodes = await page
      .locator(".page-layer--snapshot .page-layer-snapshot-content")
      .evaluateAll((roots) =>
        roots.flatMap((root) =>
          [...root.querySelectorAll("*")]
            .filter((element) => {
              const unsafeTag = [
                "script",
                "style",
                "link",
                "meta",
                "base",
                "iframe",
                "object",
                "embed",
                "audio",
                "video",
                "source",
                "track",
              ].includes(element.localName.toLowerCase());
              const unsafeAttribute = [...element.attributes].some(
                (attribute) =>
                  ["href", "src", "srcset", "poster", "action", "formaction", "srcdoc"].includes(
                    attribute.name.toLowerCase(),
                  ) ||
                  /^on/i.test(attribute.name) ||
                  (attribute.name.toLowerCase() === "style" && /url\s*\(/i.test(attribute.value)),
              );
              return unsafeTag || unsafeAttribute || element.localName.includes("-");
            })
            .map((element) => element.localName),
        ),
      );
    expect(unsafeSnapshotNodes).toEqual([]);
    await page.goBack();
    await page.goBack();
    await expect(page.locator("#dashboard-title")).toHaveText("Acme UI");
    await expect(page.locator(".foundation-card")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Open design system settings" })).toBeVisible();
    await expect(page.locator("#foundation-setup")).toBeHidden();
    await expect(page.locator("#component-area")).toBeVisible();
    await expect(page.getByRole("button", { name: "New component" })).toBeEnabled();
    await expect(page.locator("#overview-components .system-card")).toHaveCount(6);
    const searchRow = await page.locator("#active-page-layer .component-toolbar").boundingBox();
    const searchInput = await page.getByRole("searchbox", { name: "Find a component" }).boundingBox();
    const createButton = await page.getByRole("button", { name: "New component" }).boundingBox();
    await expect
      .poll(async () => {
        const [input, button] = await Promise.all([
          page.getByRole("searchbox", { name: "Find a component" }).boundingBox(),
          page.getByRole("button", { name: "New component" }).boundingBox(),
        ]);
        return Math.abs(input.y - button.y);
      })
      .toBeLessThanOrEqual(6);
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
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("wds:navigate", { detail: "/" })));
    await page.getByRole("button", { name: "New team" }).click();
    await page.getByLabel("Team slug", { exact: true }).fill("new-team");
    await page.getByRole("button", { name: "Create team", exact: true }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(page.locator("#dashboard-title")).toHaveText("Design systems");
    await expect(page.locator("#first-system-empty")).toBeVisible();
    await page.locator("#active-page-layer").getByPlaceholder("Name").fill("Web System");
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
    await expect(page.locator("#sidebar-user-card")).toBeVisible();
    await page.locator("#sidebar-user-card").click();
    await expect(page.locator("#preferences-view")).toBeVisible();
    await expect(page.locator("#page-deck > .page-layer--exiting")).toHaveCount(0);
    const snapshots = page.locator("#page-deck > .page-layer--snapshot");
    const retainedPageCount = await snapshots.count();
    expect(retainedPageCount).toBeGreaterThan(4);
    await expect(snapshots.last().locator(".page-layer-snapshot-content .studio-shell")).toHaveCount(1);
    for (let index = 0; index < 5; index += 1) {
      const route = `/?view=preferences&layer=${index}`;
      await page.evaluate((href) => window.dispatchEvent(new CustomEvent("wds:navigate", { detail: href })), route);
      await expect(page).toHaveURL(new RegExp(`layer=${index}$`));
    }
    await expect(page.locator("#page-deck > .page-layer--exiting")).toHaveCount(0);
    await expect(snapshots).toHaveCount(retainedPageCount + 5);
    const oldestSnapshot = page.locator("#page-deck > .page-layer--snapshot").first();
    const oldestRoute = await oldestSnapshot.getAttribute("data-route");
    await oldestSnapshot.locator(".page-layer-snapshot-header").click();
    await expect
      .poll(() => page.evaluate(() => `${location.pathname}${location.search}${location.hash}`))
      .toBe(oldestRoute);
    await expect(page.locator("#page-deck > .page-layer--snapshot")).toHaveCount(0);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("wds:navigate", { detail: "/?view=preferences" })));
    await expect(page.locator("#preferences-view")).toBeVisible();
    await page.locator("#preferences-sign-out").click();
    await expect(page.getByRole("heading", { name: "A home for your team’s UX" })).toBeVisible();
    await expect(page.locator("#page-deck > .page-layer--snapshot")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}
