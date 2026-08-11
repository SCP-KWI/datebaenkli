/**
 * The overview page.
 *
 * Split out of `home.html` when the Content-Security-Policy went in (phase 8.2):
 * an inline `<script type="module">` needs `script-src 'unsafe-inline'`, which
 * would have made the whole policy decorative. Three of the six pages already
 * kept their logic in a file, so this is the established shape rather than a new
 * one — `sql.js`, `roster.js` and `lesson.js` are the precedent.
 */

import { apply, formats, load, paintCached, t, wireLanguageToggle } from '/assets/i18n.js';
import {
  accountLabel,
  esc,
  json,
  loginUrl,
  mountDemoBanner,
  mountNav,
  mountVersion,
  wireLogout,
  wireThemeToggle,
} from '/assets/util.js';
import { STEPS, runTour } from '/assets/tour.js';

const get = async (url) => {
  const response = await fetch(url);
  return response.ok ? response.json() : null;
};

const byId = (id) => document.getElementById(id);

// Started before the paint rather than awaited: `paintCached()` exists to
// hide this round trip behind the first frame, and awaiting it here would
// put the round trip back in front of it.
const mePromise = get('/api/me');
await paintCached();
const paintTheme = wireThemeToggle(byId('theme'), (dark) =>
  t(dark ? 'nav.theme_light' : 'nav.theme_dark'),
);

const me = await mePromise;
if (!me) location.href = loginUrl();
else if (me.user.mustChangePassword) location.href = '/password';
else {
  const user = me.user;

  // Before anything renders: the page ships with German in its markup and
  // this swaps it, so doing it after the tables were built would leave
  // half the screen in the wrong language. `sql.js` has the long version.
  // This is also the pass that makes the cached frame above safe — the
  // account, not `localStorage`, decides.
  await load(user.locale);
  apply();
  // After apply(), not before: the toggle's label depends on which way it
  // currently points, which no `data-i18n` key can express.
  paintTheme();
  wireLanguageToggle(byId('lang'));
  // The demo countdown, if this session is a demo lease. `me.demo` is null for
  // every real account, so the call is unconditional (HANDOFF §9g).
  mountDemoBanner(me.demo, t);
  mountVersion(byId('version'), (d) => formats().dateTime(d));

  // `accountLabel`, not `displayName`: a demo lease's stored name is German
  // data ("1 Gast"), and this is the top bar, not a roster. util.js has the
  // distinction. After `apply()`, so `t` reads the account's own locale.
  byId('name').textContent = accountLabel(user, me.demo, t);
  // Spelt out rather than `t('common.role_' + user.role)`: a key built by
  // concatenation is a key that grep cannot find when it is renamed.
  const roleKey = {
    admin: 'common.role_admin',
    teacher: 'common.role_teacher',
    student: 'common.role_student',
  }[user.role];
  byId('role').textContent = `${user.username} · ${t(roleKey)}`;

  /**
   * The first-run tour.
   *
   * **Two different questions, and the order they are asked in is the whole
   * rule.** A demo lease replays it for every visitor, because a leased account
   * is a different person every half hour and `tour_seen_at` would be a fact
   * about the last one. A real account sees it once, recorded on the account
   * rather than in this browser — a class shares machines, so per-browser would
   * mean the first student of the day gets it and the next twenty-one do not.
   *
   * Admins get no tour: `STEPS` has no entry for them, and half of what it
   * points at answers 403 without a Postgres identity.
   *
   * The PATCH is not awaited before the tour is dismissed and its failure is
   * swallowed. The worst case is seeing it a second time, which is a smaller
   * cost than a spinner on a page that is otherwise done — and `mountNav`'s
   * neighbours make the same call for the same reason.
   */
  const steps = STEPS[user.role];
  const seen = () =>
    fetch('/api/me', json({ tourSeen: true }, 'PATCH')).catch(() => {});

  if (steps) {
    byId('tour-again').hidden = false;
    byId('tour-again').addEventListener('click', () => void runTour(steps, t));
    if (me.demo || !user.tourSeenAt) void runTour(steps, t).then(seen);
  }

  /**
   * Escaping happens *here*, not at the call sites.
   *
   * It used to be the caller's job, and every caller did remember — except
   * `memberCount`, which was safe only because it is an integer. That is one
   * column away from a class name rendering as markup in the admin's page, and
   * the person who adds that column has no reason to suspect the difference.
   * A cell function returning a string can now no longer be a mistake.
   *
   * The one thing a cell may still need is markup of its own (`<code>`), so
   * cells return either a string, which is escaped, or `{ html }`, which is
   * not — and every `{ html }` in this file is built from `esc()` output.
   */
  const table = (caption, columns, rows) => {
    if (!rows?.length) return '';
    const cell = (value) => (typeof value === 'object' && value?.html ? value.html : esc(value));
    const head = columns.map(([label]) => `<th>${esc(label)}</th>`).join('');
    const body = rows
      .map((row) => `<tr>${columns.map(([, get]) => `<td>${cell(get(row))}</td>`).join('')}</tr>`)
      .join('');
    return `<h2>${esc(caption)}</h2>
            <div class="table-wrap">
              <table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
            </div>`;
  };

  const code = (value) => ({ html: `<code>${esc(value)}</code>` });

  let html = '';
  if (user.role === 'admin') {
    const { teachers } = (await get('/api/teachers')) ?? {};
    // The cell parameter is `row`, not the `t` it used to be: `t` is the
    // translator now, and a cell function that shadows it is one edit away
    // from calling a teacher object.
    html += table(
      t('home.teachers'),
      [
        [t('common.name'), (row) => row.displayName],
        [t('common.username'), (row) => code(row.username)],
        [t('common.state'), (row) => row.state],
      ],
      teachers,
    );
  }
  if (user.role === 'admin' || user.role === 'teacher') {
    const { classes } = (await get('/api/classes')) ?? {};
    html += table(
      t('home.classes'),
      [
        [t('home.col_code'), (c) => code(c.code)],
        [t('common.name'), (c) => c.name],
        [t('common.teacher'), (c) => c.teacherName],
        [t('common.students'), (c) => c.memberCount],
      ],
      classes,
    );
  }
  byId('content').innerHTML = html || `<p class="muted">${esc(t('home.nothing'))}</p>`;

  // Which entries this account gets, and the marker on this one. Five copies of
  // these rules used to live across three files; `util.js` has the argument.
  mountNav(user.role);
  // Not for a demo lease. The account is thrown away in half an hour, so the
  // link leads to a form whose only possible outcome is a password nobody will
  // ever type again — and to a first-time visitor it reads as a setup step the
  // demo is asking them to complete. `me.demo` is null for every real account,
  // which is what makes this the whole test.
  byId('change').hidden = Boolean(me.demo);
}

// The nav is `<a href>` now and needs no wiring. This is not navigation — it is
// the account setting that used to sit in the middle of it.
byId('change').onclick = () => (location.href = '/password');
// Was this file's own five lines until the button went on every page; the
// content-type argument that used to be here is now in `wireLogout`, where the
// other four callers can read it too.
wireLogout(byId('logout'));
