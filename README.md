# Web Design System Editor

An HTML-first workbench for authoring, versioning, and publishing Li3 web components. The product goal is a lightweight Design/Code studio with Git-backed history and static releases; the current preview is deliberately more limited than a full Storybook-style component laboratory.

The application is intended to run at `https://wds.apphor.de`.

For the current product goals, architecture/design decisions, implementation summary, and known feature gaps, see [the project overview](docs/project-overview.md).

## Product Model

A WDS team is a metadata entity and may own several design systems. Each design system owns a Git organization with a reserved `foundation` repository; its components are repositories in that organization. A WDS repository contains either:

- A design system's `foundation` repository, which owns required shared tokens and styles.
- A self-contained component, which owns its markup, styles, behavior, stories, and tests.

There is one Git repository per component, plus one reserved `foundation` repository per design system. Git is an internal storage implementation, not an external user-facing Git hosting product. WDS team slugs and Git organization slugs are distinct identifiers.

WDS validates team slugs, design-system slugs, and Git organization/repository coordinates as lowercase safe path segments. The custom-element name is stored separately in `component.json` and must satisfy the Web Components naming rules.

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

`component.json` contains the component name, description, and a required `designSystem: { "team", "repo", "revision" }` dependency. Revision is `latest` or an immutable `vN.N` release.

```json
{
  "name": "acme-button",
  "description": "A reusable primary action control.",
  "designSystem": { "team": "acme-corp", "repo": "foundation", "revision": "v1.2" }
}
```

Components are Li3 HTML files. They may use templates, custom elements, Shadow DOM, slots, props, events, adopted stylesheets, and setup modules.

```html
<template component="acme-button" shadow-dom="open">
  <link rel="stylesheet" href="/static/acme-corp/foundation/v1.2/tokens.css" />
  <link rel="stylesheet" href="./buttons.css" />

  <button class="button" type="button" on-click="press()">
    <slot>Button</slot>
  </button>

  <script setup src="./buttons.mjs"></script>
</template>
```

Design systems own and publish `tokens.css` as their central token contract. It documents color, spacing, and breakpoint custom properties and may include Tailwind v4 `@theme` definitions. `styles.css` may import `./tokens.css` for compatibility. Components must import exactly `/static/<team>/<repo>/<revision>/tokens.css`, matching their metadata; `@import "tailwindcss"` is permitted as the local build directive. Other external CSS imports are rejected. Publish the design system first. Existing components must be migrated by adding the dependency metadata, adding the exact token import, and publishing only after the selected revision has published `tokens.css`.

Component stylesheets may use only their declared design system's published `tokens.css` as a cross-repository CSS import; arbitrary external CSS imports are rejected. Relative styles, modules, and assets are allowed only within that component's own repository; WDS validates these paths and rejects imports that escape the component boundary, including symlink traversal. Other WDS components can be referenced as published assets through their absolute URL, for example `/static/acme-corp/icons/latest/component.html`; this does not permit importing arbitrary component CSS.

The editor discovers supported project files from that repository on each request instead of relying on a server-side filename list. Nested HTML, CSS, JavaScript, JSON, and SVG source files are editable; supported images and fonts are served as assets. Discovery never follows symlinks and excludes hidden paths, Git metadata, generated output, dependencies, and release internals. Static asset requests are confined to the selected repository and revision.

Design-system repositories use the same Git-backed source model but are not components. They hold shared token/value files (for example `tokens.css` or `colors.css`), are published as standalone assets, and are not passed through the component CSS compiler or added to a component's build output. Components reference these files through absolute published URLs such as `/static/acme-corp/foundation/latest/tokens.css`.

The Workbench's component stylesheets reference `/static/web-design-system/foundation/latest/tokens.css`. That shared project must be created and published before the Workbench's shared tokens/utilities are available. Other design systems use their own `foundation` repository and token URL.

Foundation repositories use this source shape:

```text
styles.css
tokens.css
stories.html
component.json
spec.mjs
```

## Stories And Preview

`stories.html` is handcrafted Li3 markup. It is the canonical styleguide source and can use `<script state>` and ordinary Li3 behavior to exercise variants and interaction states.

`stories.html` is retained as component source and is published, but the current studio does not render a story gallery. The Design surface renders a limited draft of `component.html` in a sandboxed iframe; scripts, stylesheet links, and inline event handlers are removed. Preview width is adjustable, but breakpoint markers and full Li3 runtime behavior are not currently implemented.

The component studio follows the dark zinc/blue design concept: a layer tree, dotted canvas with zoom and adjustable width, and a Design/Code inspector. Select elements in the tree or canvas to edit layout, spacing, colors, effects, and classes. Property controls write inline CSS to the canonical HTML draft; class editing and the source editor share that same draft. Save Component commits source; Publish remains a separate action. Preview hides editing panels and selection outlines; it does not execute component scripts. The draft includes local styles.css and a limited utility preview, not the full published Tailwind build.

## Navigation and Account

