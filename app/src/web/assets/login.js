/**
 * The sign-in page.
 *
 * Split out of `login.html` for the CSP (phase 8.2) — see the header of
 * `home.js`, which says the same thing at more length.
 *
 * Note what this file deliberately does *not* import: `i18n.js`. The two
 * sentences a student actually hits are bilingual literals below, because a
 * page reached without a session has no locale to load and no account to read
 * one from.
 */

import { json, mountVersion, returnTarget, withNext, wireReveal } from '/assets/util.js';

// `de-CH` hardcoded, and it is the one place that is right: this page has
// no account to read a locale from, and it is German-first by design. The
// only visible difference from `en-CH` is zero-padding on the date.
mountVersion(document.getElementById('version'), (d) =>
  new Intl.DateTimeFormat('de-CH', { dateStyle: 'short', timeStyle: 'short' }).format(d),
);

const form = document.getElementById('form');
const error = document.getElementById('error');
const button = form.querySelector('button[type="submit"]');

/**
 * Show the password in clear text.
 *
 * The behaviour is `wireReveal` in `util.js`, shared with `/password`, which
 * has three of these. What stays here is the label, and it stays here because
 * it is the one thing this page cannot share: bilingual literals, since this
 * file loads no locale (see the header). Every other page passes `t`.
 */
wireReveal(document.getElementById('reveal'), document.getElementById('password'), (shown) =>
  shown ? 'Passwort verbergen / Hide password' : 'Passwort anzeigen / Show password',
);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  error.textContent = '';
  button.disabled = true;
  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: form.username.value,
        password: form.password.value,
      }),
    });
    const payload = await response.json();
    if (!response.ok) {
      // The API's own message, not a translated one: `i18n.js` is not
      // loaded here on purpose — see the comment above the hint — and the
      // two failures a student actually hits get a bilingual sentence of
      // their own below.
      error.textContent =
        payload?.error?.code === 'invalid_credentials'
          ? 'Benutzername oder Passwort stimmt nicht. / That username or password is not right.'
          : (payload?.error?.message ?? 'Anmeldung fehlgeschlagen. / Sign-in failed.');
      return;
    }
    // A forced change is the server's rule; the redirect only saves the
    // user a dead end, it does not enforce anything.
    //
    // `next` survives the detour through `/password` rather than being dropped
    // at it, because the two are the same student on the same morning: an
    // account handed out for an exam has `must_change_password` set, so the
    // *first* time a deep link is ever followed is the one time this branch is
    // taken. Dropping it here would mean the feature works for everyone except
    // the case it was built for.
    const next = returnTarget();
    location.href = payload.user.mustChangePassword ? withNext('/password', next) : (next ?? '/');
  } catch {
    error.textContent = 'Keine Verbindung zum Server. / No connection to the server.';
  } finally {
    button.disabled = false;
  }
});

/**
 * The demo buttons (phase 10, HANDOFF §9d).
 *
 * Revealed only if this instance offers a demo. The check is a fetch rather
 * than something baked into the page because the pages are served as static
 * bytes with no server-side substitution (`routes/pages.ts`) — the same
 * constraint that makes this page bilingual instead of translated.
 */
const demo = document.getElementById('demo');

fetch('/api/demo')
  .then((r) => (r.ok ? r.json() : null))
  .then((info) => {
    if (info?.enabled) demo.hidden = false;
  })
  .catch(() => {});

/**
 * What went wrong with a demo claim, in both languages.
 *
 * The fallback used to be `error.message`, which is the server's **English**
 * developer string — so a German reader who pressed the button twice too fast
 * got "Too many demo sessions from this address. Try again in 47 seconds." on
 * an otherwise bilingual page (HANDOFF §19). Every code a visitor can actually
 * reach is spelled out here instead; the fallback stays for the ones a bug
 * would produce, where an English sentence beats a blank banner.
 *
 * `Retry-After` rather than the seconds inside that message: the header is the
 * same number, it is already there for exactly this, and parsing a sentence for
 * a digit is how a message becomes load-bearing without anyone deciding it is.
 * Rounded up — a banner that says one second for the last half of it is worse
 * than one that says two.
 */
function demoError(code, response) {
  if (code === 'demo_pool_busy') {
    return (
      'Gerade sind alle Demo-Zugänge belegt. Versuch es in ein paar Minuten nochmals. / ' +
      'Every demo account is in use right now. Try again in a few minutes.'
    );
  }
  if (code === 'too_many_attempts' || code === 'too_many_requests') {
    const wait = Math.max(1, Math.ceil(Number(response.headers.get('retry-after')) || 60));
    return (
      `Zu viele Versuche von dieser Adresse. Nochmals in ${wait} Sekunden probieren. / ` +
      `Too many attempts from this address. Try again in ${wait} seconds.`
    );
  }
  if (code === 'not_found') {
    // The demo is off on this instance, and the route 404s rather than saying
    // so (routes/demo.ts). The button should not have been visible at all, so
    // this is only reachable if it was turned off between the page load and
    // the click — during a deploy, in other words.
    return 'Die Demo ist gerade nicht verfügbar. / The demo is not available right now.';
  }
  return 'Demo nicht verfügbar. / Demo unavailable.';
}

for (const [id, role] of [
  ['demo-student', 'student'],
  ['demo-teacher', 'teacher'],
]) {
  document.getElementById(id).addEventListener('click', async (event) => {
    const pressed = event.currentTarget;
    error.textContent = '';
    // Both, not just the one pressed: a claim takes a schema drop and recreate,
    // and the second button during that is a second slot taken by one visitor.
    for (const b of demo.querySelectorAll('button')) b.disabled = true;
    try {
      const response = await fetch('/api/demo/start', json({ role }));
      const payload = await response.json();
      if (!response.ok) {
        error.textContent = demoError(payload?.error?.code, response);
        return;
      }
      location.href = payload.landing;
    } catch {
      error.textContent = 'Keine Verbindung zum Server. / No connection to the server.';
    } finally {
      for (const b of demo.querySelectorAll('button')) b.disabled = false;
      pressed.focus();
    }
  });
}
