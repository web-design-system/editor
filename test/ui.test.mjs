import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("landing page lists teams and design systems without depending on component artifacts", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../public/app.mjs", import.meta.url), "utf8");
  assert.match(html, /id="team-list"/);
  assert.match(html, /id="system-grid"/);
  assert.match(html, /id="team-form"/);
  assert.match(html, /id="system-form"/);
  assert.match(html, /id="creation-controls"[^>]*hidden/);
  assert.match(html, /Teams are Git organizations; design systems are repositories inside a team/);
  assert.match(app, /fetch\("\/api\/teams"/);
  assert.match(app, /fetch\("\/api\/projects"/);
  assert.match(app, /project\.type === "design-system"/);
  assert.match(app, /\/\?team=\$\{encodeURIComponent\(system\.team\)\}&amp;repo=/);
  assert.match(app, /\/api\/oidc\/me/);
  assert.match(app, /\/api\/oidc\/login/);
  assert.match(app, /fetch\("\/api\/teams", \{/);
  assert.match(app, /fetch\("\/api\/projects", \{/);
  assert.match(app, /teamForm\.addEventListener\("submit"/);
  assert.match(app, /systemForm\.addEventListener\("submit"/);
  assert.match(app, /Sign-in could not be completed/);
  assert.doesNotMatch(html, /<wds-[a-z-]+/);
});

test("opening a design system presents a blank workbench shell", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../public/app.mjs", import.meta.url), "utf8");
  assert.match(app, /const team = params\.get\("team"\)/);
  assert.match(app, /const repo = params\.get\("repo"\)/);
  assert.match(app, /workspace\.style\.display = "block"/);
  assert.match(html, /id="workspace-user-card"/);
  assert.match(html, /<main class="work-area" aria-label="Design system workspace"><\/main>/);
});