The workspace is organized as **Team → Design System → Component**. Selecting a team shows its design systems in the sidebar; selecting a design system shows its components and a link back to the team's systems. Selecting a component opens the editor, where the sidebar keeps sibling components available and links back to the system. The editor topbar shows the WDS mark and the current `design-system / component` path. On small screens, the editor sidebar opens from a menu button and closes from its overlay, Escape, or a navigation link; it stays visible from the `sm` breakpoint upward. When an account has no teams, WDS shows a first-team landing state without the sidebar; creating a team reveals the regular navigation.

The account card uses the OIDC profile name, email, and photo. Agent profiles show an `Ag` avatar and the Agent name without an email address.

The draft preview does not run component scripts. Published components are intended for browser consumption, but broader untrusted author access still requires a separate-origin full-runtime preview and restrictive deployment policy.

## Revisions And Releases

All authors work on `main`; branches, pull requests, locks, and real-time collaborative editing are out of scope for v1. Source commits use atomic compare-and-swap against the full `baseRef`; concurrent stale writes conflict instead of silently overwriting newer source.

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

An authenticated, allowlisted editor creates WDS teams as metadata records, then creates design systems under a selected team. Each design system gets a Git organization and a reserved `foundation` repository with `design-system.json`, `tokens.css`, and `styles.css`. Components are created only inside that system organization and use the foundation token URL as their required dependency. The component name is the only required component-creation field; WDS derives the repository slug.

For example, a component may import a released token stylesheet with `@import url("/static/acme-corp/foundation/v1.0/tokens.css");`. This is an explicit public versioned asset reference; relative imports stay inside the current component repository and cannot traverse into sibling repositories or server files.

The Foundation studio provides a file navigator for all returned source files, including `tokens.css`, `styles.css`, and metadata. Drafts are retained when switching files. **Save Foundation** commits source; **Publish latest** makes the shared files available at their public URLs. The design-system files are served as authored and are not compiled into a component stylesheet. The server supports immutable versioned releases, but the studio does not yet expose release creation. The configured Git API token must have permission to create organizations and repositories for the selected team, as well as read and write Git data.

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

The landing page reads metadata teams and design systems directly from d0. `GET /api/teams` returns teams with nested design systems; `POST /api/teams` creates metadata only. `GET/POST /api/design-systems` lists or creates organization-backed systems. Read-only project inventory, source, history, and static artifact requests use GitMini REST; legacy seeding controlled by `WDS_LEGACY_GIT_MIGRATION=true` also uses REST and never clones. Legacy repositories remain at their original `/static/<org>/<repo>/...` paths and are not automatically moved. Team membership and team-scoped authorization are not implemented; all allowlisted users share permissions of the configured Git API token.

## Persistence And Runtime

Git-managed repositories are stored by the configured Git API. Set `GIT_API_URL` to its base URL and `GIT_API_TOKEN` to an opaque OIDC access token with repository read/write scopes; design-system provisioning also requires `org:create`. WDS uses GitMini REST for inventory, immutable-ref source reads, history, file existence, commits, and tags; it never clones, fetches, or pushes repositories and keeps no repository cache. Source writes use atomic compare-and-swap commits on `main` and require the full source `baseRef` returned by `GET /api/source`. Publishing reads the exact source commit through REST, compiles in a disposable non-repository staging directory, and atomically updates the `wds-artifacts` branch; `latest` is mutable and release artifacts remain immutable. Optional specs are fetched by REST into an isolated temporary test directory and execute only when `WDS_ENABLE_UNSANDBOXED_SPECS=true`; enable this only for trusted repositories. Temporary staging files are not Git checkouts and are removed after each operation. Git API errors are returned clearly; no local Git fallback is used.

The foundation and component source editors load the `code-editor` component from `https://sodium.static.apphor.de/code-editor.html`. It runs with the `@li3/web` runtime from `https://cdn.li3.dev` and loads Highlight.js and editor styling from public CDNs. If loading fails, a local plain-text editor keeps source editing available and identifies itself in the editor status bar.

Before enabling repository APIs, configure `OIDC_ISSUER` (production: `https://auth.api.apphor.de`), `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` (when using a confidential client), and `WDS_ALLOWED_SUBJECTS` (comma-separated OIDC `sub` values). The default callback URI is constructed from the request `Host` and `X-Forwarded-Proto` headers with the `/auth/callback` path; set `OIDC_REDIRECT_URI` only if the registered callback differs. The callback URI must be registered with the OIDC client. Start sign-in at `/api/oidc/login` and sign out at `/api/oidc/logout`. Project listing, source reads/writes, releases, and test execution require a signed-in, allowlisted user. Static artifacts remain public. All allowlisted users share the permissions of the configured Git API token; do not allowlist untrusted users until per-team authorization is implemented. Spec execution is disabled by default. `WDS_ENABLE_UNSANDBOXED_SPECS=true` opts into running specs with Node.js as the application account, with the environment secrets removed and a 30-second timeout; filesystem and network access are not sandboxed, so enable it only for trusted code or an isolated deployment.

Existing repositories under the former local `data/repos` or `REPOS_PATH` storage are not automatically imported. Keep those directories as backups and migrate their Git history to the API before switching users over.

