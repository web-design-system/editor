import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, readdir, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const exec = promisify(execFile);
const root = process.cwd();
const publicDir = join(root, 'public');
const reposDir = process.env.REPOS_PATH || join(root, 'data', 'repos');
const volumeRoot = existsSync('/data/web-design-system') ? '/data' : '/data/cloud/volumes/wds.apphor.de/_data';
const sourcePath = process.env.SOURCE_PATH || join(volumeRoot, 'web-design-system', 'editor');
const sourceTeam = process.env.SOURCE_TEAM || 'web-design-system';
const sourceRepo = process.env.SOURCE_REPO || 'editor';
const port = Number(process.env.PORT || 4173);
const safePart = /^[a-z0-9][a-z0-9._-]*$/;
const sourceFiles = ['component.html', 'styles.css', 'editor.mjs', 'buttons.mjs', 'stories.html', 'component.json', 'spec.mjs'];

const sample = {
  'component.html': `<template component="acme-button" shadow-dom="open">
  <link rel="stylesheet" href="./styles.css" />
  <button class="button" type="button" on-click="press()" bind-disabled.bool="disabled">
    <slot>Button</slot>
  </button>
  <script setup src="./buttons.mjs"></script>
</template>
`,
  'styles.css': `@import url("/static/acme-corp/system/latest/styles.css");

:host { display: inline-block; }
.button {
  appearance: none;
  border: 0;
  border-radius: var(--radius-control, 0.5rem);
  background: var(--color-accent, #70d7f0);
  color: var(--color-ink, #081421);
  cursor: pointer;
  font: inherit;
  font-weight: 700;
  padding: 0.65rem 1rem;
}
.button:hover { background: var(--color-accent-hover, #a6ebfa); }
.button:focus-visible { outline: 2px solid var(--color-focus, #f6bd60); outline-offset: 3px; }
.button:disabled { cursor: not-allowed; opacity: 0.45; }
`,
  'buttons.mjs': `import { defineEvent, defineProp } from '@li3/web';

export default function () {
  const disabled = defineProp('disabled', { default: false });
  const pressed = defineEvent('pressed');
  const press = () => !disabled.value && pressed();

  return { disabled, press };
}
`,
  'stories.html': `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <script type="importmap">
      { "imports": { "@li3/": "https://cdn.li3.dev/@li3/" } }
    </script>
    <script type="module">import '@li3/web';</script>
    <link rel="component" href="./component.html" />
    <style>
      :root { font-family: ui-sans-serif, system-ui, sans-serif; color: #e5f5fb; background: #0b1420; }
      .stories { display: grid; gap: 2rem; max-width: 56rem; margin: 0 auto; padding: 3rem; }
      header p { color: #70d7f0; font: 700 .7rem ui-monospace, monospace; letter-spacing: .12em; }
      h1 { margin: 0; font-size: 2rem; } h2 { font-size: .8rem; color: #8aadc0; text-transform: uppercase; letter-spacing: .08em; }
      section { display: grid; gap: .75rem; padding: 1rem; border: 1px solid #24394b; background: #0e1b29; }
    </style>
  </head>
  <body>
    <template app>
  <main class="stories">
    <header><p>ACME / BUTTON</p><h1>Buttons</h1></header>
    <section><h2>Default</h2><acme-button>Continue</acme-button></section>
    <section><h2>Disabled</h2><acme-button disabled>Continue</acme-button></section>
    <section><h2>Long label</h2><acme-button>Save changes and continue</acme-button></section>
  </main>
    </template>
  </body>
</html>
`,
  'component.json': `{
  "name": "acme-button",
  "description": "A reusable primary action control."
}
`,
  'spec.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';

test('component source declares a custom element', () => {
  assert.ok(true);
});
`,
};

const baseline = {
  'styles.css': `:root {
  --color-ink: #081421;
  --color-accent: #70d7f0;
  --color-accent-hover: #a6ebfa;
  --color-focus: #f6bd60;
  --radius-control: 0.5rem;
}
`,
  'tokens.css': `:root { --space-1: 0.25rem; --space-2: 0.5rem; --space-4: 1rem; }
`,
  'stories.html': '<main>ACME baseline tokens</main>\n',
  'component.json': '{\n  "name": "system",\n  "description": "ACME baseline styles and tokens."\n}\n',
  'spec.mjs': "import test from 'node:test';\ntest('baseline loads', () => {});\n",
};

function valid(...parts) { return parts.every((part) => safePart.test(part)); }
function repoPath(team, repo) { return join(reposDir, team, repo); }
function isMountedSource(team, repo) { return team === sourceTeam && repo === sourceRepo && existsSync(join(sourcePath, 'component.json')); }
function sourceFilePath(file) { return join(sourcePath, file); }
function releasePath(version, file) { return join(sourcePath, '.wds', 'releases', version, file); }
function revisionFor(files) {
  return createHash('sha256').update(sourceFiles.map((file) => files[file] || '').join('\0')).digest('hex').slice(0, 8);
}
function contentType(path) {
  return { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' }[extname(path)] || 'text/plain; charset=utf-8';
}
async function git(cwd, args) { return exec('git', ['-C', cwd, ...args]); }
async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
function reply(response, status, data, type = 'application/json; charset=utf-8') {
  response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  response.end(typeof data === 'string' ? data : JSON.stringify(data));
}
async function ensureRepo(team, repo, files) {
  const path = repoPath(team, repo);
  if (existsSync(join(path, '.git'))) return path;
  await mkdir(path, { recursive: true });
  await git(path, ['init', '--initial-branch=main']);
  await git(path, ['config', 'user.name', 'WDS Prototype']);
  await git(path, ['config', 'user.email', 'prototype@wds.apphor.de']);
  await Promise.all(Object.entries(files).map(([file, value]) => writeFile(join(path, file), value)));
  await git(path, ['add', '.']);
  await git(path, ['commit', '-m', 'Initial component source']);
  return path;
}
async function listRepos() {
  if (isMountedSource(sourceTeam, sourceRepo)) {
    const metadata = JSON.parse(await readFile(sourceFilePath('component.json'), 'utf8'));
    const files = await readSourceFiles();
    return [{ team: sourceTeam, repo: sourceRepo, ...metadata, revision: revisionFor(files), sourceMode: 'filesystem' }];
  }
  if (!existsSync(reposDir)) return [];
  const teams = await readdir(reposDir, { withFileTypes: true });
  const projects = [];
  for (const team of teams.filter((entry) => entry.isDirectory())) {
    const repos = await readdir(join(reposDir, team.name), { withFileTypes: true });
    for (const repo of repos.filter((entry) => entry.isDirectory())) {
      const path = repoPath(team.name, repo.name);
      if (!existsSync(join(path, '.git'))) continue;
      const metadata = JSON.parse(await readFile(join(path, 'component.json'), 'utf8'));
      const { stdout } = await git(path, ['rev-parse', '--short', 'HEAD']);
      projects.push({ team: team.name, repo: repo.name, ...metadata, revision: stdout.trim() });
    }
  }
  return projects;
}
async function readRevision(team, repo, revision, file) {
  if (!valid(team, repo) || !safePart.test(revision) || !sourceFiles.includes(file) && !['tokens.css'].includes(file)) return null;
  if (isMountedSource(team, repo)) {
    const generated = file === 'styles.css' && revision === 'latest' ? join(sourcePath, 'dist', 'editor.css') : null;
    const path = generated && existsSync(generated) ? generated : revision === 'latest' ? sourceFilePath(file) : releasePath(revision, file);
    try { return await readFile(path, 'utf8'); } catch { return null; }
  }
  const path = repoPath(team, repo);
  if (!existsSync(join(path, '.git'))) return null;
  try {
    const ref = revision === 'latest' ? 'main' : revision;
    const { stdout } = await git(path, ['show', `${ref}:${file}`]);
    return stdout;
  } catch { return null; }
}
async function nextVersion(path, kind) {
  const { stdout } = await git(path, ['tag', '--list', 'v[0-9]*.[0-9]*']);
  const versions = stdout.trim().split('\n').filter(Boolean).map((tag) => tag.match(/^v(\d+)\.(\d+)$/)).filter(Boolean).map(([, major, minor]) => [Number(major), Number(minor)]);
  const [major, minor] = versions.sort((a, b) => b[0] - a[0] || b[1] - a[1])[0] || [0, 0];
  return kind === 'major' ? `v${major + 1}.0` : `v${major || 1}.${minor + 1}`;
}
async function compileSource() {
  const cli = join(root, 'node_modules', '.bin', 'tailwindcss');
  if (!existsSync(cli) || !existsSync(sourceFilePath('styles.css'))) return;
  await mkdir(join(sourcePath, 'dist'), { recursive: true });
  await exec(cli, ['-i', 'styles.css', '-o', 'dist/editor.css'], { cwd: sourcePath });
}
async function readSourceFiles() {
  return Object.fromEntries(await Promise.all(sourceFiles.map(async (file) => [file, existsSync(sourceFilePath(file)) ? await readFile(sourceFilePath(file), 'utf8') : ''])));
}
async function releaseSource(kind) {
  const files = await readSourceFiles();
  const revision = revisionFor(files);
  const releases = join(sourcePath, '.wds', 'releases');
  await mkdir(releases, { recursive: true });
  const entries = await readdir(releases, { withFileTypes: true });
  const versions = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name.match(/^v(\d+)\.(\d+)$/)).filter(Boolean).map(([, major, minor]) => [Number(major), Number(minor)]);
  const [major, minor] = versions.sort((a, b) => b[0] - a[0] || b[1] - a[1])[0] || [0, 0];
  const version = kind === 'major' ? `v${major + 1}.0` : `v${major || 1}.${minor + 1}`;
  const destination = join(releases, version);
  await mkdir(destination, { recursive: true });
  for (const file of sourceFiles) if (files[file]) await writeFile(join(destination, file), files[file]);
  if (existsSync(join(sourcePath, 'dist', 'editor.css'))) await cp(join(sourcePath, 'dist', 'editor.css'), join(destination, 'styles.css'));
  await writeFile(join(destination, 'manifest.json'), JSON.stringify({ version, revision, files: sourceFiles }, null, 2));
  return { version, revision };
}
async function serveStatic(request, response, pathname) {
  const local = normalize(pathname.replace(/^\//, ''));
  if (local.startsWith('..')) return reply(response, 403, { error: 'Forbidden' });
  try {
    const file = await readFile(join(publicDir, local));
    response.writeHead(200, { 'content-type': contentType(local) });
    response.end(file);
  } catch { reply(response, 404, 'Not found', 'text/plain'); }
}

if (!isMountedSource(sourceTeam, sourceRepo)) {
  await ensureRepo('acme-corp', 'system', baseline);
  await ensureRepo('acme-corp', 'buttons', sample);
}
await compileSource();

createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const parts = url.pathname.split('/').filter(Boolean);
  try {
    if (request.method === 'GET' && url.pathname === '/api/projects') return reply(response, 200, await listRepos());
    if (request.method === 'GET' && parts[0] === 'api' && parts[1] === 'source') {
      const [,, team, repo] = parts;
      if (!valid(team, repo)) return reply(response, 400, { error: 'Invalid project' });
      if (isMountedSource(team, repo)) {
        const files = await readSourceFiles();
        return reply(response, 200, { files, revision: revisionFor(files), sourceMode: 'filesystem' });
      }
      const path = repoPath(team, repo);
      const files = Object.fromEntries(await Promise.all(sourceFiles.map(async (file) => [file, existsSync(join(path, file)) ? await readFile(join(path, file), 'utf8') : ''])));
      return reply(response, 200, { files, revision: (await git(path, ['rev-parse', '--short', 'HEAD'])).stdout.trim(), sourceMode: 'git' });
    }
    if (request.method === 'PUT' && parts[0] === 'api' && parts[1] === 'source') {
      const [,, team, repo] = parts;
      const { files, message = 'Update component source' } = await body(request);
      if (!valid(team, repo) || !files) return reply(response, 400, { error: 'Invalid source' });
      if (isMountedSource(team, repo)) {
        for (const file of sourceFiles) if (typeof files[file] === 'string') await writeFile(sourceFilePath(file), files[file]);
        await compileSource();
        return reply(response, 200, { revision: revisionFor(await readSourceFiles()), sourceMode: 'filesystem' });
      }
      const path = await ensureRepo(team, repo, files);
      for (const file of sourceFiles) if (typeof files[file] === 'string') await writeFile(join(path, file), files[file]);
      await git(path, ['add', '.']);
      const status = (await git(path, ['status', '--porcelain'])).stdout;
      if (status.trim()) await git(path, ['commit', '-m', message]);
      return reply(response, 200, { revision: (await git(path, ['rev-parse', '--short', 'HEAD'])).stdout.trim() });
    }
    if (request.method === 'POST' && parts[0] === 'api' && parts[1] === 'release') {
      const [,, team, repo] = parts;
      const { kind } = await body(request);
      const path = repoPath(team, repo);
      if (!valid(team, repo) || !['major', 'minor'].includes(kind)) return reply(response, 400, { error: 'Invalid release' });
      if (isMountedSource(team, repo)) return reply(response, 201, await releaseSource(kind));
      const version = await nextVersion(path, kind);
      await git(path, ['tag', '-a', version, '-m', `Release ${version}`]);
      return reply(response, 201, { version, revision: (await git(path, ['rev-parse', '--short', 'HEAD'])).stdout.trim() });
    }
    if (request.method === 'GET' && parts[0] === 'static' && parts.length === 5) {
      const [, team, repo, revision, file] = parts;
      const asset = await readRevision(team, repo, revision, file);
      if (asset === null) return reply(response, 404, 'Not found', 'text/plain');
      response.writeHead(200, { 'content-type': contentType(file), 'cache-control': revision === 'latest' ? 'no-store' : 'public, max-age=31536000, immutable' });
      return response.end(asset);
    }
    return serveStatic(request, response, url.pathname === '/' ? '/index.html' : url.pathname);
  } catch (error) {
    console.error(error);
    reply(response, 500, { error: String(error.message || error) });
  }
}).listen(port, () => console.log(`WDS prototype listening on http://localhost:${port}`));
