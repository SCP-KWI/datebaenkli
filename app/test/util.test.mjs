/**
 * `mb()` — the one figure this app states disk usage in.
 *
 * No DOM, no db. `util.js` touches `document` only inside its functions, which
 * is what makes it importable here at all; the same bar `names.js`, `hints.js`
 * and `markdown.js` are held to, and this file exists for the same reason those
 * do. The student's schema browser and their teacher's lesson view print the
 * *same number about the same schema* (HANDOFF §8.6), so a change to this
 * function is a change to two screens that are supposed to agree, and nothing
 * else in the suite would notice it moving.
 *
 * The cases below are the boundary and the two sides of it. A usability pass
 * found the line reading "0.0 MB" for a schema that held several tables — true,
 * and useless — so the sub-megabyte branch is not cosmetic: it is the difference
 * between a meter and a decoration, and it is one `<` away from being wrong in
 * the direction nobody notices.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = (p) => pathToFileURL(join(import.meta.dirname, '..', 'dist', p)).href;
const { mb } = await import(dist('web/assets/util.js'));

test('below a megabyte the figure is stated in kB, whole numbers', () => {
  // The case the branch exists for: a lesson's worth of rows used to render as
  // "0.0 MB", which reads as "this is not measuring anything".
  assert.equal(mb(0), '0 kB');
  assert.equal(mb(48 * 1024), '48 kB');
  // Rounded, not truncated — 1023.6 kB is nearer a megabyte than 1023 is.
  assert.equal(mb(1024 * 1024 - 1), '1024 kB');
});

test('a megabyte and above keeps one decimal, and the unit changes with it', () => {
  assert.equal(mb(1024 * 1024), '1.0 MB');
  assert.equal(mb(12.44 * 1024 * 1024), '12.4 MB');
  // The quota itself, which is the other half of every sentence this appears in.
  assert.equal(mb(50 * 1024 * 1024), '50.0 MB');
});
