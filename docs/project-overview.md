# WDS project overview

This document is the product and architecture overview for the Web Design System (WDS) workbench. It records the goals, decisions reflected in the current implementation, and known gaps so roadmap discussions do not confuse intended behavior with shipped behavior. Deployment-specific state is intentionally not asserted here.

## Product goals

WDS aims to provide a team-shared workflow for creating and maintaining design systems and reusable Li3 web components:

1. Let an authenticated team create a design system, author its design tokens, and publish a stable dependency for component projects.
2. Let component authors move between a minimal visual Design surface and a source Code editor without losing a single canonical source of truth.
3. Keep commits, mutable publication, and immutable releases as explicit, distinct actions.
4. Make published component and design-system assets consumable through predictable static URLs.
5. Keep Git-backed source/history authoritative while WDS coordinates authoring, validation, compilation, and publishing.
6. Support more than one WDS team without making a WDS team synonymous with a Git organization.
7. Keep the initial studio small and practical; advanced collaboration, general-purpose visual design, AI, and external Git hosting workflows are not prerequisites for v1.

## Domain model

- A **WDS team** is a metadata entity stored in the d0 database. It is not a Git organization.
- A **design system** belongs to one WDS team and owns a Git organization. Its reserved `foundation` repository is the canonical source for `tokens.css` and shared styles.
- A **component** belongs to a design system's Git organization and is stored in its own repository. The component name is the only required input when creating one; WDS derives its repository slug.
- A component's `component.json` declares its design-system dependency. Published `tokens.css` is required before components can be created/published against that system.
- Git organizations and repository names remain separate from WDS team slugs. Existing Git organization/repository artifact URLs are not rewritten by this model.

## User workflows

### Design-system foundation

Create a WDS team, create a design system for it, and provision the design system's Git organization and `foundation` repository. Edit `tokens.css`, commit the source, then publish it. Commit does not update public assets; publishing updates the mutable `latest` token artifact. Component creation remains locked until the published token artifact is available.

The Foundation studio edits all returned source files, including tokens, shared styles, and metadata, retaining drafts across file switches. A design-system overview separates the Foundation repository from component repositories. Team-scoped navigation and breadcrumbs reflect the metadata-team → Git-organization → repository hierarchy.

### Component authoring

Open a component project and edit its discovered source files in Code mode, or use the Design mode for a bounded preview and a small set of utility-class adjustments. The current preview removes scripts, stylesheet links, and inline event attributes; it is not a full Li3 runtime or story runner. Commit saves the current source revision. Publish builds the committed revision and updates `latest` separately.

The navigation follows **Team → Design System → Component**: choosing a team lists its systems in the sidebar; choosing a system lists its components; choosing a component opens the editor while keeping sibling components available. The editor topbar shows the WDS mark and `design-system / component`. Its sidebar remains visible at the `sm` breakpoint and above; on smaller screens it opens as an overlay drawer. An account with no teams sees a first-team landing state without the sidebar. The OIDC account card shows profile name, email, and photo; Agent profiles use an `Ag` avatar and omit email.

The Code editor component is loaded from `sodium.static.apphor.de`; its runtime and assets use public CDNs. This keeps the editor dependency external to the app bundle, but makes authoring dependent on those hosts and on their code remaining trustworthy.

### Public consumption and releases

- `/static/<git-org>/<repo>/latest/...` serves the latest explicitly published artifact and is not long-term cacheable.
- `/static/<git-org>/<repo>/vN.N/...` serves an immutable release artifact and is cacheable indefinitely.
- Static routes never serve uncommitted source as a fallback.
- Release creation is supported by the server API, but is not currently exposed as a control in the studio UI.

## Architecture and design decisions

### Data ownership

- d0 SQLite metadata owns WDS teams and design-system-to-team mappings.
- GitMini REST owns repository source, commit history, refs, tags, and published artifacts. Git is an internal source/history mechanism, not a user-facing hosting workflow.
- Mounted filesystem source is a compatibility/development mode. It bypasses remote Git behavior and does not have all remote compile/release semantics.
- Static artifacts are served by the WDS service in v1. Independent S3/CDN delivery may be considered if delivery or replication needs justify it.

### Source operations and publication

- WDS does not clone repositories or maintain repository checkouts/caches. Remote reads, history, commits, and tags use GitMini REST.
- Source writes use full `baseRef` optimistic concurrency and atomic compare-and-swap on `main`. Stale writes conflict rather than silently overwriting another author's commit.
- Publishing reads the exact committed source revision and compiles in a disposable temporary staging directory. Staging is not a repository checkout and is removed after the operation.
- `main` contains editable source; the `wds-artifacts` branch stores published output. `latest` is mutable; versioned releases are immutable and target explicit source revisions.
- Commit, publish-latest, and release are deliberately separate operations. Publishing does not implicitly commit editor state.
- Design-system `tokens.css` is a required published dependency. Component styles may use their own relative files and the declared system's published token stylesheet; cross-repository traversal and arbitrary external CSS imports are rejected.

