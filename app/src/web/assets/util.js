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

// Relative, not `/assets/…`: `test/util.test.mjs` imports this module in Node,
// where a root-absolute specifier resolves against the filesystem and fails.
import { installSessionGuard } from './session-guard.js';

/**
 * **The one side effect in this file, and the only one in the front end.**
 *
 * It wraps `window.fetch` so that no request can be made in the name of a
 * session the browser has since replaced — a cookie belongs to the profile, not
 * to the tab, so a second sign-in anywhere silently re-points every open tab.
 * `session-guard.js` has the whole argument, including why this is a wrap and
 * not a helper the twenty-odd call sites would have had to remember.
 *
 * Here because every page script imports this module — six pages, plus
 * `i18n.js` and `csv-import.js` — so there is exactly one install and no
 * seventh page can be added without it. Import evaluation runs before any
 * page's own top-level `fetch`, which is what makes even `/api/me` covered.
 */
installSessionGuard();

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
 * Show a password field in clear text.
 *
 * It lived in `login.js` while one page had one field. `/password` has three,
 * and a page that asks a fifteen-year-old to type a new password twice without
 * letting them see either is the case this exists for more than login was.
 * Four copies of a state machine is how the theme toggle's bug happened, so:
 * one.
 *
 * `labelFor` is a callback and `paint` is returned, for exactly the reasons
 * `wireThemeToggle` above states at length — `/password` wires this against the
 * cached locale and then loads the account's a moment later. `/login` passes a
 * bilingual literal instead, because it deliberately loads no locale at all.
 *
 * **The icon and the label both name the state the click moves *to***, and this
 * function owns both; the button must carry no `data-i18n-attr` for the label,
 * or `apply()` will overwrite half of a pair with a constant.
 *
 * The focus goes back into the field afterwards. Without it the caret is lost
 * to the button, and this gets pressed mid-typing by someone checking a slip —
 * having to click back into the field is the whole cost of the feature.
 *
 * Nothing is persisted. "Show my password by default" is not a preference this
 * app should remember on a machine a class shares.
 */
