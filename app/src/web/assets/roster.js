/**
 * The roster page — phase 5.
 *
 * Plain module, served as written, like every page script except the editor
 * bundle. Every route it calls already existed and was tested before this file
 * did; §4aa is the finding that there was simply no way to *click* any of them.
 *
 * ---------------------------------------------------------------------------
 * The one thing to understand before editing: a slip password exists exactly
 * once, in the body of the response that created the account. `password_hash`
 * is scrypt, so there is no reading it back — the only other operation is
 * issuing a new one, which invalidates the slip already handed out. For a
 * student that is not merely inconvenient: `mustChangePassword` defaults to
 * false for them on purpose (services/users.ts), so the slip *is* the
 * credential rather than a first-login formality.
 *
 * Three consequences are built into this file, and none of them should be
 * quietly dropped:
 *
 * 1. **The slip view is not a `<dialog>`.** `lesson.js` uses one for its
 *    drill-down and is right to, but Esc closes a dialog — and Esc must not be
 *    able to destroy thirty passwords. The slips replace `<main>` and go away
 *    only on an explicit "gedruckt" click.
 *
 * 2. **Nothing is persisted.** Not `localStorage`, not `sessionStorage`. That
 *    was the obvious fix for the closed tab and it is the wrong one: thirty
 *    non-expiring plaintext passwords left in a school laptop's browser profile
 *    is a worse trade than the one it buys, especially since (3) buys more.
 *    `beforeunload` cannot promise anything, but it turns "closed the tab" into
 *    "was asked first", which is most of the accidents.
 *
 * 3. **Losing them costs one click, with provably no collateral damage.**
 *    `reissueUnused()` re-slips only students whose `lastLoginAt` is null. A
 *    student who has never signed in cannot have used their slip, so nothing
 *    that was handed out is invalidated — which is what makes the button safe
 *    to press mid-lesson after twenty of thirty slips are already out. Without
 *    that filter it is a footgun; with it, it is the answer.
 */

import { apply, errorText, formats, load, paintCached, t, wireLanguageToggle } from './i18n.js';
import { parseNames } from './names.js';
import {
  alertDialog,
  confirmDialog,
  esc,
  json,
  loginUrl,
  mountDemoBanner,
  mountNav,
  mountVersion,
  wireLogout,
  wireThemeToggle,
} from './util.js';

const $ = (id) => document.getElementById(id);

/** Set while unprinted slips are on screen — see the beforeunload guard. */
let slipsPending = false;

let me = null;
let classes = [];
let selected = null;
let roster = [];

// --- transport ---------------------------------------------------------------

const get = async (url) => {
  const response = await fetch(url).catch(() => null);
  if (!response) return null;
  if (response.status === 401) {
    location.href = loginUrl();
    return null;
  }
  return response.ok ? response.json() : null;
};

/**
 * A mutating call, returning `[payload, errorMessage]`.
 *
 * Never throws: every caller here is a click handler, and an unhandled rejection
 * in one is a button that does nothing with no explanation — the exact failure
 * `util.js`'s `json()` exists to prevent one cause of.
 */
async function send(url, options) {
  const response = await fetch(url, options).catch(() => null);
  if (!response) return [null, t('error.offline')];
  if (response.status === 401) {
    location.href = loginUrl();
    return [null, t('error.unauthenticated')];
  }
  const payload = await response.json().catch(() => null);
  // `errorText()` and not `error.message`: the code is what carries a German or
  // English sentence, and the developer message is only the fallback for a code
  // nothing has translated yet (`i18n.js`).
  if (!response.ok) {
    return [
      null,
      payload?.error ? errorText(payload.error) : t('common.failed', { status: response.status }),
    ];
  }
  return [payload, null];
}

// --- asking, and reporting ---------------------------------------------------

