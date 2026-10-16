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
  const serverSource = await readFile(join(projectRoot, "server.mjs"), "utf8");
  assert.doesNotMatch(serverSource, /remoteCache|remoteRepo\(|GIT_ASKPASS|git\s+(?:clone|fetch|push)\b/i);
  const temp = await mkdtemp(join(tmpdir(), "wds-next-integration-"));
  let oidcServer;
  let gitApiServer;
  let databaseServer;
  let app;
  try {
    const bareRoot = join(temp, "git");
    const mountedRoot = join(temp, "mounted");
    const atomicCommits = [];
    const tagWrites = [];
    let forceNextAtomicConflict = false;
    let forceNextTagFailure = false;
    await mkdir(bareRoot);
    await mkdir(mountedRoot);
    await mkdir(join(bareRoot, "broken-team"));
    await writeFile(join(bareRoot, "broken-team", "broken-repo.git"), "not a Git repository\n");
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = publicKey.export({ format: "jwk" });
    Object.assign(jwk, { kid: "integration-key", use: "sig", alg: "RS256" });
    let expectedNonce;
    let userinfoSubject = "integration-user";
    let smartGitRequests = 0;
    const restFileRefs = [];
    const restFileUrls = [];
    let restHeadRequests = 0;
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
      const parsedUrl = new URL(req.url, "http://localhost");
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
      const repoRoute = path.match(/^\/api\/v1\/orgs\/([^/]+)\/repos\/([^/]+)(?:\/(.*))?$/);
      if (repoRoute) {
        const [, org, repo, operation = ""] = repoRoute;
        const gitDir = join(bareRoot, org, `${repo}.git`);
        const readJson = async () => {
          let raw = "";
          for await (const chunk of req) {
            raw += chunk;
          }
          return JSON.parse(raw || "{}");
        };
        const gitDirExists = await readdir(gitDir)
          .then(() => true)
          .catch(() => false);
        if (operation === "branches" && req.method === "GET") {
          const refs = gitDirExists
            ? (
                await run(
                  "git",
                  ["--git-dir", gitDir, "for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads"],
                  { cwd: temp },
                )
              )
                .split("\n")
                .filter(Boolean)
            : [];
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify(
              refs.map((entry) => {
                const [name, sha] = entry.split(" ");
                return { name, sha };
              }),
            ),
          );
          return;
        }
        if (operation === "tags" && req.method === "GET") {
          const tags = gitDirExists
            ? (await run("git", ["--git-dir", gitDir, "tag", "--list"], { cwd: temp })).split("\n").filter(Boolean)
            : [];
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(tags));
          return;
        }
        if (operation === "tags" && req.method === "POST") {
          const { name, target } = await readJson();
          if (forceNextTagFailure) {
            forceNextTagFailure = false;
            res.writeHead(500);
            res.end();
            return;
          }
          try {
            await run(
              "git",
              [
                "-c",
                "user.name=GitMini",
                "-c",
                "user.email=gitmini@example.test",
                "--git-dir",
                gitDir,
                "tag",
                "-a",
                name,
                target,
                "-m",
                name,
              ],
              { cwd: temp },
            );
            tagWrites.push({ name, target });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ name, target }));
          } catch {
            res.writeHead(409);
            res.end();
          }
          return;
        }
        if (operation === "commits" && req.method === "POST") {
          const input = await readJson();
          atomicCommits.push({ org, repo, ...input });
          if (forceNextAtomicConflict) {
            forceNextAtomicConflict = false;
            res.writeHead(409);
            res.end();
            return;
          }
          const branch = input.targetBranch || "main";
          const current = gitDirExists
            ? await run("git", ["--git-dir", gitDir, "rev-parse", `refs/heads/${branch}`], { cwd: temp }).catch(
                () => "",
              )
            : "";
          if ((current || null) !== input.expectedRef) {
            res.writeHead(409);
            res.end();
            return;
          }
          const checkout = join(temp, `atomic-${org}-${repo}-${Math.random().toString(16).slice(2)}`);
          try {
            await run("git", ["clone", "--quiet", gitDir, checkout], { cwd: temp });
            const branchExists = await run(
              "git",
              ["-C", checkout, "show-ref", "--verify", `refs/remotes/origin/${branch}`],
              { cwd: temp },
            )
              .then(() => true)
              .catch(() => false);
            if (branchExists) {
              await run("git", ["-C", checkout, "checkout", "--quiet", "-B", branch, `origin/${branch}`], {
                cwd: temp,
              });
            } else {
              await run("git", ["-C", checkout, "checkout", "--quiet", "--orphan", branch], { cwd: temp });
              await run("git", ["-C", checkout, "rm", "-rf", "--ignore-unmatch", "."], { cwd: temp }).catch(() => "");
            }
            for (const change of input.changes) {
              const target = join(checkout, change.path);
              if (change.delete) {
                await rm(target, { force: true });
              } else {
                await mkdir(join(target, ".."), { recursive: true });
                await writeFile(target, Buffer.from(change.content, "base64"));
              }
            }
            await run("git", ["-C", checkout, "add", "-A"]);
            await run(
              "git",
              [
                "-C",
                checkout,
                "-c",
                "user.name=GitMini",
                "-c",
                "user.email=gitmini@example.test",
                "commit",
                "--quiet",
                "-m",
                input.message,
              ],
              { cwd: temp },
            );
            const sha = await run("git", ["-C", checkout, "rev-parse", "HEAD"], { cwd: temp });
            await run("git", ["-C", checkout, "push", "--quiet", "origin", branch], { cwd: temp });
            res.writeHead(201, { "content-type": "application/json" });
            res.end(JSON.stringify({ commit: { sha }, ref: sha }));
          } catch (error) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: error.message }));
          } finally {
            await rm(checkout, { recursive: true, force: true });
          }
          return;
        }
      }
      const readRoute = path.match(/^\/api\/v1\/orgs\/([^/]+)\/repos\/([^/]+)\/(tree|file|log)$/);
      if (readRoute) {
        const [, org, repo, kind] = readRoute;
        const gitDir = join(bareRoot, org, `${repo}.git`);
        const ref = parsedUrl.searchParams.get("ref") || "main";
        try {
          if (kind === "tree") {
            const names = (await run("git", ["--git-dir", gitDir, "ls-tree", "-r", "--name-only", ref], { cwd: temp }))
              .split("\n")
              .filter(Boolean);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(names));
            return;
          }
          if (kind === "file") {
            const file = parsedUrl.searchParams.get("path");
            restFileRefs.push({ ref, file, method: req.method });
            restFileUrls.push(req.url);
            if (req.method === "HEAD") {
              restHeadRequests += 1;
            }
            const content = await new Promise((resolveContent, rejectContent) => {
              const child = spawn("git", ["--git-dir", gitDir, "show", `${ref}:${file}`], {
                cwd: temp,
                stdio: ["ignore", "pipe", "pipe"],
              });
              const chunks = [];
              child.stdout.on("data", (chunk) => chunks.push(chunk));
              child.once("error", rejectContent);
              child.once("close", (code) =>
                code === 0 ? resolveContent(Buffer.concat(chunks)) : rejectContent(new Error("missing file")),
              );
            });
            res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
            res.end(req.method === "HEAD" ? undefined : content);
            return;
          }
          const entries = (
            await run(
              "git",
              [
                "--git-dir",
                gitDir,
                "log",
                "-n",
                parsedUrl.searchParams.get("limit") || "50",
                "--format=%H%x00%s%x00%an%x00%aI",
                "main",
              ],
              { cwd: temp },
            )
          )
            .split("\n")
            .filter(Boolean);
          const commits = entries.map((row) => {
            const [revision, message, author, date] = row.split("\0");
            return { revision, message, author, date };
          });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(commits));
          return;
        } catch {
          res.writeHead(404);
          res.end();
          return;
        }
      }
      const createRepo = path.match(/^\/api\/v1\/orgs\/([^/]+)\/repos\/([^/]+)$/);
      if (createRepo && req.method === "POST") {
        const repoPath = join(bareRoot, createRepo[1], `${createRepo[2]}.git`);
        try {
          await mkdir(join(bareRoot, createRepo[1]), { recursive: true });
          await run("git", ["init", "--bare", "--initial-branch=main", repoPath]);
          res.writeHead(201, { "content-type": "application/json" });
        } catch {
          res.writeHead(409);
        }
        res.end(req.method === "POST" && res.statusCode === 201 ? "{}" : undefined);
        return;
      }
      if (path.startsWith("/git/")) {
        smartGitRequests += 1;
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
    const metadata = { teams: [], design_systems: [] };
    let databaseAvailable = true;
    const schemaStatements = [];
    databaseServer = createServer(async (req, res) => {
      if (!databaseAvailable) {
        res.writeHead(503);
        res.end("unavailable");
        return;
      }
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
      }
      const { s: sql, d: params = [] } = JSON.parse(raw || "{}");
      assert.equal(req.headers.authorization, "Bearer local-db-test-token");
      if (sql.startsWith("CREATE TABLE")) {
        schemaStatements.push(sql);
      }
      const normalized = sql.trim().toLowerCase();
      let rows = [];
      if (normalized.startsWith("insert into teams")) {
        const row = { id: params[0], slug: params[1], name: params[2], created_at: new Date().toISOString() };
        if (metadata.teams.some((team) => team.slug === row.slug)) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "unique constraint failed" }));
          return;
        }
        metadata.teams.push(row);
      } else if (normalized.startsWith("insert into design_systems")) {
        const row = {
          id: params[0],
          team_id: params[1],
          slug: params[2],
          git_org: params[3],
          foundation_repo: "foundation",
          name: params[4],
        };
        metadata.design_systems.push(row);
      } else if (normalized.startsWith("select")) {
        const table = normalized.includes("from teams") ? metadata.teams : metadata.design_systems;
        rows = table.filter(
          (row) =>
            !normalized.includes(" where ") ||
            Object.entries(row).some(([key, value]) => normalized.includes(`${key} = ?`) && value === params[0]),
        );
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ rows }));
    });
    const databasePort = await listen(databaseServer);
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
        DATABASE_URL: `http://127.0.0.1:${databasePort}/api`,
        DB_AUTH_TOKEN: "local-db-test-token",
        WDS_ALLOWED_SUBJECTS: "integration-user",
        WDS_ENABLE_UNSANDBOXED_SPECS: "true",
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
    const createdTeamData = await createTeam.json();
    assert.equal(createTeam.status, 201, JSON.stringify(createdTeamData));
    const gitOrgsAfterTeamCreate = await (
      await fetch(`${gitApiUrl}/api/v1/orgs`, { headers: { authorization: "Bearer local-test-only" } })
    ).json();
    assert.equal(gitOrgsAfterTeamCreate.includes("new-team"), false);
    const duplicateTeam = await fetch(`${base}/api/teams`, {
      method: "POST",
      headers,
      body: JSON.stringify({ slug: "new-team" }),
    });
    assert.equal(duplicateTeam.status, 409, await duplicateTeam.clone().text());
    assert.equal(typeof createdTeamData.team.slug, "string");
    const systemsCreated = [];
    for (const [slug, gitOrg, teamRef] of [
      ["system-one", "org-one", { team: "new-team" }],
      ["system-two", "org-two", { teamId: createdTeamData.team.id }],
    ]) {
      const response = await fetch(`${base}/api/design-systems`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...teamRef, slug, gitOrg, name: slug }),
      });
      assert.equal(response.status, 201, await response.clone().text());
      systemsCreated.push(await response.json());
      const foundationSource = await fetch(`${base}/api/source/${gitOrg}/foundation`, { headers });
      assert.equal(foundationSource.status, 200);
      const files = (await foundationSource.json()).files;
      assert.match(files["design-system.json"], /design-system/);
      assert.match(files["tokens.css"], /:root/);
      assert.match(files["styles.css"], /tokens\.css/);
    }
    const smartGitRequestsBeforeMetadataLists = smartGitRequests;
    const systemsListResponse = await fetch(`${base}/api/design-systems`, { headers });
    assert.match(systemsListResponse.headers.get("server-timing"), /^app;dur=\d/);
    const systemsList = await systemsListResponse.json();
    assert.equal(systemsList.designSystems.filter((item) => item.team_id === createdTeamData.team.id).length, 2);
    const nestedTeams = await (await fetch(`${base}/api/teams`, { headers })).json();
    assert.equal(nestedTeams.teams.find((item) => item.slug === "new-team").designSystems.length, 2);
    assert.equal(
      smartGitRequests,
      smartGitRequestsBeforeMetadataLists,
      "GET /api/teams and GET /api/design-systems must not use Smart HTTP",
    );
    const newSystemPublish = await fetch(`${base}/api/publish/org-one/foundation`, { method: "POST", headers });
    assert.equal(newSystemPublish.status, 200, await newSystemPublish.clone().text());
    const newComponent = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        team: "org-one",
        repo: "new-button",
        designSystem: { team: "org-one", repo: "foundation", revision: "latest" },
      }),
    });
    assert.equal(newComponent.status, 201, await newComponent.clone().text());
    const newComponentSource = await (await fetch(`${base}/api/source/org-one/new-button`, { headers })).json();
    assert.match(newComponentSource.files["styles.css"], /\/static\/org-one\/foundation\/latest\/tokens\.css/);
    const newComponentPublish = await fetch(`${base}/api/publish/org-one/new-button`, {
      method: "POST",
      headers,
    });
    assert.equal(newComponentPublish.status, 200, await newComponentPublish.clone().text());
    assert.equal((await fetch(`${base}/static/org-one/new-button/latest/component.html`)).status, 200);
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
    const tokenHead = await fetch(`${base}/static/test-team/foundation/latest/tokens.css`, { method: "HEAD" });
    assert.equal(tokenHead.status, 200);
    assert.equal(await tokenHead.text(), "");
    assert.equal(tokenHead.headers.get("cache-control"), "no-store");
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
      (await listing.json()).filter(({ team }) => team === "test-team").map(({ team, repo }) => ({ team, repo })),
      [
        { team: "test-team", repo: "foundation" },
        { team: "test-team", repo: "sample-project" },
      ],
    );
    const teamListing = await fetch(`${base}/api/teams`, { headers });
    const listedTeams = (await teamListing.json()).teams;
    assert.ok(listedTeams.some(({ slug }) => slug === "new-team"));
    const sourceUrl = `${base}/api/source/test-team/sample-project`;
    const smartBeforeSource = smartGitRequests;
    const sourceBefore = await (await fetch(sourceUrl, { headers })).json();
    assert.equal(smartGitRequests, smartBeforeSource, "GET /api/source must not use Smart HTTP");
    assert.equal(sourceBefore.sourceMode, "git");
    const smartBeforeSpecs = smartGitRequests;
    const specs = await fetch(`${base}/api/test/test-team/sample-project`, { method: "POST", headers });
    const specsData = await specs.json();
    assert.equal(specs.status, 200, JSON.stringify(specsData));
    assert.equal(specsData.code, 0, specsData.output);
    assert.equal(smartGitRequests, smartBeforeSpecs, "remote spec execution must use GitMini REST, not Smart HTTP");
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
      body: JSON.stringify({ files: changed, baseRef: sourceBefore.baseRef, message: "Integration source update" }),
    });
    const updateData = await update.json();
    assert.equal(update.status, 200, JSON.stringify(updateData));
    assert.equal(updateData.sourceMode, "git");
    const sourceAfter = await (await fetch(sourceUrl, { headers })).json();
    assert.equal(sourceAfter.files["component.html"], changed["component.html"]);
    const missingBaseRef = await fetch(sourceUrl, {
      method: "PUT",
      headers,
      body: JSON.stringify({ files: changed }),
    });
    assert.equal(missingBaseRef.status, 400);
    forceNextAtomicConflict = true;
    const racedUpdate = await fetch(sourceUrl, {
      method: "PUT",
      headers,
      body: JSON.stringify({ files: changed, baseRef: sourceAfter.baseRef, message: "Simulated CAS race" }),
    });
    assert.equal(racedUpdate.status, 409);
    assert.equal(
      (await (await fetch(sourceUrl, { headers })).json()).files["component.html"],
      changed["component.html"],
    );
    const smartBeforeHistory = smartGitRequests;
    const historyResponse = await fetch(`${base}/api/history/test-team/sample-project`, { headers });
    assert.equal(smartGitRequests, smartBeforeHistory, "GET /api/history must not use Smart HTTP");
    const historyData = await historyResponse.json();
    assert.equal(historyResponse.status, 200, JSON.stringify(historyData));
    assert.ok(historyData.history.some((entry) => entry.message === "Integration source update"));
    assert.match(historyData.history[0].revision, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
    const blockedGitImport = await fetch(sourceUrl, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        files: { ...sourceAfter.files, "styles.css": '@import "../outside.css"' },
        baseRef: sourceAfter.baseRef,
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
        baseRef: sourceAfter.baseRef,
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
        baseRef: sourceAfter.baseRef,
        message: "Use mismatched tokens",
      }),
    });
    assert.equal(mismatchedTokens.status, 200);
    const afterMismatchedTokens = await (await fetch(sourceUrl, { headers })).json();
    const mismatchedPublish = await fetch(`${base}/api/publish/test-team/sample-project`, { method: "POST", headers });
    assert.equal(mismatchedPublish.status, 400);
    const nestedFiles = {
      ...afterMismatchedTokens.files,
      "styles.css":
        '@import url("/static/test-team/foundation/latest/tokens.css");\n@import "tailwindcss";\n.dynamic { color: teal; }\n',
      "themes/nested.css": ".dynamic { color: teal; }\n",
      "examples/demo.html": "<main>New nested page</main>\n",
      "images/new.svg": '<svg xmlns="http://www.w3.org/2000/svg"><title>Fresh</title></svg>',
    };
    const nestedUpdate = await fetch(sourceUrl, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        files: nestedFiles,
        baseRef: afterMismatchedTokens.baseRef,
        message: "Integration source update",
      }),
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
    assert.match(publishData.revision, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
    const publishedManifest = await (
      await fetch(`${base}/static/test-team/sample-project/latest/manifest.json`)
    ).json();
    assert.equal(publishedManifest.revision, publishData.revision);
    assert.ok(publishedManifest.files.includes("component.html"));
    assert.equal(publishedManifest.files.includes("spec.mjs"), false);
    assert.equal((await fetch(`${base}/static/test-team/sample-project/latest/spec.mjs`)).status, 404);
    const smartBeforeStatic = smartGitRequests;
    const publishedPreview = await fetch(
      `${base}/static/test-team/sample-project/latest/component.html?view=component`,
    );
    assert.equal(smartGitRequests, smartBeforeStatic, "GET /static must not use Smart HTTP");
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
      body: JSON.stringify({ files: newerSource, baseRef: nestedSource.baseRef, message: "Unpublished source change" }),
    });
    assert.equal(newerCommit.status, 200);
    const artifactRepoPath = join(bareRoot, "test-team", "sample-project.git");
    const artifactRef = await run("git", ["--git-dir", artifactRepoPath, "rev-parse", "refs/heads/wds-artifacts"], {
      cwd: temp,
    });
    const addObsoleteArtifact = await fetch(`${gitApiUrl}/api/v1/orgs/test-team/repos/sample-project/commits`, {
      method: "POST",
      headers: { authorization: "Bearer local-test-only", "content-type": "application/json" },
      body: JSON.stringify({
        expectedRef: artifactRef,
        targetBranch: "wds-artifacts",
        message: "Add stale artifact for cleanup coverage",
        changes: [{ path: "latest/obsolete.css", content: Buffer.from(".obsolete {}\n").toString("base64") }],
      }),
    });
    assert.equal(addObsoleteArtifact.status, 201, await addObsoleteArtifact.text());
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
    assert.equal((await fetch(`${base}/static/test-team/sample-project/latest/obsolete.css`)).status, 404);
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
    assert.equal(png.status, 404);
    assert.equal((await fetch(`${base}/static/test-team/sample-project/latest/.secret`)).status, 404);
    assert.equal((await fetch(`${base}/static/test-team/sample-project/latest/.env`)).status, 404);
    assert.equal((await fetch(`${base}/static/test-team/sample-project/latest/%2e%2e/README.md`)).status, 404);
    assert.equal((await fetch(`${base}/static/test-team/sample-project/latest/images%2fseed.png`)).status, 404);
    const remoteRepoPath = join(bareRoot, "test-team", "sample-project.git");
    assert.match(
      await run("git", ["--git-dir", remoteRepoPath, "log", "-1", "--format=%s", "main"], { cwd: temp }),
      /Unpublished source change/,
    );
    assert.equal(
      await run("git", ["--git-dir", remoteRepoPath, "show", "main:component.html"], { cwd: temp }),
      newerSource["component.html"].trim(),
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
        .filter(({ team }) => team === "test-team")
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
        baseRef: systemSource.baseRef,
        message: "Define shared tokens",
      }),
    });
    assert.equal(systemUpdate.status, 200);
    forceNextTagFailure = true;
    const failedSystemRelease = await fetch(`${base}/api/release/test-team/sample-system`, {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "minor" }),
    });
    assert.equal(failedSystemRelease.status, 502);
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
    assert.equal(tagWrites.length, 1);
    assert.deepEqual(tagWrites[0], { name: releaseData.version, target: releaseData.revision });
    assert.ok(
      restFileRefs.some(
        ({ ref, file, method }) => /^[a-f0-9]{40,64}$/i.test(ref) && file === "component.json" && method === "GET",
      ),
    );
    assert.ok(
      restFileRefs.some(
        ({ ref, file, method }) => /^[a-f0-9]{40,64}$/i.test(ref) && file === "themes/nested.css" && method === "GET",
      ),
      "nested path and immutable ref should survive URL query encoding",
    );
    assert.ok(
      restFileUrls.some((url) => url.includes("path=themes%2Fnested.css") && /ref=[a-f0-9]{40,64}/i.test(url)),
      "file path and ref must be query parameters, not interpolated route fragments",
    );
    assert.ok(restFileRefs.some(({ ref, file }) => ref === "wds-artifacts" && file.startsWith("latest/")));
    assert.ok(
      restFileRefs.some(
        ({ ref, file, method }) => ref === "wds-artifacts" && file.endsWith("tokens.css") && method === "HEAD",
      ),
      "remote token existence validation should use HEAD",
    );
    assert.ok(restHeadRequests > 0);
    assert.equal((await fetch(`${base}/static/test-team/sample-system/latest/component.html`)).status, 404);
    assert.equal((await fetch(`${base}/static/test-team/sample-system/latest/design-system.json`)).status, 404);
    const versionedStyles = await fetch(`${base}/static/test-team/sample-system/${releaseData.version}/styles.css`);
    assert.equal(versionedStyles.status, 200);
    assert.equal(await versionedStyles.text(), tokenStyles);
    const systemSourceAfterRelease = await (
      await fetch(`${base}/api/source/test-team/sample-system`, { headers })
    ).json();
    const changedTokens = ":root { --ds-color-accent: #ff5500; }\n";
    const updateAfterRelease = await fetch(`${base}/api/source/test-team/sample-system`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        files: { ...systemSourceAfterRelease.files, "tokens.css": changedTokens },
        baseRef: systemSourceAfterRelease.baseRef,
        message: "Update tokens after release",
      }),
    });
    assert.equal(updateAfterRelease.status, 200);
    const publishAfterRelease = await fetch(`${base}/api/publish/test-team/sample-system`, {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(publishAfterRelease.status, 200, await publishAfterRelease.text());
    assert.equal(await (await fetch(`${base}/static/test-team/sample-system/latest/tokens.css`)).text(), changedTokens);
    assert.equal(
      await (await fetch(`${base}/static/test-team/sample-system/${releaseData.version}/tokens.css`)).text(),
      systemSource.files["tokens.css"],
    );
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
    databaseAvailable = false;
    const databaseUnavailable = await fetch(`${base}/api/design-systems`, { headers });
    assert.equal(databaseUnavailable.status, 503);
    assert.match((await databaseUnavailable.json()).error, /temporarily unavailable/);
    assert.equal(schemaStatements.length, 2);
    assert.ok(schemaStatements.every((sql) => sql.includes("IF NOT EXISTS")));
    assert.equal(
      smartGitRequests,
      0,
      "remote inventory, source, history, specs, publish, and release must not use Smart HTTP",
    );
    assert.ok(atomicCommits.some(({ targetBranch, expectedRef }) => targetBranch === "main" && expectedRef === null));
    assert.ok(
      atomicCommits.some(
        ({ targetBranch, expectedRef, message }) =>
          targetBranch === "main" && message === "Integration source update" && /^[a-f0-9]{40,64}$/i.test(expectedRef),
      ),
    );
    assert.ok(
      atomicCommits.some(({ targetBranch, expectedRef }) => targetBranch === "wds-artifacts" && expectedRef === null),
    );
    t.diagnostic(
      `OIDC flow, project CRUD, validation, atomic source commits, REST specs and history verified locally (${create.status}, ${duplicate.status}, ${invalid.status}).`,
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
    if (databaseServer?.listening) {
      await close(databaseServer);
    }
    await rm(temp, { recursive: true, force: true });
  }
});
