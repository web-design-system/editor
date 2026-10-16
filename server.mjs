import { createServer } from "node:http";
import { mkdir, readFile, writeFile, readdir, cp, mkdtemp, rm, lstat } from "node:fs/promises";
import { existsSync, lstatSync } from "node:fs";
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
const databaseUrl = process.env.DATABASE_URL;
const databaseToken = process.env.DB_AUTH_TOKEN || process.env.DATABASE_TOKEN;
const unsandboxedSpecsEnabled = process.env.WDS_ENABLE_UNSANDBOXED_SPECS === "true";
const performanceDebugEnabled = process.env.WDS_PERF_DEBUG === "true";
const configuredPerformanceSlowMs = Number(process.env.WDS_PERF_SLOW_MS || 250);
const performanceSlowMs = Number.isFinite(configuredPerformanceSlowMs) ? Math.max(0, configuredPerformanceSlowMs) : 250;
const legacyGitMigrationEnabled = process.env.WDS_LEGACY_GIT_MIGRATION === "true";
const sourceTeam = process.env.SOURCE_TEAM;
const sourceTeamPath = process.env.SOURCE_TEAM_PATH;
if (Boolean(sourceTeam) !== Boolean(sourceTeamPath)) {
  throw new Error("Configure SOURCE_TEAM and SOURCE_TEAM_PATH together, or leave both unset.");
}
const port = Number(process.env.PORT || 4173);
const safePart = /^[a-z0-9][a-z0-9._-]*$/;
const sourceExtensions = new Set([".html", ".css", ".mjs", ".js", ".json", ".svg"]);
const maxRemoteFiles = 1000;
const maxRemoteTreeEntries = 20_000;
const maxRemoteFileBytes = 10 * 1024 * 1024;
const maxRemoteSourceBytes = 50 * 1024 * 1024;
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
async function remoteTree(team, repo, ref = null) {
  return measurePerformance("git-rest.tree", {}, async () => {
    const query = ref ? `?${new URLSearchParams({ ref })}` : "";
    const result = await api(`${remoteRoute(team, repo, "tree")}${query}`);
    const entries = Array.isArray(result) ? result : result.files || result.tree || [];
    if (!Array.isArray(entries) || entries.length > maxRemoteTreeEntries) {
      throw Object.assign(new Error("Git repository tree exceeds the supported file limit."), { status: 413 });
    }
    return entries;
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
  return String(commit?.revision || commit?.hash || commit?.id || "");
}
async function remoteHead(team, repo) {
  try {
    const revision = await remoteRevision(team, repo);
    return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(revision) ? revision.toLowerCase() : null;
  } catch (error) {
    if (error.status === 404) {
      return null;
    }
    throw error;
  }
}
async function remoteBranchHead(team, repo, branch) {
  const [branches, treeResponse] = await Promise.all([
    api(remoteRoute(team, repo, "branches")),
    api(`${remoteRoute(team, repo, "tree")}?${new URLSearchParams({ ref: branch })}`).catch((error) => {
      if (error.status === 404) {
        return null;
      }
      throw error;
    }),
  ]);
  const rows = Array.isArray(branches) ? branches : branches.branches || [];
  const branchRow = rows.find((entry) => (typeof entry === "string" ? entry : entry.name || entry.branch) === branch);
  const candidates = [
    typeof branchRow === "object"
      ? branchRow.sha ||
        branchRow.revision ||
        branchRow.head ||
        branchRow.hash ||
        branchRow.object ||
        (typeof branchRow.commit === "string" ? branchRow.commit : branchRow.commit?.sha)
      : null,
    treeResponse?.ref?.sha,
    treeResponse?.head?.sha,
    treeResponse?.commit?.sha,
    treeResponse?.revision,
    treeResponse?.sha,
  ];
  const revision = candidates.find(
    (value) => typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value),
  );
  if (revision) {
    return revision.toLowerCase();
  }
  if (branchRow || (Array.isArray(treeResponse) && treeResponse.length > 0) || treeResponse?.files?.length) {
    throw new Error(`GitMini did not return a commit SHA for branch ${branch}.`);
  }
  return null;
}
async function atomicCommit(team, repo, expectedRef, changes, message, targetBranch = "main") {
  if (!changes.length || changes.length > 200) {
    const error = new Error(
      changes.length
        ? "A single GitMini commit cannot contain more than 200 file changes."
        : "There are no source changes to commit.",
    );
    error.status = 400;
    throw error;
  }
  const normalized = changes.map((change) => {
    if (!safeFile(change.path, assetExtensions)) {
      throw Object.assign(new Error("Invalid repository file path."), { status: 400 });
    }
    if (change.delete === true) {
      return { path: change.path, delete: true };
    }
    const content = Buffer.isBuffer(change.content) ? change.content : Buffer.from(String(change.content));
    if (content.length > 10 * 1024 * 1024) {
      throw Object.assign(new Error("Repository file exceeds 10 MiB."), { status: 413 });
    }
    return { path: change.path, content: content.toString("base64") };
  });
  const result = await measurePerformance(
    "git-rest.atomic-commit",
    { targetBranch, changedFiles: changes.length },
    () =>
      api(remoteRoute(team, repo, "commits"), {
        method: "POST",
        body: JSON.stringify({ expectedRef, targetBranch, message, changes: normalized }),
      }),
  );
  const revisions = [
    result?.commit?.sha,
    result?.commit?.revision,
    result?.commit?.id,
    typeof result?.commit === "string" ? result.commit : null,
    result?.revision,
    result?.sha,
    typeof result?.ref === "string" ? result.ref : null,
  ];
  const revision = revisions.find(
    (value) => typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value),
  );
  if (!revision) {
    throw new Error("GitMini returned an invalid commit revision.");
  }
  return revision.toLowerCase();
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
  const tree = await remoteTree(team, repo, ref);
  const files = tree
    .filter(
      (entry) =>
        typeof entry === "string" ||
        (!["tree", "directory"].includes(entry.type || entry.kind) &&
          (!entry.mode || String(entry.mode).startsWith("100"))),
    )
    .map((entry) => (typeof entry === "string" ? entry : entry.path || entry.name))
    .filter((file) => typeof file === "string" && safeFile(file, extensions));
  if (files.length > maxRemoteFiles) {
    throw Object.assign(new Error("Git repository has too many supported source files."), { status: 413 });
  }
  let bytes = 0;
  const pairs = await mapLimit(files, 8, async (file) => {
    const content = await remoteFile(team, repo, file, ref);
    const size = Buffer.isBuffer(content) ? content.byteLength : Buffer.byteLength(String(content));
    if (size > maxRemoteFileBytes) {
      throw Object.assign(new Error(`Remote file ${file} exceeds 10 MiB.`), { status: 413 });
    }
    bytes += size;
    if (bytes > maxRemoteSourceBytes) {
      throw Object.assign(new Error("Git repository source exceeds the 50 MiB read limit."), { status: 413 });
    }
    return [file, content];
  });
  return Object.fromEntries(pairs);
}
async function validateRemoteFiles(files) {
  const path = await mkdtemp(join(tmpdir(), "wds-source-validation-"));
  try {
    for (const [file, content] of Object.entries(files)) {
      await writeSafeFile(path, file, content);
    }
    await validateRelativeReferences(path, files);
    await validateCssImports(
      path,
      Object.fromEntries(Object.entries(files).filter(([file]) => extname(file).toLowerCase() === ".css")),
    );
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}
async function materializeRemoteSource(team, repo, ref = "main") {
  const path = await mkdtemp(join(tmpdir(), "wds-source-stage-"));
  try {
    const files = await readRemoteFiles(team, repo, ref, assetExtensions);
    for (const [file, content] of Object.entries(files)) {
      await writeSafeFile(path, file, content, assetExtensions);
    }
    return { path, files };
  } catch (error) {
    await rm(path, { recursive: true, force: true });
    throw error;
  }
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
  remoteRequired();
  if (!valid(team, repo)) {
    throw Object.assign(new Error("Invalid organization or repository name."), { status: 400 });
  }
  try {
    await api(`/api/v1/orgs/${encodeURIComponent(team)}/repos/${encodeURIComponent(repo)}`, { method: "POST" });
  } catch (error) {
    if (error.status !== 409) {
      throw error;
    }
  }
  const existingHead = await remoteHead(team, repo).catch((error) => {
    if (error.status === 404) {
      return null;
    }
    throw error;
  });
  if (existingHead) {
    const paths = await remoteTree(team, repo, existingHead);
    const metadataFile = Object.hasOwn(files, "component.json") ? "component.json" : "design-system.json";
    const expectedContent = files[metadataFile];
    const metadataExists = paths.some(
      (entry) => (typeof entry === "string" ? entry : entry.path || entry.name) === metadataFile,
    );
    if (metadataExists && typeof expectedContent === "string") {
      let expectedMetadata;
      let existingMetadata;
      try {
        expectedMetadata = JSON.parse(expectedContent);
        const content = await remoteFile(team, repo, metadataFile, existingHead);
        existingMetadata = JSON.parse(Buffer.isBuffer(content) ? content.toString("utf8") : content);
      } catch {
        throw Object.assign(new Error("Repository already contains invalid project metadata."), { status: 409 });
      }
      const identityMatches = Object.entries(expectedMetadata).every(
        ([key, value]) => JSON.stringify(existingMetadata[key]) === JSON.stringify(value),
      );
      if (identityMatches) {
        return existingHead;
      }
    }
    if (metadataExists) {
      throw Object.assign(new Error("Repository metadata does not match the requested project."), { status: 409 });
    }
    throw Object.assign(new Error("Repository already contains content; refusing to overwrite it."), { status: 409 });
  }
  const branchResponse = await api(remoteRoute(team, repo, "branches"));
  const branches = Array.isArray(branchResponse) ? branchResponse : branchResponse.branches || [];
  const nonMainBranch = branches.find((entry) => {
    const name = typeof entry === "string" ? entry : entry.name || entry.branch;
    return name && name !== "main";
  });
  if (nonMainBranch) {
    throw Object.assign(new Error("Repository already contains a non-main branch; refusing to initialize it."), {
      status: 409,
    });
  }
  const changes = Object.entries(files)
    .filter(([file, content]) => safeFile(file, sourceExtensions) && typeof content === "string")
    .map(([path, content]) => ({ path, content }));
  const revision = await atomicCommit(team, repo, null, changes, "Initial component source", "main");
  invalidateInventory();
  return revision;
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
function nextVersionFromNames(names, kind) {
  const versions = names
    .map((tag) => tag.match(/^v(\d+)\.(\d+)$/))
    .filter(Boolean)
    .map(([, major, minor]) => [Number(major), Number(minor)]);
  if (versions.length === 0) {
    return "v1.0";
  }
  const [major, minor] = versions.sort((a, b) => b[0] - a[0] || b[1] - a[1])[0];
  return kind === "major" ? `v${major + 1}.0` : `v${major || 1}.${minor + 1}`;
}
async function remoteTags(team, repo) {
  const result = await api(remoteRoute(team, repo, "tags"));
  const tags = Array.isArray(result) ? result : result.tags || [];
  return tags.map((item) => (typeof item === "string" ? item : item.name)).filter((name) => typeof name === "string");
}
async function createRemoteTag(team, repo, name, target) {
  return api(remoteRoute(team, repo, "tags"), {
    method: "POST",
    body: JSON.stringify({ name, target }),
  });
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
async function publishSnapshot(path, team, repo, version = null, sourceRevisionOverride = null) {
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
    const isMountedDependency = isMountedSource(dependency.team, dependency.repo);
    const depMetadata = isMountedDependency
      ? await isDesignSystemProject(mountedPath(dependency.team, dependency.repo))
      : await remoteFile(dependency.team, dependency.repo, "design-system.json", "main")
          .then((content) => JSON.parse(content.toString()))
          .then((value) => value.type === "design-system")
          .catch(() => false);
    if (
      !depMetadata ||
      !(isMountedDependency
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
  const sourceRevision = isMounted ? revisionFor(files) : sourceRevisionOverride;
  if (!sourceRevision) {
    throw new Error("Could not determine the source commit revision for publishing.");
  }
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
      const oldTree = await remoteTree(team, repo, "wds-artifacts").catch((error) => {
        if (error.status === 404) {
          return [];
        }
        throw error;
      });
      const oldPaths = oldTree
        .map((entry) => (typeof entry === "string" ? entry : entry.path || entry.name))
        .filter((file) => typeof file === "string");
      const newFiles = await discoverAssets(artifactPath);
      const newLatestPaths = new Set(Object.keys(newFiles).map((file) => `latest/${file}`));
      const changes = Object.entries(newFiles).map(([file, content]) => ({ path: `latest/${file}`, content }));
      for (const oldPath of oldPaths) {
        if (oldPath.startsWith("latest/") && !newLatestPaths.has(oldPath)) {
          changes.push({ path: oldPath, delete: true });
        }
      }
      if (version) {
        const versionPrefix = `releases/${version}/`;
        if (oldPaths.some((file) => file.startsWith(versionPrefix))) {
          throw Object.assign(new Error(`Published release ${version} already exists.`), { status: 409 });
        }
        for (const [file, content] of Object.entries(newFiles)) {
          changes.push({ path: `${versionPrefix}${file}`, content });
        }
      }
      const expectedRef = await remoteBranchHead(team, repo, "wds-artifacts");
      await atomicCommit(
        team,
        repo,
        expectedRef,
        changes,
        version ? `Publish ${version}` : "Publish latest",
        "wds-artifacts",
      );
      if (version) {
        await createRemoteTag(team, repo, version, sourceRevision);
      }
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
      if (isMountedSource(team, repo)) {
        const sourceCwd = mountedPath(team, repo);
        if (!existsSync(join(sourceCwd, "spec.mjs"))) {
          return true;
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
      }
      const head = await remoteHead(team, repo);
      if (!head) {
        return false;
      }
      const files = await readRemoteFiles(team, repo, head, assetExtensions);
      await mkdir(cwd, { recursive: true });
      for (const [file, content] of Object.entries(files)) {
        await writeSafeFile(cwd, file, content, assetExtensions);
      }
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
        if ((mountedPath(team, repo) && existsSync(mountedPath(team, repo))) || (await remoteHead(team, repo))) {
          return reply(response, 409, { error: "Project already exists" });
        }
        if (type === "component") {
          const systemExists = isMountedSource(designSystem.team, designSystem.repo)
            ? await isDesignSystemProject(mountedPath(designSystem.team, designSystem.repo))
            : await remoteFile(designSystem.team, designSystem.repo, "design-system.json", "main")
                .then((content) => JSON.parse(content.toString()).type === "design-system")
                .catch(() => false);
          if (!systemExists) {
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
        const revision = await ensureRepo(team, repo, files);
        return reply(response, 201, {
          project: { team, repo, name, description, type, revision: revision.slice(0, 12), sourceMode: "git" },
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
      const revision = await ensureRepo(gitOrg, "foundation", blankDesignSystemFiles(name, "Shared design tokens"));
      const foundationMetadata = await remoteFile(gitOrg, "foundation", "design-system.json", "main")
        .then((content) => JSON.parse(content.toString()))
        .catch(() => null);
      if (foundationMetadata?.type !== "design-system") {
        return reply(response, 409, { error: "The reserved foundation repository is not a design system." });
      }
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
      return reply(response, 201, {
        designSystem: { team: gitOrg, repo: "foundation", slug, name, revision: revision.slice(0, 12) },
      });
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
        const baseRef = await remoteHead(team, repo);
        if (!baseRef) {
          return reply(response, 404, { error: "Project not found" });
        }
        const files = await readRemoteFiles(team, repo, baseRef);
        return reply(response, 200, {
          files,
          revision: baseRef.slice(0, 12),
          baseRef,
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
          .filter(
            (entry) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(entry.revision) && !Number.isNaN(Date.parse(entry.date)),
          );
        return reply(response, 200, { history, sourceMode: "git" });
      });
    }
    if (request.method === "PUT" && parts[0] === "api" && parts[1] === "source") {
      if (!requireEditorAccess(request, response)) {
        return;
      }
      const [, , team, repo] = parts;
      const { files, message = "Update component source", baseRef: requestedBaseRef } = await body(request);
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
      const currentHead = await remoteHead(team, repo);
      if (!currentHead) {
        return reply(response, 404, { error: "Project not found" });
      }
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(requestedBaseRef || "")) {
        return reply(response, 400, { error: "A full baseRef is required to commit remote source changes." });
      }
      if (requestedBaseRef.toLowerCase() !== currentHead) {
        return reply(response, 409, {
          error: "This project changed since it was loaded. Refresh the source and try again.",
        });
      }
      const currentFiles = await readRemoteFiles(team, repo, currentHead);
      const proposedFiles = { ...currentFiles, ...files };
      await validateRemoteFiles(proposedFiles);
      const revision = await atomicCommit(
        team,
        repo,
        currentHead,
        Object.entries(files).map(([path, content]) => ({ path, content })),
        message,
      );
      invalidateInventory();
      return reply(response, 200, { revision: revision.slice(0, 12), baseRef: revision, sourceMode: "git" });
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
        const version = nextVersionFromNames(
          versions.map(([releaseMajor, releaseMinor]) => `v${releaseMajor}.${releaseMinor}`),
          kind,
        );
        const published = await publishSnapshot(path, team, repo, version);
        invalidateInventory();
        return reply(response, 201, { version, revision: published.revision });
      }
      return await withRepoLock(team, repo, async () => {
        const sourceRevision = await remoteHead(team, repo);
        if (!sourceRevision) {
          return reply(response, 404, { error: "Project not found" });
        }
        const tags = await remoteTags(team, repo);
        const version = nextVersionFromNames(tags, kind);
        const artifactTree = await remoteTree(team, repo, "wds-artifacts").catch((error) => {
          if (error.status === 404) {
            return [];
          }
          throw error;
        });
        const versionPrefix = `releases/${version}/`;
        const artifactPaths = artifactTree.map((entry) =>
          typeof entry === "string" ? entry : entry.path || entry.name,
        );
        if (artifactPaths.some((file) => typeof file === "string" && file.startsWith(versionPrefix))) {
          const manifestPath = `${versionPrefix}manifest.json`;
          if (!artifactPaths.includes(manifestPath)) {
            return reply(response, 409, { error: `Release ${version} artifacts exist without a manifest.` });
          }
          const manifestContent = await remoteFile(team, repo, manifestPath, "wds-artifacts");
          let manifest;
          try {
            manifest = JSON.parse(
              Buffer.isBuffer(manifestContent) ? manifestContent.toString("utf8") : manifestContent,
            );
          } catch {
            return reply(response, 409, { error: `Release ${version} manifest is invalid.` });
          }
          if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(manifest.revision || "")) {
            return reply(response, 409, { error: `Release ${version} manifest has no valid source revision.` });
          }
          if (
            !Array.isArray(manifest.files) ||
            manifest.files.some(
              (file) => !safeFile(file, assetExtensions) || !artifactPaths.includes(`${versionPrefix}${file}`),
            )
          ) {
            return reply(response, 409, { error: `Release ${version} artifacts do not match their manifest.` });
          }
          await createRemoteTag(team, repo, version, manifest.revision);
          invalidateInventory();
          return reply(response, 201, { version, revision: manifest.revision });
        }
        const stage = await materializeRemoteSource(team, repo, sourceRevision);
        try {
          const result = await publishSnapshot(stage.path, team, repo, version, sourceRevision);
          invalidateInventory();
          return reply(response, 201, { version, revision: result.revision });
        } finally {
          await rm(stage.path, { recursive: true, force: true });
        }
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
        if (isMountedSource(team, repo)) {
          const result = await publishSnapshot(mountedPath(team, repo), team, repo);
          invalidateInventory();
          return reply(response, 200, result);
        }
        const sourceRevision = await remoteHead(team, repo);
        if (!sourceRevision) {
          return reply(response, 404, { error: "Project not found" });
        }
        const stage = await materializeRemoteSource(team, repo, sourceRevision);
        let result;
        try {
          result = await publishSnapshot(stage.path, team, repo, null, sourceRevision);
        } finally {
          await rm(stage.path, { recursive: true, force: true });
        }
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