/**
 * The page's questions, all of which cancel the same way.
 *
 * Only that default is shared: the wording stays at each call site, because
 * *which* sentence a destructive dialog shows is the safeguard, and it has to be
 * readable beside the thing it guards. `danger` is `confirmDialog`'s own default
 * and most questions here take it — the two that do not say why at the site.
 */
const ask = (options) => confirmDialog({ cancelLabel: t('common.cancel'), ...options });

/**
 * Every failure path reports the same way, and the shape is worth naming once:
 * `send()` has already turned the code into a German or English sentence, and a
 * whole sentence is a `body`, never a `title`. The heading says only that it did
 * not work — which is all a heading can say about an error nobody predicted.
 */
const showError = (message) =>
  alertDialog({ title: t('common.error'), body: message, okLabel: t('common.close') });

// --- the slip view -----------------------------------------------------------

/**
 * `created` is the shape both creation and a password reset return:
 * `{ user, password, provisioning? }`. The two paths share this view precisely
 * because the slip does not care which one produced it.
 */
/**
 * The address is the app's *configured* public URL, not `location.host`.
 *
 * `https://` is stripped because a bare domain is what a student types and
 * browsers default to it anyway; `http://` is kept, because there it is
 * information they need rather than noise.
 */
function slipAddress() {
  return (me?.app?.publicUrl ?? '')
    .replace(/\/+$/, '')
    .replace(/^https:\/\//, '');
}

/**
 * A slip renders in the *teacher's* locale, not the student's.
 *
 * There is no per-class locale to read, and even if there were it would not
 * help: the slip is printed on paper, and paper cannot be re-rendered when the
 * student later switches the interface to English. A recorded limitation rather
 * than a bug to fix here — the words on it are an address, a username and a
 * password, and the two labels around them are the whole translated surface.
 */
function showSlips(created, title) {
  const origin = slipAddress();

  // Provisioning runs outside the meta transaction, so an account can exist
  // with no schema yet — a real state, not an error (see services/users.ts).
  // The student can still log in, so the slip is still worth printing; the
  // warning is on screen and marked .noprint because it is for the teacher.
  const failed = created.filter((c) => c.provisioning && !c.provisioning.ok);
  // Escaped as a whole: the catalogue string is trusted text with no markup in
  // it, and the usernames it carries are the part that is not.
  $('slips-warn').innerHTML = failed.length
    ? `<p class="bad">${esc(
        t('roster.slips_no_schema', {
          count: failed.length,
          names: failed.map((c) => c.user.username).join(', '),
        }),
      )}</p>`
    : '';

  $('slips-title').textContent = title;
  $('slips').innerHTML = created
    .map(
      ({ user, password }) => `<div class="slip">
        <h3>${esc(user.displayName)}</h3>
        <p class="who">${esc(t('roster.slip_access'))}</p>
        <dl>
          <dt>${esc(t('roster.slip_address'))}</dt><dd>${esc(origin)}</dd>
          <dt>${esc(t('common.username'))}</dt><dd><code>${esc(user.username)}</code></dd>
          <dt>${esc(t('roster.slip_password'))}</dt><dd><code>${esc(password)}</code></dd>
        </dl>
        <p class="foot">${esc(t('roster.slip_foot'))}</p>
      </div>`,
    )
    .join('');

  slipsPending = true;
  $('main').hidden = true;
  $('slips-view').hidden = false;
  scrollTo(0, 0);
}

function closeSlips() {
  slipsPending = false;
  $('slips').innerHTML = '';
  $('slips-view').hidden = true;
  $('main').hidden = false;
}

// The browser will not let us say why, and a teacher who genuinely wants to
// leave still can. It is here to catch the reflexive Cmd-W, which is the way
// these are actually lost.
addEventListener('beforeunload', (event) => {
  if (!slipsPending) return;
  event.preventDefault();
  event.returnValue = '';
});

// --- teachers (admin only) ---------------------------------------------------

async function loadTeachers() {
  const teachers = (await get('/api/teachers'))?.teachers ?? [];
  // The row parameter is `teacher`, not the `t` it was: `t` is the translator
  // now, and the two cannot share a name in the same template literal.
  $('teachers').innerHTML = teachers.length
    ? `<table>
        <thead><tr><th>${esc(t('common.name'))}</th><th>${esc(t('common.username'))}</th>
          <th>${esc(t('common.state'))}</th>
          <th class="act">${esc(t('roster.col_access'))}</th></tr></thead>
        <tbody>${teachers
          .map(
            (teacher) => `<tr>
              <td>${esc(teacher.displayName)}</td>
              <td><code>${esc(teacher.username)}</code></td>
              <td>${teacher.state === 'active' ? `<span class="quiet">${esc(t('common.active'))}</span>` : `<span class="tag warn">${esc(teacher.state)}</span>`}</td>
              <td class="act"><button class="small" data-reslip="${teacher.id}">${esc(t('roster.reslip'))}</button></td>
            </tr>`,
          )
          .join('')}</tbody>
      </table>`
    : `<p class="quiet">${esc(t('roster.no_teachers'))}</p>`;

  for (const button of $('teachers').querySelectorAll('[data-reslip]')) {
    button.addEventListener('click', () => void reslipTeacher(Number(button.dataset.reslip)));
  }

  // The class form's owner select is the same list; an admin has no classes of
  // their own and must name one (routes/classes.ts).
  if (me.user.role === 'admin') {
    $('c-teacher-label').hidden = false;
    $('c-teacher').innerHTML = teachers
      .filter((teacher) => teacher.state === 'active')
      .map((teacher) => `<option value="${teacher.id}">${esc(teacher.displayName)}</option>`)
      .join('');
  }
  return teachers;
}

async function reslipTeacher(id) {
  const go = await ask({
    title: t('roster.reslip'),
    body: t('roster.reslip_teacher_confirm'),
    confirmLabel: t('roster.reslip'),
  });
  if (!go) return;
  const [created, error] = await send(`/api/teachers/${id}/password`, json());
  if (error) return void showError(error);
  showSlips([created], t('roster.slips_reslip'));
}

$('t-create').addEventListener('click', async () => {
  const firstName = $('t-first').value.trim();
  const lastName = $('t-last').value.trim();
  // The heading names what was being attempted; the catalogue string says what
  // is missing. That split is why these keep their own titles rather than the
  // "went wrong" one — nothing went wrong, the form is simply not finished.
  if (!firstName || !lastName) {
    return void alertDialog({
      title: t('roster.teacher_new'),
      body: t('roster.name_required'),
      okLabel: t('common.close'),
    });
  }

  const [created, error] = await send('/api/teachers', json({ firstName, lastName }));
  if (error) return void showError(error);
  $('t-first').value = '';
  $('t-last').value = '';
  await loadTeachers();
  showSlips([created], t('roster.slips_new_teacher'));
});

// --- classes -----------------------------------------------------------------

async function loadClasses() {
  classes = (await get('/api/classes'))?.classes ?? [];
  $('classes').innerHTML = classes.length
    ? `<table>
        <thead><tr><th>${esc(t('common.class_code'))}</th><th>${esc(t('common.name'))}</th>
          <th>${esc(t('common.teacher'))}</th><th>${esc(t('common.school_year'))}</th>
          <th class="num">${esc(t('common.students'))}</th><th class="act"></th></tr></thead>
        <tbody>${classes
          .map(
            (c) => `<tr class="row${c.id === selected ? ' sel' : ''}" data-id="${c.id}">
              <td><code>${esc(c.code)}</code></td>
              <td>${esc(c.name)}${c.state === 'active' ? '' : ` <span class="tag warn">${esc(t('common.archived'))}</span>`}</td>
              <td>${esc(c.teacherName)}</td>
              <td class="quiet">${esc(c.schoolYear ?? '—')}</td>
              <td class="num">${c.memberCount}</td>
              <td class="act"><button class="small">${esc(t('roster.open'))}</button></td>
            </tr>`,
          )
          .join('')}</tbody>
      </table>`
    : `<p class="quiet">${esc(t('common.no_classes'))}</p>`;

  for (const row of $('classes').querySelectorAll('tr.row')) {
    row.addEventListener('click', () => void openClass(Number(row.dataset.id)));
  }
}

$('c-create').addEventListener('click', async () => {
  const code = $('c-code').value.trim();
  const name = $('c-name').value.trim();
  const schoolYear = $('c-year').value.trim();
  if (!code || !name) {
    return void alertDialog({
      title: t('roster.class_new'),
      body: t('roster.class_required'),
      okLabel: t('common.close'),
    });
  }

  const [payload, error] = await send(
    '/api/classes',
    json({
      code,
      name,
      ...(schoolYear ? { schoolYear } : {}),
      ...(me.user.role === 'admin' ? { teacherId: Number($('c-teacher').value) } : {}),
    }),
  );
  if (error) return void showError(error);
  $('c-code').value = '';
  $('c-name').value = '';
  await loadClasses();
  await openClass(payload.class.id);
});

// --- one class's roster ------------------------------------------------------

async function openClass(id) {
  selected = id;
  await loadClasses();
  const klass = classes.find((c) => c.id === id);
  $('roster-title').textContent = klass ? `${klass.code} — ${klass.name}` : t('roster.class');
  $('roster-section').hidden = false;
  await loadRoster();
  $('roster-section').scrollIntoView({ block: 'nearest' });
}

async function loadRoster() {
  roster = (await get(`/api/classes/${selected}/students`))?.students ?? [];
  // `state` as well as `lastLoginAt`: archiving takes the Postgres login away,
  // so a slip for an archived account is a slip that cannot be used. Found by
  // archiving a student and watching the count stay put — the never-logged-in
  // test alone is necessary but not sufficient.
  const unused = roster.filter((s) => s.state === 'active' && s.lastLoginAt === null);

  $('roster').innerHTML = roster.length
    ? `<table>
        <thead><tr><th>${esc(t('common.name'))}</th><th>${esc(t('common.username'))}</th>
          <th>${esc(t('roster.col_first_login'))}</th>
          <th>${esc(t('common.state'))}</th><th class="act"></th></tr></thead>
        <tbody>${roster
          .map(
            (s) => `<tr>
              <td>${esc(s.displayName)}</td>
              <td><code>${esc(s.username)}</code></td>
              <td class="quiet">${
                s.lastLoginAt
                  // `de-CH` or `en-CH`: the language follows the interface,
                  // the region does not, so this stays day-first in both and
                  // differs only in zero-padding. `formats()` in `i18n.js`.
                  ? esc(formats().date(new Date(s.lastLoginAt)))
                  : `<span class="tag">${esc(t('roster.never'))}</span>`
              }</td>
              <td>${s.state === 'active' ? `<span class="quiet">${esc(t('common.active'))}</span>` : `<span class="tag warn">${esc(stateLabel(s.state))}</span>`}</td>
              <td class="act">
                <button class="small" data-reslip="${s.id}">${esc(t('roster.reslip'))}</button>
                <button class="small" data-state="${s.id}">${esc(s.state === 'active' ? t('roster.archive') : t('roster.activate'))}</button>
                ${
                  // The newline above is load-bearing: these buttons are
                  // inline-block and it is the whitespace text node between
                  // them that draws the 3 px gap. Interpolating directly onto
                  // `</button>` closed it to 0 and made two separate controls
                  // look like one — measured, not noticed by eye.
                  //
                  // Cold storage is admin-only (routes/students.ts: it answers
                  // instance-wide disk pressure, which one teacher cannot see
                  // and should not have to judge). Rendering it for a teacher
                  // would be a button that returns 400 — the route's `oneOf`
                  // does not even list the state for them.
                  me.user.role === 'admin' && s.state !== 'cold'
                    ? `<button class="small" data-cold="${s.id}">${esc(t('roster.cold'))}</button>`
                    : ''
                }
                <button class="small" data-remove="${s.id}">${esc(t('roster.remove'))}</button>
                <button class="small btn-danger" data-delete="${s.id}">${esc(t('roster.delete'))}</button>
              </td>
            </tr>`,
          )
          .join('')}</tbody>
      </table>`
    : `<p class="quiet">${esc(t('common.class_empty'))}</p>`;

  // Offered only when it can do no harm — see the header, point 3. It is also
  // the reason "Erste Anmeldung" is a column: the teacher can see for
  // themselves which accounts the button will touch before pressing it.
  //
  // **The label is the action and nothing else.** It used to be the whole
  // sentence, with the caveat trailing inline beside it, and a usability pass
  // found it read as a caption rather than as a control. The count and the
  // caveat are prose, so they belong in prose — `<p class="quiet msg">` is what
  // the rest of this page puts helper text in (roster.html).
  //
  // Two keys rather than one with a `{count}`: German needs "eine:n Lernende:n"
  // in the singular, so the sentence changes in more places than the number.
  $('roster-msg').innerHTML = unused.length
    ? `<button id="reissue">${esc(t('roster.reissue'))}</button>
       <p class="quiet msg">${esc(
         unused.length === 1
           ? t('roster.reissue_one')
           : t('roster.reissue_many', { count: unused.length }),
       )} ${esc(t('roster.reissue_note'))}</p>`
    : '';
  if (unused.length) $('reissue').addEventListener('click', () => void reissueUnused(unused));

  for (const button of $('roster').querySelectorAll('[data-reslip]')) {
    button.addEventListener('click', () => void reslipStudent(Number(button.dataset.reslip)));
  }
  for (const button of $('roster').querySelectorAll('[data-state]')) {
    button.addEventListener('click', () => void toggleState(Number(button.dataset.state)));
  }
  for (const button of $('roster').querySelectorAll('[data-remove]')) {
    button.addEventListener('click', () => void removeMember(Number(button.dataset.remove)));
  }
  for (const button of $('roster').querySelectorAll('[data-cold]')) {
    button.addEventListener('click', () => void coldStore(Number(button.dataset.cold)));
  }
  for (const button of $('roster').querySelectorAll('[data-delete]')) {
    button.addEventListener('click', () => void deleteStudent(Number(button.dataset.delete)));
  }
}

/**
 * The state as a word the reader knows, not the enum.
 *
 * It used to interpolate `s.state` raw, which put the literal `archived` in a
 * German page. That went unnoticed while `archived` was the only non-active
 * state a teacher could reach from here; phase 7.3 adds `cold`, which would have
 * read as an English word nobody in the room uses.
 *
 * Falls back to the raw value rather than to a blank: an unmapped state is a
 * bug, and the enum name is the most useful thing to show whoever has to find
 * it. `deleted` is deliberately absent — `listStudents` filters those rows out,
 * so it is unreachable here and a key for it would be dead weight.
 */
const STATE_KEYS = {
  active: 'common.active',
  archived: 'common.archived',
  cold: 'common.cold',
};
const stateLabel = (state) => (STATE_KEYS[state] ? t(STATE_KEYS[state]) : state);

async function reslipStudent(id) {
  const student = roster.find((s) => s.id === id);
  const go = await ask({
    title: t('roster.reslip'),
    body: t('roster.reslip_student_confirm', { name: student.displayName }),
    confirmLabel: t('roster.reslip'),
  });
  if (!go) return;
  const [created, error] = await send(`/api/students/${id}/password`, json());
  if (error) return void showError(error);
  await loadRoster();
  showSlips([created], t('roster.slips_reslip_student', { name: student.displayName }));
}

/**
 * The recovery path: one click instead of thirty.
 *
 * Sequential, not `Promise.all`. Each reset is a scrypt hash — ~100 ms of CPU
 * and 16 MB, deliberately — plus a transaction, and `services/users.ts` makes
 * the same argument for the same reason on the create path: firing thirty at
 * once queues on the pool anyway and makes a partial failure much harder to
 * read in the audit log.
 *
 * A failure part way through is reported *and* the slips gathered so far are
 * still shown, because those passwords are already the live ones. Throwing them
 * away to report an error cleanly would lock out exactly the students the
 * button just re-slipped.
 */
async function reissueUnused(unused) {
  const go = await ask({
    title: t('roster.reissue'),
    body: t('roster.reissue_confirm', { count: unused.length }),
    confirmLabel: t('roster.reissue'),
  });
  if (!go) return;

  const button = $('reissue');
  button.disabled = true;
  const created = [];
  let failure = null;

  for (const [index, student] of unused.entries()) {
    button.textContent = `${index + 1} / ${unused.length} …`;
    const [payload, error] = await send(`/api/students/${student.id}/password`, json());
    if (error) {
      failure = `${student.username}: ${error}`;
      break;
    }
    created.push(payload);
  }

  await loadRoster();
  if (created.length) showSlips(created, t('roster.slips_reissued'));
  if (failure) {
    await alertDialog({
      title: t('roster.reissue'),
      body: t('roster.reissue_aborted', { failure }),
      okLabel: t('common.close'),
    });
  }
}

async function toggleState(id) {
  const student = roster.find((s) => s.id === id);
  const state = student.state === 'active' ? 'archived' : 'active';
  const [, error] = await send(`/api/students/${id}/state`, json({ state }, 'PATCH'));
  if (error) return void showError(error);
  await loadRoster();
}

async function removeMember(id) {
  const student = roster.find((s) => s.id === id);
  const go = await ask({
    title: t('roster.remove'),
    body: t('roster.remove_confirm', { name: student.displayName }),
    confirmLabel: t('roster.remove'),
  });
  if (!go) return;
  const [, error] = await send(`/api/classes/${selected}/members/${id}`, json(undefined, 'DELETE'));
  if (error) return void showError(error);
  await loadClasses();
  await loadRoster();
}

/**
 * Cold storage: dump the schema, drop it, keep the role NOLOGIN.
 *
 * **One confirm, not two, and that is the point of the difference.** This is
 * reversible — "Aktivieren" on the next line restores the dump, and the button
 * is already there because `roster.js` has always rendered any non-active state
 * with it. Escalating a reversible action to the same ceremony as deletion
 * would teach the reader that the ceremony means nothing, which is the way to
 * make the ceremony on `deleteStudent` stop working.
 *
 * Admin-only, and the button is not rendered for a teacher at all — see
 * `loadRoster`.
 */
async function coldStore(id) {
  const student = roster.find((s) => s.id === id);
  const go = await ask({
    title: t('roster.cold'),
    body: t('roster.cold_confirm', { name: student.displayName }),
    confirmLabel: t('roster.cold'),
  });
  if (!go) return;
  const [payload, error] = await send(`/api/students/${id}/state`, json({ state: 'cold' }, 'PATCH'));
  if (error) return void showError(error);
  // The dump is the whole operation, so a provisioning failure here is not a
  // detail: the row now says `cold` while the schema is still on disk, and it
  // is `reconcile.ts` rather than this page that will finish it.
  //
  // Awaited, because `confirm()`'s replacement does not block the way `alert()`
  // did: without it the list below re-renders underneath the open dialog.
  if (payload?.provisioning && payload.provisioning.ok === false) {
    await alertDialog({
      title: t('roster.cold'),
      body: t('roster.cold_incomplete', {
        name: student.displayName,
        error: payload.provisioning.error ?? '',
      }),
      okLabel: t('common.close'),
    });
  }
  await loadRoster();
}

/**
 * Deletion — dump to the archive, then drop schema and role.
 *
 * **Two confirms, saying different things.** The first asks the question and
 * names the person; the second states what is actually destroyed and what
 * survives. Two identical dialogs would be one dialog with an extra click, and
 * the click is not the safeguard — reading is. Both name the student, because
 * the row above this one is "Aus Klasse" and the failure this guards against is
 * as much *wrong student* as *wrong button*.
 *
 * What the copy must not do is overclaim in either direction. A dump really is
 * written first and the drop is skipped if it fails (`services/users.ts`), so
 * the work is not gone from the server — but nothing in this application can
 * bring the account back, because only `cold -> active` has a restore path. The
 * strings say exactly that: the data survives, the account does not.
 *
 * The row disappears afterwards rather than going grey: `listStudents` filters
 * `state <> 'deleted'`, so there is nothing left to render. `loadClasses()`
 * first, because the class list carries a member count that is now wrong.
 */
async function deleteStudent(id) {
  const student = roster.find((s) => s.id === id);
  const go = await ask({
    title: t('roster.delete'),
    body: t('roster.delete_confirm', { name: student.displayName }),
    confirmLabel: t('roster.delete'),
  });
  if (!go) return;
  // The second heading is not the first one again: two dialogs headed "Löschen"
  // would read as one dialog shown twice, which is the failure the two steps
  // exist to avoid.
  const sure = await ask({
    title: t('roster.delete_final'),
    body: t('roster.delete_confirm_final', {
      name: student.displayName,
      username: student.username,
    }),
    confirmLabel: t('common.delete'),
  });
  if (!sure) return;

  const [payload, error] = await send(
    `/api/students/${id}/state`,
    json({ state: 'deleted' }, 'PATCH'),
  );
  if (error) return void showError(error);

  // `provisioning.ok === false` is the case worth telling the truth about: the
  // account row is `deleted` and the student has vanished from this list, but
  // the dump failed and so the drop was skipped — their schema is still there.
  // Saying nothing would leave a teacher believing the disk was freed.
  if (payload?.provisioning && payload.provisioning.ok === false) {
    await alertDialog({
      title: t('roster.delete'),
      body: t('roster.delete_incomplete', {
        name: student.displayName,
        error: payload.provisioning.error ?? '',
      }),
      okLabel: t('common.close'),
    });
  }
  await loadClasses();
  await loadRoster();
}

// --- pasting a class ---------------------------------------------------------

function renderPreview() {
  const people = parseNames($('paste').value, $('order').value);
  $('s-create').disabled = people.length === 0;

  if (people.length === 0) {
    $('preview').innerHTML = '';
    return;
  }

  // A name already in the class is almost always a double paste rather than two
  // real people. It is only a warning because two real "Muster Lena" do happen —
  // but the second becomes `u_k3a_muster_lena2` permanently, so it should be a
  // decision rather than a surprise (§4aa).
  const existing = new Set(roster.map((s) => s.displayName.toLowerCase()));
  const rows = people
    .map((p) => {
      const full = `${p.firstName} ${p.lastName}`.trim().toLowerCase();
      const clash = existing.has(full);
      return `<tr>
        <td>${esc(p.firstName) || `<span class="bad">${esc(t('roster.missing'))}</span>`}</td>
        <td>${esc(p.lastName)}</td>
        <td>${clash ? `<span class="tag warn">${esc(t('roster.already_in_class'))}</span>` : ''}</td>
      </tr>`;
    })
    .join('');

  const missing = people.filter((p) => p.firstName === '').length;
  $('preview').innerHTML = `<table>
      <thead><tr><th>${esc(t('common.first_name'))}</th><th>${esc(t('common.last_name'))}</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="msg${missing ? ' bad' : ' quiet'}">${esc(
      missing
        ? t('roster.preview_missing', { count: missing })
        : t('roster.preview_ok', { count: people.length }),
    )}</p>`;
}

$('paste').addEventListener('input', renderPreview);
$('order').addEventListener('change', renderPreview);

$('s-create').addEventListener('click', async () => {
  const students = parseNames($('paste').value, $('order').value);
  if (students.some((p) => p.firstName === '')) {
    return void alertDialog({
      title: t('roster.add_students'),
      body: t('roster.no_first_name'),
      okLabel: t('common.close'),
    });
  }
  // Not `danger`: this asks because the slips appear exactly once and the
  // usernames are permanent, not because anything is destroyed. A red "Anlegen"
  // would spend the colour that has to still mean something on "Löschen".
  const go = await ask({
    title: t('roster.add_students'),
    body: t('roster.create_confirm', { count: students.length }),
    confirmLabel: t('common.create'),
    danger: false,
  });
  if (!go) return;

  $('s-create').disabled = true;
  const [payload, error] = await send(`/api/classes/${selected}/students`, json({ students }));
  $('s-create').disabled = false;
  if (error) return void showError(error);

  $('paste').value = '';
  renderPreview();
  await loadClasses();
  await loadRoster();
  showSlips(payload.students, t('roster.slips_for', { class: $('roster-title').textContent }));
});

// --- chrome ------------------------------------------------------------------

$('print').addEventListener('click', () => print());
$('slips-done').addEventListener('click', async () => {
  // Not `danger`: what is at stake is a view, not data — the passwords stay
  // valid, they just stop being readable. Red would say the opposite of what
  // the sentence says.
  const go = await ask({
    title: t('common.close'),
    body: t('roster.close_confirm'),
    confirmLabel: t('common.close'),
    danger: false,
  });
  if (go) closeSlips();
});

// --- boot --------------------------------------------------------------------

// Started before the cached paint rather than awaited, so the round trip hides
// behind the first frame instead of sitting in front of it (`paintCached()`).
const mePromise = get('/api/me');
await paintCached();
const paintTheme = wireThemeToggle($('theme'), (dark) =>
  t(dark ? 'nav.theme_light' : 'nav.theme_dark'),
);

me = await mePromise;
if (!me) {
  location.href = loginUrl();
} else if (me.user.mustChangePassword) {
  location.href = '/password';
} else if (me.user.role === 'student') {
  location.href = '/sql';
} else {
  /**
   * Before anything renders. The page ships with German in its markup and this
   * swaps it, so doing it after `loadClasses()` would leave the tables — which
   * are built by script — in the wrong language entirely.
   *
   * `app_user.locale` is the source of truth. Phase 7 added a
   * `localStorage["chalk-lang"]` mirror, but only as a paint-ahead cache — this
   * call is what overrides it, and removing it would promote the cache to an
   * authority. `i18n.js`'s header has the argument.
   */
  await load(me.user.locale);
  apply();
  // After apply(), not before: the toggle's label depends on which way it
  // currently points, which no `data-i18n` key can express.
  paintTheme();
  wireLanguageToggle($('lang'));
  // The demo countdown, if this session is a demo lease. `me.demo` is null for
  // every real account, so the call is unconditional (HANDOFF §9g).
  mountDemoBanner(me.demo, t);
  mountVersion($('version'), (d) => formats().dateTime(d));
  wireLogout($('logout'));
  // The bar is the same markup on all five pages; this is what makes it about
  // this one. Only reached by staff — the redirect below sends a student away.
  mountNav(me.user.role);

  $('sub').textContent = `${me.user.displayName} · ${
    me.user.role === 'admin' ? t('common.role_admin') : t('common.role_teacher')
  }`;
  if (me.user.role === 'admin') {
    $('teachers-section').hidden = false;
    await loadTeachers();
  }
  await loadClasses();
  if (classes.length === 1) await openClass(classes[0].id);
}
