# Web Design System Editor Source

This is the authored source repository for the `web-design-system/editor` component. It is intentionally not initialized as a Git repository yet; the editor service will later manage its commits and release tags.

## Files

- `component.html`: Li3 component definition.
- `editor.mjs`: Li3 setup module.
- `styles.css`: Tailwind 4 CSS-first source, including definitions extracted from the legacy WDS stylesheet.
- `stories.html`: handcrafted Li3 styleguide entrypoint.
- `component.json`: component name and description.
- `spec.mjs`: dependency-free Node specification.

## Legacy Definition Extraction

The legacy `wds/site.css` stylesheet defined these authored values on top of Tailwind 2:

- Colors: primary `#9c27b0`, primary-dark `#7c1f8c`, secondary `#6b7280`, danger `#dc2626`.
- Spacing: `xxs` `0.25rem`, `xs` `0.5rem`, `sm` `0.75rem`, `md` `1rem`, `lg` `2rem`, `xl` `4rem`.
- Component utilities: buttons, pages, code blocks, containers, and tabs.

`styles.css` expresses these as Tailwind 4 `@theme` and `@utility` definitions. The future editor compiler will process it with `@tailwindcss/cli` and publish the result with the component.

## Commands

```sh
pnpm install
pnpm test
pnpm build:css
```
