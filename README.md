# WDS Next Prototype

A local, Git-backed prototype for authoring Li3 HTML components and styleguides.

## Run

```sh
npm start
```

Open `http://localhost:4173`. Repositories are initialized under `data/repos` (or `REPOS_PATH`).

## Implemented slice

- Team/repository source stored in one local Git repo per component or baseline.
- Hand-authored `component.html`, `styles.css`, `buttons.mjs`, `stories.html`, metadata, and Node spec tabs.
- Commit creates a Git commit and updates public `/static/:team/:repo/latest/:file` assets.
- Major/minor releases create immutable Git tags and cacheable static URLs.
- `stories.html` runs in a sandboxed, resizable iframe with breakpoint shortcuts.

## Deliberately deferred

- OIDC login at `https://auth.api.apphor.de/` and the d0 SQLite metadata API.
- Team invitations, role enforcement, imports/dependency manifesting, Tailwind adapter, SSR/jsdom test execution, and AI assistance.