### Security and trust boundaries

- Editor APIs require an OIDC session and allowlisted subject. All allowed users currently act through the configured Git API token; WDS does not yet enforce team membership or per-team permissions.
- Published artifacts are public. Do not allowlist untrusted users while authorization is shared this way.
- The in-studio draft preview is an empty-sandbox iframe and intentionally does not run component scripts or inline handlers. It is a limited visual aid, not a safe execution environment for a complete component runtime.
- Optional `spec.mjs` execution is disabled by default. Enabling `WDS_ENABLE_UNSANDBOXED_SPECS=true` runs trusted repository code with Node.js, without filesystem/network sandboxing; use only in an isolated environment or for trusted sources.
- The editor UI loads executable third-party editor/runtime code and public CDN assets in the app page. Pinning/vendoring reviewed dependencies would reduce supply-chain and availability exposure; this is not the current implementation.

### Collaboration and scope

- Authors share `main`; branches, pull requests, real-time co-editing, locks, and merge tooling are out of scope for v1.
- The current conflict model returns a conflict for stale writes; it is not an automatic merge or last-write-wins system.
- The studio is a minimal authoring surface, not a general-purpose page builder or full Storybook replacement.
- AI authoring and GitHub export are future possibilities, not runtime dependencies or v1 requirements.

## Current implementation

- OIDC authorization-code flow with PKCE, subject allowlist, authenticated project APIs, and sign-in/out UI.
- d0-backed team and design-system metadata; organization-backed design systems with a reserved foundation repository.
- GitMini REST source reads, history, atomic commits, tags, and artifact updates without WDS repository clones.
- Dynamic supported-source discovery and repository-boundary validation for relative imports/assets.
- Foundation token editing, commit/publish controls, and a published-token gate for component creation.
- Component Code/Design modes, discovered-file selection, history, commit/publish controls, width-adjustable draft preview, and limited utility editing.
- Hierarchical Team → Design System → Component navigation, responsive editor sidebar, first-team empty state, and OIDC/Agent account-card variants.
- Component CSS compilation at publish time; design-system files publish unchanged.
- Mutable `latest`, immutable versioned artifacts, release tagging, and public static routes.
- Integration coverage for authentication, metadata/repository workflows, compare-and-swap conflicts, publication, releases, artifact handling, and REST-only behavior.

## Known gaps and missing features

These describe current product limitations, not promises or committed delivery dates.

### Authorization and team management

- Team membership, roles, invitations, and per-team authorization are absent; all allowlisted users share the configured Git API permissions.
- Team/system membership administration, repository deletion, and ownership transfer are not available as complete user workflows.

### Authoring experience

- The Design surface is intentionally basic: one editable template target and a fixed set of utility controls, rather than arbitrary visual layout editing.
- The draft preview does not execute setup modules, event handlers, or stories. It does not reproduce the full published Li3 runtime.
- There is no breakpoint-marker workflow, full story gallery, component dependency browser/graph, or integrated visual regression workflow.
- Foundation file creation, renaming, and deletion are not exposed in the studio; existing source files are editable.
- Some supported repository files can be selected in Code mode, but the UI does not provide a full file creation/rename/delete manager.
- Versioned release creation is available in the backend but missing from the author-facing studio controls.
- Conflict detection exists, but merge/rebase support and multi-author live collaboration do not.

### Testing and isolation

- There is no in-workbench spec runner, sandboxed WebContainer runner, or browser test report UI. Optional server-side Node specs are unsandboxed and therefore opt-in for trusted code only.
- The app has backend/integration, source-level UI, and Playwright browser regression tests for navigation, responsive layout, and core editor flows. There is no integrated visual-regression workflow or browser test report UI.
- A separate-origin preview with a restrictive deployment policy remains a production-hardening requirement before broader untrusted author access. The current local draft preview is restricted, but does not provide a separate-origin full-runtime preview.
- Remote code-editor/runtime/CDN dependencies are not vendored or integrity-pinned by WDS.

### Operations and ecosystem

- Published artifacts are served by the editor service; independent CDN/S3-compatible artifact storage is not implemented.
- AI-assisted source changes and GitHub export are not implemented.
- `pnpm build` is currently a placeholder rather than a bundling/production build step; release checks should not mistake it for compilation validation.
- Mounted filesystem mode remains available for compatibility but does not match the full remote GitMini commit/publish/release workflow.

## Documentation notes

`README.md` remains the installation, configuration, API, and runtime reference. Update this overview when product decisions or implementation scope materially change; keep environment and operational details in the README so the two documents have distinct purposes.
