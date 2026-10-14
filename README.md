# Web Design System Editor

An HTML-first component workbench for authoring, testing, versioning, and publishing Li3 web components. It combines a lightweight design tool, Storybook-style component laboratory, Git-backed revision history, and CDN-style static releases.

The application is intended to run at `https://wds.apphor.de`.

## Product Model

A team owns independent repositories. A repository is either:

- A baseline design system, which owns shared tokens, CSS, assets, and optional reusable components.
- A self-contained component, which owns its markup, styles, behavior, stories, and tests.

There is one Git repository per baseline or component. Git is an internal storage implementation, not an external user-facing Git hosting product.

Teams use GitHub-style lowercase slugs, such as `acme-corp/buttons`. The custom-element name is stored separately in `component.json` and must satisfy the Web Components naming rules.

## Source Format

The initial component scaffold is deliberately small:

```text
component.html
styles.css
buttons.mjs
stories.html
component.json
spec.mjs
```

`component.json` contains only the component name and description. Dependencies remain in the source files where browsers and authors can inspect them directly.

```json
{
  "name": "acme-button",
  "description": "A reusable primary action control."
}
```

Components are Li3 HTML files. They may use templates, custom elements, Shadow DOM, slots, props, events, adopted stylesheets, and setup modules.

```html
<template component="acme-button" shadow-dom="open">
  <link rel="stylesheet" href="/static/acme-corp/system/v1.2/styles.css" />
  <link rel="stylesheet" href="./buttons.css" />

  <button class="button" type="button" on-click="press()">
    <slot>Button</slot>
  </button>

  <script setup src="./buttons.mjs"></script>
</template>
```

The baseline version is explicit in the CSS link or CSS `@import`, never hidden in metadata. This prevents a baseline change from silently altering a released component.

Components may import external CSS, Li3 component HTML, ESM modules, or assets by absolute URL. Relative styles, modules, and assets are allowed only within that component's own repository; WDS validates these paths and rejects imports that escape the component boundary, including symlink traversal. A dependency on another WDS component must use its absolute published URL, for example `/static/acme-corp/icons/latest/component.html`.

The editor discovers supported project files from that repository on each request instead of relying on a server-side filename list. Nested HTML, CSS, JavaScript, JSON, and SVG source files are editable; supported images and fonts are served as assets. Discovery never follows symlinks and excludes hidden paths, Git metadata, generated output, dependencies, and release internals. Static asset requests are confined to the selected repository and revision.

Design-system repositories use the same Git-backed source model but are not components. They hold shared token/value files (for example `tokens.css` or `colors.css`), are published as standalone assets, and are not passed through the component CSS compiler or added to a component's build output. Components reference these files through absolute published URLs such as `/static/acme-corp/foundation/latest/tokens.css`.

The Workbench's component stylesheets reference `/static/web-design-system/foundation/latest/styles.css`. That shared project must be created and published before the Workbench's shared tokens/utilities are available. Other systems can choose their own baseline repository and URL.

Baseline repositories use this source shape:

```text
styles.css
tokens.css
stories.html
component.json
spec.mjs
```

## Stories And Preview

`stories.html` is handcrafted Li3 markup. It is the canonical styleguide source and can use `<script state>` and ordinary Li3 behavior to exercise variants and interaction states.

The editor renders stories in a resizable, sandboxed iframe. The preview width can be changed continuously and with breakpoint markers. The initial markers are Tailwind-style defaults:

- `sm`: 640px
- `md`: 768px
- `lg`: 1024px

The editor’s visual direction is a compact, dark, technical three-pane workspace inspired by VoidExplorer Shipyard: project registry, source workspace, design inspector, persistent status, and a live preview canvas.

Components are allowed full browser capabilities in v1, including remote imports and network access. Before production use beyond the initial tester, the preview must move to a distinct origin and receive a restrictive CSP/permission policy.

## Revisions And Releases

All authors work on `main`; branches, pull requests, locks, and real-time collaborative editing are out of scope for v1. The initial multi-user policy is last-write-wins.