export function wireReveal(button, input, labelFor) {
  if (!button || !input) return () => {};

  const paint = () => {
    const shown = input.type === 'text';
    button.textContent = shown ? 'visibility_off' : 'visibility';
    button.setAttribute('aria-pressed', String(shown));
    const label = labelFor?.(shown);
    if (label) {
      button.setAttribute('aria-label', label);
      button.setAttribute('title', label);
    }
  };

  button.addEventListener('click', () => {
    input.type = input.type === 'text' ? 'password' : 'text';
    paint();
    input.focus();
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
 * The top bar: mark where we are, hide what this account cannot reach.
 *
 * **The set of entries never changes — only the marker moves.** That is the
 * whole design, and it replaced five pages that each dropped their own link and
 * kept the rest in whatever order they were written in. Removing the current
 * page is locally sensible and globally corrosive: no two bars looked alike, so
 * nothing about the bar could be learned, and `/sql` had quietly become
 * unreachable from `/lesson` and `/roster` without anyone deciding that.
 *
 * **The role rules are here and nowhere else.** They used to be three copies —
 * `home.js`, `sql.js`, `uebungen.js` — with slightly different comments, which
 * is exactly how the five bars came to disagree in the first place. A fourth
 * page is now one call.
 *
 * Two of them are worth stating rather than reading off the table:
 *
 * - **An admin has no Postgres identity at all**, so `/sql` and `/uebungen`
 *   would answer 403 for them. Not a permission judgement — there is no schema.
 * - **A student's `/lesson` and `/roster` are staff pages.** The server enforces
 *   that; this only saves them a redirect, and the page scripts still bounce a
 *   student who types the URL.
 *
 * `hidden` rather than removal, so the markup stays the byte-identical block
 * `test/pages.test.mjs` compares across pages.
 */
const NAV_HIDDEN = {
  student: ['nav-lesson', 'nav-roster'],
  admin: ['nav-sql', 'nav-exercises'],
  teacher: [],
};

/**
 * Which handbook the `?` opens (0.10.3).
 *
 * There are two documents — `/handbuch` for staff, `/handbuch-lernende` for
 * students — and the markup carries the staff one, because that is the one an
 * account with no role at all should get. Only the student is redirected, and
 * only here: the `href` cannot be branched in the pages themselves without
 * breaking the byte-identical bar, which is the whole point of that test.
 *
 * The `?` was the teacher's manual for every reader until now, which was the
 * placeholder the markup's own comment described. A student who opened it
 * landed in "Klasse anlegen" — not harmful, but it read as "this is not for
 * you", on the one page they spend a whole lesson in.
 *
 * `title`/`aria-label` stay as they are: "Handbuch öffnen" is true either way,
 * and rewriting them here would be the second owner of a label the markup
 * already sets — the trap `app.css`'s banner records for `data-i18n-attr`.
 */
const HANDBOOK = { student: '/handbuch-lernende' };

export function mountNav(role, path = location.pathname) {
  for (const id of NAV_HIDDEN[role] ?? []) {
    const link = document.getElementById(id);
    if (link) link.hidden = true;
  }

  const help = document.getElementById('help');
  if (help && HANDBOOK[role]) help.href = HANDBOOK[role];

  for (const link of document.querySelectorAll('.navlink')) {
    // `getAttribute`, not `.href`: the property is absolute, and comparing
    // `http://host/sql` against a pathname silently marks nothing.
    const target = link.getAttribute('href');
    // `/sql?uebung=3` is still `/sql` — `location.pathname` drops the query,
    // which is what makes an exercise read as "you are in the SQL editor"
    // rather than as nowhere at all.
    if (target === path) link.setAttribute('aria-current', 'page');
  }
}

/**
 * Where a sign-in came from, so that it can go back there (0.11.4).
 *
 * The three functions below exist for one URL: `/sql?uebung=<id>`. It is the
 * only deep link this app hands out — a teacher pastes it into a lesson, a
 * message, or (the case that prompted this) an Exam.net external resource — and
 * until now it survived exactly as far as the login page, because `login.js`
 * landed every successful sign-in on `/`. The student then had to find the
 * exercise again from the top bar, which is a small thing everywhere except in
 * front of a class in a locked-down browser.
 *
 * **`returnTarget` is the whole security surface, and it is one rule: the target
 * must resolve to this origin.** `new URL(raw, origin)` is what enforces it and
 * why nothing here matches on strings — `//evil.example` and `/\evil.example`
 * are both *parsed* as an authority by the WHATWG rules and come back with
 * somebody else's origin, which a `startsWith('/')` check waves through. That is
 * an open redirect on the one page in the app where a user is about to type a
 * password, so it is worth the constructor rather than a regex.
 *
 * The `/api` and `/assets` refusal is not a security rule — both are same-origin
 * and neither is harmful to land on. It is that a sign-in ending on a JSON blob
 * reads as a broken login, and nothing here emits one, so a `next` naming one
 * did not come from this app.
 */
const NO_RETURN = new Set([
  // Where a login lands anyway; a `next` naming it is a no-op.
  '/',
  // Naming the login page from the login page is a loop.
  '/login',
  // A waypoint, not a destination. What is worth remembering here is the target
  // it was already carrying, not this page — and threading that through costs
  // more than it buys, so a session that dies *on* `/password` loses the deep
  // link and lands on `/`. One click, on a path nobody walks.
  '/password',
]);

/** `/login` → `/login?next=%2Fsql%3Fuebung%3D3`, or unchanged when there is nothing to remember. */
export function withNext(path, next) {
  return next ? `${path}?next=${encodeURIComponent(next)}` : path;
}

/**
 * The URL to bounce someone to when they have no valid session.
 *
 * Every "you are not signed in" redirect in the front end goes through this, so
 * that the rule about what is worth remembering lives in one place. The three
 * that deliberately do *not*: `wireLogout` and both of `mountDemoBanner`'s exits
 * are someone leaving on purpose, and sending them back to the page they left is
 * the opposite of what they asked for. `session-guard.js` is a fourth, for a
 * duller reason — `util.js` imports it, so it cannot import this back.
 */
export function loginUrl(here = location.pathname + location.search) {
  const [path] = here.split('?');
  return withNext('/login', NO_RETURN.has(path) ? null : here);
}

/**
 * The validated `?next=` this page was reached with, or `null`.
 *
 * The arguments have defaults rather than being read from `location` directly so
 * that `test/util.test.mjs` can reach the one thing here that is worth a test.
 */
export function returnTarget(search = location.search, origin = location.origin) {
  const raw = new URLSearchParams(search).get('next');
  if (raw === null) return null;

  let url;
  try {
    url = new URL(raw, origin);
  } catch {
    return null;
  }
  // Also catches `javascript:` and friends, whose origin is the string "null".
  if (url.origin !== origin) return null;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/assets/')) return null;

  // Not `url.href`: a same-origin absolute is a legal `next`, and following it
  // as one would leave the app's own links looking different from each other.
  return url.pathname + url.search;
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
 * have no handler to speak from, so they still come through `close`.
 *
 * **The backup listener has to be taken down when the button answers, and
 * `{ once: true }` is not enough to do it.** That sentence is the whole of
 * HANDOFF §23 and it cost every two-step confirmation in the app.
 * `HTMLDialogElement.close()` does not fire `close` synchronously — it *queues*
 * a task — while the `await` in the caller resumes on a **microtask**, which
 * runs first. So in `deleteStudent`, the second question was already open and
 * had already registered its own listener by the time the *first* question's
 * close event arrived; that event then answered question two, from question
 * one's click, against a `returnValue` the second call had just cleared. It
 * read as `false` and the delete silently did nothing.
 *
 * The fix is the `confirmBox.open` check in `onClose`, and the first attempt at
 * it — removing this call's listener when a button answers — was **wrong in a
 * way worth recording, because it looks right**: the queued event is dispatched
 * to whatever is attached when it *fires*, so question two's brand-new listener
 * catches question one's close regardless of what question one tidied up. What
 * separates the two is the box, not the listener. `settle()` removes the
 * listener as well, which stops them accumulating one per question and covers
 * the case where the caller awaits something between two questions.
 *
 * A promise still cannot resolve twice — that is what made this invisible
 * rather than what made it safe.
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
    // The box outlives every question asked through it, so this call's listener
    // must be gone before the next call registers its own. `{ once: true }`
    // removes it when it *fires*, which is a task too late — see the header.
    const settle = (answer) => {
      confirmBox.removeEventListener('close', onClose);
      resolve(answer);
    };
    /**
     * `confirmBox.open` is the guard, and it has to be *this* rather than
     * anything about the listener.
     *
     * Removing our own listener in `settle` is necessary and not sufficient:
     * the queued event is dispatched to whatever is attached **when it fires**,
     * so the next question's freshly registered listener catches the previous
     * question's close just as happily. The only thing that tells the two apart
     * is the box itself — a genuine close arrives with the dialog shut, and a
     * stale one arrives after the next `showModal()` has already re-opened it.
     */
    const onClose = () => {
      if (confirmBox.open) return;
      settle(confirmBox.returnValue === 'yes');
    };

    no.onclick = () => {
      confirmBox.close('no');
      settle(false);
    };
    yes.onclick = () => {
      confirmBox.close('yes');
      settle(true);
    };
    // Escape and the backdrop only.
    confirmBox.addEventListener('close', onClose);
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
 * The name to put in the top bar for the account looking at the page.
 *
 * Ordinarily `displayName`, which is a person's name and is never translated.
 * A demo lease is the exception, and it is the reason this function exists: the
 * pool's accounts are called "1 Gast" and "Lehrperson Demo" in `app_user`,
 * because `services/demo.ts` creates them through the same `createStudents`
 * every real account goes through and a display name is data. On the English
 * page that read "1 Gast", which was reported as a translation gap and is one
 * (HANDOFF §19) — it is not somebody's name, it is a label for a slot.
 *
 * Only the *own* name, deliberately. A demo teacher's roster shows "Muster
 * Lena" and the rest of the fixture class, and those stay as they are: they are
 * fictional people, and translating a name is a different mistake from
 * translating a label.
 *
 * Takes `t` rather than importing `i18n.js`, like `mountDemoBanner` below and
 * for the same reason — `login.js` imports this module and loads no catalogue.
 */
export function accountLabel(user, demo, t) {
  if (!demo) return user.displayName;
  return t(user.role === 'teacher' ? 'demo.as_teacher' : 'demo.as_student');
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
