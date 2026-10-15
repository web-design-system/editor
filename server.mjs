import { createServer } from "node:http";
import { mkdir, readFile, writeFile, readdir, cp, mkdtemp, rm, lstat } from "node:fs/promises";
import { existsSync, lstatSync, rmSync } from "node:fs";
import { dirname, join, normalize, extname, relative, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import * as oidc from "openid-client";

const exec = promisify(execFile);
const root = process.cwd();
const publicDir = join(root, "public");
const gitApi = process.env.GIT_API_URL?.replace(/\/$/, "");
const gitToken = process.env.GIT_API_TOKEN;
const gitAuthorName = process.env.GIT_AUTHOR_NAME || "Design System";
const gitAuthorEmail = process.env.GIT_AUTHOR_EMAIL || "system@wds.local";
const databaseUrl = process.env.DATABASE_URL;
const databaseToken = process.env.DB_AUTH_TOKEN || process.env.DATABASE_TOKEN;
const unsandboxedSpecsEnabled = process.env.WDS_ENABLE_UNSANDBOXED_SPECS === "true";
const performanceDebugEnabled = process.env.WDS_PERF_DEBUG === "true";
const configuredPerformanceSlowMs = Number(process.env.WDS_PERF_SLOW_MS || 250);
const performanceSlowMs = Number.isFinite(configuredPerformanceSlowMs) ? Math.max(0, configuredPerformanceSlowMs) : 250;
const legacyGitMigrationEnabled = process.env.WDS_LEGACY_GIT_MIGRATION === "true";
const remoteCache = await mkdtemp(join(tmpdir(), "wds-next-remote-repos-"));
process.once("exit", () => rmSync(remoteCache, { recursive: true, force: true }));
const sourceTeam = process.env.SOURCE_TEAM;
const sourceTeamPath = process.env.SOURCE_TEAM_PATH;
if (Boolean(sourceTeam) !== Boolean(sourceTeamPath)) {
  throw new Error("Configure SOURCE_TEAM and SOURCE_TEAM_PATH together, or leave both unset.");
}
const port = Number(process.env.PORT || 4173);
const safePart = /^[a-z0-9][a-z0-9._-]*$/;
const sourceExtensions = new Set([".html", ".css", ".mjs", ".js", ".json", ".svg"]);
const assetExtensions = new Set([
  ...sourceExtensions,
  ".avif",
  ".bmp",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
]);
const excludedPaths = new Set([".git", "node_modules", ".wds", "dist"]);
// OIDC Authentication Configuration
const oidcIssuer = process.env.OIDC_ISSUER;
const oidcClientId = process.env.OIDC_CLIENT_ID;
const oidcClientSecret = process.env.OIDC_CLIENT_SECRET;
const oidcRedirectUri = process.env.OIDC_REDIRECT_URI;
const oidcCallbackPath = (() => {
  try {
    return oidcRedirectUri ? new URL(oidcRedirectUri).pathname : "/auth/callback";
  } catch {
    return null;
  }
})();
const allowedSubjects = new Set(
  (process.env.WDS_ALLOWED_SUBJECTS || "")
    .split(",")
    .map((subject) => subject.trim())
    .filter(Boolean),
);

const sessions = new Map();
const repoLocks = new Map();
const requestTimings = new WeakMap();
let metadataReady = null;
let inventoryCache = { expires: 0, value: null, pending: null };
let legacySeedPending = null;
let legacySeedComplete = false;

function performanceLog(operation, startedAt, fields = {}) {
  const durationMs = Math.round((performance.now() - startedAt) * 10) / 10;
  if (performanceDebugEnabled || durationMs >= performanceSlowMs) {
    console.info(`[wds-perf] ${JSON.stringify({ operation, durationMs, ...fields })}`);
  }
  return durationMs;
}

async function measurePerformance(operation, fields, action) {
  const startedAt = performance.now();
  try {
    const result = await action();
    performanceLog(operation, startedAt, { ...fields, outcome: "ok" });
    return result;
  } catch (error) {
    performanceLog(operation, startedAt, { ...fields, outcome: "error", status: error.status });
    throw error;
  }
}

function metadataOperation(sql) {
  const normalized = sql.trim().replace(/\s+/g, " ");
  const table = normalized.match(/(?:FROM|INTO|TABLE)\s+(?:IF NOT EXISTS )?([a-z_]+)/i)?.[1] || "unknown";
  return `${normalized.split(" ", 1)[0].toLowerCase()}.${table.toLowerCase()}`;
}

function invalidateInventory() {
  inventoryCache = { expires: 0, value: null, pending: null };
}

function metadataAvailable() {
  if (!databaseUrl) {
    return false;
  }
  try {
    const parsed = new URL(databaseUrl);
    return !(process.env.NODE_ENV === "production" && parsed.protocol !== "https:");
  } catch {
    return false;
  }
}

async function metadataQuery(sql, params = []) {
  if (!metadataAvailable()) {
    throw Object.assign(new Error("Team and design-system metadata is unavailable."), { status: 503 });
  }
  const endpointUrl = new URL(databaseUrl);
  if (endpointUrl.pathname.endsWith("/index.mjs")) {
    endpointUrl.pathname = endpointUrl.pathname.replace(/\/index\.mjs$/, "/query");
  } else if (!endpointUrl.pathname.endsWith("/query")) {
    endpointUrl.pathname = `${endpointUrl.pathname.replace(/\/$/, "")}/query`;
  }
  return measurePerformance("metadata.query", { statement: metadataOperation(sql) }, async () => {
    let response;
    try {
      response = await fetch(endpointUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(databaseToken ? { authorization: `Bearer ${databaseToken}` } : {}),
        },
        body: JSON.stringify({ s: sql, d: params, m: /^\s*select\b/i.test(sql) ? "all" : "run" }),
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error("Metadata database request failed");
      }
      let data = text ? JSON.parse(text) : {};
      if (data && data.result && !Array.isArray(data.rows)) {
        data = data.result;
      }
      if (data && data.error) {
        throw new Error(String(data.error).slice(0, 300));
      }
      return data;
    } catch (error) {
      // Preserve constraint details for callers to map duplicate records to HTTP 409.
      // Network and malformed responses remain deliberately opaque to API clients.
      if (error && /unique|constraint/i.test(error.message || "")) {
        throw error;
      }
      throw Object.assign(new Error("Team and design-system metadata is temporarily unavailable."), { status: 503 });
    }
  });
}

async function ensureMetadata() {
  if (!metadataReady) {
    metadataReady = (async () => {
      await metadataQuery(
        "CREATE TABLE IF NOT EXISTS teams (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
      );
      await metadataQuery(
        "CREATE TABLE IF NOT EXISTS design_systems (id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id), slug TEXT NOT NULL UNIQUE, git_org TEXT NOT NULL UNIQUE, foundation_repo TEXT NOT NULL DEFAULT 'foundation', name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
      );
    })().catch((error) => {
      metadataReady = null;
      throw error;
    });
  }
  await metadataReady;
}

async function seedLegacySystems() {
  return measurePerformance("legacy.seed", {}, async () => {
    await ensureMetadata();
    if (!gitToken && !sourceTeamPath) {
      return;
    }
    let projects;
    try {
      projects = await listRepos();
    } catch {
      return;
    }
    for (const project of projects.filter((item) => item.type === "design-system" && valid(item.team, item.repo))) {
      let teamRows = queryRows(await metadataQuery("SELECT id FROM teams WHERE slug = ?", [project.team]));
      if (!teamRows.length) {
        const teamId = randomBytes(16).toString("hex");
        try {
          await metadataQuery("INSERT INTO teams (id, slug, name) VALUES (?, ?, ?)", [
            teamId,
            project.team,
            project.team,
          ]);
        } catch (error) {
          if (!/unique|constraint/i.test(error.message || "")) {
            throw error;
          }
        }
        teamRows = queryRows(await metadataQuery("SELECT id FROM teams WHERE slug = ?", [project.team]));
      }
      if (
        !teamRows.length ||
        queryRows(await metadataQuery("SELECT id FROM design_systems WHERE git_org = ?", [project.team])).length
      ) {
        continue;
      }
      try {
        await metadataQuery(
          "INSERT INTO design_systems (id, team_id, slug, git_org, foundation_repo, name) VALUES (?, ?, ?, ?, ?, ?)",
          [
            randomBytes(16).toString("hex"),
            teamRows[0].id,
            project.repo,
            project.team,
            project.repo,
            project.name || project.repo,
          ],
        );
      } catch (error) {
        if (!/unique|constraint/i.test(error.message || "")) {
          throw error;
        }
      }
    }
  });
}

