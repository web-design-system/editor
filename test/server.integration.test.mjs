import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, readdir, readFile, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";

const projectRoot = resolve(import.meta.dirname, "..");
const listen = (server) =>
  new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen(server.address().port));
  });
const close = (server) => new Promise((resolveClose) => server.close(resolveClose));
const run = (cmd, args, options = {}) =>
  new Promise((resolveRun, reject) => {
    const child = spawn(cmd, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolveRun(stdout.trim()) : reject(new Error(`${cmd} failed: ${stderr}`)),
    );
  });

test("OIDC-authenticated project flow persists changes to isolated Git API", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "wds-next-integration-"));
  let oidcServer;
  let gitApiServer;
  let app;
  try {
    const bareRoot = join(temp, "git");
    const mountedRoot = join(temp, "mounted");
    const imageBytes = Buffer.from([0, 1, 2, 3, 255, 128]);
    await mkdir(bareRoot);
    await mkdir(mountedRoot);
    await mkdir(join(bareRoot, "broken-team"));
    await writeFile(join(bareRoot, "broken-team", "broken-repo.git"), "not a Git repository\n");
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = publicKey.export({ format: "jwk" });
    Object.assign(jwk, { kid: "integration-key", use: "sig", alg: "RS256" });
    let expectedNonce;
    let userinfoSubject = "integration-user";
    oidcServer = createServer(async (req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const json = (body) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === "/.well-known/openid-configuration") {
        return json({
          issuer: oidcIssuer,
          authorization_endpoint: `${oidcIssuer}/authorize`,
          token_endpoint: `${oidcIssuer}/token`,
          userinfo_endpoint: `${oidcIssuer}/userinfo`,
          jwks_uri: `${oidcIssuer}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (url.pathname === "/jwks") {
        return json({ keys: [jwk] });
      }
      if (url.pathname === "/authorize") {
        expectedNonce = url.searchParams.get("nonce");
        res.writeHead(302, {
          location: `/authorize-done?state=${url.searchParams.get("state")}&nonce=${url.searchParams.get("nonce")}`,
        });
        res.end();
        return;
      }
      if (url.pathname === "/token") {
        let raw = "";
        for await (const chunk of req) {
          raw += chunk;
        }
        const form = new URLSearchParams(raw);
        assert.equal(form.get("code_verifier")?.length, 43);
        assert.equal(form.get("client_id"), "local-client");
        assert.equal(form.get("client_secret"), "local-secret");
        const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "integration-key" })).toString("base64url");
        const claims = {
          iss: oidcIssuer,
          aud: "local-client",
          sub: "integration-user",
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 600,
        };
        if (form.get("code") !== "missing-nonce") {
          claims.nonce = form.get("code") === "bad-nonce" ? "wrong-nonce" : expectedNonce;
        }
        const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
        const input = `${header}.${payload}`;
        return json({
          id_token: `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`,
          access_token: "local-access-token",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
      if (url.pathname === "/userinfo") {
        return json({ sub: userinfoSubject, name: "Integration User" });
      }
      res.writeHead(404);
      res.end();
    });
    const oidcPort = await listen(oidcServer);
    const oidcIssuer = `http://127.0.0.1:${oidcPort}`;

    gitApiServer = createServer(async (req, res) => {
      const path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
      if (!path.startsWith("/git/") && req.headers.authorization !== "Bearer local-test-only") {
        res.writeHead(401);
        res.end();
        return;
      }
      if (path === "/api/v1/orgs" && req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(await readdir(bareRoot)));
        return;
      }
      if (path === "/api/v1/orgs" && req.method === "POST") {
        let body = "";
        for await (const chunk of req) {
          body += chunk;
        }
        const { slug } = JSON.parse(body);
        try {
          await mkdir(join(bareRoot, slug));
        } catch {
          res.writeHead(409);
          res.end();
          return;
        }
        res.writeHead(201, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      const repoList = path.match(/^\/api\/v1\/orgs\/([^/]+)\/repos$/);
      if (repoList) {
        const names = await readdir(join(bareRoot, repoList[1])).catch(() => []);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(names.map((name) => name.replace(/\.git$/, ""))));
        return;
      }
      const createRepo = path.match(/^\/api\/v1\/orgs\/([^/]+)\/repos\/([^/]+)$/);
      if (createRepo && req.method === "POST") {
        const repoPath = join(bareRoot, createRepo[1], `${createRepo[2]}.git`);
        try {
          await mkdir(join(bareRoot, createRepo[1]), { recursive: true });
          const seedPath = join(temp, `initial-repository-${createRepo[2]}`);
          await run("git", ["init", "--bare", "--initial-branch=master", repoPath]);
          await run("git", ["init", "--initial-branch=master", seedPath]);
          await run("git", ["-C", seedPath, "config", "user.name", "Git API"]);
          await run("git", ["-C", seedPath, "config", "user.email", "git-api@example.test"]);
          await writeFile(join(seedPath, "README.md"), "Git API repository initialization\n");
          await writeFile(join(seedPath, ".env"), "PRIVATE=not-public\n");
          await mkdir(join(seedPath, "images"), { recursive: true });
          await writeFile(join(seedPath, "images", "seed.png"), imageBytes);
          await run("git", ["-C", seedPath, "add", "."]);
          await run("git", ["-C", seedPath, "commit", "-m", "Initialize repository"]);
          await run("git", ["-C", seedPath, "remote", "add", "origin", repoPath]);
          await run("git", ["-C", seedPath, "push", "origin", "master"]);
          res.writeHead(201, { "content-type": "application/json" });
        } catch {
          res.writeHead(409);
        }
        res.end(req.method === "POST" && res.statusCode === 201 ? "{}" : undefined);
        return;
      }
      if (path.startsWith("/git/")) {
        const gitPath = path.slice("/git/".length);
        const child = spawn("git", ["http-backend"], {
          env: {
            ...process.env,
            GIT_PROJECT_ROOT: bareRoot,
            GIT_HTTP_EXPORT_ALL: "1",
            PATH_INFO: `/${gitPath}`,
            REQUEST_METHOD: req.method,
            QUERY_STRING: new URL(req.url, "http://localhost").searchParams.toString(),
            CONTENT_TYPE: req.headers["content-type"] || "",
            CONTENT_LENGTH: req.headers["content-length"] || "0",
            REMOTE_USER: "integration",
            REMOTE_ADDR: "127.0.0.1",
          },
        });
        let header = Buffer.alloc(0);
        child.stdout.on("data", (chunk) => {
          if (header) {
            header = Buffer.concat([header, chunk]);
            const i = header.indexOf("\r\n\r\n");
            if (i >= 0) {
              const head = header.subarray(0, i).toString();
              for (const line of head.split("\r\n")) {
                const j = line.indexOf(":");
                if (j > 0 && line.slice(0, j).toLowerCase() !== "status") {
                  res.setHeader(line.slice(0, j), line.slice(j + 1).trim());
                }
              }
              res.writeHead(Number(head.match(/Status: (\d+)/)?.[1] || 200));
              res.write(header.subarray(i + 4));
              header = null;
            }
          } else {
            res.write(chunk);
          }
        });
        child.once("close", () => {
          if (header) {
            res.writeHead(500);
            res.end(header);
          } else {
            res.end();
          }
        });
        req.pipe(child.stdin);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const gitPort = await listen(gitApiServer);
    const gitApiUrl = `http://127.0.0.1:${gitPort}`;
    const appPort = await new Promise((resolvePort, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const port = probe.address().port;
        probe.close(() => resolvePort(port));
      });
    });
    app = spawn(process.execPath, [join(projectRoot, "server.mjs")], {
      cwd: projectRoot,
      env: {
        ...process.env,
        PORT: String(appPort),
        OIDC_ISSUER: oidcIssuer,
        OIDC_CLIENT_ID: "local-client",
        OIDC_CLIENT_SECRET: "local-secret",
        GIT_API_URL: gitApiUrl,
        GIT_API_TOKEN: "local-test-only",
        WDS_ALLOWED_SUBJECTS: "integration-user",
        SOURCE_TEAM: "mounted-team",
        SOURCE_TEAM_PATH: mountedRoot,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let appErrors = "";
    app.stderr.on("data", (chunk) => {
      appErrors += chunk;
    });
    const base = `http://127.0.0.1:${appPort}`;
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      if (app.exitCode !== null) {
        throw new Error(`WDS server exited: ${appErrors}`);
      }
      try {
        ready = (await fetch(`${base}/api/oidc/me`)).ok;
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      }
    }
    assert.equal(ready, true, `WDS server did not become ready: ${appErrors}`);

    assert.equal((await fetch(`${base}/api/teams`, { method: "POST" })).status, 401);

    const login = await fetch(`${base}/api/oidc/login`, {
      redirect: "manual",
      headers: {
        origin: "https://attacker.example",
        "x-forwarded-proto": "https",
      },
    });
    assert.equal(login.status, 302, appErrors);
    const stateCookie = login.headers.get("set-cookie").split(";")[0];
    const authorize = new URL(login.headers.get("location"));
    assert.equal(authorize.searchParams.get("client_id"), "local-client");
    assert.equal(authorize.searchParams.get("redirect_uri"), `https://127.0.0.1:${appPort}/auth/callback`);
    assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
    assert.ok(authorize.searchParams.get("nonce"));
    const authorizationDone = await fetch(`${oidcIssuer}/authorize?${authorize.searchParams}`, { redirect: "manual" });
    const callback = new URL(authorizationDone.headers.get("location"), oidcIssuer);
    const badState = await fetch(`${base}/auth/callback?code=local-code&state=wrong`, {
      headers: { cookie: stateCookie },
      redirect: "manual",
    });
    assert.equal(badState.status, 400);
    const malformedState = await fetch(`${base}/auth/callback?code=local-code&state=x%29%5B`, {
      redirect: "manual",
    });
    assert.equal(malformedState.status, 400);
    const missingState = await fetch(`${base}/auth/callback?error=access_denied`, { redirect: "manual" });
    assert.equal(missingState.status, 400);
    const authResult = await fetch(
      `${base}/auth/callback?code=local-code&state=${callback.searchParams.get("state")}`,
      { headers: { cookie: stateCookie }, redirect: "manual" },
    );
    assert.equal(authResult.status, 302);
    const responseCookies = authResult.headers.getSetCookie?.() || [authResult.headers.get("set-cookie")];
    const sessionSetCookie = responseCookies.find((cookie) => cookie?.startsWith("wds-session="));
    assert.ok(sessionSetCookie, appErrors);
    const sessionCookie = sessionSetCookie.split(";")[0];
    const headers = { cookie: sessionCookie, "content-type": "application/json" };
    assert.deepEqual(await (await fetch(`${base}/api/oidc/me`, { headers })).json(), {
      authenticated: true,
      user: { sub: "integration-user", name: "Integration User" },
    });
    const replay = await fetch(`${base}/auth/callback?code=local-code&state=${callback.searchParams.get("state")}`, {
      headers: { cookie: stateCookie },
      redirect: "manual",
    });
    assert.equal(replay.status, 400);
    const deniedLogin = await fetch(`${base}/api/oidc/login`, { redirect: "manual" });
    const deniedCookie = deniedLogin.headers.get("set-cookie").split(";")[0];
    const deniedAuthorization = new URL(deniedLogin.headers.get("location"));
    const deniedState = deniedAuthorization.searchParams.get("state");
    const deniedCallback = await fetch(`${base}/auth/callback?error=access_denied&state=${deniedState}`, {
      headers: { cookie: deniedCookie },
      redirect: "manual",
    });
    assert.equal(deniedCallback.status, 302);
    assert.match(deniedCallback.headers.get("location"), /auth_error=1/);
    const missingNonceLogin = await fetch(`${base}/api/oidc/login`, { redirect: "manual" });
    const missingNonceCookie = missingNonceLogin.headers.get("set-cookie").split(";")[0];
    const missingNonceAuthorization = new URL(missingNonceLogin.headers.get("location"));
    const missingNonceRedirect = await fetch(`${oidcIssuer}/authorize?${missingNonceAuthorization.searchParams}`, {
      redirect: "manual",
    });
    const missingNonceState = new URL(missingNonceRedirect.headers.get("location"), oidcIssuer).searchParams.get(
      "state",
    );
    const missingNonceCallback = await fetch(`${base}/auth/callback?code=missing-nonce&state=${missingNonceState}`, {
      headers: { cookie: missingNonceCookie },
      redirect: "manual",
    });
    assert.match(missingNonceCallback.headers.get("location"), /auth_error=1/);
    userinfoSubject = "different-user";
    const mismatchLogin = await fetch(`${base}/api/oidc/login`, { redirect: "manual" });
    const mismatchCookie = mismatchLogin.headers.get("set-cookie").split(";")[0];
    const mismatchAuthorization = new URL(mismatchLogin.headers.get("location"));
    const mismatchRedirect = await fetch(`${oidcIssuer}/authorize?${mismatchAuthorization.searchParams}`, {
      redirect: "manual",
    });
    const mismatchState = new URL(mismatchRedirect.headers.get("location"), oidcIssuer).searchParams.get("state");
    const mismatchCallback = await fetch(`${base}/auth/callback?code=mismatch&state=${mismatchState}`, {
      headers: { cookie: mismatchCookie },
      redirect: "manual",
    });
    assert.match(mismatchCallback.headers.get("location"), /auth_error=1/);
    userinfoSubject = "integration-user";
    const invalidTeam = await fetch(`${base}/api/teams`, {
      method: "POST",
      headers,
      body: JSON.stringify({ slug: "Bad Team" }),
    });
    assert.equal(invalidTeam.status, 400);
    const createTeam = await fetch(`${base}/api/teams`, {
      method: "POST",
      headers,
      body: JSON.stringify({ slug: "new-team" }),
    });
    assert.equal(createTeam.status, 201, await createTeam.text());
    const duplicateTeam = await fetch(`${base}/api/teams`, {
      method: "POST",
      headers,
      body: JSON.stringify({ slug: "new-team" }),
    });
    assert.equal(duplicateTeam.status, 409);
    const invalid = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers,
      body: JSON.stringify({ team: "Invalid Team", repo: "bad" }),
    });
    assert.equal(invalid.status, 400);
    const invalidJson = await fetch(`${base}/api/projects`, { method: "POST", headers, body: "{" });
    assert.equal(invalidJson.status, 400);
    const oversized = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers,
      body: JSON.stringify({ team: "test-team", repo: "too-large", description: "x".repeat(2 * 1024 * 1024) }),
    });
    assert.equal(oversized.status, 413);
    const unassociatedComponent = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers,
      body: JSON.stringify({ team: "test-team", repo: "unassociated", type: "component" }),
    });
    assert.equal(unassociatedComponent.status, 400);
    const invalidSystemComponent = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        team: "test-team",
        repo: "bad-system",
        type: "component",
        designSystem: { team: "test-team", repo: "not-a-system", revision: "latest" },
      }),
    });
    assert.equal(invalidSystemComponent.status, 400);
    const createFoundation = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        team: "test-team",
        repo: "foundation",
        type: "design-system",
        description: "Shared tokens",
      }),
    });
    assert.equal(createFoundation.status, 201, await createFoundation.text());
    const beforeTokenPublish = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        team: "test-team",
        repo: "before-token-publish",
        type: "component",
        designSystem: { team: "test-team", repo: "foundation", revision: "latest" },
      }),
    });
    assert.equal(beforeTokenPublish.status, 400);
    const foundationPublish = await fetch(`${base}/api/publish/test-team/foundation`, { method: "POST", headers });
    assert.equal(foundationPublish.status, 200, await foundationPublish.text());
    assert.equal((await fetch(`${base}/static/test-team/foundation/latest/tokens.css`)).status, 200);
    const create = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        team: "test-team",
        repo: "sample-project",
        description: "integration",
        designSystem: { team: "test-team", repo: "foundation", revision: "latest" },
      }),
    });
    const createdProject = await create.json();
    assert.equal(create.status, 201, JSON.stringify(createdProject));
    assert.equal(createdProject.project.sourceMode, "git");
    assert.match(createdProject.project.revision, /^[0-9a-f]+$/);
    const duplicate = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        team: "test-team",
        repo: "sample-project",
        designSystem: { team: "test-team", repo: "foundation", revision: "latest" },
      }),
    });
    assert.equal(duplicate.status, 409);
    const listing = await fetch(`${base}/api/projects`, { headers });
    assert.deepEqual(
      (await listing.json()).map(({ team, repo }) => ({ team, repo })),
      [
        { team: "test-team", repo: "foundation" },
        { team: "test-team", repo: "sample-project" },
      ],
    );
    const teamListing = await fetch(`${base}/api/teams`, { headers });
    assert.deepEqual((await teamListing.json()).teams, ["broken-team", "mounted-team", "new-team", "test-team"]);
    const sourceUrl = `${base}/api/source/test-team/sample-project`;
    const sourceBefore = await (await fetch(sourceUrl, { headers })).json();
    assert.equal(sourceBefore.sourceMode, "git");
    assert.equal((await fetch(`${base}/static/test-team/sample-project/latest/component.html`)).status, 404);
    assert.match(sourceBefore.files["component.html"], /component="ds-sample-project"/);
    assert.match(sourceBefore.files["component.html"], /data-wds-editable class="p-4 bg-indigo-600 text-white"/);
    assert.equal(
      sourceBefore.files["styles.css"],
      '@import url("/static/test-team/foundation/latest/tokens.css");\n@import "tailwindcss";\n',
    );
    assert.match(sourceBefore.files["component.json"], /"designSystem"/);
    assert.match(sourceBefore.files["stories.html"], /import '@li3\/web'/);
    assert.match(sourceBefore.files["component.json"], /"description": "integration"/);
    const changed = {
      ...sourceBefore.files,
      "component.html":
        '<template component="ds-sample-project" shadow-dom="open"><div data-wds-editable class="p-6">Changed integration source</div></template>\n',
    };
    const update = await fetch(sourceUrl, {
      method: "PUT",
      headers,
      body: JSON.stringify({ files: changed, message: "Integration source update" }),
    });
    const updateData = await update.json();
    assert.equal(update.status, 200, JSON.stringify(updateData));
    assert.equal(updateData.sourceMode, "git");
    const sourceAfter = await (await fetch(sourceUrl, { headers })).json();
    assert.equal(sourceAfter.files["component.html"], changed["component.html"]);
    const historyResponse = await fetch(`${base}/api/history/test-team/sample-project`, { headers });
    const historyData = await historyResponse.json();
    assert.equal(historyResponse.status, 200, JSON.stringify(historyData));
    assert.ok(historyData.history.some((entry) => entry.message === "Integration source update"));
    assert.match(historyData.history[0].revision, /^[a-f0-9]{40}$/);
    const blockedGitImport = await fetch(sourceUrl, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        files: { ...sourceAfter.files, "styles.css": '@import "../outside.css"' },
        message: "Reject cross-repository stylesheet import",
      }),
    });
    assert.equal(blockedGitImport.status, 400);
    const afterBlockedGitImport = await (await fetch(sourceUrl, { headers })).json();
    assert.equal(afterBlockedGitImport.files["styles.css"], sourceAfter.files["styles.css"]);
    const blockedExternalImport = await fetch(sourceUrl, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        files: { ...sourceAfter.files, "styles.css": '@import url("https://example.test/tokens.css");' },
        message: "Reject remote stylesheet",
      }),
    });
    assert.equal(blockedExternalImport.status, 400);
    const mismatchedTokens = await fetch(sourceUrl, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        files: {
          ...sourceAfter.files,
          "styles.css": '@import url("/static/test-team/other-system/latest/tokens.css");\n@import "tailwindcss";\n',
        },
        message: "Use mismatched tokens",
      }),
    });
    assert.equal(mismatchedTokens.status, 200);
    const mismatchedPublish = await fetch(`${base}/api/publish/test-team/sample-project`, { method: "POST", headers });
    assert.equal(mismatchedPublish.status, 400);
    const nestedFiles = {
      ...sourceAfter.files,
      "styles.css":
        '@import url("/static/test-team/foundation/latest/tokens.css");\n@import "tailwindcss";\n.dynamic { color: teal; }\n',
      "themes/nested.css": ".dynamic { color: teal; }\n",
      "examples/demo.html": "<main>New nested page</main>\n",
      "images/new.svg": '<svg xmlns="http://www.w3.org/2000/svg"><title>Fresh</title></svg>',
    };
    const nestedUpdate = await fetch(sourceUrl, {
      method: "PUT",
      headers,
      body: JSON.stringify({ files: nestedFiles, message: "Integration source update" }),
    });
    assert.equal(nestedUpdate.status, 200);
    const nestedSource = await (await fetch(sourceUrl, { headers })).json();
    assert.equal(nestedSource.files["themes/nested.css"], nestedFiles["themes/nested.css"]);
    assert.equal(nestedSource.files["examples/demo.html"], nestedFiles["examples/demo.html"]);
    assert.equal((await fetch(`${base}/static/test-team/sample-project/latest/component.html`)).status, 404);
    const publish = await fetch(`${base}/api/publish/test-team/sample-project`, {
      method: "POST",
      headers,
      body: "{}",
    });
    const publishData = await publish.json();
    assert.equal(publish.status, 200, JSON.stringify(publishData));
    assert.match(publishData.revision, /^[a-f0-9]{40}$/);
    const publishedManifest = await (
      await fetch(`${base}/static/test-team/sample-project/latest/manifest.json`)
    ).json();
    assert.equal(publishedManifest.revision, publishData.revision);
    assert.ok(publishedManifest.files.includes("component.html"));
    assert.equal(publishedManifest.files.includes("spec.mjs"), false);
    assert.equal((await fetch(`${base}/static/test-team/sample-project/latest/spec.mjs`)).status, 404);
    const publishedPreview = await fetch(
      `${base}/static/test-team/sample-project/latest/component.html?view=component`,
    );
    assert.equal(publishedPreview.status, 200);
    assert.match(publishedPreview.headers.get("content-security-policy"), /^sandbox allow-scripts;/);
    assert.match(publishedPreview.headers.get("content-security-policy"), /connect-src 'none'/);
    const publishedStyles = await (await fetch(`${base}/static/test-team/sample-project/latest/styles.css`)).text();
    assert.notEqual(publishedStyles, nestedSource.files["styles.css"]);
    assert.match(publishedStyles, /@import\s+["']\/static\/test-team\/foundation\/latest\/tokens\.css["']/);
    assert.doesNotMatch(publishedStyles, /--ds-color-accent/);
    const newerSource = {
      ...nestedSource.files,
      "component.html": "<main>Committed but not published yet</main>\n",
    };
    const newerCommit = await fetch(sourceUrl, {
      method: "PUT",
      headers,
      body: JSON.stringify({ files: newerSource, message: "Unpublished source change" }),
    });
    assert.equal(newerCommit.status, 200);
    assert.equal(
      await (await fetch(`${base}/static/test-team/sample-project/latest/component.html`)).text(),
      changed["component.html"],
    );
    const republish = await fetch(`${base}/api/publish/test-team/sample-project`, {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(republish.status, 200);
    assert.equal(
      await (await fetch(`${base}/static/test-team/sample-project/latest/component.html`)).text(),
      newerSource["component.html"],
    );
    assert.equal(
      (await fetch(`${base}/static/test-team/sample-project/latest/themes/nested.css`)).headers.get("content-type"),
      "text/css; charset=utf-8",
    );
    const svg = await fetch(`${base}/static/test-team/sample-project/latest/images/new.svg`);
    assert.equal(svg.headers.get("content-type"), "image/svg+xml");
    assert.match(await svg.text(), /<title>Fresh<\/title>/);
    const png = await fetch(`${base}/static/test-team/sample-project/latest/images/seed.png`);
    assert.equal(png.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await png.arrayBuffer()), imageBytes);
    assert.equal((await fetch(`${base}/static/test-team/sample-project/latest/.secret`)).status, 404);
    assert.equal((await fetch(`${base}/static/test-team/sample-project/latest/.env`)).status, 404);
    assert.equal((await fetch(`${base}/static/test-team/sample-project/latest/%2e%2e/README.md`)).status, 404);
    assert.equal((await fetch(`${base}/static/test-team/sample-project/latest/images%2fseed.png`)).status, 404);
    const remoteRepoPath = join(bareRoot, "test-team", "sample-project.git");
    assert.equal(
      await run("git", ["--git-dir", remoteRepoPath, "log", "-1", "--format=%an <%ae>", "main"], { cwd: temp }),
      "Design System <system@wds.local>",
    );
    assert.match(
      await run("git", ["--git-dir", remoteRepoPath, "log", "-1", "--format=%s", "main"], { cwd: temp }),
      /Unpublished source change/,
    );
    assert.equal(
      await run("git", ["--git-dir", remoteRepoPath, "show", "main:component.html"], { cwd: temp }),
      newerSource["component.html"].trim(),
    );
    assert.equal(
      await run("git", ["--git-dir", remoteRepoPath, "show", "main:README.md"], { cwd: temp }),
      "Git API repository initialization",
    );
    assert.equal(
      await run("git", ["--git-dir", remoteRepoPath, "log", "--format=%an <%ae>", "main"], { cwd: temp }),
      [
        "Design System <system@wds.local>",
        "Design System <system@wds.local>",
        "Design System <system@wds.local>",
        "Design System <system@wds.local>",
        "Design System <system@wds.local>",
        "Git API <git-api@example.test>",
      ].join("\n"),
    );
    await run(
      "git",
      ["--git-dir", remoteRepoPath, "merge-base", "--is-ancestor", "refs/heads/master", "refs/heads/main"],
      {
        cwd: temp,
      },
    );
    const systemCreate = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        team: "test-team",
        repo: "sample-system",
        name: "Shared Foundation",
        type: "design-system",
        description: "Shared tokens",
      }),
    });
    const systemCreated = await systemCreate.json();
    assert.equal(systemCreate.status, 201, JSON.stringify(systemCreated));
    assert.equal(systemCreated.project.type, "design-system");
    assert.equal(systemCreated.project.name, "Shared Foundation");
    const systemListing = await fetch(`${base}/api/projects`, { headers });
    assert.deepEqual(
      (await systemListing.json())
        .map(({ repo, type }) => ({ repo, type }))
        .sort((a, b) => a.repo.localeCompare(b.repo)),
      [
        { repo: "foundation", type: "design-system" },
        { repo: "sample-project", type: "component" },
        { repo: "sample-system", type: "design-system" },
      ],
    );
    const systemUrl = `${base}/api/source/test-team/sample-system`;
    const systemSource = await (await fetch(systemUrl, { headers })).json();
    assert.deepEqual(Object.keys(systemSource.files).sort(), ["design-system.json", "styles.css", "tokens.css"]);
    assert.match(systemSource.files["styles.css"], /@import "\.\/tokens\.css"/);
    assert.match(systemSource.files["tokens.css"], /--color-primary/);
    assert.match(systemSource.files["design-system.json"], /"name": "Shared Foundation"/);
    assert.equal(systemSource.files["component.html"], undefined);
    const tokenStyles = ":root { --ds-color-accent: #15b8a6; }\n";
    const systemUpdate = await fetch(systemUrl, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        files: { ...systemSource.files, "styles.css": tokenStyles },
        message: "Define shared tokens",
      }),
    });
    assert.equal(systemUpdate.status, 200);
    const systemRelease = await fetch(`${base}/api/release/test-team/sample-system`, {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "minor" }),
    });
    const releaseData = await systemRelease.json();
    assert.equal(systemRelease.status, 201, JSON.stringify(releaseData));
    const publishedSystemStyles = await fetch(`${base}/static/test-team/sample-system/latest/styles.css`);
    assert.equal(publishedSystemStyles.status, 200);
    assert.equal(await publishedSystemStyles.text(), tokenStyles);
    assert.equal((await fetch(`${base}/static/test-team/sample-system/latest/component.html`)).status, 404);
    assert.equal((await fetch(`${base}/static/test-team/sample-system/latest/design-system.json`)).status, 404);
    const versionedStyles = await fetch(`${base}/static/test-team/sample-system/${releaseData.version}/styles.css`);
    assert.equal(versionedStyles.status, 200);
    assert.equal(await versionedStyles.text(), tokenStyles);
    const mountedFoundationPath = join(mountedRoot, "foundation");
    await mkdir(mountedFoundationPath);
    await writeFile(
      join(mountedFoundationPath, "design-system.json"),
      JSON.stringify({ type: "design-system", name: "Mounted Foundation" }),
    );
    await writeFile(join(mountedFoundationPath, "tokens.css"), ":root { --mounted-color: navy; }\n");
    await writeFile(join(mountedFoundationPath, "styles.css"), '@import "./tokens.css";\n');
    const publishMountedFoundation = await fetch(`${base}/api/publish/mounted-team/foundation`, {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(publishMountedFoundation.status, 200, await publishMountedFoundation.text());
    const mountedProjectPath = join(mountedRoot, "mounted-widget");
    await mkdir(mountedProjectPath);
    await writeFile(
      join(mountedProjectPath, "component.json"),
      JSON.stringify({
        name: "mounted-widget",
        designSystem: { team: "mounted-team", repo: "foundation", revision: "latest" },
      }),
    );
    await writeFile(join(mountedProjectPath, "component.html"), "<main>Mounted</main>\n");
    await writeFile(
      join(mountedProjectPath, "styles.css"),
      '@import url("/static/mounted-team/foundation/latest/tokens.css");\n@import "tailwindcss";\n.mounted { color: navy; }\n',
    );
    const outsidePath = join(temp, "outside.css");
    await writeFile(outsidePath, ".outside { color: red; }\n");
    await symlink(temp, join(mountedProjectPath, "linked"), "dir");
    const mountedUrl = `${base}/api/source/mounted-team/mounted-widget`;
    const mountedHistory = await fetch(`${base}/api/history/mounted-team/mounted-widget`, { headers });
    assert.deepEqual(await mountedHistory.json(), { history: [], sourceMode: "filesystem" });
    const mountedSource = await (await fetch(mountedUrl, { headers })).json();
    assert.equal(mountedSource.files["component.html"], "<main>Mounted</main>\n");
    assert.equal(mountedSource.files["linked/outside.css"], undefined);
    const mountedUpdate = await fetch(mountedUrl, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        files: {
          ...mountedSource.files,
          "themes/nested.css": ".mounted-theme { color: teal; }\n",
          "scripts/behavior.mjs": "export const mounted = true;\n",
          "scripts/main.mjs": 'import "./behavior.mjs";\n',
        },
        message: "Mounted dynamic files",
      }),
    });
    assert.equal(mountedUpdate.status, 200);
    const mountedAfterUpdate = await (await fetch(mountedUrl, { headers })).json();
    assert.equal(mountedAfterUpdate.files["themes/nested.css"], ".mounted-theme { color: teal; }\n");
    const blockedHtmlEscape = await fetch(mountedUrl, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        files: { ...mountedAfterUpdate.files, "component.html": '<img src="../outside.css" />' },
      }),
    });
    assert.equal(blockedHtmlEscape.status, 400);
    const blockedModuleEscape = await fetch(mountedUrl, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        files: {
          ...mountedAfterUpdate.files,
          "scripts/behavior.mjs": 'import "../../../outside.css";\n',
        },
      }),
    });
    assert.equal(blockedModuleEscape.status, 400);
    const blockedDynamicImport = await fetch(mountedUrl, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        files: {
          ...mountedAfterUpdate.files,
          "scripts/behavior.mjs": 'const modulePath = "../outside.mjs"; await import(modulePath);\n',
        },
      }),
    });
    assert.equal(blockedDynamicImport.status, 400);
    const blockedImport = await fetch(mountedUrl, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        files: { ...mountedAfterUpdate.files, "styles.css": '@import "../outside.css";\n' },
      }),
    });
    assert.equal(blockedImport.status, 400);
    const blockedImportWithoutSemicolon = await fetch(mountedUrl, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        files: { ...mountedAfterUpdate.files, "styles.css": '@import "../outside.css"' },
      }),
    });
    assert.equal(blockedImportWithoutSemicolon.status, 400);
    const blockedHiddenImport = await fetch(mountedUrl, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        files: { ...mountedAfterUpdate.files, "styles.css": '@import "./.env";' },
      }),
    });
    assert.equal(blockedHiddenImport.status, 400);
    const blockedCssAssetEscape = await fetch(mountedUrl, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        files: { ...mountedAfterUpdate.files, "styles.css": '.escaped { background-image: url("../outside.css"); }' },
      }),
    });
    assert.equal(blockedCssAssetEscape.status, 400);
    const blockedSymlinkImport = await fetch(mountedUrl, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        files: {
          ...mountedAfterUpdate.files,
          "styles.css": '@import "./linked/outside.css";',
        },
      }),
    });
    assert.equal(blockedSymlinkImport.status, 400);
    const blockedMalformedImports = await fetch(mountedUrl, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        files: {
          ...mountedAfterUpdate.files,
          "styles.css": '@import "safe.css" @import "../outside.css"',
        },
      }),
    });
    assert.equal(blockedMalformedImports.status, 400);
    const blockedSymlinkWrite = await fetch(mountedUrl, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        files: { ...mountedAfterUpdate.files, "linked/outside.css": ".outside { color: black; }\n" },
      }),
    });
    assert.equal(blockedSymlinkWrite.status, 400);
    assert.equal(await readFile(outsidePath, "utf8"), ".outside { color: red; }\n");
    const publishMounted = await fetch(`${base}/api/publish/mounted-team/mounted-widget`, {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(publishMounted.status, 200, await publishMounted.text());
    const mountedArtifact = await fetch(`${base}/static/mounted-team/mounted-widget/latest/component.html`);
    assert.equal(mountedArtifact.status, 200);
    assert.equal(await mountedArtifact.text(), mountedAfterUpdate.files["component.html"]);
    const mountedReleaseResponse = await fetch(`${base}/api/release/mounted-team/mounted-widget`, {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "minor" }),
    });
    const mountedRelease = await mountedReleaseResponse.json();
    assert.equal(mountedReleaseResponse.status, 201, JSON.stringify(mountedRelease));
    assert.equal(mountedRelease.version, "v1.0");
    const changedMounted = await fetch(mountedUrl, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        files: { ...mountedAfterUpdate.files, "component.html": "<main>New mounted source</main>\n" },
      }),
    });
    assert.equal(changedMounted.status, 200);
    assert.equal(
      await (await fetch(`${base}/static/mounted-team/mounted-widget/v1.0/component.html`)).text(),
      mountedAfterUpdate.files["component.html"],
    );
    assert.equal(
      await (await fetch(`${base}/static/mounted-team/mounted-widget/latest/component.html`)).text(),
      mountedAfterUpdate.files["component.html"],
    );
    const republishMounted = await fetch(`${base}/api/publish/mounted-team/mounted-widget`, {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(republishMounted.status, 200);
    assert.equal(
      await (await fetch(`${base}/static/mounted-team/mounted-widget/latest/component.html`)).text(),
      "<main>New mounted source</main>\n",
    );
    assert.equal(
      await (await fetch(`${base}/static/mounted-team/mounted-widget/v1.0/component.html`)).text(),
      mountedAfterUpdate.files["component.html"],
    );
    assert.equal((await fetch(`${base}/static/mounted-team/mounted-widget/latest/linked/outside.css`)).status, 404);
    const malformedTestRoute = await fetch(`${base}/api/test/test-team/sample-project/extra`, {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(malformedTestRoute.status, 400);
    const malformedReleaseRoute = await fetch(`${base}/api/release/test-team/sample-project/extra`, {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "minor" }),
    });
    assert.equal(malformedReleaseRoute.status, 400);
    t.diagnostic(
      `OIDC flow, project CRUD, validation, source push and Git history verified locally (${create.status}, ${duplicate.status}, ${invalid.status}).`,
    );
  } finally {
    if (app && app.exitCode === null) {
      app.kill("SIGTERM");
    }
    if (app) {
      await new Promise((resolveExit) => app.once("exit", resolveExit));
    }
    if (oidcServer?.listening) {
      await close(oidcServer);
    }
    if (gitApiServer?.listening) {
      await close(gitApiServer);
    }
    await rm(temp, { recursive: true, force: true });
  }
});
