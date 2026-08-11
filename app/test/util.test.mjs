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
const { loginUrl, mb, returnTarget, withNext } = await import(dist('web/assets/util.js'));

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

/**
 * `?next=` — the sign-in return-to (0.11.4).
 *
 * Two things are being pinned, and only one of them is the feature. The feature
 * is that `/sql?uebung=3` survives a login; it is one assertion and it would be
 * noticed the first time anyone used it.
 *
 * The other is `returnTarget`'s refusal, and it is the reason this block exists:
 * an open redirect on the page a student is about to type a password into is
 * both the worst place in this app to have one and completely invisible from the
 * browser — every case below *works*, in the sense that the login succeeds and
 * the page goes somewhere. `//evil.example` and `/\evil.example` are the two
 * that matter, because both start with a slash and both defeat the string check
 * that the `new URL` in that function exists instead of.
 */
const ORIGIN = 'https://db.example.ch';

test('a deep link survives the sign-in, query and all', () => {
  assert.equal(loginUrl('/sql?uebung=3'), '/login?next=%2Fsql%3Fuebung%3D3');
  assert.equal(returnTarget('?next=%2Fsql%3Fuebung%3D3', ORIGIN), '/sql?uebung=3');
});

test('the pages the login flow lands on itself are not remembered', () => {
  // A `next` naming any of these is a no-op or a loop; see NO_RETURN.
  assert.equal(loginUrl('/'), '/login');
  assert.equal(loginUrl('/login?next=%2Fsql'), '/login');
  assert.equal(loginUrl('/password?next=%2Fsql%3Fuebung%3D3'), '/login');
  // Everything else is, including the pages with no query of their own.
  assert.equal(loginUrl('/uebungen'), '/login?next=%2Fuebungen');
});

test('no target, or a malformed one, is simply no target', () => {
  assert.equal(returnTarget('', ORIGIN), null);
  assert.equal(returnTarget('?uebung=3', ORIGIN), null);
  assert.equal(withNext('/password', null), '/password');
});

test('a target that resolves off this origin is refused', () => {
  // The two that a `startsWith('/')` check waves through: the WHATWG parser
  // reads both as an authority, so both come back as somebody else's site.
  assert.equal(returnTarget('?next=%2F%2Fevil.example', ORIGIN), null);
  assert.equal(returnTarget('?next=%2F%5Cevil.example', ORIGIN), null);
  assert.equal(returnTarget('?next=https%3A%2F%2Fevil.example%2Fsql', ORIGIN), null);
  // Origin "null", so the same one line refuses it.
  assert.equal(returnTarget('?next=javascript%3Aalert(1)', ORIGIN), null);
  // Same origin spelled the long way is legal, and comes back as a path.
  const absolute = encodeURIComponent(`${ORIGIN}/sql?uebung=3`);
  assert.equal(returnTarget(`?next=${absolute}`, ORIGIN), '/sql?uebung=3');
});

test('a target that is not a page is refused', () => {
  // Not a security rule — both are same-origin. A sign-in that ends on a JSON
  // blob reads as a broken login, and nothing in this app emits one.
  assert.equal(returnTarget('?next=%2Fapi%2Fme', ORIGIN), null);
  assert.equal(returnTarget('?next=%2Fassets%2Futil.js', ORIGIN), null);
});