function scheduleLegacySystemSeed() {
  if (!legacyGitMigrationEnabled || legacySeedComplete || legacySeedPending) {
    return;
  }
  legacySeedPending = seedLegacySystems()
    .then(() => {
      legacySeedComplete = true;
    })
    .catch((error) => console.warn("Legacy Git migration failed:", error.message))
    .finally(() => {
      legacySeedPending = null;
    });
}

function queryRows(data) {
  let rows = Array.isArray(data)
    ? data
    : Array.isArray(data?.rows)
      ? data.rows
      : Array.isArray(data?.results)
        ? data.results
        : Array.isArray(data?.data?.rows)
          ? data.data.rows
          : Array.isArray(data?.result?.rows)
            ? data.result.rows
            : [];
  const columns = data?.columns || data?.result?.columns || data?.data?.columns;
  if (columns && rows.length && Array.isArray(rows[0])) {
    rows = rows.map((row) => Object.fromEntries(columns.map((column, index) => [column.name || column, row[index]])));
  }
  return rows;
}

let authClient = null;
let authReady = false;
let authInitialization = null;

function generateSessionId() {
  return randomBytes(32).toString("base64url");
}

function getOidcRedirectUri(request) {
  if (oidcRedirectUri) {
    return oidcRedirectUri;
  }
  const host = request.headers.host;
  const forwardedProtocol = request.headers["x-forwarded-proto"]?.split(",")[0].trim().toLowerCase();
  const protocol = forwardedProtocol || (request.socket.encrypted ? "https" : "http");
  if (!host || !["http", "https"].includes(protocol)) {
    return null;
  }
  try {
    const origin = new URL(`${protocol}://${host}`);
    if (origin.host !== host || origin.pathname !== "/") {
      return null;
    }
    return new URL(oidcCallbackPath || "/auth/callback", origin).href;
  } catch {
    return null;
  }
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
      } finally {
        if (!authReady) {
          authInitialization = null;
        }
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
  const config = await oidc.discovery(
    new URL(oidcIssuer),
    oidcClientId,
    oidcClientSecret ? { client_secret: oidcClientSecret } : undefined,
    oidcClientSecret ? oidc.ClientSecretPost(oidcClientSecret) : oidc.None(),
    new URL(oidcIssuer).protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(new URL(oidcIssuer).hostname)
      ? { execute: [oidc.allowInsecureRequests] }
      : undefined,
  );
  if (oidcRedirectUri && (!oidcCallbackPath || !["https:", "http:"].includes(new URL(oidcRedirectUri).protocol))) {
    throw new Error("OIDC redirect URI must be an absolute HTTP(S) URL");
  }
  return config;
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
  return Boolean(path && (existsSync(join(path, "component.json")) || existsSync(join(path, "design-system.json"))));
}
async function isDesignSystemProject(path) {
  try {
    const metadata = JSON.parse(await readFile(join(path, "design-system.json"), "utf8"));
    return metadata.type === "design-system";
  } catch {
    return false;
  }
}
function safeFile(file, extensions = assetExtensions) {
  if (typeof file !== "string" || !file || file.startsWith("/") || file.includes("\\") || /%2f|%5c|%2e/i.test(file)) {
    return false;
  }
  const parts = file.split("/");
  return (
    parts.every(
      (part) =>
        /^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(part) &&
        part !== "." &&
        part !== ".." &&
        !part.endsWith(" ") &&
        !part.startsWith(".") &&
        !excludedPaths.has(part),
    ) && extensions.has(extname(file).toLowerCase())
  );
}
async function discoverFiles(path, extensions = sourceExtensions) {
  const result = {};
  const rootInfo = await lstat(path);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    return result;
  }
  async function walk(dir, prefix = "") {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.name.startsWith(".") || excludedPaths.has(entry.name)) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), rel);
      } else if (entry.isFile() && safeFile(rel, extensions)) {
        try {
          const content = await readSafeFile(path, rel, "utf8");
          if (content !== null) {
            result[rel] = content;
          }
        } catch (error) {
          if (error.code !== "ENOENT") {
            throw error;
          }
        }
      }
    }
  }
  await walk(path);
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}
async function discoverAssets(path) {
  const result = {};
  const rootInfo = await lstat(path);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    return result;
  }
  async function walk(dir, prefix = "") {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.name.startsWith(".") || excludedPaths.has(entry.name)) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), rel);
      } else if (entry.isFile() && safeFile(rel, assetExtensions)) {
        try {
          const content = await readSafeFile(path, rel);
          if (content !== null) {
            result[rel] = content;
          }
        } catch (error) {
          if (error.code !== "ENOENT") {
            throw error;
          }
        }
      }
    }
  }
  await walk(path);
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}
async function readSafeFile(rootPath, file, encoding) {
  if (!safeFile(file)) {
    return null;
  }
  let current = rootPath;
  const rootInfo = await lstat(rootPath);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    return null;
  }
  const parts = file.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]);
    const info = await lstat(current);
    if (info.isSymbolicLink()) {
      return null;
    }
    if (index < parts.length - 1 && !info.isDirectory()) {
      return null;
    }
    if (index === parts.length - 1 && !info.isFile()) {
      return null;
    }
  }
  return encoding ? readFile(current, encoding) : readFile(current);
}
async function writeSafeFile(rootPath, file, content, extensions = sourceExtensions) {
  if (!safeFile(file, extensions)) {
    const error = new Error("Invalid source file path.");
    error.status = 400;
    throw error;
  }
  const rootInfo = await lstat(rootPath);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("Source repository path is not a regular directory.");
  }
  const parts = file.split("/");
  let current = rootPath;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        const error = new Error("Source path cannot traverse non-directory entries.");
        error.status = 400;
        throw error;
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      await mkdir(current);
    }
  }
  const target = join(current, parts.at(-1));
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile()) {
      const error = new Error("Source path must refer to a regular file.");
      error.status = 400;
      throw error;
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  await writeFile(target, content);
}
async function ensureSafeDirectories(rootPath, directories) {
  const rootInfo = await lstat(rootPath);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("Project path is not a regular directory.");
  }
  let current = rootPath;
  for (const directory of directories) {
    current = join(current, directory);
    try {
      await mkdir(current);
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
    }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("Project path contains a non-directory entry.");
    }
  }
  return current;
}
async function assertNoSymlinkPath(rootPath, file) {
  let current = rootPath;
  const parts = file.split("/");
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (error.code === "ENOENT") {
        return;
      }
      throw error;
    }
    if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory())) {
      const error = new Error("CSS imports cannot traverse symlinks or non-directory entries.");
      error.status = 400;
      throw error;
    }
    if (index === parts.length - 1 && !info.isFile()) {
      const error = new Error("CSS imports must target regular files.");
      error.status = 400;
      throw error;
    }
  }
}
function revisionFor(files) {
  const hash = createHash("sha256");
  for (const [file, content] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(file).update("\0").update(content).update("\0");
  }
  return hash.digest("hex").slice(0, 8);
}
function contentType(path) {
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".mjs": "text/javascript; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".svg": "image/svg+xml",
      ".avif": "image/avif",
      ".bmp": "image/bmp",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".ico": "image/x-icon",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
      ".ttf": "font/ttf",
      ".otf": "font/otf",
    }[extname(path).toLowerCase()] || "text/plain; charset=utf-8"
  );
}
async function git(cwd, args, remote = false, encoding = "utf8") {
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
  return measurePerformance("git.command", { command: args[0], remote }, () =>
    exec("git", ["-C", cwd, ...args], { env, encoding }),
  );
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
  return Promise.all([
    git(path, ["config", "user.name", gitAuthorName]),
    git(path, ["config", "user.email", gitAuthorEmail]),
  ]);
}
async function api(path, options = {}) {
  remoteRequired();
  const operation = options.method || "GET";
  const route = path
    .replace(/\/(?:[a-z0-9._-]+)(?=\/repos(?:\/|$))/i, "/:org")
    .replace(/\/repos\/[a-z0-9._-]+$/i, "/repos/:repo");
  return measurePerformance("git-api.request", { method: operation, route }, async () => {
    const { raw, ...requestOptions } = options;
    const response = await fetch(`${gitApi}${path}`, {
      ...requestOptions,
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
    if (response.status === 204 || operation === "HEAD") {
      return null;
    }
    if (raw) {
      return Buffer.from(await response.arrayBuffer());
    }
    if (!response.headers.get("content-type")?.includes("application/json")) {
      return response.text();
    }
    return response.json();
  });
}
async function remoteRepositories() {
  return measurePerformance("git-api.inventory", {}, async () => {
    const orgResponse = await api("/api/v1/orgs");
    const orgs = Array.isArray(orgResponse) ? orgResponse : orgResponse.orgs || orgResponse.organizations || [];
    const result = [];
    for (const item of orgs) {
      const org = typeof item === "string" ? item : item.slug || item.org;
      if (!org) {
        continue;
      }
      let response;
      try {
        response = await api(`/api/v1/orgs/${encodeURIComponent(org)}/repos`);
      } catch (error) {
        console.warn(`Skipping inaccessible Git organization ${org}:`, error.message);
        continue;
      }
      const repos = Array.isArray(response) ? response : response.repos || response.repositories || [];
      for (const entry of repos) {
        result.push({ team: org, repo: typeof entry === "string" ? entry : entry.repo || entry.slug || entry.name });
      }
    }
    return result.filter((entry) => entry.repo);
  });
}
function remoteRoute(team, repo, suffix) {
  return `/api/v1/orgs/${encodeURIComponent(team)}/repos/${encodeURIComponent(repo)}/${suffix}`;
}
async function remoteTree(team, repo) {
  return measurePerformance("git-rest.tree", {}, async () => {
    const result = await api(remoteRoute(team, repo, "tree"));
    return Array.isArray(result) ? result : result.files || result.tree || [];
  });
}
async function remoteFile(team, repo, file, ref = "main", method = "GET") {
  const query = new URLSearchParams({ path: file, ref });
  return measurePerformance("git-rest.file", { method, ref }, () =>
    api(`${remoteRoute(team, repo, "file")}?${query}`, {
      method,
      raw: method === "GET" && !sourceExtensions.has(extname(file).toLowerCase()),
    }),
  );
}
async function remoteFileExists(team, repo, file, ref = "main") {
  try {
    await remoteFile(team, repo, file, ref, "HEAD");
    return true;
  } catch (error) {
    if (error.status === 404) {
      return false;
    }
    throw error;
  }
}
async function remoteRevision(team, repo) {
  const result = await api(`${remoteRoute(team, repo, "log")}?limit=1`);
  const commit = (Array.isArray(result) ? result : result.commits || result.log || [])[0];
  return String(commit?.revision || commit?.hash || commit?.id || "").slice(0, 12);
}
async function mapLimit(items, limit, action) {
  const result = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        result[index] = await action(items[index], index);
      }
    }),
  );
  return result;
}
async function readRemoteFiles(team, repo, ref = "main", extensions = sourceExtensions) {
  const tree = await remoteTree(team, repo);
  const files = tree
    .filter(
      (entry) =>
        typeof entry === "string" ||
        (!["tree", "directory"].includes(entry.type || entry.kind) &&
          (!entry.mode || String(entry.mode).startsWith("100"))),
    )
    .map((entry) => (typeof entry === "string" ? entry : entry.path || entry.name))
    .filter((file) => typeof file === "string" && safeFile(file, extensions));
  const pairs = await mapLimit(files, 8, async (file) => [file, await remoteFile(team, repo, file, ref)]);
  return Object.fromEntries(pairs);
}
async function remoteRepo(team, repo, create = false, inventory = null) {
  remoteRequired();
  if (!valid(team, repo)) {
    throw new Error("Invalid organization or repository name.");
  }
  const entries = inventory || (await remoteRepositories());
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
  const freshCheckout = !existsSync(join(path, ".git"));
  if (freshCheckout) {
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
      if (freshCheckout) {
        // The Git API can advertise master as HEAD even when WDS stores its canonical branch on main.
        await git(path, ["checkout", "-B", "main", "origin/main"]);
      } else {
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
      }
    } else {
      const remoteBranches = (await git(path, ["for-each-ref", "--format=%(refname)", "refs/remotes/origin"])).stdout;
      if (remoteBranches.includes("refs/remotes/origin/master")) {
        // Promote the Git API's initial master branch without discarding its history.
        const hasLocalHead = await git(path, ["rev-parse", "--verify", "HEAD"])
          .then(() => true)
          .catch(() => false);
        if (!hasLocalHead || freshCheckout) {
          await git(path, ["checkout", "-B", "main", "origin/master"]);
          await git(path, ["push", "-u", "origin", "main"], true);
        } else {
          throw new Error("Repository has a master branch but no main branch; refusing to discard its history.");
        }
      } else if (remoteBranches.trim()) {
        throw new Error("WDS Git repositories must use the main branch.");
      }
    }
  }
  return path;
}
async function body(request) {
  const chunks = [];
  const maxBytes = 2 * 1024 * 1024;
  let bytes = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      tooLarge = true;
      chunks.length = 0;
    } else if (!tooLarge) {
      chunks.push(chunk);
    }
  }
  if (tooLarge) {
    const error = new Error("Request body exceeds the 2 MiB limit.");
    error.status = 413;
    throw error;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    const error = new Error("Request body must contain valid JSON.");
    error.status = 400;
    throw error;
  }
}
function reply(response, status, data, type = "application/json; charset=utf-8") {
  const startedAt = requestTimings.get(response);
  if (startedAt !== undefined && !response.headersSent) {
    response.setHeader("server-timing", `app;dur=${performanceLog("request.server-timing", startedAt, {})}`);
  }
  response.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  response.end(typeof data === "string" ? data : JSON.stringify(data));
}
async function ensureRepo(team, repo, files) {
  const path = await remoteRepo(team, repo, true);
  const hasCommit = await git(path, ["rev-parse", "--verify", "HEAD"])
    .then(() => true)
    .catch(() => false);
  if (hasCommit) {
    const projectMetadata = await Promise.any(
      ["component.json", "design-system.json"].map((file) => git(path, ["cat-file", "-e", `HEAD:${file}`])),
    )
      .then(() => true)
      .catch(() => false);
    if (projectMetadata) {
      return path;
    }
  }
  for (const file of Object.keys(files)) {
    if (safeFile(file, sourceExtensions) && typeof files[file] === "string") {
      await writeSafeFile(path, file, files[file]);
    }
  }
  await configureGitAuthor(path);
  await git(path, ["add", "."]);
  await git(path, ["commit", "-m", "Initial component source"]);
  await git(path, ["push", "-u", "origin", "main"], true);
  invalidateInventory();
  return path;
}

