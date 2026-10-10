import { createServer } from "node:http";
import { mkdir, readFile, writeFile, readdir, cp, mkdtemp, rm } from "node:fs/promises";
import { existsSync, rmSync } from "node:fs";
import { join, normalize, extname, relative, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, createPublicKey, randomBytes, verify as verifySignature } from "node:crypto";
import { tmpdir } from "node:os";

const exec = promisify(execFile);
const root = process.cwd();
const publicDir = join(root, "public");
const gitApi = process.env.GIT_API_URL?.replace(/\/$/, "");
const gitToken = process.env.GIT_API_TOKEN;
const gitAuthorName = process.env.GIT_AUTHOR_NAME;
const gitAuthorEmail = process.env.GIT_AUTHOR_EMAIL;
const unsandboxedSpecsEnabled = process.env.WDS_ENABLE_UNSANDBOXED_SPECS === "true";
const remoteCache = await mkdtemp(join(tmpdir(), "wds-next-remote-repos-"));
process.once("exit", () => rmSync(remoteCache, { recursive: true, force: true }));
const sourceTeam = process.env.SOURCE_TEAM;
const sourceTeamPath = process.env.SOURCE_TEAM_PATH;
if (Boolean(sourceTeam) !== Boolean(sourceTeamPath)) {
  throw new Error("Configure SOURCE_TEAM and SOURCE_TEAM_PATH together, or leave both unset.");
}
const port = Number(process.env.PORT || 4173);
const safePart = /^[a-z0-9][a-z0-9._-]*$/;
const sourceFiles = [
  "component.html",
  "styles.css",
  "editor.mjs",
  "buttons.mjs",
  "action-button.mjs",
  "viewport-control.mjs",
  "registry.mjs",
  "editor-tabs.mjs",
  "studio.mjs",
  "inspector.mjs",
  "preview.mjs",
  "workbench.mjs",
  "topbar.mjs",
  "repo-switcher.mjs",
  "mode-toggle.mjs",
  "nav-tab.mjs",
  "range-input.mjs",
  "repo-item.mjs",
  "share-qr.mjs",
  "user-card.mjs",
  "stories.html",
  "component.json",
  "spec.mjs",
];
const assetFiles = [...sourceFiles, "manifest.json"];
// OIDC Authentication Configuration
const oidcIssuer = process.env.OIDC_ISSUER;
const oidcClientId = process.env.OIDC_CLIENT_ID;
const oidcClientSecret = process.env.OIDC_CLIENT_SECRET;
const oidcRedirectUri = process.env.OIDC_REDIRECT_URI;
const allowedSubjects = new Set(
  (process.env.WDS_ALLOWED_SUBJECTS || "")
    .split(",")
    .map((subject) => subject.trim())
    .filter(Boolean),
);

const sessions = new Map();
const repoLocks = new Map();

let authClient = null;
let authReady = false;
let authInitialization = null;

function generateSessionId() {
  return randomBytes(32).toString("base64url");
}

function checkSession(request) {
  const cookieHeader =
    request.headers instanceof Object && request.headers.get
      ? request.headers.get("cookie")
      : request.headers?.cookie || "";
  const match = cookieHeader.match(/wds-session=([^;]+)/);
  if (!match) {
    return null;
  }
  const sessionId = match[1];
  const session = sessions.get(sessionId);
  if (!session || session.expires <= Date.now()) {
    sessions.delete(sessionId);
    return null;
  }
  return session;
}

function requireEditorAccess(request, response) {
  const session = checkSession(request);
  if (!session?.authenticated) {
    reply(response, 401, { error: "Authentication required" });
    return false;
  }
  if (allowedSubjects.size === 0) {
    reply(response, 503, { error: "WDS_ALLOWED_SUBJECTS must be configured before enabling repository access" });
    return false;
  }
  if (!session.user?.sub || !allowedSubjects.has(session.user.sub)) {
    reply(response, 403, { error: "This account is not authorized to edit repositories" });
    return false;
  }
  return true;
}

async function ensureAuthClient() {
  if (!authInitialization) {
    authInitialization = (async () => {
      try {
        authClient = await createAuthClient();
        authReady = !!authClient;
        if (authReady) {
          console.log("OIDC auth client initialized");
        }
      } catch (err) {
        console.error("Failed to initialize OIDC auth client:", err.message);
        authReady = false;
      }
    })();
  }
  await authInitialization;
}

