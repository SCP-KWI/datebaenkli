/**
 * The helpers every page script needs, in one place.
 *
 * Extracted when `csv-import.js` became the second module on the student page:
 * the first two are the sort of thing that is quietly wrong when it is written
 * twice — an `esc` that forgets `"` is an attribute-injection bug, and a `json`
 * that forgets its content type is a silent 415 that looks like a dead button.
 * `wireThemeToggle` joined them in phase 7 for the same reason: six pages, one
 * button, and a copy that forgets to write `localStorage` is a toggle that works
 * until you navigate.
 *
 * `ticked` and `mb` joined them in 7.2, and both are here for that same test —
 * not "this is used twice", but "the second copy can be wrong without anyone
 * seeing it". Each says which way at its own definition.
 */

/**
 * Display names and every catalog name are free text; none of it is trusted markup.
 *
 * The apostrophe is escaped even though every attribute in this app is written
 * with double quotes — which was the actual, unwritten reason the set of five
 * was safe as a set of four. That invariant held across six pages by nothing
 * but habit, and the failure it guards against is silent: `title='${esc(x)}'`
 * looks exactly like the correct line and is an injection. One character here
 * costs nothing and removes the requirement to remember.
 */
export const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

/**
 * Escape first, *then* turn `` `x` `` into `<code>x</code>`.
 *
 * That order is the whole safety argument: a hint interpolates identifiers the
 * student chose, so `CREATE TABLE "<img onerror=…>"` reaches this function.
 * After `esc()` there is no `<` left to open a tag, and backticks survive
 * escaping untouched. Doing it the other way round would be an injection.
 * `hints.js` strips backticks out of identifiers so the pairs cannot be
 * unbalanced by a table name containing one.
 *
 * Shared once `csv-import.js` grew a hint pane of its own: the two panes render
 * the same `hints.js` output, and the version of this that is *only* safe when
 * you remember the ordering is precisely the one not to write twice.
 */
