/**
 * The change-password page.
 *
 * Split out of `password.html` for the CSP (phase 8.2) — see the header of
 * `home.js`.
 */

import { apply, errorText, formats, load, paintCached, t } from '/assets/i18n.js';
import { loginUrl, mountVersion, returnTarget, wireLogout, wireReveal } from '/assets/util.js';

const form = document.getElementById('form');
const error = document.getElementById('error');
const why = document.getElementById('why');
const button = form.querySelector('button[type="submit"]');

// Outside the branch below, and wired before `/api/me` is awaited: this is the
// page a user can be *held* on by the forced-change gate, so the way off it has
// to work even when everything else on the page is still loading.
wireLogout(document.getElementById('logout'));

// The three reveals, wired before `/api/me` is awaited so they work during the
// round trip, and re-painted after `load()` for the reason `wireThemeToggle`
// gives: `t` is read late, but the labels already written have to be redone if
// the account's locale turns out not to be the cached one.
const paintReveals = ['current', 'next', 'repeat'].map((id) =>
  wireReveal(document.getElementById(`reveal-${id}`), document.getElementById(id), (shown) =>
    t(shown ? 'password.hide' : 'password.show'),
  ),
);

// Started before the paint, awaited after — see `paintCached()`.
const mePromise = fetch('/api/me').then((r) => (r.ok ? r.json() : null));
await paintCached();

const me = await mePromise;
if (!me) location.href = loginUrl();
else {
  // Before the two lines below touch anything: `why` is one of the strings
  // apply() replaces, so loading the locale afterwards would overwrite the
  // forced-change sentence with the generic rule.
  await load(me.user.locale);
  apply();
  // After apply(), like `home.js` does for the theme button: these labels
  // depend on which way each field currently points, which no `data-i18n` key
  // can express, so nothing else will fix them.
  for (const paint of paintReveals) paint();
  if (me.user.mustChangePassword) why.textContent = t('password.forced');
}

// Outside the branch: the footer is chrome and should render even for
// someone being redirected to /login, who sees this page for a moment.
mountVersion(document.getElementById('version'), (d) => formats().dateTime(d));

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  error.textContent = '';
  if (form.next.value !== form.repeat.value) {
    error.textContent = t('password.mismatch');
    return;
  }
  button.disabled = true;
  try {
    const response = await fetch('/api/me/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        currentPassword: form.current.value,
        newPassword: form.next.value,
      }),
    });
    const payload = await response.json();
    if (!response.ok) {
      error.textContent = payload?.error ? errorText(payload.error) : t('password.failed');
      return;
    }
    // `?next=`, forwarded here by `login.js` — not `form.next`, which is the new
    // password. The two are unrelated and the names collide only on this screen.
    location.href = returnTarget() ?? '/';
  } catch {
    error.textContent = t('error.offline');
  } finally {
    button.disabled = false;
  }
});
