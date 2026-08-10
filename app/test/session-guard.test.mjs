/**
 * The tab-bleed guard's decision — §18. Pure, no db, no DOM.
 *
 * `verdict()` decides, once per `/api` response, whether this tab is still the
 * session it rendered as. It exists as a separate function precisely because
 * both ways of being wrong are invisible in a browser: too eager and a lesson
 * ends behind an interstitial that cannot be dismissed, too slack and a teacher
 * tab quietly carries on as the student who signed in next door — which is the
 * bug it was written for, and which looks exactly like working software.
 *
 * The `labelled` cases are the ones to read first. They are where the client's
 * rule leans on the server's: a labelled request has been checked against the
 * cookie in `http/auth.ts` before its handler ran, so a 2xx that comes back
 * under a *different* fingerprint is a rotation the server performed itself.
 * Nothing else may be followed.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { NO_SESSION, verdict } from '../src/web/assets/session-guard.js';

const A = 'aaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbb';

// --- the two failure modes ---------------------------------------------------

test('a changed fingerprint on a refused request is a halt', () => {
  // The shape of the bug: another tab signed in, so the server answered 409
  // session_switched rather than running the handler as the wrong person.
  assert.equal(verdict({ expected: A, seen: B, ok: false, labelled: true }), 'halt');
});

test('a session that has gone away entirely is a halt', () => {
  // Logged out in another tab. The response is a 401 under `none`, and a page
  // that ignored it would sit there showing an account nobody is signed in as.
  assert.equal(verdict({ expected: A, seen: NO_SESSION, ok: false, labelled: true }), 'halt');
});

test('an unlabelled request may not adopt, however well it went', () => {
  // The one window the label cannot cover: a request that left before the first
  // answer established an identity, and landed after somebody else's sign-in.
  // Nothing checked it against anything, so a 2xx proves nothing about who ran
  // it — and this is the case a rule written as "ok means fine" would miss.
  assert.equal(verdict({ expected: A, seen: B, ok: true, labelled: false }), 'halt');
});

// --- what must NOT stop the page ---------------------------------------------

test('the same session is a pass', () => {
  assert.equal(verdict({ expected: A, seen: A, ok: true, labelled: true }), 'pass');
  // Including when the request failed for its own reasons: a 403 from a role
  // guard, a 507 from the quota. Those are the page's business, not this one's.
  assert.equal(verdict({ expected: A, seen: A, ok: false, labelled: true }), 'pass');
});

test('the first answer establishes the identity', () => {
  assert.equal(verdict({ expected: null, seen: A, ok: true, labelled: false }), 'adopt');
  // Even a failing one. `/api/me` answering 401 on a cold page is how a page
  // learns it has no session, and it still names the session that answered.
  assert.equal(verdict({ expected: null, seen: NO_SESSION, ok: false, labelled: false }), 'adopt');
});

test('a rotation the server made on our own request is followed', () => {
  // Signing in, claiming a demo slot, and the fresh session `/api/me/password`
  // issues after it drops every session the account had. All three answer 2xx
  // under a new fingerprint, and a page that halted on them would break the
  // password change it was sent to `/password` to make.
  assert.equal(verdict({ expected: A, seen: B, ok: true, labelled: true }), 'adopt');
  assert.equal(verdict({ expected: NO_SESSION, seen: A, ok: true, labelled: true }), 'adopt');
  // And logging out, which ends under `none` and must not be turned into a
  // "your session was replaced" box on the way to `/login`.
  assert.equal(verdict({ expected: A, seen: NO_SESSION, ok: true, labelled: true }), 'adopt');
});

test('a response carrying no fingerprint decides nothing', () => {
  // `/api` is where the header is set. Everything else — a page, an asset, a
  // font — must pass through untouched, and so must an `/api` response from an
  // older build during a deploy: this may not be a way for a rolling restart to
  // stop every open tab in a school.
  assert.equal(verdict({ expected: A, seen: null, ok: true, labelled: true }), 'pass');
  assert.equal(verdict({ expected: A, seen: null, ok: false, labelled: false }), 'pass');
  assert.equal(verdict({ expected: null, seen: null, ok: true, labelled: false }), 'pass');
});