- Unsaved editor state is private and is never published.
- A commit creates a Git revision on `main`.
- A commit updates only editable source; it never changes public output.
- **Publish latest** builds the committed source and updates the public mutable `latest` artifact.
- A release builds the committed source, publishes an immutable versioned artifact, and tags its source revision.
- Tagged releases are immutable and cannot be deleted or hidden.

Only major and minor releases are supported. The system selects versions from the latest tag:

- Major release: `v2.0`
- Minor release: `v1.2`

No release is created automatically for a new repository. An author must publish once before `latest` is available; a versioned artifact is available after a release.

## Creating A Design System

An authenticated, allowlisted editor can use **New design system** in the workbench to create a project without leaving the interface. The team field is a Git organization slug; the repository field is a lowercase project slug. WDS creates the organization when needed, creates the Git repository, and pushes a first `main` commit containing a shared `styles.css` plus project metadata. A design-system repository is not a component: it has no component markup, story, or spec. Its stylesheet can hold versioned design tokens shared by components.

For example, a component may import a released token stylesheet with `@import url("/static/acme-corp/foundation/v1.0/styles.css");`. This is an explicit public versioned asset reference; relative imports stay inside the current component repository and cannot traverse into sibling repositories or server files.

The new project is selected in the workbench immediately, with only its shared stylesheet available in the source editor. Commit saves source; **Publish latest** makes the shared files available at their public URLs. The design-system file is served as authored and is not compiled into a component stylesheet. Release creates an immutable versioned artifact. The configured Git API token must have permission to create organizations and repositories for the selected team, as well as read and write Git data.

## Public Artifact URLs

Static assets are served by the editor service in v1. They can later move unchanged to `cdn.apphor.de`.

```text
/static/acme-corp/buttons/latest/component.html
/static/acme-corp/buttons/latest/styles.css
/static/acme-corp/buttons/latest/stories.html

/static/acme-corp/buttons/v1.5/component.html
/static/acme-corp/buttons/v1.5/styles.css
/static/acme-corp/buttons/v1.5/stories.html
/static/acme-corp/buttons/v1.5/manifest.json
```

`latest` resolves only to the most recently published build and is public with non-cacheable responses. A source commit does not change it. Versioned URLs resolve only to published immutable artifacts and can be cached indefinitely. A missing artifact returns 404; static routes never fall back to editable source.

Git stores published output on the `wds-artifacts` branch, separate from editable `main` source. Mounted projects persist output under `.wds/artifacts`. Both use the same artifact-only static URL contract.

The component HTML is the consumer entrypoint. `stories.html` is published with the same artifact and can be used as the styleguide. Each artifact's `manifest.json` records its source revision, project type, and published file inventory.

## Authentication And Teams

The service uses OIDC authorization-code flow with PKCE through `https://auth.api.apphor.de/` in production. Editor APIs require an authenticated OIDC session and an explicit subject allowlist. Team membership, per-team authorization, repository deletion, and invitations are not implemented yet.

The landing page at `/` lists design systems and teams returned through the configured Git API connection. Opening a design system navigates to `/?team=<team>&repo=<repo>`, where the Workbench is currently an intentionally blank workspace shell with the account control in its header. The Git API currently supplies organizations visible to the configured service token; WDS cannot yet distinguish organizations personally owned by the signed-in user from other organizations available to that token. `/api/teams` exposes that organization list to authenticated, allowlisted editors.

## Persistence And Runtime

Git-managed repositories are stored by the configured Git API. Set `GIT_API_URL` to its base URL and `GIT_API_TOKEN` to an opaque OIDC access token with repository read/write scopes. The application lists organizations and repositories through the API and reads/writes repository history over Smart HTTP. Git credentials are supplied through a temporary askpass helper and environment variable, never embedded in remote URLs or command arguments. Git operations fail clearly when the API URL or token is missing; no local Git fallback is used. Application-created commits use `GIT_AUTHOR_NAME` and `GIT_AUTHOR_EMAIL` when set, defaulting to `Design System` and `system@wds.local`. A private per-process clone cache is kept under the system temporary directory and removed on exit.