function blankProjectFiles(repo, name, description, designSystem) {
  const tag = `ds-${repo}`;
  return {
    "component.html": `<template component="${tag}" shadow-dom="open">\n  <link rel="stylesheet" href="./styles.css" />\n  <div data-wds-editable class="p-4 bg-indigo-600 text-white"><slot></slot></div>\n</template>\n`,
    "styles.css": `@import url("/static/${designSystem.team}/${designSystem.repo}/${designSystem.revision}/tokens.css");\n@import "tailwindcss";\n`,
    "stories.html": `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="utf-8" />\n    <script type="importmap">{ "imports": { "@li3/": "https://cdn.li3.dev/@li3/" } }</script>\n    <script type="module">import '@li3/web';</script>\n    <link rel="component" href="./component.html" />\n  </head>\n  <body>\n    <template app>\n      <main><h1>${name}</h1><${tag}></${tag}></main>\n    </template>\n  </body>\n</html>\n`,
    "component.json": `${JSON.stringify({ name, description, designSystem }, null, 2)}\n`,
    "spec.mjs":
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\n\ntest('component source is ready for specifications', () => {\n  assert.ok(true);\n});\n",
  };
}
function blankDesignSystemFiles(name, description) {
  return {
    "design-system.json": `${JSON.stringify({ type: "design-system", name, description }, null, 2)}\n`,
    "styles.css": `/* Shared design tokens for ${name}. */\n@import "./tokens.css";\n`,
    "tokens.css": `:root {\n  /* --color-primary: #2563eb; */\n  /* --spacing-unit: 0.25rem; */\n  /* --breakpoint-wide: 80rem; */\n}\n\n@theme {\n  /* --color-primary: #2563eb; */\n}\n`,
  };
}
async function listReposUncached() {
  return measurePerformance("git.inventory-projects", {}, async () => {
    const projects = [];
    if (sourceTeamPath && existsSync(sourceTeamPath)) {
      const entries = await readdir(sourceTeamPath, { withFileTypes: true });
      for (const entry of entries.filter((item) => item.isDirectory() && valid(item.name))) {
        if (!isMountedSource(sourceTeam, entry.name)) {
          continue;
        }
        const path = mountedPath(sourceTeam, entry.name);
        let metadata;
        try {
          metadata = JSON.parse(await readFile(join(path, "component.json"), "utf8"));
          metadata.type = "component";
        } catch {
          metadata = JSON.parse(await readFile(join(path, "design-system.json"), "utf8"));
          if (metadata.type !== "design-system") {
            continue;
          }
        }
        projects.push({
          team: sourceTeam,
          repo: entry.name,
          ...metadata,
          revision: revisionFor(await discoverAssets(path)),
          sourceMode: "filesystem",
        });
      }
    }
    if (gitToken) {
      const inventory = await remoteRepositories();
      for (const { team, repo } of inventory) {
        await withRepoLock(team, repo, async () => {
          try {
            const paths = (await remoteTree(team, repo)).map((entry) =>
              typeof entry === "string" ? entry : entry.path || entry.name,
            );
            const metadataFile = paths.includes("component.json") ? "component.json" : "design-system.json";
            if (!paths.includes(metadataFile)) {
              return;
            }
            const parsedMetadata = JSON.parse(await remoteFile(team, repo, metadataFile, "main"));
            if (metadataFile === "design-system.json" && parsedMetadata.type !== "design-system") {
              return;
            }
            const metadata = {
              ...parsedMetadata,
              type: metadataFile === "component.json" ? "component" : "design-system",
            };
            const revision = await remoteRevision(team, repo);
            if (!metadata) {
              return;
            }
            if (!projects.some((project) => project.team === team && project.repo === repo)) {
              projects.push({
                team,
                repo,
                ...metadata,
                revision,
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
  });
}
async function listRepos() {
  if (inventoryCache.value && inventoryCache.expires > Date.now()) {
    return inventoryCache.value;
  }
  if (!inventoryCache.pending) {
    inventoryCache.pending = listReposUncached()
      .then((value) => {
        inventoryCache = { value, expires: Date.now() + 3000, pending: null };
        return value;
      })
      .catch((error) => {
        inventoryCache = { expires: 0, value: null, pending: null };
        throw error;
      });
  }
  return inventoryCache.pending;
}
async function readRevision(team, repo, revision, file) {
  if (
    !valid(team, repo) ||
    !(revision === "latest" || /^[a-f0-9]{4,40}$/.test(revision) || /^v\d+\.\d+$/.test(revision)) ||
    !safeFile(file)
  ) {
    return null;
  }
  if (isMountedSource(team, repo)) {
    const root = mountedPath(team, repo);
    const sourceRoot =
      revision === "latest"
        ? join(root, ".wds", "artifacts", "latest")
        : join(root, ".wds", "artifacts", "releases", revision);
    try {
      return await readSafeFile(
        sourceRoot,
        file,
        sourceExtensions.has(extname(file).toLowerCase()) ? "utf8" : undefined,
      );
    } catch {
      return null;
    }
  }
  remoteRequired();
  try {
    const artifactPath = revision === "latest" ? `latest/${file}` : `releases/${revision}/${file}`;
    return await remoteFile(team, repo, artifactPath, "wds-artifacts");
  } catch {
    return null;
  }
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
  if (versions.length === 0) {
    return "v1.0";
  }
  const [major, minor] = versions.sort((a, b) => b[0] - a[0] || b[1] - a[1])[0];
  return kind === "major" ? `v${major + 1}.0` : `v${major || 1}.${minor + 1}`;
}
async function validateCssImports(path, files) {
  let browserImportsFound = false;
  for (const [file, value] of Object.entries(files)) {
    if (extname(file).toLowerCase() !== ".css") {
      continue;
    }
    const source = Buffer.isBuffer(value) ? value.toString("utf8") : value;
    const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "");
    const imports = [...withoutComments.matchAll(/@import\b([^;]*)(?:;|$)/gi)];
    const importTokens = [...withoutComments.matchAll(/@import\b/gi)];
    if (imports.length !== importTokens.length) {
      const error = new Error("CSS imports could not be safely parsed.");
      error.status = 400;
      throw error;
    }
    for (const [, prelude] of imports) {
      const parsed = prelude.match(/^\s*(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]+))\s*\)|"([^"]*)"|'([^']*)')/i);
      if (!parsed || /@import\b/i.test(prelude.slice(parsed[0].length))) {
        const error = new Error("CSS import could not be safely parsed.");
        error.status = 400;
        throw error;
      }
      const specifier = parsed.slice(1).find((value) => value !== undefined);
      if (specifier === "tailwindcss") {
        continue;
      }
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(specifier)) {
        const error = new Error("External CSS imports are not allowed.");
        error.status = 400;
        throw error;
      }
      if (specifier.startsWith("/")) {
        if (
          /^\/static\/[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*\/(?:latest|v\d+\.\d+)\/tokens\.css$/.test(specifier)
        ) {
          browserImportsFound = true;
          continue;
        }
        const error = new Error("Absolute CSS imports are only allowed for design-system tokens.css.");
        error.status = 400;
        throw error;
      }
      if (!specifier.startsWith(".")) {
        const error = new Error("External CSS imports are not allowed.");
        error.status = 400;
        throw error;
      }
      let localSpecifier;
      try {
        localSpecifier = decodeURIComponent(specifier.split(/[?#]/, 1)[0]);
      } catch {
        const error = new Error("CSS import path is invalid.");
        error.status = 400;
        throw error;
      }
      const target = resolve(path, file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".", localSpecifier);
      const targetRelative = relative(path, target);
      if (
        targetRelative.startsWith("..") ||
        targetRelative === "" ||
        targetRelative.startsWith(sep) ||
        !safeFile(targetRelative.split(sep).join("/"), new Set([".css"]))
      ) {
        const error = new Error("CSS imports must target supported stylesheets within the current project repository.");
        error.status = 400;
        throw error;
      }
      await assertNoSymlinkPath(path, targetRelative.split(sep).join("/"));
    }
  }
  return browserImportsFound;
}
async function validateRelativeReferences(path, files) {
  const references = [];
  for (const [file, value] of Object.entries(files)) {
    const extension = extname(file).toLowerCase();
    const content = Buffer.isBuffer(value) ? value.toString("utf8") : value;
    if (extension === ".html") {
      for (const [, specifier] of content.matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)) {
        references.push([file, specifier]);
      }
    } else if (extension === ".css") {
      const cssWithoutComments = content.replace(/\/\*[\s\S]*?\*\//g, "");
      for (const match of cssWithoutComments.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)) {
        references.push([
          file,
          match
            .slice(1)
            .find((item) => item !== undefined)
            .trim(),
        ]);
      }
    } else if (extension === ".mjs" || extension === ".js") {
      const dynamicImports = [...content.matchAll(/\bimport\s*\(([^)]*)\)/g)];
      const literalImport = /^\s*(?:"[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*')\s*$/;
      if (dynamicImports.some(([, expression]) => !literalImport.test(expression))) {
        const error = new Error("Dynamic imports must use literal paths so component boundaries can be validated.");
        error.status = 400;
        throw error;
      }
      const imports =
        /\bimport\s*(?:\(\s*)?["']([^"']+)["']|\bfrom\s*["']([^"']+)["']|\brequire\(\s*["']([^"']+)["']\s*\)|\bnew\s+URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g;
      for (const match of content.matchAll(imports)) {
        references.push([file, match.slice(1).find(Boolean)]);
      }
    }
  }
  for (const [importer, specifier] of references) {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\/|var\()/i.test(specifier)) {
      continue;
    }
    if (
      (extname(importer).toLowerCase() === ".mjs" || extname(importer).toLowerCase() === ".js") &&
      !specifier.startsWith(".")
    ) {
      continue;
    }
    let decoded;
    try {
      decoded = decodeURIComponent(specifier.split(/[?#]/, 1)[0]);
    } catch {
      const error = new Error("Relative component reference is invalid.");
      error.status = 400;
      throw error;
    }
    const target = resolve(path, dirname(importer), decoded);
    const targetRelative = relative(path, target);
    const relativeFile = targetRelative.split(sep).join("/");
    if (
      targetRelative.startsWith("..") ||
      targetRelative === "" ||
      targetRelative.startsWith(sep) ||
      !safeFile(relativeFile, assetExtensions)
    ) {
      const error = new Error("Relative imports and assets must remain inside the current component repository.");
      error.status = 400;
      throw error;
    }
    await assertNoSymlinkPath(path, relativeFile);
  }
}
async function readSourceFiles(path) {
  return discoverFiles(path, sourceExtensions);
}
async function publishSnapshot(path, team, repo, version = null) {
  const isMounted = isMountedSource(team, repo);
  const files = await discoverAssets(path);
  const isDesignSystem = await isDesignSystemProject(path);
  const metadataFile = isDesignSystem ? "design-system.json" : "component.json";
  let metadata;
  try {
    metadata = JSON.parse(Buffer.isBuffer(files[metadataFile]) ? files[metadataFile].toString() : files[metadataFile]);
  } catch {
    const error = new Error(`Valid ${metadataFile} metadata is required.`);
    error.status = 400;
    throw error;
  }
  if (isDesignSystem) {
    if (files["tokens.css"] === undefined) {
      const error = new Error("Design systems must publish tokens.css.");
      error.status = 400;
      throw error;
    }
  } else {
    const dependency = metadata.designSystem;
    if (
      !dependency ||
      dependency.team !== team ||
      !valid(dependency.team, dependency.repo) ||
      (!["latest"].includes(dependency.revision) && !/^v\d+\.\d+$/.test(dependency.revision || ""))
    ) {
      const error = new Error("Component must declare a valid designSystem dependency.");
      error.status = 400;
      throw error;
    }
    const url = `/static/${dependency.team}/${dependency.repo}/${dependency.revision}/tokens.css`;
    const importedStylesheets = [];
    for (const [file, value] of Object.entries(files)) {
      if (extname(file).toLowerCase() !== ".css") {
        continue;
      }
      const css = (Buffer.isBuffer(value) ? value.toString("utf8") : value).replace(/\/\*[\s\S]*?\*\//g, "");
      for (const [, prelude] of css.matchAll(/@import\b([^;]*)(?:;|$)/gi)) {
        const parsed = prelude.match(/^\s*(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]+))\s*\)|"([^"]*)"|'([^']*)')/i);
        const specifier = parsed?.slice(1).find((value) => value !== undefined);
        if (!specifier) {
          const error = new Error("Component styles must use safely parseable imports.");
          error.status = 400;
          throw error;
        }
        if (specifier !== "tailwindcss" && !specifier.startsWith(".")) {
          importedStylesheets.push(specifier);
        }
      }
    }
    if (importedStylesheets.length !== 1 || importedStylesheets[0] !== url) {
      const error = new Error(
        "Component styles must import the associated tokens.css exactly once and no external stylesheets.",
      );
      error.status = 400;
      throw error;
    }
    const depPath = isMountedSource(dependency.team, dependency.repo)
      ? mountedPath(dependency.team, dependency.repo)
      : await remoteRepo(dependency.team, dependency.repo);
    if (
      !depPath ||
      !(await isDesignSystemProject(depPath)) ||
      !(isMountedSource(dependency.team, dependency.repo)
        ? await readRevision(dependency.team, dependency.repo, dependency.revision, "tokens.css")
        : await remoteFileExists(
            dependency.team,
            dependency.repo,
            `${dependency.revision === "latest" ? "latest" : `releases/${dependency.revision}`}/tokens.css`,
            "wds-artifacts",
          ))
    ) {
      const error = new Error("The associated design system must have published tokens.css at the requested revision.");
      error.status = 400;
      throw error;
    }
  }
  await validateRelativeReferences(path, files);
  const sourceRevision = isMounted ? revisionFor(files) : (await git(path, ["rev-parse", "HEAD"])).stdout.trim();
  const stage = await mkdtemp(join(tmpdir(), "wds-publish-"));
  try {
    const artifactPath = join(stage, "latest");
    await mkdir(artifactPath);
    for (const [file, content] of Object.entries(files)) {
      if (
        file === "spec.mjs" ||
        file === "component.json" ||
        file === "design-system.json" ||
        file === "package.json" ||
        file.endsWith(".lock")
      ) {
        continue;
      }
      await writeSafeFile(artifactPath, file, content, assetExtensions);
    }
    if (!isDesignSystem && files["styles.css"] !== undefined) {
      const tailwind = join(root, "node_modules", ".bin", "tailwindcss");
      if (!existsSync(tailwind)) {
        const error = new Error("Tailwind CSS compiler is unavailable; refusing to publish uncompiled component CSS.");
        error.status = 503;
        throw error;
      }
      await validateCssImports(
        path,
        Object.fromEntries(Object.entries(files).filter(([file]) => extname(file) === ".css")),
      );
      await exec(tailwind, ["-i", "styles.css", "-o", "editor.css", "--minify"], { cwd: artifactPath });
      const generated = await readFile(join(artifactPath, "editor.css"));
      await rm(join(artifactPath, "editor.css"));
      await rm(join(artifactPath, "styles.css"));
      await writeFile(join(artifactPath, "styles.css"), generated);
    }
    const inventory = await discoverAssets(artifactPath);
    const artifactNames = Object.keys(inventory).sort();
    await writeFile(
      join(artifactPath, "manifest.json"),
      `${JSON.stringify({ revision: sourceRevision, type: isDesignSystem ? "design-system" : "component", files: artifactNames }, null, 2)}\n`,
    );
    if (isMounted) {
      const destination = await ensureSafeDirectories(path, [".wds", "artifacts"]);
      const releases = version ? await ensureSafeDirectories(path, [".wds", "artifacts", "releases"]) : null;
      const versionDirectory = version ? join(releases, version) : null;
      if (versionDirectory) {
        try {
          await lstat(versionDirectory);
          const error = new Error(`Published release ${version} already exists.`);
          error.status = 409;
          throw error;
        } catch (error) {
          if (error.code !== "ENOENT") {
            throw error;
          }
        }
      }
      const tempLatest = join(destination, `.latest-${randomBytes(6).toString("hex")}`);
      const tempVersion = version ? join(releases, `.${version}-${randomBytes(6).toString("hex")}`) : null;
      await cp(artifactPath, tempLatest, { recursive: true });
      if (tempVersion) {
        await cp(artifactPath, tempVersion, { recursive: true });
      }
      const previousLatest = join(destination, `.previous-${randomBytes(6).toString("hex")}`);
      let movedPrevious = false;
      let movedVersion = false;
      try {
        await (await import("node:fs/promises")).rename(join(destination, "latest"), previousLatest);
        movedPrevious = true;
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
      try {
        if (tempVersion) {
          await (await import("node:fs/promises")).rename(tempVersion, versionDirectory);
          movedVersion = true;
        }
        await (await import("node:fs/promises")).rename(tempLatest, join(destination, "latest"));
      } catch (error) {
        if (movedVersion) {
          await rm(versionDirectory, { recursive: true, force: true });
        }
        if (movedPrevious) {
          await (
            await import("node:fs/promises")
          )
            .rename(previousLatest, join(destination, "latest"))
            .catch(() => undefined);
        }
        await rm(tempLatest, { recursive: true, force: true });
        if (tempVersion) {
          await rm(tempVersion, { recursive: true, force: true });
        }
        throw error;
      }
      if (movedPrevious) {
        await rm(previousLatest, { recursive: true, force: true });
      }
    } else {
      const artifactRepo = join(stage, "artifact-repo");
      await mkdir(artifactRepo);
      await git(artifactRepo, ["init", "--initial-branch=main"]);
      await git(artifactRepo, ["remote", "add", "origin", `${gitApi}/git/${team}/${repo}.git`]);
      await git(
        artifactRepo,
        ["fetch", "origin", "refs/heads/wds-artifacts:refs/remotes/origin/wds-artifacts"],
        true,
      ).catch((error) => {
        if (!/couldn't find remote ref|not our ref/i.test(error.stderr || "")) {
          throw error;
        }
      });
      const existingArtifacts = await git(artifactRepo, ["rev-parse", "--verify", "refs/remotes/origin/wds-artifacts"])
        .then(() => true)
        .catch(() => false);
      if (existingArtifacts) {
        await git(artifactRepo, ["checkout", "-B", "wds-artifacts", "refs/remotes/origin/wds-artifacts"]);
      } else {
        await git(artifactRepo, ["checkout", "--orphan", "wds-artifacts"]);
      }
      await rm(join(artifactRepo, "latest"), { recursive: true, force: true });
      await cp(artifactPath, join(artifactRepo, "latest"), { recursive: true });
      if (version) {
        const releases = await ensureSafeDirectories(artifactRepo, ["releases"]);
        const versionDirectory = join(releases, version);
        try {
          await lstat(versionDirectory);
          const error = new Error(`Published release ${version} already exists.`);
          error.status = 409;
          throw error;
        } catch (error) {
          if (error.code !== "ENOENT") {
            throw error;
          }
        }
        await mkdir(join(artifactRepo, "releases"), { recursive: true });
        await cp(artifactPath, versionDirectory, { recursive: true });
      }
      await configureGitAuthor(artifactRepo);
      await git(artifactRepo, ["add", "-A"]);
      await git(artifactRepo, ["commit", "-m", version ? `Publish ${version}` : "Publish latest"]);
      await git(artifactRepo, ["push", "origin", "wds-artifacts"], true);
    }
    return { revision: sourceRevision, ...(version ? { version } : {}) };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
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
          try {
            return !parts.includes(".git") && !parts.includes("node_modules") && !lstatSync(source).isSymbolicLink();
          } catch {
            return false;
          }
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

createServer(async (request, response) => {
  const startedAt = performance.now();
  requestTimings.set(response, startedAt);
  const url = new URL(request.url, `http://${request.headers.host}`);
  response.once("finish", () => {
    performanceLog("http.request", startedAt, {
      method: request.method,
      path: url.pathname,
      status: response.statusCode,
    });
  });
  const parts = url.pathname.split("/").filter(Boolean);

  // OIDC Auth routes
  if (url.pathname === "/api/oidc/login") {
    await ensureAuthClient();
    if (!authReady || !authClient) {
      return reply(response, 503, { error: "OIDC auth not configured" });
    }
    const redirectUri = getOidcRedirectUri(request);
    if (!redirectUri) {
      return reply(response, 400, { error: "Could not determine the OIDC redirect URI" });
    }
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
    const authUrl = oidc.buildAuthorizationUrl(authClient, {
      redirect_uri: redirectUri,
      scope: "openid profile email",
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
    for (const [id, value] of sessions) {
      if (value.expires <= Date.now()) {
        sessions.delete(id);
      }
    }
    sessions.set(state, {
      verifier: codeVerifier,
      nonce,
      redirectUri,
      expires: Date.now() + 5 * 60 * 1000,
    });
    response.writeHead(302, {
      Location: authUrl.href,
      "Set-Cookie": `wds-oidc-state-${state}=${state}; Path=${oidcCallbackPath}; Max-Age=300; HttpOnly; Secure; SameSite=Lax`,
    });
    response.end();
    return;
  }
  if (oidcCallbackPath && url.pathname === oidcCallbackPath) {
    const code = url.searchParams.get("code");
    const providerError = url.searchParams.get("error");
    const state = url.searchParams.get("state");
    const validState = typeof state === "string" && /^[A-Za-z0-9_-]{43}$/.test(state);
    const stateCookie = validState
      ? request.headers.cookie?.match(new RegExp(`(?:^|;\\s*)wds-oidc-state-${state}=([^;]+)`))?.[1]
      : undefined;
    const expiredStateCookie = validState
      ? `wds-oidc-state-${state}=; Path=${oidcCallbackPath}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`
      : undefined;
    if (!validState) {
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
    if (providerError || !code) {
      response.writeHead(302, { Location: "/?auth_error=1", "Set-Cookie": expiredStateCookie });
      response.end();
      return;
    }
    let oidcPhase = "discovery";
    try {
      await ensureAuthClient();
      if (!authReady || !authClient) {
        return reply(response, 503, { error: "OIDC auth not configured" });
      }
      const callbackUrl = new URL(sessionData.redirectUri);
      callbackUrl.search = url.search;
      oidcPhase = "token exchange and ID token verification";
      const tokenData = await oidc.authorizationCodeGrant(authClient, callbackUrl, {
        pkceCodeVerifier: sessionData.verifier,
        expectedState: state,
        expectedNonce: sessionData.nonce,
      });
      const claims = tokenData.claims();
      if (!claims?.sub || !tokenData.access_token) {
        throw new Error("OIDC response did not include required claims");
      }
      oidcPhase = "userinfo";
      const profile = await oidc.fetchUserInfo(authClient, tokenData.access_token, claims.sub);
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
      console.error("OIDC callback failed:", oidcPhase, err?.name || "validation or exchange error");
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
      "Set-Cookie": ["wds-session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax"],
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
    if (request.method === "POST" && url.pathname === "/api/teams") {
      if (!requireEditorAccess(request, response)) {
        return;
      }
      const input = await body(request);
      const { slug, name = slug } = input || {};
      if (typeof slug !== "string" || slug.length > 100 || !valid(slug)) {
        return reply(response, 400, { error: "Invalid team slug" });
      }
      if (typeof name !== "string" || name.length > 100) {
        return reply(response, 400, { error: "Invalid team name" });
      }
      await ensureMetadata();
      const id = randomBytes(16).toString("hex");
      try {
        await metadataQuery("INSERT INTO teams (id, slug, name) VALUES (?, ?, ?)", [id, slug, name]);
      } catch (error) {
        if (/unique|constraint/i.test(error.message)) {
          return reply(response, 409, { error: "Team already exists" });
        }
        throw error;
      }
      return reply(response, 201, { team: { id, slug, name } });
    }
    if (request.method === "POST" && url.pathname === "/api/projects") {
      if (!requireEditorAccess(request, response)) {
        return;
      }
      const input = await body(request);
      const { team, repo, name = repo, description = "", type = "component", designSystem } = input || {};
      if (
        typeof team !== "string" ||
        team.length > 100 ||
        typeof repo !== "string" ||
        repo.length > 100 ||
        !valid(team, repo) ||
        typeof name !== "string" ||
        name.length > 100 ||
        !["component", "design-system"].includes(type) ||
        typeof description !== "string" ||
        description.length > 500 ||
        (type === "component" &&
          (!designSystem ||
            designSystem.team !== team ||
            !valid(designSystem.team, designSystem.repo) ||
            !(designSystem.revision === "latest" || /^v\d+\.\d+$/.test(designSystem.revision || ""))))
      ) {
        return reply(response, 400, { error: "Invalid project" });
      }
      return await withRepoLock(team, repo, async () => {
        if ((mountedPath(team, repo) && existsSync(mountedPath(team, repo))) || (await remoteRepo(team, repo))) {
          return reply(response, 409, { error: "Project already exists" });
        }
        if (type === "component") {
          const systemPath = isMountedSource(designSystem.team, designSystem.repo)
            ? mountedPath(designSystem.team, designSystem.repo)
            : await remoteRepo(designSystem.team, designSystem.repo);
          if (!systemPath || !(await isDesignSystemProject(systemPath))) {
            return reply(response, 400, { error: "designSystem must reference an existing design-system project." });
          }
          if (
            !(isMountedSource(designSystem.team, designSystem.repo)
              ? await readRevision(designSystem.team, designSystem.repo, designSystem.revision, "tokens.css")
              : await remoteFileExists(
                  designSystem.team,
                  designSystem.repo,
                  `${designSystem.revision === "latest" ? "latest" : `releases/${designSystem.revision}`}/tokens.css`,
                  "wds-artifacts",
                ))
          ) {
            return reply(response, 400, {
              error: "Publish the design system tokens.css before creating a component that depends on it.",
            });
          }
        }
        const files =
          type === "design-system"
            ? blankDesignSystemFiles(name, description)
            : blankProjectFiles(repo, name, description, designSystem);
        const path = await ensureRepo(team, repo, files);
        const revision = (await git(path, ["rev-parse", "--short", "HEAD"])).stdout.trim();
        return reply(response, 201, {
          project: { team, repo, name, description, type, revision, sourceMode: "git" },
        });
      });
    }
    if (request.method === "GET" && url.pathname === "/api/projects") {
      if (!requireEditorAccess(request, response)) {
        return;
      }
      return reply(response, 200, await listRepos());
    }
    if (request.method === "GET" && url.pathname === "/api/teams") {
      if (!requireEditorAccess(request, response)) {
        return;
      }
      await ensureMetadata();
      scheduleLegacySystemSeed();
      const teams = queryRows(await metadataQuery("SELECT id, slug, name, created_at FROM teams ORDER BY slug"));
      const systems = queryRows(
        await metadataQuery(
          "SELECT id, team_id, slug, git_org, foundation_repo, name, created_at FROM design_systems ORDER BY slug",
        ),
      );
      return reply(response, 200, {
        teams: teams.map((team) => ({
          ...team,
          designSystems: systems.filter((system) => system.team_id === team.id),
        })),
      });
    }
    if (request.method === "GET" && url.pathname === "/api/design-systems") {
      if (!requireEditorAccess(request, response)) {
        return;
      }
      await ensureMetadata();
      scheduleLegacySystemSeed();
      return reply(response, 200, {
        designSystems: queryRows(
          await metadataQuery(
            "SELECT id, team_id, slug, git_org, foundation_repo, name, created_at FROM design_systems ORDER BY slug",
          ),
        ),
      });
    }
    if (request.method === "POST" && url.pathname === "/api/design-systems") {
      if (!requireEditorAccess(request, response)) {
        return;
      }
      const { teamId, team, slug, name = slug, gitOrg } = await body(request);
      if (
        (!teamId && !team) ||
        typeof slug !== "string" ||
        !valid(slug) ||
        typeof gitOrg !== "string" ||
        !valid(gitOrg) ||
        typeof name !== "string" ||
        name.length > 100
      ) {
        return reply(response, 400, { error: "Invalid design system" });
      }
      await ensureMetadata();
      const teams = queryRows(
        await metadataQuery(`SELECT id, slug FROM teams WHERE ${teamId ? "id" : "slug"} = ?`, [teamId || team]),
      );
      if (!teams.length) {
        return reply(response, 404, { error: "Team not found" });
      }
      const teamRow = teams[0];
      const existing = queryRows(await metadataQuery("SELECT id FROM design_systems WHERE git_org = ?", [gitOrg]));
      if (existing.length) {
        return reply(response, 409, { error: "Git organization is already assigned to a design system" });
      }
      try {
        await api("/api/v1/orgs", { method: "POST", body: JSON.stringify({ slug: gitOrg }) });
      } catch (error) {
        if (error.status !== 409) {
          throw error;
        }
      }
      const foundation = await ensureRepo(gitOrg, "foundation", blankDesignSystemFiles(name, "Shared design tokens"));
      if (!(await isDesignSystemProject(foundation))) {
        return reply(response, 409, { error: "The reserved foundation repository is not a design system." });
      }
      const revision = (await git(foundation, ["rev-parse", "--short", "HEAD"])).stdout.trim();
      try {
        await metadataQuery(
          "INSERT INTO design_systems (id, team_id, slug, git_org, foundation_repo, name) VALUES (?, ?, ?, ?, 'foundation', ?)",
          [randomBytes(16).toString("hex"), teamRow.id, slug, gitOrg, name],
        );
      } catch (error) {
        if (/unique|constraint/i.test(error.message || "")) {
          return reply(response, 409, { error: "Design system metadata already exists." });
        }
        throw Object.assign(new Error("System repository is ready; retry to persist its metadata."), { status: 503 });
      }
      return reply(response, 201, { designSystem: { team: gitOrg, repo: "foundation", slug, name, revision } });
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
        return reply(response, 200, {
          files,
          revision: revisionFor(await discoverAssets(mountedPath(team, repo))),
          sourceMode: "filesystem",
        });
      }
      return await withRepoLock(team, repo, async () => {
        const files = await readRemoteFiles(team, repo, "main");
        return reply(response, 200, {
          files,
          revision: await remoteRevision(team, repo),
          sourceMode: "git",
        });
      });
    }
    if (request.method === "GET" && parts[0] === "api" && parts[1] === "history") {
      if (!requireEditorAccess(request, response)) {
        return;
      }
      const [, , team, repo] = parts;
      if (parts.length !== 4 || !valid(team, repo)) {
        return reply(response, 400, { error: "Invalid project" });
      }
      if (isMountedSource(team, repo)) {
        return reply(response, 200, { history: [], sourceMode: "filesystem" });
      }
      return await measurePerformance("git-rest.history", {}, async () => {
        const responseData = await api(`${remoteRoute(team, repo, "log")}?limit=50`);
        const commits = Array.isArray(responseData) ? responseData : responseData.commits || responseData.log || [];
        const history = commits
          .map((item) => ({
            revision: String(item.revision || item.hash || item.id || ""),
            message: String(item.message || item.subject || "").slice(0, 500),
            author: String(item.author || item.authorName || "").slice(0, 100),
            date: item.date || item.authorDate || item.timestamp,
          }))
          .filter((entry) => /^[a-f0-9]{40}$/.test(entry.revision) && !Number.isNaN(Date.parse(entry.date)));
        return reply(response, 200, { history, sourceMode: "git" });
      });
    }
    if (request.method === "PUT" && parts[0] === "api" && parts[1] === "source") {
      if (!requireEditorAccess(request, response)) {
        return;
      }
      const [, , team, repo] = parts;
      const { files, message = "Update component source" } = await body(request);
      if (
        !valid(team, repo) ||
        !files ||
        typeof files !== "object" ||
        Array.isArray(files) ||
        Object.entries(files).some(
          ([file, content]) => !safeFile(file, sourceExtensions) || typeof content !== "string",
        )
      ) {
        return reply(response, 400, { error: "Invalid source" });
      }
      if (isMountedSource(team, repo)) {
        const path = mountedPath(team, repo);
        const currentFiles = await readSourceFiles(path);
        const proposedFiles = { ...currentFiles, ...files };
        await validateRelativeReferences(path, proposedFiles);
        await validateCssImports(
          path,
          Object.fromEntries(Object.entries(proposedFiles).filter(([file]) => extname(file).toLowerCase() === ".css")),
        );
        for (const [file, content] of Object.entries(files)) {
          if (!safeFile(file, sourceExtensions) || typeof content !== "string") {
            continue;
          }
          await writeSafeFile(path, file, content);
        }
        return reply(response, 200, {
          revision: revisionFor(await discoverAssets(path)),
          sourceMode: "filesystem",
        });
      }
      return await withRepoLock(team, repo, async () => {
        const path = await ensureRepo(team, repo, files);
        const localHead = (await git(path, ["rev-parse", "HEAD"])).stdout.trim();
        const remoteHead = (await git(path, ["rev-parse", "refs/remotes/origin/main"])).stdout.trim();
        if (localHead !== remoteHead) {
          const error = new Error("Local main has unpublished commits; refusing to publish them with this update.");
          error.status = 409;
          throw error;
        }
        const tree = (await git(path, ["ls-tree", "-r", "-z", "refs/remotes/origin/main"])).stdout
          .split("\0")
          .flatMap((entry) => {
            const separator = entry.indexOf("\t");
            if (separator < 0) {
              return [];
            }
            const mode = entry.slice(0, separator).split(" ", 1)[0];
            const file = entry.slice(separator + 1);
            return mode.startsWith("100") && safeFile(file, sourceExtensions) ? [file] : [];
          });
        const currentFiles = Object.fromEntries(
          await Promise.all(
            tree.map(async (file) => [file, (await git(path, ["show", `refs/remotes/origin/main:${file}`])).stdout]),
          ),
        );
        const proposedFiles = { ...currentFiles, ...files };
        await validateRelativeReferences(path, proposedFiles);
        await validateCssImports(
          path,
          Object.fromEntries(Object.entries(proposedFiles).filter(([file]) => extname(file).toLowerCase() === ".css")),
        );
        for (const [file, content] of Object.entries(files)) {
          if (!safeFile(file, sourceExtensions) || typeof content !== "string") {
            continue;
          }
          await writeSafeFile(path, file, content);
        }
        await git(path, ["add", "."]);
        const status = (await git(path, ["status", "--porcelain"])).stdout;
        if (status.trim()) {
          await configureGitAuthor(path);
          await git(path, ["commit", "-m", message]);
        }
        await git(path, ["push", "origin", "main"], true);
        invalidateInventory();
        return reply(response, 200, {
          revision: (await git(path, ["rev-parse", "--short", "HEAD"])).stdout.trim(),
          sourceMode: "git",
        });
      });
    }
    if (request.method === "POST" && parts[0] === "api" && parts[1] === "release") {
      if (!requireEditorAccess(request, response)) {
        return;
      }
      const [, , team, repo] = parts;
      const { kind } = await body(request);
      if (parts.length !== 4 || !valid(team, repo) || !["major", "minor"].includes(kind)) {
        return reply(response, 400, { error: "Invalid release" });
      }
      if (isMountedSource(team, repo)) {
        const path = mountedPath(team, repo);
        const releases = join(path, ".wds", "artifacts", "releases");
        const entries = await readdir(releases, { withFileTypes: true }).catch(() => []);
        const versions = entries
          .map(({ name }) => name.match(/^v(\d+)\.(\d+)$/))
          .filter(Boolean)
          .map(([, a, b]) => [Number(a), Number(b)]);
        const [major, minor] = versions.sort((a, b) => b[0] - a[0] || b[1] - a[1])[0] || [0, 0];
        const version =
          versions.length === 0 ? "v1.0" : kind === "major" ? `v${major + 1}.0` : `v${major || 1}.${minor + 1}`;
        const published = await publishSnapshot(path, team, repo, version);
        invalidateInventory();
        return reply(response, 201, { version, revision: published.revision });
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
        const result = await publishSnapshot(path, team, repo, version);
        invalidateInventory();
        await git(path, ["tag", "-a", version, "-m", `Release ${version}`]);
        await git(path, ["push", "origin", version], true);
        return reply(response, 201, { version, revision: result.revision });
      });
    }
    if (request.method === "POST" && parts[0] === "api" && parts[1] === "publish") {
      if (!requireEditorAccess(request, response)) {
        return;
      }
      const [, , team, repo] = parts;
      if (parts.length !== 4 || !valid(team, repo)) {
        return reply(response, 400, { error: "Invalid project" });
      }
      return await withRepoLock(team, repo, async () => {
        const path = isMountedSource(team, repo) ? mountedPath(team, repo) : await remoteRepo(team, repo);
        if (!path) {
          return reply(response, 404, { error: "Project not found" });
        }
        if (!isMountedSource(team, repo)) {
          const localHead = (await git(path, ["rev-parse", "HEAD"])).stdout.trim();
          const remoteHead = (await git(path, ["rev-parse", "refs/remotes/origin/main"])).stdout.trim();
          const dirty = (await git(path, ["status", "--porcelain"])).stdout.trim();
          if (localHead !== remoteHead || dirty) {
            const error = new Error("Commit and push source changes before publishing.");
            error.status = 409;
            throw error;
          }
        }
        const result = await publishSnapshot(path, team, repo);
        invalidateInventory();
        return reply(response, 200, result);
      });
    }
    if (request.method === "POST" && parts[0] === "api" && parts[1] === "test") {
      if (!requireEditorAccess(request, response)) {
        return;
      }
      const [, , team, repo] = parts;
      if (parts.length !== 4 || !valid(team, repo)) {
        return reply(response, 400, { error: "Invalid project" });
      }
      return reply(response, 200, await runSpecs(team, repo));
    }
    if (["GET", "HEAD"].includes(request.method) && parts[0] === "static" && parts.length >= 5) {
      const [, team, repo, revision, ...fileParts] = parts;
      if (fileParts.some((part) => /%2f|%5c|%2e/i.test(part))) {
        return reply(response, 404, "Not found", "text/plain");
      }
      let decodedParts;
      try {
        decodedParts = fileParts.map(decodeURIComponent);
      } catch {
        decodedParts = [];
      }
      if (decodedParts.some((part) => part.includes("/") || part.includes("\\"))) {
        return reply(response, 404, "Not found", "text/plain");
      }
      const file = decodedParts.join("/");
      if (!safeFile(file)) {
        return reply(response, 404, "Not found", "text/plain");
      }
      if (file === "component.html" && url.searchParams.get("view") === "component") {
        const preview = await componentPreview(team, repo, revision);
        if (preview) {
          response.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": revision === "latest" ? "no-store" : "public, max-age=31536000, immutable",
            "content-security-policy":
              "sandbox allow-scripts; default-src 'none'; script-src 'self' https://cdn.li3.dev 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
            "referrer-policy": "no-referrer",
          });
          return response.end(request.method === "HEAD" ? undefined : preview);
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
      return response.end(request.method === "HEAD" ? undefined : asset);
    }
    return serveStatic(request, response, url.pathname === "/" ? "/index.html" : url.pathname);
  } catch (error) {
    console.error(error);
    reply(response, error.status || 500, { error: String(error.message || error) });
  }
}).listen(port, () => console.log(`WDS prototype listening on http://localhost:${port}`));
