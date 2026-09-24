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

The initial component source contract is deliberately small:

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

Components may import CSS, Li3 component HTML, ESM modules, or assets from any URL in v1. For example, an authored module may import `markdown-it` directly from a CDN. The future compiler manifest will inventory every discovered dependency, but v1 does not restrict or bundle them.

Baseline repositories use the same approach, normally with this source shape:

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
- Each commit updates the public mutable `latest` artifact.
- A release manually tags the current committed revision.
- Tagged releases are immutable and cannot be deleted or hidden.

Only major and minor releases are supported. The system selects versions from the latest tag:

- Major release: `v2.0`
- Minor release: `v1.2`

No release is created automatically for a new repository. New repositories expose only `latest` until an author releases a tag.

## Public Artifact URLs

Static assets are served by the editor service in v1. They can later move unchanged to `cdn.apphor.de`.

```text
/static/acme-corp/buttons/latest/buttons.html
/static/acme-corp/buttons/latest/buttons.mjs
/static/acme-corp/buttons/latest/buttons.css
/static/acme-corp/buttons/latest/styleguide.html

/static/acme-corp/buttons/v1.5/buttons.html
/static/acme-corp/buttons/v1.5/buttons.mjs
/static/acme-corp/buttons/v1.5/buttons.css
/static/acme-corp/buttons/v1.5/styleguide.html
/static/acme-corp/buttons/v1.5/manifest.json
```

`latest` resolves to the latest committed source and is public with non-cacheable responses. Tagged URLs resolve to immutable Git revisions and can be cached indefinitely.

The component HTML is the consumer entrypoint. The styleguide is a separate generated/public entrypoint that loads the exact same component version. A future `manifest.json` will record the Git commit, tag, compiler version, source asset hashes, and resolved dependency URLs.

## Authentication And Teams

The production service will integrate OIDC with `https://auth.api.apphor.de/`, which supports authorization-code flow with PKCE and RS256 identity tokens.

- Any authenticated user can create a team.
- A team owns all its baseline and component repositories.
- Team members have equal v1 permissions: create/delete repositories, commit, release, and create invitations.
- Invitations are shared as copyable, single-use links. The service does not send email or messages.

The prototype currently has no authentication or authorization enforcement.

## Persistence And Runtime

Source repositories live on a Docker-mounted path under `/data`. The application currently defaults to `data/repos` locally; set `REPOS_PATH` to use a mounted production path.

The planned metadata store is the d0 SQLite API at `https://wds-test.db.apphor.de/api`. It will own users, teams, invitations, repository records, sessions, releases, build records, and public share metadata. Git remains the authoritative source and revision store.

S3-compatible object storage is not required in v1. It becomes useful only when artifacts need independent CDN delivery, replication, or storage separated from the editor deployment.

## Testing

Each repository starts with one `spec.mjs`. Specs use Node built-ins such as `node:test` and `node:assert`.

The intended next test runner mounts the committed source in WebContainer and runs specs in the browser. `@li3/ssr` plus `jsdom` will make Li3 component rendering testable from Node without adding a full browser test framework. Browser integration tests can be added after that with a native browser test page or Playwright.

## CSS Compilation

Tailwind is an optional future compiler adapter, not the component model. The v1 prototype publishes authored CSS and explicitly declared CSS imports unchanged. If added, Tailwind 4 should use its CSS-first `@import` and `@theme` model with no arbitrary plugins initially.

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

- Dark three-pane editor shell with project registry, source tabs, design inspector, and live styleguide canvas.
- Topbar, registry, studio, editor tabs, inspector, preview, action button, panel, viewport control, and workbench components are independently authored in the mounted design-system source.
- Local Git repository creation for sample `acme-corp/system` and `acme-corp/buttons` repositories.
- Commit-to-`latest` source updates and Git tag creation for major/minor releases.
- Public static component/styleguide asset serving.
- Li3 sample component with explicit baseline CSS and separate ESM setup module.
- Mounted component source is compiled through the Tailwind 4 CLI with minified output served as `styles.css`.
- Resizable preview width and breakpoint shortcuts.
- Production Docker build and HTTP smoke test.

Deferred:

- OIDC sessions, d0 persistence, teams, and single-use invitation links.
- Dependency graph/manifest generation and release artifact copying.
- Tailwind 4 adapter.
- WebContainer, Li3 SSR/jsdom spec execution, and browser test reporting.
- Separate preview origin and production sandbox policy.
- AI assistance and GitHub export.
