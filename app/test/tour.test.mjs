/**
 * The first-run tour's step lists. No db, no DOM — `STEPS` is data.
 *
 * This exists because both halves of a step fail *quietly*. A selector that no
 * longer matches is dropped by `runTour` rather than thrown, so the tour is
 * silently one step shorter; a mistyped key makes `t()` return the key itself,
 * so the popover renders `tour.t.rostr` as its body. Neither shows up unless
 * somebody signs in as a brand-new account of that exact role — the one thing
 * nobody does twice, because doing it consumes the state that triggers it.
 *
 * The selectors are checked against `home.html` in `pages.test.mjs`, where the
 * rest of the "the markup has what the script reaches for" assertions live.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import de from '../src/web/assets/i18n-de.js';
import en from '../src/web/assets/i18n-en.js';
import { STEPS } from '../src/web/assets/tour.js';

const ROLES = Object.keys(STEPS);

test('tour: teachers and students each get a tour, admins do not', () => {
  assert.deepEqual(ROLES.sort(), ['student', 'teacher']);
  // An admin has no Postgres identity, so /sql and /uebungen — half of what the
  // tour points at — answer 403 for them. `home.js` reads `STEPS[role]` and
  // shows nothing when it is undefined; this pins that it stays undefined.
  assert.equal(STEPS.admin, undefined);
});

test('tour: every tour is 4–5 steps and ends at the handbook', () => {
  for (const role of ROLES) {
    const steps = STEPS[role];
    assert.ok(steps.length >= 4 && steps.length <= 5, `${role}: ${steps.length} steps`);
    // The point of the whole thing: four sentences and a pointer at where the
    // rest is written down. A tour that ends somewhere else has lost the plot.
    assert.equal(steps.at(-1).target, '#help', `${role}: does not end at the handbook`);
  }
});

test('tour: no step is repeated within a tour', () => {
  for (const role of ROLES) {
    const targets = STEPS[role].map((s) => s.target);
    assert.equal(new Set(targets).size, targets.length, `${role}: a target appears twice`);
  }
});

test('tour: every step key exists in both locales', () => {
  // Read out of the catalogues rather than listed here — a list would be a
  // third copy and the one that goes stale silently.
  for (const role of ROLES) {
    for (const { key } of STEPS[role]) {
      assert.ok(Object.hasOwn(de, key), `${key}: missing from i18n-de.js`);
      assert.ok(Object.hasOwn(en, key), `${key}: missing from i18n-en.js`);
    }
  }
});

test('tour: the chrome keys exist in both locales too', () => {
  // `runTour` calls these directly rather than through `STEPS`, so the loop
  // above cannot see them.
  for (const key of ['tour.step', 'tour.next', 'tour.done', 'tour.skip', 'tour.again']) {
    assert.ok(Object.hasOwn(de, key), `${key}: missing from i18n-de.js`);
    assert.ok(Object.hasOwn(en, key), `${key}: missing from i18n-en.js`);
  }
  // `{n}`/`{total}` are substituted by `translator()`; a placeholder that got
  // renamed on one side renders as literal `{n}` rather than failing.
  for (const catalogue of [de, en]) {
    assert.match(catalogue['tour.step'], /\{n\}/);
    assert.match(catalogue['tour.step'], /\{total\}/);
  }
});

test('tour: the two roles are told different things', () => {
  // The request was "differently targeted for teachers/students both in content
  // and language". Sharing a key between the two lists is how that quietly
  // stops being true — the second role's wording then follows the first's.
  const teacher = new Set(STEPS.teacher.map((s) => s.key));
  for (const { key } of STEPS.student) {
    assert.ok(!teacher.has(key), `${key}: shared between the teacher and student tours`);
  }
});

/**
 * The demo lands where the tour runs.
 *
 * These are two files that have to agree and nothing made them: `home.js` runs
 * the tour on `/` and `routes/demo.ts` decides where a demo visitor is sent.
 * 0.11.0 shipped with the second deep-linking past the first — `/uebungen` for
 * a teacher, `/sql` for a student — so every demo visitor skipped the tour, and
 * the only thing that caught it was a person pressing the button in production.
 *
 * Read out of the route rather than hardcoded on both sides, so this fails when
 * the value changes rather than agreeing with a copy of itself. If `landing`
 * ever needs to be conditional again, the condition belongs here as an
 * assertion about every branch, not as a looser regex.
 */
test('tour: the demo lands on the page the tour runs on', () => {
  const source = readFileSync(
    join(import.meta.dirname, '..', 'src', 'routes', 'demo.ts'),
    'utf8',
  ).replace(/\/\*[\s\S]*?\*\//g, '');

  const matches = [...source.matchAll(/\blanding:\s*(.+?),?\n/g)].map((m) => m[1].trim());
  assert.equal(matches.length, 1, `expected one landing, found ${matches.length}`);
  assert.equal(
    matches[0],
    "'/'",
    'the demo landing is not the overview — a demo visitor would skip the tour',
  );
});
