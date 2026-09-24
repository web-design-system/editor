import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('keeps legacy WDS color and spacing definitions in Tailwind source', async () => {
  const source = await readFile(new URL('./styles.css', import.meta.url), 'utf8');

  assert.match(source, /--color-primary: #9c27b0/);
  assert.match(source, /--color-primary-dark: #7c1f8c/);
  assert.match(source, /--color-secondary: #6b7280/);
  assert.match(source, /--color-danger: #dc2626/);
  assert.match(source, /--spacing-xxs: 0.25rem/);
  assert.match(source, /@utility wds-btn/);
  assert.match(source, /@utility wds-tabs__button/);
  assert.match(source, /@utility wds-editor__console/);
  assert.match(source, /@utility wds-workbench__action/);
});

test('component explicitly loads its authored stylesheet and setup module', async () => {
  const source = await readFile(new URL('./component.html', import.meta.url), 'utf8');

  assert.match(source, /href="\.\/styles\.css"/);
  assert.match(source, /src="\.\/editor\.mjs"/);
  assert.match(source, /shadow-dom="open"/);
});
