/**
 * The framed session — server half (`http/embed.ts`) and page half
 * (`assets/embed-auth.js`). Pure, no db, no environment, no DOM.
 *
 * Every way of being wrong here is quiet. A `DBK_FRAME_ANCESTORS` parser that
 * lets `*` through makes the app frameable by anyone and nothing renders
 * differently. A `nextToken` that drops the token on a response that merely
 * said nothing logs a student out mid-exam on whichever button happened to be
 * first — and only inside the frame, where nobody is testing.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = (p) => pathToFileURL(join(import.meta.dirname, '..', 'dist', p)).href;
const { bearerToken, parseFrameAncestors } = await import(dist('http/embed.js'));
const { TOKEN_CLEARED, isFramed, nextToken } = await import(dist('web/assets/embed-auth.js'));

const TOKEN = 'kq3Vb8x_Zt0-LmN4pQrS7uVwXyZ012345678901234A';

// --- which sites may frame the app ------------------------------------------

test('unset or blank means not frameable', () => {
  assert.deepEqual(parseFrameAncestors(''), []);
  assert.deepEqual(parseFrameAncestors('   '), []);
});

test('an exam platform and its subdomains are accepted', () => {
  assert.deepEqual(parseFrameAncestors(' https://exam.net  https://*.exam.net '), [
    'https://exam.net',
    'https://*.exam.net',
  ]);
});

test('anything that widens "the exam platform" to "anyone" is refused at boot', () => {
  for (const bad of ['*', 'https:', 'https://*', 'http://exam.net', 'exam.net', "'self'", 'https://exam.net/path', 'https://*.*.net']) {
    assert.throws(() => parseFrameAncestors(bad), /DBK_FRAME_ANCESTORS/, bad);
  }
});

// --- the bearer header -------------------------------------------------------

test('a well-formed bearer header yields its token', () => {
  assert.equal(bearerToken(`Bearer ${TOKEN}`), TOKEN);
});

test('anything else is no session, not a lookup of whatever followed', () => {
  for (const bad of [undefined, '', TOKEN, `bearer ${TOKEN}`, `Basic ${TOKEN}`, `Bearer  ${TOKEN}`, `Bearer ${TOKEN} x`, 'Bearer a.b.c', 'Bearer short']) {
    assert.equal(bearerToken(bad), null, String(bad));
  }
});

// --- what the page holds after a response ------------------------------------

test('a response that says nothing leaves the token alone', () => {
  // The case that matters most: almost every response is this one.
  assert.equal(nextToken(TOKEN, null), TOKEN);
  assert.equal(nextToken(TOKEN, undefined), TOKEN);
  assert.equal(nextToken(null, null), null);
});

test('a login or rotation replaces it, a logout or expiry clears it', () => {
  assert.equal(nextToken(null, TOKEN), TOKEN);
  assert.equal(nextToken('old', TOKEN), TOKEN);
  assert.equal(nextToken(TOKEN, TOKEN_CLEARED), null);
});

test('framed is decided by self versus top, and leans framed when unreadable', () => {
  const top = {};
  assert.equal(isFramed({ self: top, top }), false);
  assert.equal(isFramed({ self: {}, top }), true);
  const hostile = { self: {}, get top() { throw new Error('denied'); } };
  assert.equal(isFramed(hostile), true);
});