The mounted source remains filesystem-backed and bypasses remote Git storage, including its compile/release behavior. Configure `SOURCE_TEAM` and `SOURCE_TEAM_PATH` together to enable it; neither has a built-in path or team-name default.

The metadata store is the d0 SQLite API configured by `DATABASE_URL` (production requires HTTPS); an optional `DB_AUTH_TOKEN` or `DATABASE_TOKEN` is sent as a Bearer credential. It currently owns WDS teams and design-system mappings. Git remains authoritative for source, history, and artifact revisions. A WDS team is metadata only and may own several design systems; each new design system is a Git organization with a reserved `foundation` repository. Components are repositories in that organization and refer to `/static/<git-org>/foundation/<revision>/tokens.css`. Existing Git organization/repository URLs are unchanged. Readable legacy design-system repositories are surfaced as legacy mappings and are not moved or rewritten; inaccessible repositories are skipped. Team/system metadata endpoints return 503 if the metadata database is not configured or unavailable.

Set `WDS_PERF_DEBUG=true` to emit structured `[wds-perf]` timing records for each HTTP request, d0 metadata query, Git API call, Git inventory scan, and legacy-system seed. Without it, operations at or above `WDS_PERF_SLOW_MS` (default `250`) are logged. Timing records never include credentials, database bindings, or Git organization/repository names. API responses also include an `Server-Timing: app` duration for browser network inspection.

S3-compatible object storage is not required in v1. It becomes useful only when artifacts need independent CDN delivery, replication, or storage separated from the editor deployment.

## Testing

Repositories may include `spec.mjs`, which can use Node built-ins such as `node:test` and `node:assert`. Optional server-side execution is disabled by default; when explicitly enabled it runs trusted specs with Node.js and is not sandboxed. There is no in-workbench spec runner/report UI or browser test runner yet. The product and architecture gaps are tracked in the [project overview](docs/project-overview.md).

## CSS Compilation

Component CSS is compiled with Tailwind 4 when published. Absolute published design-system URLs are retained as external CSS imports; design-system projects are published unchanged and are not compiled. Tailwind uses the CSS-first `@import` and `@theme` model with no arbitrary plugins initially.

## AI Assistance

AI is a phase-two authoring tool, not a central runtime dependency. It may later scaffold Li3 components and stories or propose focused source edits after the editor interaction model is established.

## Development

The application UI is served from `public/`. The code editor is loaded at runtime from sodium and uses its public CDN runtime/assets; see the [project overview](docs/project-overview.md) for availability and supply-chain tradeoffs. pnpm is used for dependency operations and the production image retains only production dependencies.

```sh
pnpm start
```

Open `http://localhost:4173`. Set `PORT` to change the listening port.

Run `pnpm test` for server/source checks and `pnpm exec playwright test` for the studio browser checks (install Chromium with `pnpm exec playwright install chromium` if needed). Browser tests isolate API responses and the remote code-editor loader, and cover layer edits, preserved files, saving, publishing, tabs, zoom, and preview at desktop, tablet, and mobile widths.

## Container

The Docker image uses `ghcr.io/cloud-cli/image-node:latest`. That base image launches `npm start` from `/home/app`, so the Dockerfile copies the project there and keeps its unprivileged `node` runtime user.

```sh
docker build -t web-design-system-editor:local .
docker run --rm -p 4173:4173 -e PORT=4173 web-design-system-editor:local
```

Mount `/data` in deployment so authored Git repositories persist across containers.

## Authoring workbench

All pages share the studio’s dark zinc/blue visual language. Workspace navigation follows **team → design system → Foundation and components**. The team sidebar scopes the system inventory; selecting a system opens an overview of its Foundation and component repositories. Creation forms open in focused dialogs. Breadcrumbs and repository links connect the overview, Foundation editor, and component studio.

The landing and system views use searchable, compact rows rather than descriptive cards. On mobile, the team switcher collapses into one row so repositories remain visible without scrolling through navigation. Foundation publication status appears inline, with additional guidance only when publication blocks component creation.

Signed-out visitors see a separate welcome page with one sign-in action, not an empty workspace. To verify the deployed welcome and real OIDC journey, run `WDS_LAB_SMOKE=true pnpm exec playwright test test/welcome.lab.browser.spec.mjs` with `AUTH_LAB_KEY` provided through the environment. It uses the existing lab OIDC client, checks mobile/desktop welcome, PKCE sign-in, authenticated team/system access, and logout, and closes both sessions. It creates no persistent test data. These live checks are skipped by default.

- `/`: all design systems, grouped through the team sidebar.
- `/?teamSlug=<team>`: one metadata team’s systems (the team may own several Git organizations).
- `/?system=<git-org>`: a design system overview and component creation, unlocked by published Foundation tokens.
- `/?team=<git-org>&repo=<repo>`: the Foundation or component repository editor; existing links remain supported.

Sign in, create/select a WDS team, then create/select a design system and add components from its workbench. Components are repositories in the design-system Git organization and import `/static/<org>/foundation/latest/tokens.css`. Component source commits update Git `main`; publishing is a separate explicit action that updates public `latest` artifacts. Project workspace routes use Git organization/repository coordinates in their `team` and `repo` query parameters; these are not WDS team slugs.