export const ticked = (text) => esc(text).replace(/`([^`]+)`/g, '<code>$1</code>');

/**
 * Bytes as the one string this app states disk usage in.
 *
 * Shared rather than copied because the teacher's lesson view and the student's
 * schema browser now show the **same number about the same schema**, and that
 * agreement is the whole argument for showing it to the student at all (HANDOFF
 * §8.6). Two `toFixed` calls in two files is exactly how that quietly stops
 * being true.
 *
 * A bare `.` rather than `formats().number`: `de-CH` and `en-CH` both use a
 * point for the decimal separator, so the locale-aware version formats
 * identically — and this is called from render paths that run before `/api/me`
 * has answered, where `formats()` would pin the cached locale.
 *
 * **Below a megabyte it switches to kB, and the name is now a small lie.** A
 * usability pass found the line reading "0.0 MB von 50.0 MB" after a student
 * had made tables and inserted rows — true to one decimal, and useless: the one
 * reading it cannot tell a working meter from a broken one. A whole lesson fits
 * inside the rounding error of this figure's old form, so the case that needs
 * the precision is the ordinary one. The unit is part of the string precisely
 * so this switch is possible without every call site knowing.
 */
export const mb = (bytes) =>
  bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)} kB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/**
 * The method is a parameter because PATCH and DELETE need the header for the
 * same reason POST does — `server.ts` applies the check to every non-GET `/api`
 * request, not just POSTs, so a roster's "archivieren" is a 415 without it.
 */
export const json = (body, method = 'POST') => ({
  method,
  // Not optional: the content type *is* the CSRF control, so a POST without it
  // is a 415 and the click silently does nothing.
  headers: { 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

/**
 * The light/dark toggle. `theme.js` applies the stored choice before first
 * paint; this is the only thing that writes it.
 *
 * **The theme is device-local and `localStorage` is its source of truth** — the
 * opposite of the language, which lives in `app_user.locale` and treats its
 * `chalk-lang` key as a cache (`i18n.js`). The two keys sit side by side and
 * look like siblings, so the difference is worth stating: a teacher who wants
 * dark on the classroom projector and light on their laptop is expressing a
 * preference *about that screen*, and syncing it to the account would be a bug.
 * A student switching to English is expressing something about themselves, and
 * not syncing that would be the bug.
 *
 * The icon is the *target* state, not the current one — `dark_mode` while light,
 * per Chalk §6. The label has to say the same thing.
 *
 * **This function is the only owner of that `aria-label`, and the button must
 * not carry a `data-i18n-attr` for it.** Both together is a bug that testing in
 * light mode cannot find: `apply()` writes whatever constant key the markup
 * names, it runs *after* this wiring on every page, and so a reader in dark mode
 * got the icon for "switch to light" beside the label "switch to dark". The two
 * only agree in the mode the author happened to be in.
 *
 * **`labelFor` is a callback, not two strings**, and that is not ceremony: pages
 * wire this once against the cached locale and then load the authoritative one
 * from `/api/me` a moment later. Captured strings would be from the first of
 * those and would survive the second, so a student who switched to English would
 * flip the toggle and get a German label. Calling `t` late reads the live
 * binding that `load()` swaps.
 *
 * **Returns its paint function**, which the page must call again once that
 * authoritative locale has landed — wiring early is what makes the button live
 * during the `/api/me` round trip, and re-painting is what stops the label being
 * stuck in the cached language when the two disagree.
 */
export function wireThemeToggle(button, labelFor) {
  if (!button) return () => {};
  const root = document.documentElement;

  const paint = () => {
    const dark = root.getAttribute('data-theme') === 'dark';
    button.textContent = dark ? 'light_mode' : 'dark_mode';
    const label = labelFor?.(dark);
    if (label) button.setAttribute('aria-label', label);
  };

  button.addEventListener('click', () => {
    const dark = root.getAttribute('data-theme') === 'dark';
    if (dark) root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', 'dark');
    // Wrapped for the reason `theme.js` explains: access can throw outright in
    // private browsing. A toggle that works for this page but is forgotten on
    // the next one beats one that throws and takes the page's script with it.
    try {
      localStorage.setItem('chalk-theme', dark ? 'light' : 'dark');
    } catch (e) {
      /* private mode: the choice lasts as long as this document */
    }
    paint();
  });

  paint();
  return paint;
}

/**
 * Fill in the footer's build stamp. Every page has one; only this fills it.
 *
 * **Never rejects, and renders nothing rather than something wrong.** It runs on
 * `login.html` too, where it is the only fetch on the page — so a failure here
 * must not be able to take the login form with it. `catch` leaving the version
 * blank is the right outcome: the contact address beside it is static markup and
 * is the half that actually matters when something is broken.
 *
 * The date is formatted through the page's locale (`de-CH`/`en-CH`, see
 * `i18n.js`), which is why this takes a formatter rather than reaching for
 * `toLocaleString()` itself — the bare call would use the *browser's* locale and
 * put an English date under a German page.
 */
export async function mountVersion(element, formatDate) {
  if (!element) return;
  const info = await fetch('/api/version')
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  if (!info) return;

  // `builtAt: null` is a dev run, not a failure — say so rather than printing
  // an empty separator that looks like something failed to load.
  const stamp = info.builtAt ? formatDate(new Date(info.builtAt)) : 'dev';
  element.textContent = `v${info.version} · ${stamp}`;
}

/**
 * Sign out. One implementation, because the wrong copy of it is silent.
 *
 * It lived in `home.js` while the button was on one page. Now it is on every
 * page with a top bar, and this is exactly the `json()` case one line up: the
 * content type **is** the CSRF control, so a POST without it is a 415 and the
 * session survives a "logout" that looked like it worked. A shared classroom
 * machine is where that gets noticed, by the wrong person.
 *
 * `replace`, not `href`: the page behind a logout must not be one Back returns
 * to, where it would look alive and answer 401 to everything (`mountDemoBanner`
 * makes the same call for the same reason).
 *
 * The button is not disabled first. If the request fails there is nothing to
 * retry *into* — the caller wants out — and the redirect happens either way, so
 * the worst case is a session that ends at its own expiry instead of now.
 */
export function wireLogout(button) {
  if (!button) return;
  button.addEventListener('click', async () => {
    await fetch('/api/logout', json({})).catch(() => {});
    location.replace('/login');
  });
}

/**
 * The app's confirmation dialog, in place of `window.confirm`.
 *
 * Every other question this app asks is a `<dialog>` — the CSV import, the SQL
 * script, a hand-in — and the destructive ones were the browser's grey box.
 * That is backwards: the dialogs that only collect input looked like the app,
 * and the ones that destroy a schema looked like a page from 2004. Native
 * `confirm()` also cannot be translated beyond its message, cannot mark its
 * dangerous button as dangerous, and blocks the event loop while it is open.
 *
 * **The element is built here, not put in seven pages' markup.** Same argument
 * as `mountDemoBanner` below: it belongs to no page, and a copy per page is six
 * copies to keep in step — which is exactly what `test/pages.test.mjs` exists
 * to police for the one block that genuinely has to be duplicated.
 *
 * `body` is optional and is the second sentence: the callers that ask twice use
 * it to state what does not survive rather than repeating the question.
 * **Both are `textContent`** — no caller may pass markup, and none needs to.
 *
 * Returns a promise for `true`/`false`, so a caller reads exactly as it did
 * with `confirm()` bar an `await`.
 *
 * **The two buttons resolve it themselves, and the `close` event is the backup
 * rather than the mechanism.** Routing a click through `close` → `returnValue`
 * → a listener is three steps to carry an answer the handler already had, and
 * every one of them is a way for the button to do nothing at all — which is what
 * it did in a browser that never dispatched the event. Escape and the backdrop
 * have no handler to speak from, so they still come through `close`; a promise
 * cannot resolve twice, so the two paths cannot disagree.
 */
let confirmBox = null;

export function confirmDialog({ title, body = '', confirmLabel, cancelLabel, danger = true }) {
  if (!confirmBox) {
    confirmBox = document.createElement('dialog');
    confirmBox.className = 'confirm-dialog';
    confirmBox.innerHTML =
      '<h2></h2><p class="confirm-body"></p>' +
      '<menu><button data-no></button><button data-yes></button></menu>';
    document.body.append(confirmBox);
  }

  const heading = confirmBox.querySelector('h2');
  const text = confirmBox.querySelector('.confirm-body');
  const no = confirmBox.querySelector('[data-no]');
  const yes = confirmBox.querySelector('[data-yes]');

  heading.textContent = title;
  text.textContent = body;
  text.hidden = !body;
  no.textContent = cancelLabel;
  // Every field is reassigned on every call, including the ones that look like
  // they could be left alone: the box is one element reused for the life of the
  // page, so `alertDialog` hiding the cancel button would otherwise hide it for
  // the next *question* too — a confirm with no way to say no.
  no.hidden = false;
  yes.textContent = confirmLabel;
  yes.className = danger ? 'btn-danger' : 'primary';

  // **Cleared before every opening, and this is not defensive coding.** Escape
  // closes a `<dialog>` without touching `returnValue`, so it keeps whatever the
  // last dialog set — meaning "confirm a delete, then dismiss the next question
  // with Escape" would read back as a yes and run the destructive path. The one
  // failure mode this whole helper exists to prevent.
  confirmBox.returnValue = '';

  return new Promise((resolve) => {
    no.onclick = () => {
      confirmBox.close('no');
      resolve(false);
    };
    yes.onclick = () => {
      confirmBox.close('yes');
      resolve(true);
    };
    // Escape and the backdrop only. `once` matters: the box outlives every
    // question asked through it, so a listener left behind would answer the
    // next one from the last one's promise.
    confirmBox.addEventListener('close', () => resolve(confirmBox.returnValue === 'yes'), {
      once: true,
    });
    confirmBox.showModal();
    // The cancel button, not the dangerous one: a teacher who hits Enter out of
    // habit must not thereby drop a class's work.
    no.focus();
  });
}

/**
 * The same box with one button — `window.alert`'s replacement.
 *
 * Here rather than left as `alert()` because the two appear side by side in
 * `roster.js`: every failure path there reports through one and every question
 * asks through the other, and a page that answers half its own questions in its
 * own styling and half in the browser's looks broken rather than plain.
 *
 * Not `danger`: an alert is the report of something that already happened, and
 * a red button offers a choice that no longer exists.
 */
export function alertDialog({ title, body = '', okLabel }) {
  const promise = confirmDialog({ title, body, confirmLabel: okLabel, cancelLabel: '', danger: false });
  confirmBox.querySelector('[data-no]').hidden = true;
  confirmBox.querySelector('[data-yes]').focus();
  return promise.then(() => undefined);
}

/**
 * The demo countdown (phase 10, HANDOFF §9g).
 *
 * A demo session stops after 30 minutes whether or not anyone is typing, and
 * the server enforces that on the *next* request — so without this the visitor
 * finds out by pressing Run and getting a 401. The banner is not decoration; it
 * is the difference between an ending and a fault.
 *
 * Takes `t` rather than importing `i18n.js`: this module is imported by every
 * page including ones that never load a catalogue, and a static import would
 * pull the whole i18n layer onto `/login`.
 *
 * `demo` is `/api/me`'s field — null for every real account, which is what makes
 * the call safe to make unconditionally from a page script.
 */
export function mountDemoBanner(demo, t) {
  if (!demo) return;

  // The stylesheet keys off this: the bar is `position: fixed`, so on a page
  // with a tall left-hand list (the schema tree, a roster) it sat *on top* of
  // the last two rows. Reserving the strip is the honest fix — a floating
  // element that covers content is a bug in every mode, and nudging it up only
  // moves which rows it covers. `app.css`'s `.demo-bar` block has the rest.
  document.body.classList.add('has-demo');

  const bar = document.createElement('div');
  bar.className = 'demo-bar';
  bar.setAttribute('role', 'status');
  const label = document.createElement('span');
  const end = document.createElement('button');
  end.type = 'button';
  end.className = 'btn';
  end.textContent = t('demo.end');
  bar.append(label, end);
  document.body.append(bar);

  const deadline = new Date(demo.expiresAt).getTime();

  function tick() {
    const left = deadline - Date.now();
    if (left <= 0) {
      // `replace`, not `href`: the expired page must not sit in the history for
      // a Back button to return to, where it would look alive and answer 401 to
      // everything.
      location.replace('/login');
      return;
    }
    // Rounded *up*, so the banner never says "1 minute" for the 30 seconds
    // after it stopped being true. The last minute gets a sentence of its own
    // rather than counting seconds — see the catalogue.
    const minutes = Math.ceil(left / 60000);
    label.textContent = minutes <= 1 ? t('demo.soon') : t('demo.left', { minutes });
  }

  tick();
  // Every 15 seconds rather than every second: the display moves once a minute,
  // and this way the tab is idle 59/60 of the time.
  const timer = setInterval(tick, 15000);

  end.addEventListener('click', async () => {
    end.disabled = true;
    clearInterval(timer);
    await fetch('/api/demo/end', json({})).catch(() => {});
    location.replace('/login');
  });
}