Before enabling repository APIs, configure `OIDC_ISSUER` (production: `https://auth.api.apphor.de`), `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` (when using a confidential client), and `WDS_ALLOWED_SUBJECTS` (comma-separated OIDC `sub` values). By default, the callback URI is `https://<OIDC_CLIENT_ID>/auth/callback`; set `OIDC_REDIRECT_URI` only when the registered callback differs. The callback URI must be registered with the OIDC client. Start sign-in at `/api/oidc/login` and sign out at `/api/oidc/logout`. Project listing, source reads/writes, releases, and test execution require a signed-in, allowlisted user. Static artifacts remain public. All allowlisted users share the permissions of the configured Git API token; do not allowlist untrusted users until per-team authorization is implemented. Spec execution is disabled by default. `WDS_ENABLE_UNSANDBOXED_SPECS=true` opts into running specs with Node.js as the application account, with the environment secrets removed and a 30-second timeout; filesystem and network access are not sandboxed, so enable it only for trusted code or an isolated deployment.

Existing repositories under the former local `data/repos` or `REPOS_PATH` storage are not automatically imported. Keep those directories as backups and migrate their Git history to the API before switching users over.

The mounted source remains filesystem-backed and bypasses remote Git storage, including its compile/release behavior. Configure `SOURCE_TEAM` and `SOURCE_TEAM_PATH` together to enable it; neither has a built-in path or team-name default.

The planned metadata store is the d0 SQLite API at `https://wds-test.db.apphor.de/api`. It will own users, teams, invitations, repository records, sessions, releases, build records, and public share metadata. Git remains the authoritative source and revision store.

S3-compatible object storage is not required in v1. It becomes useful only when artifacts need independent CDN delivery, replication, or storage separated from the editor deployment.

## Testing

Each repository starts with one `spec.mjs`. Specs use Node built-ins such as `node:test` and `node:assert`.

The intended next test runner mounts the committed source in WebContainer and runs specs in the browser. `@li3/ssr` plus `jsdom` will make Li3 component rendering testable from Node without adding a full browser test framework. Browser integration tests can be added after that with a native browser test page or Playwright.

## CSS Compilation

Component CSS is compiled with Tailwind 4 when published. Absolute published design-system URLs are retained as external CSS imports; design-system projects are published unchanged and are not compiled. Tailwind uses the CSS-first `@import` and `@theme` model with no arbitrary plugins initially.

## AI Assistance

AI is a phase-two authoring tool, not a central runtime dependency. It may later scaffold Li3 components and stories or propose focused source edits after the editor interaction model is established.

## Development

The workbench UI is composed from Li3 components loaded from the mounted design-system source. pnpm is used for dependency operations and the production image retains only production dependencies.

```sh
pnpm start
```

Open `http://localhost:4173`. Set `PORT` to change the listening port.

## Container

The Docker image uses `ghcr.io/cloud-cli/image-node:latest`. That base image launches `npm start` from `/home/app`, so the Dockerfile copies the project there and keeps its unprivileged `node` runtime user.

```sh
docker build -t web-design-system-editor:local .
docker run --rm -p 4173:4173 -e PORT=4173 web-design-system-editor:local
```

Mount `/data` in deployment so authored Git repositories persist across containers.

## Prototype Status

Implemented now:

- Multi-team landing page with team filters and design-system cards; opened systems currently show a blank workbench shell.
- Individual topbar, registry, studio, editor tabs, inspector, preview, action button, panel, viewport control, and workbench components remain independently authored in design-system source for gradual reintroduction.
- Git API-backed source commits, explicit publication to mutable `latest`, and immutable major/minor releases.
- Public static serving from published artifacts only; source commits do not change public output.
- Component CSS compilation during publish; design-system styles are published separately without component compilation.
- Per-request source discovery and repository-boundary validation for relative imports/assets.
- Li3 sample component with explicit baseline CSS and separate ESM setup module.
- Published component stylesheets are compiled through the Tailwind 4 CLI and served as `styles.css`.
- Resizable preview width and breakpoint shortcuts.
- Production Docker build and HTTP smoke test.

Deferred:

- OIDC sessions, d0 persistence, teams, and single-use invitation links.
- Dependency graph/manifest generation and release artifact copying.
- Tailwind 4 adapter.
- WebContainer, Li3 SSR/jsdom spec execution, and browser test reporting.
- Separate preview origin and production sandbox policy.
- AI assistance and GitHub export.