async function createAuthClient() {
  if (!oidcClientId || !oidcIssuer) {
    console.warn("OIDC_ISSUER and OIDC_CLIENT_ID must be set; OIDC auth will be disabled");
    return null;
  }
  const discoveryResponse = await fetch(new URL("/.well-known/openid-configuration", oidcIssuer));
  if (!discoveryResponse.ok) {
    throw new Error(`Could not load OIDC discovery document (${discoveryResponse.status})`);
  }
  const discovery = await discoveryResponse.json();
  if (discovery.issuer !== oidcIssuer || typeof discovery.jwks_uri !== "string") {
    throw new Error("OIDC discovery issuer or JWKS URI is invalid");
  }
  let signingKeys = null;

  async function getSigningKeys(refresh = false) {
    if (!refresh && signingKeys) {
      return signingKeys;
    }
    const response = await fetch(discovery.jwks_uri);
    if (!response.ok) {
      throw new Error(`Could not load OIDC signing keys (${response.status})`);
    }
    const data = await response.json();
    if (!Array.isArray(data.keys)) {
      throw new Error("OIDC JWKS response did not contain signing keys");
    }
    signingKeys = data.keys;
    return signingKeys;
  }

  async function createAuthorizationRequest({ redirectUri }) {
    const state = randomBytes(32).toString("base64url");
    const codeVerifier = randomBytes(32).toString("base64url");
    const url = new URL("/authorize", oidcIssuer);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", oidcClientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("scope", "openid profile email");
    url.searchParams.set("code_challenge", createHash("sha256").update(codeVerifier).digest("base64url"));
    url.searchParams.set("code_challenge_method", "S256");
    return { url: String(url), state, codeVerifier };
  }

  async function exchangeCode({ code, codeVerifier, redirectUri }) {
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: oidcClientId,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    });
    if (oidcClientSecret) {
      form.set("client_secret", oidcClientSecret);
    }
    const response = await fetch(new URL("/token", oidcIssuer), {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form,
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Could not exchange authorization code: ${response.status} ${detail}`);
    }
    return response.json();
  }

  async function verifyToken(token) {
    const jwtParts = token.split(".");
    if (jwtParts.length !== 3) {
      throw new Error("Invalid JWT");
    }
    try {
      const header = JSON.parse(Buffer.from(jwtParts[0], "base64url").toString("utf8"));
      const payload = JSON.parse(Buffer.from(jwtParts[1], "base64url").toString("utf8"));
      if (header.alg !== "RS256" || typeof header.kid !== "string") {
        throw new Error("Unsupported JWT algorithm");
      }
      if (payload.iss !== oidcIssuer) {
        throw new Error("Invalid issuer");
      }
      const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (!audiences.includes(oidcClientId)) {
        throw new Error("Invalid audience");
      }
      if (audiences.length > 1 && payload.azp !== oidcClientId) {
        throw new Error("Invalid authorized party");
      }
      if (typeof payload.sub !== "string") {
        throw new Error("Invalid subject");
      }
      const now = Math.floor(Date.now() / 1000);
      if (typeof payload.exp !== "number" || payload.exp <= now) {
        throw new Error("Expired JWT");
      }
      if (typeof payload.nbf === "number" && payload.nbf > now) {
        throw new Error("JWT not yet active");
      }
      let keys = await getSigningKeys();
      let jwk = keys.find(
        (key) =>
          key.kid === header.kid &&
          key.kty === "RSA" &&
          (!key.use || key.use === "sig") &&
          (!key.alg || key.alg === "RS256"),
      );
      if (!jwk) {
        keys = await getSigningKeys(true);
        jwk = keys.find(
          (key) =>
            key.kid === header.kid &&
            key.kty === "RSA" &&
            (!key.use || key.use === "sig") &&
            (!key.alg || key.alg === "RS256"),
        );
      }
      if (!jwk) {
        throw new Error("Unknown signing key");
      }
      const signingInput = Buffer.from(`${jwtParts[0]}.${jwtParts[1]}`);
      const signature = Buffer.from(jwtParts[2], "base64url");
      if (!verifySignature("RSA-SHA256", signingInput, createPublicKey({ key: jwk, format: "jwk" }), signature)) {
        throw new Error("Invalid JWT signature");
      }
      return payload;
    } catch {
      throw new Error("Invalid JWT");
    }
  }

  async function getProfile(accessToken, subject) {
    const response = await fetch(new URL("/userinfo", oidcIssuer), {
      headers: { Authorization: `Bearer ${accessToken}`, "X-Auth-Audience": oidcClientId },
    });
    if (!response.ok) {
      throw new Error(`Could not load profile: ${response.status}`);
    }
    const profile = await response.json();
    if (profile.sub !== subject) {
      throw new Error("OIDC userinfo subject did not match the verified token");
    }
    return profile;
  }

  return { createAuthorizationRequest, exchangeCode, verifyToken, getProfile };
}

function valid(...parts) {
  return parts.every((part) => safePart.test(part));
}
async function withRepoLock(team, repo, operation) {
  const key = `${team}/${repo}`;
  const previous = repoLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  repoLocks.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (repoLocks.get(key) === current) {
      repoLocks.delete(key);
    }
  }
}
function mountedPath(team, repo) {
  return sourceTeamPath && team === sourceTeam && valid(repo) ? join(sourceTeamPath, repo) : null;
}
function isMountedSource(team, repo) {
  const path = mountedPath(team, repo);
  return Boolean(path && existsSync(join(path, "component.json")));
}
function sourceFilePath(file, path) {
  return join(path, file);
}
function releasePath(version, file, path) {
  return join(path, ".wds", "releases", version, file);
}
function revisionFor(files) {
  return createHash("sha256")
    .update(sourceFiles.map((file) => files[file] || "").join("\0"))
    .digest("hex")
    .slice(0, 8);
}
function contentType(path) {
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".mjs": "text/javascript; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
    }[extname(path)] || "text/plain; charset=utf-8"
  );
}
async function git(cwd, args, remote = false) {
  const env =
    remote && gitToken
      ? { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS_REQUIRE: "force", WDS_GIT_TOKEN: gitToken }
      : { ...process.env };
  if (remote) {
    const helper = join(remoteCache, "askpass.sh");
    await writeFile(helper, '#!/bin/sh\ncase "$1" in *sername*) echo wds;; *) printf %s "$WDS_GIT_TOKEN";; esac\n', {
      mode: 0o700,
    });
    env.GIT_ASKPASS = helper;
  }
  return exec("git", ["-C", cwd, ...args], { env });
}
function remoteRequired() {
  if (!gitApi) {
    const error = new Error("GIT_API_URL is required for Git-managed repositories.");
    error.status = 503;
    throw error;
  }
  if (!gitToken) {
    const error = new Error(
      "GIT_API_TOKEN is required for Git-managed repositories; configure the opaque OIDC access token.",
    );
    error.status = 503;
    throw error;
  }
}
function configureGitAuthor(path) {
  if (!gitAuthorName || !gitAuthorEmail) {
    const error = new Error("GIT_AUTHOR_NAME and GIT_AUTHOR_EMAIL are required to create Git commits.");
    error.status = 503;
    throw error;
  }
  return Promise.all([
    git(path, ["config", "user.name", gitAuthorName]),
    git(path, ["config", "user.email", gitAuthorEmail]),
  ]);
}
async function api(path, options = {}) {
  remoteRequired();
  const response = await fetch(`${gitApi}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${gitToken}`,
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  });
  if (!response.ok) {
    const error = new Error(`Git API request failed (${response.status})`);
    error.status = response.status >= 400 && response.status < 500 ? response.status : 502;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}
async function remoteRepositories() {
  const orgResponse = await api("/api/v1/orgs");
  const orgs = Array.isArray(orgResponse) ? orgResponse : orgResponse.orgs || orgResponse.organizations || [];
  const result = [];
  for (const item of orgs) {
    const org = typeof item === "string" ? item : item.slug || item.org;
    if (!org) {
      continue;
    }
    const response = await api(`/api/v1/orgs/${encodeURIComponent(org)}/repos`);
    const repos = Array.isArray(response) ? response : response.repos || response.repositories || [];
    for (const entry of repos) {
      result.push({ team: org, repo: typeof entry === "string" ? entry : entry.repo || entry.slug || entry.name });
    }
  }
  return result.filter((entry) => entry.repo);
}
async function remoteRepo(team, repo, create = false) {
  remoteRequired();
  if (!valid(team, repo)) {
    throw new Error("Invalid organization or repository name.");
  }
  const entries = await remoteRepositories();
  let exists = entries.some((entry) => entry.team === team && entry.repo === repo);
  if (!entries.some((entry) => entry.team === team)) {
    if (!create) {
      return null;
    }
    try {
      await api("/api/v1/orgs", { method: "POST", body: JSON.stringify({ slug: team }) });
    } catch (error) {
      if (!error.message.includes("(409)")) {
        throw error;
      }
    }
  }
  if (!exists) {
    if (!create) {
      return null;
    }
    try {
      await api(`/api/v1/orgs/${encodeURIComponent(team)}/repos/${encodeURIComponent(repo)}`, { method: "POST" });
    } catch (error) {
      if (!error.message.includes("(409)")) {
        throw error;
      }
    }
    exists = true;
  }
  const path = join(remoteCache, team, repo);
  await mkdir(join(remoteCache, team), { recursive: true });
  const url = `${gitApi}/git/${encodeURIComponent(team)}/${encodeURIComponent(repo)}.git`;
  if (!existsSync(join(path, ".git"))) {
    if (exists && entries.some((entry) => entry.team === team && entry.repo === repo)) {
      await git(remoteCache, ["clone", url, path], true);
    } else {
      await mkdir(path, { recursive: true });
      await git(path, ["init", "--initial-branch=main"]);
    }
    await git(path, ["remote", "set-url", "origin", url]).catch(async () => {
      await git(path, ["remote", "add", "origin", url]);
    });
  } else {
    await git(path, ["remote", "set-url", "origin", url]);
  }
  if (exists) {
    await git(path, ["fetch", "origin", "+refs/heads/*:refs/remotes/origin/*", "+refs/tags/*:refs/tags/*"], true);
    const remoteMain = await git(path, ["rev-parse", "--verify", "refs/remotes/origin/main"])
      .then(() => true)
      .catch(() => false);
    if (remoteMain) {
      const dirty = (await git(path, ["status", "--porcelain"])).stdout;
      if (dirty.trim()) {
        throw new Error("Repository cache has uncommitted changes; refusing to overwrite them.");
      }
      const hasLocalHead = await git(path, ["rev-parse", "--verify", "HEAD"])
        .then(() => true)
        .catch(() => false);
      if (!hasLocalHead) {
        await git(path, ["checkout", "-B", "main", "origin/main"]);
      } else {
        const [localHead, remoteHead] = await Promise.all([
          git(path, ["rev-parse", "HEAD"]).then(({ stdout }) => stdout.trim()),
          git(path, ["rev-parse", "refs/remotes/origin/main"]).then(({ stdout }) => stdout.trim()),
        ]);
        if (localHead === remoteHead) {
          const branch = (await git(path, ["branch", "--show-current"])).stdout.trim();
          if (branch !== "main") {
            await git(path, ["checkout", "-B", "main", "origin/main"]);
          }
        } else {
          const localBehind = await git(path, ["merge-base", "--is-ancestor", "HEAD", "origin/main"])
            .then(() => true)
            .catch(() => false);
          if (localBehind) {
            await git(path, ["checkout", "-B", "main", "origin/main"]);
          } else {
            const localAhead = await git(path, ["merge-base", "--is-ancestor", "origin/main", "HEAD"])
              .then(() => true)
              .catch(() => false);
            if (!localAhead) {
              throw new Error("Local and remote main branches diverged; refusing to discard either history.");
            }
          }
        }
      }
    } else {
      const remoteBranches = (await git(path, ["for-each-ref", "--format=%(refname)", "refs/remotes/origin"])).stdout;
      if (remoteBranches.trim()) {
        throw new Error("WDS Git repositories must use the main branch.");
      }
    }
  }
  return path;
}
async function body(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
function reply(response, status, data, type = "application/json; charset=utf-8") {
  response.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  response.end(typeof data === "string" ? data : JSON.stringify(data));
}
async function ensureRepo(team, repo, files) {
  const path = await remoteRepo(team, repo, true);
  const hasCommit = await git(path, ["rev-parse", "--verify", "HEAD"])
    .then(() => true)
    .catch(() => false);
  if (hasCommit) {
    return path;
  }
  for (const file of sourceFiles) {
    if (typeof files[file] === "string") {
      await writeFile(join(path, file), files[file]);
    }
  }
  await configureGitAuthor(path);
  await git(path, ["add", "."]);
  await git(path, ["commit", "-m", "Initial component source"]);
  await git(path, ["push", "-u", "origin", "main"], true);
  return path;
}
async function listRepos() {
  const projects = [];
  if (sourceTeamPath && existsSync(sourceTeamPath)) {
    const entries = await readdir(sourceTeamPath, { withFileTypes: true });
    for (const entry of entries.filter((item) => item.isDirectory() && valid(item.name))) {
      if (!isMountedSource(sourceTeam, entry.name)) {
        continue;
      }
      const path = mountedPath(sourceTeam, entry.name);
      const metadata = JSON.parse(await readFile(join(path, "component.json"), "utf8"));
      const files = await readSourceFiles(path);
      projects.push({
        team: sourceTeam,
        repo: entry.name,
        ...metadata,
        revision: revisionFor(files),
        sourceMode: "filesystem",
      });
    }
  }
  if (gitToken) {
    for (const { team, repo } of await remoteRepositories()) {
      await withRepoLock(team, repo, async () => {
        const path = await remoteRepo(team, repo);
        if (!path) {
          return;
        }
        try {
          const { stdout } = await git(path, ["show", "refs/remotes/origin/main:component.json"]);
          const metadata = JSON.parse(stdout);
          if (!projects.some((project) => project.team === team && project.repo === repo)) {
            projects.push({
              team,
              repo,
              ...metadata,
              revision: (await git(path, ["rev-parse", "--short", "refs/remotes/origin/main"])).stdout.trim(),
            });
          }
        } catch {
          // Empty or non-WDS repositories are not editor projects.
        }
      });
    }
  } else if (projects.length === 0) {
    remoteRequired();
  }
  return projects;
}
async function readRevision(team, repo, revision, file) {
  if (!valid(team, repo) || !safePart.test(revision) || !assetFiles.includes(file)) {
    return null;
  }
  if (isMountedSource(team, repo)) {
    const root = mountedPath(team, repo);
    const generated = file === "styles.css" && revision === "latest" ? join(root, "dist", "editor.css") : null;
    const path =
      generated && existsSync(generated)
        ? generated
        : revision === "latest"
          ? sourceFilePath(file, root)
          : releasePath(revision, file, root);
    try {
      return await readFile(path, "utf8");
    } catch {
      return null;
    }
  }
  remoteRequired();
  return withRepoLock(team, repo, async () => {
    const path = await remoteRepo(team, repo);
    if (!path) {
      return null;
    }
    try {
      const ref = revision === "latest" ? "refs/remotes/origin/main" : revision;
      const { stdout } = await git(path, ["show", `${ref}:${file}`]);
      return stdout;
    } catch {
      return null;
    }
  });
}
async function nextVersion(path, kind) {
  const { stdout } = await git(path, ["tag", "--list", "v[0-9]*.[0-9]*"]);
  const versions = stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((tag) => tag.match(/^v(\d+)\.(\d+)$/))
    .filter(Boolean)
    .map(([, major, minor]) => [Number(major), Number(minor)]);
  const [major, minor] = versions.sort((a, b) => b[0] - a[0] || b[1] - a[1])[0] || [0, 0];
  return kind === "major" ? `v${major + 1}.0` : `v${major || 1}.${minor + 1}`;
}
async function compileSource(path) {
  if (!path) {
    return;
  }
  const cli = join(root, "node_modules", ".bin", "tailwindcss");
  if (!existsSync(cli) || !existsSync(sourceFilePath("styles.css", path))) {
    return;
  }
  await mkdir(join(path, "dist"), { recursive: true });
  await exec(cli, ["-i", "styles.css", "-o", "dist/editor.css", "--minify"], { cwd: path });
}
async function readSourceFiles(path) {
  return Object.fromEntries(
    await Promise.all(
      sourceFiles.map(async (file) => [
        file,
        existsSync(sourceFilePath(file, path)) ? await readFile(sourceFilePath(file, path), "utf8") : "",
      ]),
    ),
  );
}
async function releaseSource(team, repo, kind) {
  const path = mountedPath(team, repo);
  const files = await readSourceFiles(path);
  const revision = revisionFor(files);
  const releases = join(path, ".wds", "releases");
  await mkdir(releases, { recursive: true });
  const entries = await readdir(releases, { withFileTypes: true });
  const versions = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name.match(/^v(\d+)\.(\d+)$/))
    .filter(Boolean)
    .map(([, major, minor]) => [Number(major), Number(minor)]);
  const [major, minor] = versions.sort((a, b) => b[0] - a[0] || b[1] - a[1])[0] || [0, 0];
  const version = kind === "major" ? `v${major + 1}.0` : `v${major || 1}.${minor + 1}`;
  const destination = join(releases, version);
  await mkdir(destination, { recursive: true });
  for (const file of sourceFiles) {
    if (files[file]) {
      await writeFile(join(destination, file), files[file]);
    }
  }
  if (existsSync(join(path, "dist", "editor.css"))) {
    await cp(join(path, "dist", "editor.css"), join(destination, "styles.css"));
  }
  await writeFile(
    join(destination, "manifest.json"),
    JSON.stringify({ version, revision, files: sourceFiles }, null, 2),
  );
  return { version, revision };
}
async function runSpecs(team, repo) {
  if (!unsandboxedSpecsEnabled) {
    return {
      code: 1,
      output: "Spec execution is disabled; set WDS_ENABLE_UNSANDBOXED_SPECS=true only for trusted repositories.",
    };
  }
  const testTemp = await mkdtemp(join(tmpdir(), "wds-spec-test-"));
  const cwd = join(testTemp, "repo");
  const testEnv = {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: testTemp,
    TMPDIR: testTemp,
    TEMP: testTemp,
    LANG: process.env.LANG || "C.UTF-8",
    NODE_ENV: "test",
  };
  try {
    const projectFound = await withRepoLock(team, repo, async () => {
      const sourceCwd = isMountedSource(team, repo) ? mountedPath(team, repo) : await remoteRepo(team, repo);
      if (!sourceCwd || !existsSync(join(sourceCwd, "spec.mjs"))) {
        return Boolean(sourceCwd);
      }
      await cp(sourceCwd, cwd, {
        recursive: true,
        filter: (source) => {
          const parts = relative(sourceCwd, source).split(sep);
          return !parts.includes(".git") && !parts.includes("node_modules");
        },
      });
      return true;
    });
    if (!projectFound) {
      return { code: 1, output: "Project not found." };
    }
    if (!existsSync(join(cwd, "spec.mjs"))) {
      return { code: 0, output: "No spec.mjs found." };
    }
    const result = await exec(process.execPath, ["--test", "spec.mjs"], {
      cwd,
      env: testEnv,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { code: 0, output: `${result.stdout}${result.stderr}`.trim() };
  } catch (error) {
    return { code: error.code || 1, output: `${error.stdout || ""}${error.stderr || error.message}`.trim() };
  } finally {
    await rm(testTemp, { recursive: true, force: true });
  }
}
async function componentPreview(team, repo, revision) {
  const source = await readRevision(team, repo, revision, "component.html");
  const name = source?.match(/component=["']([^"']+)["']/)?.[1];
  if (!name || !/^[a-z][.0-9_a-z-]*-[.0-9_a-z-]*$/.test(name)) {
    return null;
  }
  const base = `/static/${team}/${repo}/${revision}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><script type="importmap">{"imports":{"@li3/":"https://cdn.li3.dev/@li3/"}}</script><script type="module">import '@li3/web';</script><link rel="component" href="${base}/component.html"></head><body><template app><${name}></${name}></template></body></html>`;
}
async function serveStatic(request, response, pathname) {
  const local = normalize(pathname.replace(/^\//, ""));
  if (local.startsWith("..")) {
    return reply(response, 403, { error: "Forbidden" });
  }
  try {
    const file = await readFile(join(publicDir, local));
    response.writeHead(200, { "content-type": contentType(local) });
    response.end(file);
  } catch {
    reply(response, 404, "Not found", "text/plain");
  }
}

// Git-managed projects are initialized on demand in the remote store; never create local shadow repos.
if (sourceTeamPath && existsSync(sourceTeamPath)) {
  const entries = await readdir(sourceTeamPath, { withFileTypes: true });
  for (const entry of entries.filter((item) => item.isDirectory() && valid(item.name))) {
    if (isMountedSource(sourceTeam, entry.name)) {
      await compileSource(mountedPath(sourceTeam, entry.name));
    }
  }
}

createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const parts = url.pathname.split("/").filter(Boolean);

  // OIDC Auth routes
  if (url.pathname === "/api/oidc/login") {
    await ensureAuthClient();
    if (!authReady || !authClient) {
      return reply(response, 503, { error: "OIDC auth not configured" });
    }
    const origin = request.headers.origin || `https://${request.headers.host}`;
    const redirectUri = oidcRedirectUri || new URL("/api/oidc/callback", origin).toString();
    const authResult = await authClient.createAuthorizationRequest({ redirectUri });
    for (const [id, value] of sessions) {
      if (value.expires <= Date.now()) {
        sessions.delete(id);
      }
    }
    sessions.set(authResult.state, {
      verifier: authResult.codeVerifier,
      redirectUri,
      expires: Date.now() + 5 * 60 * 1000,
    });
    response.writeHead(302, {
      Location: authResult.url,
      "Set-Cookie": `wds-oidc-state=${authResult.state}; Path=/api/oidc/callback; Max-Age=300; HttpOnly; Secure; SameSite=Lax`,
    });
    response.end();
    return;
  }
  if (url.pathname === "/api/oidc/callback") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const stateCookie = request.headers.cookie?.match(/(?:^|;\s*)wds-oidc-state=([^;]+)/)?.[1];
    const expiredStateCookie = "wds-oidc-state=; Path=/api/oidc/callback; Max-Age=0; HttpOnly; Secure; SameSite=Lax";
    if (!code || !state) {
      response.setHeader("Set-Cookie", expiredStateCookie);
      return reply(response, 400, { error: "Missing code or state" });
    }
    if (!stateCookie || stateCookie !== state) {
      response.setHeader("Set-Cookie", expiredStateCookie);
      return reply(response, 400, { error: "Invalid state" });
    }
    const sessionData = sessions.get(state);
    if (!sessionData || sessionData.expires <= Date.now()) {
      sessions.delete(state);
      response.setHeader("Set-Cookie", expiredStateCookie);
      return reply(response, 400, { error: "Invalid state" });
    }
    sessions.delete(state);
    try {
      await ensureAuthClient();
      if (!authReady || !authClient) {
        return reply(response, 503, { error: "OIDC auth not configured" });
      }
      const tokenData = await authClient.exchangeCode({
        code,
        codeVerifier: sessionData.verifier,
        redirectUri: sessionData.redirectUri,
      });
      if (typeof tokenData.id_token !== "string" || typeof tokenData.access_token !== "string") {
        throw new Error("OIDC token response is missing an ID token or access token");
      }
      const claims = await authClient.verifyToken(tokenData.id_token);
      const profile = await authClient.getProfile(tokenData.access_token, claims.sub);
      const sessionId = generateSessionId();
      sessions.set(sessionId, {
        user: profile,
        authenticated: true,
        created: Date.now(),
        expires: Date.now() + 8 * 60 * 60 * 1000,
      });
      response.writeHead(302, {
        "Set-Cookie": [
          `wds-session=${sessionId}; Path=/; Max-Age=28800; HttpOnly; Secure; SameSite=Lax`,
          expiredStateCookie,
        ],
        Location: "/",
      });
      response.end();
      return;
    } catch (err) {
      console.error("OIDC callback error:", err);
      response.writeHead(302, { Location: "/?auth_error=1", "Set-Cookie": expiredStateCookie });
      response.end();
      return;
    }
  }
  if (url.pathname === "/api/oidc/logout") {
    const session = checkSession(request);
    if (session) {
      for (const [id, candidate] of sessions) {
        if (candidate === session) {
          sessions.delete(id);
        }
      }
    }
    response.writeHead(302, {
      "Set-Cookie": [
        "wds-session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
        "wds-oidc-state=; Path=/api/oidc/callback; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
      ],
      Location: "/",
    });
    response.end();
    return;
  }
  if (url.pathname === "/api/oidc/me") {
    const session = checkSession(request);
    if (!session || !session.authenticated) {
      return reply(response, 200, { authenticated: false, user: null });
    }
    return reply(response, 200, { authenticated: true, user: session.user });
  }

  try {
    if (request.method === "GET" && url.pathname === "/api/projects") {
      if (!requireEditorAccess(request, response)) {
        return;
      }
      return reply(response, 200, await listRepos());
    }
    if (request.method === "GET" && parts[0] === "api" && parts[1] === "source") {
      if (!requireEditorAccess(request, response)) {
        return;
      }
      const [, , team, repo] = parts;
      if (!valid(team, repo)) {
        return reply(response, 400, { error: "Invalid project" });
      }
      if (isMountedSource(team, repo)) {
        const files = await readSourceFiles(mountedPath(team, repo));
        return reply(response, 200, { files, revision: revisionFor(files), sourceMode: "filesystem" });
      }
      return await withRepoLock(team, repo, async () => {
        const path = await remoteRepo(team, repo);
        if (!path) {
          return reply(response, 404, { error: "Project not found" });
        }
        const files = Object.fromEntries(
          await Promise.all(
            sourceFiles.map(async (file) => {
              try {
                return [file, (await git(path, ["show", `refs/remotes/origin/main:${file}`])).stdout];
              } catch {
                return [file, ""];
              }
            }),
          ),
        );
        return reply(response, 200, {
          files,
          revision: (await git(path, ["rev-parse", "--short", "refs/remotes/origin/main"])).stdout.trim(),
          sourceMode: "git",
        });
      });
    }
    if (request.method === "PUT" && parts[0] === "api" && parts[1] === "source") {
      if (!requireEditorAccess(request, response)) {
        return;
      }
      const [, , team, repo] = parts;
      const { files, message = "Update component source" } = await body(request);
      if (!valid(team, repo) || !files) {
        return reply(response, 400, { error: "Invalid source" });
      }
      if (isMountedSource(team, repo)) {
        const path = mountedPath(team, repo);
        for (const file of sourceFiles) {
          if (typeof files[file] === "string" && (files[file] || existsSync(sourceFilePath(file, path)))) {
            await writeFile(sourceFilePath(file, path), files[file]);
          }
        }
        await compileSource(path);
        return reply(response, 200, { revision: revisionFor(await readSourceFiles(path)), sourceMode: "filesystem" });
      }
      return await withRepoLock(team, repo, async () => {
        const path = await ensureRepo(team, repo, files);
        await git(path, ["push", "origin", "main"], true);
        for (const file of sourceFiles) {
          if (typeof files[file] === "string") {
            await writeFile(join(path, file), files[file]);
          }
        }
        await git(path, ["add", "."]);
        const status = (await git(path, ["status", "--porcelain"])).stdout;
        if (status.trim()) {
          await git(path, ["commit", "-m", message]);
        }
        await git(path, ["push", "origin", "main"], true);
        return reply(response, 200, {
          revision: (await git(path, ["rev-parse", "--short", "HEAD"])).stdout.trim(),
        });
      });
    }
    if (request.method === "POST" && parts[0] === "api" && parts[1] === "release") {
      if (!requireEditorAccess(request, response)) {
        return;
      }
      const [, , team, repo] = parts;
      const { kind } = await body(request);
      if (!valid(team, repo) || !["major", "minor"].includes(kind)) {
        return reply(response, 400, { error: "Invalid release" });
      }
      if (isMountedSource(team, repo)) {
        await compileSource(mountedPath(team, repo));
        return reply(response, 201, await releaseSource(team, repo, kind));
      }
      return await withRepoLock(team, repo, async () => {
        const path = await remoteRepo(team, repo);
        if (!path) {
          return reply(response, 404, { error: "Project not found" });
        }
        const localHead = (await git(path, ["rev-parse", "HEAD"])).stdout.trim();
        const remoteHead = (await git(path, ["rev-parse", "refs/remotes/origin/main"])).stdout.trim();
        if (localHead !== remoteHead) {
          const error = new Error("Cannot release while the local main branch has unpublished commits.");
          error.status = 409;
          throw error;
        }
        const version = await nextVersion(path, kind);
        await git(path, ["tag", "-a", version, "-m", `Release ${version}`]);
        await git(path, ["push", "origin", version], true);
        return reply(response, 201, {
          version,
          revision: (await git(path, ["rev-parse", "--short", "HEAD"])).stdout.trim(),
        });
      });
    }
    if (request.method === "POST" && parts[0] === "api" && parts[1] === "test") {
      if (!requireEditorAccess(request, response)) {
        return;
      }
      const [, , team, repo] = parts;
      if (!valid(team, repo)) {
        return reply(response, 400, { error: "Invalid project" });
      }
      return reply(response, 200, await runSpecs(team, repo));
    }
    if (request.method === "GET" && parts[0] === "static" && parts.length === 5) {
      const [, team, repo, revision, file] = parts;
      if (file === "component.html" && url.searchParams.get("view") === "component") {
        const preview = await componentPreview(team, repo, revision);
        if (preview) {
          response.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": revision === "latest" ? "no-store" : "public, max-age=31536000, immutable",
          });
          return response.end(preview);
        }
      }
      const asset = await readRevision(team, repo, revision, file);
      if (asset === null) {
        return reply(response, 404, "Not found", "text/plain");
      }
      response.writeHead(200, {
        "content-type": contentType(file),
        "cache-control": revision === "latest" ? "no-store" : "public, max-age=31536000, immutable",
      });
      return response.end(asset);
    }
    return serveStatic(request, response, url.pathname === "/" ? "/index.html" : url.pathname);
  } catch (error) {
    console.error(error);
    reply(response, error.status || 500, { error: String(error.message || error) });
  }
}).listen(port, () => console.log(`WDS prototype listening on http://localhost:${port}`));
