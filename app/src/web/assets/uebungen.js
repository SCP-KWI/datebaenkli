/**
 * The exercises page — phase 9.
 *
 * One page and two audiences, branching on role the way `home.js` does. The
 * student's half is a list; the teacher's half is where an exercise is actually
 * built.
 *
 * ## Why the student *works* somewhere else
 *
 * This page hands a student a link to `/sql?uebung=<id>` rather than giving them
 * an editor here. That is not a layout preference: the CodeMirror bundle is the
 * app's only bundled entry point and CLAUDE.md says there will not be a second,
 * so there is exactly one page in this application with a SQL editor on it. The
 * shape of this feature follows from that constraint rather than fighting it,
 * and it turns out to be the right shape anyway — the exercise's tables belong
 * beside the schema browser, which is also only there.
 *
 * ## Why the teacher's SQL box is a `<textarea>`
 *
 * Same constraint, opposite conclusion. A teacher pasting a schema dump wants a
 * big box; highlighting would be nice and is not worth a second bundle.
 *
 * ## Two things that would be bugs if written the obvious way
 *
 * **Take-back and delete are behind two dialogs, and they say different things.**
 * `roster.js` set that precedent for deleting a student and its header has the
 * argument: two identical confirms are one confirm with an extra click. The
 * first asks the question, the second states what does not survive — here, that
 * the hand-ins go too.
 *
 * **The task preview goes through `markdown.js`, never through a template
 * string.** The task is text one person writes and twenty-five read, and it is
 * the only untrusted-ish thing in this app that reaches `innerHTML`. That module
 * escapes first and inserts tags second; anything else here uses `esc()`.
 *
 * ## The draft, and the bug it exists for
 *
 * This screen has two save models on it and always did: the title and the task
 * are held until "Speichern", while a table, a distribution and a take-back
 * commit the moment their dialog closes. That is not sloppiness — a `<textarea>`
 * that saved on every keystroke would write a row per character — but the two
 * models met badly. Every action in the lower half ends in `openExercise()`,
 * which refetches and repaints the pane, and the repaint took the typed title
 * and task with it. A teacher who wrote the task first and added the tables
 * second — the natural order — lost the text with no warning and no way back.
 *
 * `draft` is the fix and it is deliberately not autosave: what is on screen is
 * kept across a repaint, said out loud in a bar that only appears while it is
 * true, and is still the teacher's to save or discard. `beforeunload` covers the
 * one exit a repaint cannot: closing the tab.
 */

import { openImportDialog, post } from '/assets/csv-import.js';
import { apply, errorText, formats, load, paintCached, t, wireLanguageToggle } from '/assets/i18n.js';
import { renderMarkdown } from '/assets/markdown.js';
import {
  confirmDialog,
  esc,
  json,
  mountDemoBanner,
  mountNav,
  mountVersion,
  wireLogout,
  wireThemeToggle,
} from '/assets/util.js';

const $ = (id) => document.getElementById(id);

let me = null;
let list = [];
let classes = [];
/** The exercise open in the detail pane, in full. Null when none is. */
let open = null;

/**
 * The unsaved title and task, when they differ from the saved exercise.
 * `{ id, title, taskMd }`, or null when the form matches what the server holds.
 *
 * **It carries the exercise's id**, which is the whole reason it is an object
 * rather than two strings: the same pane shows any exercise in the list, and a
 * draft applied to the wrong one would be worse than the loss it prevents — it
 * would overwrite a second exercise with the first one's text.
 */
let draft = null;

/**
 * Read the form into `draft`, before anything repaints over it.
 *
 * Comparing against `open` rather than tracking an `oninput` flag: typing a
 * character and deleting it again leaves no change to save, and an indicator
 * that lights up for that teaches the reader to ignore it.
 */
function captureDraft() {
  if (!open || !$('title')) return;
  const title = $('title').value;
  const taskMd = $('task').value;
  draft =
    title === open.title && taskMd === open.taskMd ? null : { id: open.id, title, taskMd };
}

/** The draft's values if they belong to the exercise on screen; null otherwise. */
const draftFor = (id) => (draft && draft.id === id ? draft : null);

/** Paint the unsaved-changes bar. Called on every keystroke, so it does no work. */
function paintDirty() {
  const dirty = Boolean(draftFor(open?.id));
  const bar = $('unsaved');
  if (bar) bar.hidden = !dirty;
}

// --- transport ---------------------------------------------------------------

const get = async (url) => {
  const response = await fetch(url).catch(() => null);
  if (!response) return null;
  if (response.status === 401) {
    location.href = '/login';
    return null;
  }
  return response.ok ? response.json() : null;
};

/**
 * A mutating call, returning `[payload, errorMessage]`. Never throws — every
 * caller is a click handler, and an unhandled rejection in one is a button that
 * does nothing with no explanation. Same shape as `roster.js`'s.
 */
async function send(url, options) {
  const response = await fetch(url, options).catch(() => null);
  if (!response) return [null, t('error.offline')];
  if (response.status === 401) {
    location.href = '/login';
    return [null, t('error.unauthenticated')];
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    return [
      null,
      payload?.error ? errorText(payload.error) : t('common.failed', { status: response.status }),
    ];
  }
  return [payload, null];
}

const when = (value) => (value ? formats().dateTime(new Date(value)) : '—');

// --- the student's list ------------------------------------------------------

function renderMine() {
  if (list.length === 0) {
    $('mineList').innerHTML = `<p class="note">${esc(t('ex.none_yet'))}</p>`;
    return;
  }

  $('mineList').innerHTML = list
    .map(
      (exercise) => `
        <article class="card ex-card">
          <div class="hstack">
            <h2>${esc(exercise.title)}</h2>
            ${
              exercise.schema
                ? `<span class="tag">${esc(t('ex.opened'))}</span>`
                : `<span class="tag warn">${esc(t('ex.not_opened'))}</span>`
            }
          </div>
          <p class="sub">${esc(t('ex.by', { name: exercise.teacherName }))}</p>
          <div class="ex-task">${renderMarkdown(exercise.taskMd)}</div>
          <div class="hstack ex-actions">
            <a class="btn btn-primary" href="/sql?uebung=${encodeURIComponent(exercise.id)}"
               >${esc(t('ex.work_on'))}</a>
            <span class="small muted">${esc(
              exercise.submissions === 0
                ? t('ex.no_handins')
                : t('ex.handin_count', {
                    count: exercise.submissions,
                    when: when(exercise.lastSubmittedAt),
                  }),
            )}</span>
            ${
              exercise.submissions > 0
                ? `<button class="small" data-mine="${exercise.id}">${esc(t('ex.my_handins'))}</button>`
                : ''
            }
          </div>
        </article>`,
    )
    .join('');

  for (const button of $('mineList').querySelectorAll('[data-mine]')) {
    button.onclick = () => void showMyHandins(Number(button.dataset.mine));
  }
}

async function showMyHandins(exerciseId) {
  const exercise = list.find((e) => e.id === exerciseId);
  const payload = await get(`/api/my/exercises/${exerciseId}/submissions`);
  const submissions = payload?.submissions ?? [];
  $('handinTitle').textContent = exercise?.title ?? t('ex.heading');
  $('handinBody').innerHTML = submissions
    .map(
      (s) => `
        <section class="handin">
          <div class="hstack">
            <strong>${esc(t('ex.attempt', { n: s.attempt }))}</strong>
            <span class="small muted">${esc(when(s.createdAt))}</span>
            <a class="btn small"
               href="/api/my/exercises/${exerciseId}/submissions/${s.id}/download"
               >${esc(t('ex.download'))}</a>
          </div>
          ${s.note ? `<p class="small">${esc(s.note)}</p>` : ''}
          <pre><code>${esc(s.sqlText)}</code></pre>
        </section>`,
    )
    .join('');
  $('handinDialog').showModal();
}

// --- the teacher's list ------------------------------------------------------

function renderList() {
  if (list.length === 0) {
    $('list').innerHTML = `<p class="small muted">${esc(t('ex.none_authored'))}</p>`;
    return;
  }
  $('list').innerHTML = list
    .map(
      (exercise) => `
        <button class="ex-item${open?.id === exercise.id ? ' sel' : ''}" data-open="${exercise.id}">
          <span class="ex-item-title">${esc(exercise.title)}</span>
          <span class="small muted">${esc(when(exercise.updatedAt))}</span>
        </button>`,
    )
    .join('');
  for (const button of $('list').querySelectorAll('[data-open]')) {
    button.onclick = () => void openExercise(Number(button.dataset.open));
  }
}

async function reloadList() {
  const payload = await get('/api/exercises');
  list = payload?.exercises ?? [];
  renderList();
}

/**
 * Fetch an exercise and show it.
 *
 * Called both to *switch* exercises and to repaint the one already open after
 * something in the lower half of the pane changed the server's copy. Those two
 * want opposite things from an unsaved draft — a repaint must keep it, a switch
 * must not carry it to another exercise — which is why the capture happens first
 * and the discard question is asked only when the id actually changes.
 */
async function openExercise(id) {
  captureDraft();
  if (draft && draft.id !== id) {
    const discard = await confirmDialog({
      title: t('ex.unsaved_title'),
      body: t('ex.unsaved_leave'),
      confirmLabel: t('ex.discard'),
      cancelLabel: t('common.cancel'),
    });
    if (!discard) return;
    draft = null;
  }

  const payload = await get(`/api/exercises/${id}`);
  if (!payload) return;
  open = payload.exercise;
  renderList();
  renderDetail();
}

// --- the teacher's detail pane -----------------------------------------------

/** Which classes this exercise has *not* been handed to yet. */
const undistributed = () =>
  classes.filter((klass) => !open.assignments.some((a) => a.classId === klass.id));

function renderDetail() {
  if (!open) {
    $('detail').innerHTML = `<p class="note">${esc(t('ex.pick'))}</p>`;
    return;
  }

  // The draft, where there is one, is what the fields show — this function runs
  // after every table change, and rendering `open` here is precisely the bug it
  // used to have.
  const shown = draftFor(open.id) ?? open;

  $('detail').innerHTML = `
    <div class="card stack">
      <div class="hstack ex-detail-head">
        <input type="text" id="title" class="ex-title" maxlength="200"
               value="${esc(shown.title)}" />
        <button id="save" class="primary small">${esc(t('common.save'))}</button>
        <button id="del" class="btn-danger small">${esc(t('common.delete'))}</button>
      </div>
      <p class="msg quiet" id="saveStatus"></p>

      <div class="ex-task-edit">
        <label class="block"><span>${esc(t('ex.task'))}</span>
          <textarea id="task" rows="10" spellcheck="true">${esc(shown.taskMd)}</textarea>
        </label>
        <div>
          <span class="eyebrow">${esc(t('ex.preview'))}</span>
          <div class="ex-task" id="taskPreview"></div>
        </div>
      </div>
    </div>

    <div class="card stack">
      <div class="hstack ex-list-head">
        <h2>${esc(t('ex.tables'))}</h2>
        <button id="addCsv" class="small">${esc(t('ex.add_csv'))}</button>
        <button id="addSql" class="small">${esc(t('ex.add_sql'))}</button>
      </div>
      ${
        open.sources.length === 0
          ? `<p class="small muted">${esc(t('ex.no_tables'))}</p>`
          : `<div class="table-wrap"><table>
               <tbody>${open.sources
                 .map(
                   (source, i) => `
                     <tr>
                       <td><span class="tag">${esc(source.kind)}</span></td>
                       <td><code>${esc(source.label)}</code></td>
                       <td class="small muted">${esc(
                         source.kind === 'csv'
                           ? t('ex.csv_summary', {
                               rows: source.rowCount ?? 0,
                               columns: source.columns?.length ?? 0,
                             })
                           : t('ex.sql_summary'),
                       )}</td>
                       <td class="act">
                         ${
                           source.kind === 'sql'
                             ? `<button class="small" data-edit="${source.id}">${esc(t('common.edit'))}</button>`
                             : ''
                         }
                         <!-- Both arrows, not just "↑". One arrow does move a
                              row down — you move the row *below* it up — and a
                              teacher should not have to work that out. -->
                         <button class="small" data-up="${source.id}" ${i === 0 ? 'disabled' : ''}
                                 title="${esc(t('ex.move_up'))}"
                                 aria-label="${esc(t('ex.move_up'))}">↑</button>
                         <button class="small" data-down="${source.id}"
                                 ${i === open.sources.length - 1 ? 'disabled' : ''}
                                 title="${esc(t('ex.move_down'))}"
                                 aria-label="${esc(t('ex.move_down'))}">↓</button>
                         <button class="small btn-danger" data-drop="${source.id}"
                                 >${esc(t('common.delete'))}</button>
                       </td>
                     </tr>`,
                 )
                 .join('')}</tbody>
             </table></div>`
      }
      <p class="msg quiet" id="sourceStatus"></p>
    </div>

    <div class="card stack">
      <h2>${esc(t('ex.distribution'))}</h2>
      ${
        open.assignments.length === 0
          ? `<p class="small muted">${esc(t('ex.not_distributed'))}</p>`
          : `<div class="table-wrap"><table>
               <thead><tr>
                 <th>${esc(t('ex.class'))}</th>
                 <th class="num">${esc(t('ex.opened_by'))}</th>
                 <th class="num">${esc(t('ex.handins'))}</th>
                 <th class="act"></th>
               </tr></thead>
               <tbody>${open.assignments
                 .map(
                   (a) => `
                     <tr>
                       <td><strong>${esc(a.code)}</strong> ${esc(a.name)}</td>
                       <td class="num">${a.openedBy}</td>
                       <td class="num">${a.submissions}</td>
                       <td class="act">
                         <button class="small" data-handins="${a.classId}"
                                 >${esc(t('ex.view_handins'))}</button>
                         <a class="btn small"
                            href="/api/exercises/${open.id}/classes/${a.classId}/download"
                            >${esc(t('ex.download_all'))}</a>
                         <button class="small btn-danger" data-take="${a.classId}"
                                 >${esc(t('ex.take_back'))}</button>
                       </td>
                     </tr>`,
                 )
                 .join('')}</tbody>
             </table></div>`
      }
      ${
        undistributed().length === 0
          ? ''
          : `<div class="hstack">
               <select id="klass">${undistributed()
                 .map((k) => `<option value="${k.id}">${esc(k.code)} — ${esc(k.name)}</option>`)
                 .join('')}</select>
               <button id="give" class="primary small">${esc(t('ex.distribute'))}</button>
             </div>`
      }
      <p class="msg quiet" id="giveStatus"></p>
    </div>

    <div class="card stack">
      <h2>${esc(t('ex.try_it'))}</h2>
      <p class="small muted">${esc(t('ex.try_it_why'))}</p>
      <div class="hstack">
        <button id="tryIt" class="small">${esc(t('ex.build_mine'))}</button>
        <a class="btn small" href="/sql?uebung=${open.id}">${esc(t('ex.open_editor'))}</a>
        <span class="small" id="tryStatus"></span>
      </div>
    </div>

    <!--
      The unsaved-changes bar. Two problems in one control, both from the
      usability pass: there was no cue at all that a Speichern was still owed,
      and the only Speichern is at the very top of a pane long enough that a
      teacher adding tables cannot see it. Sticky to the bottom of the viewport,
      so it is under the hand that just typed; hidden whenever there is nothing
      to save, so the screen is unchanged the rest of the time.
    -->
    <div class="ex-unsaved" id="unsaved" hidden>
      <span>${esc(t('ex.unsaved'))}</span>
      <button id="discard" class="small">${esc(t('ex.discard'))}</button>
      <button id="saveBottom" class="primary small">${esc(t('common.save'))}</button>
    </div>`;

  $('taskPreview').innerHTML = renderMarkdown(shown.taskMd);
  $('title').oninput = () => {
    captureDraft();
    paintDirty();
  };
  $('task').oninput = () => {
    $('taskPreview').innerHTML = renderMarkdown($('task').value);
    captureDraft();
    paintDirty();
  };
  paintDirty();

  $('save').onclick = () => void saveExercise();
  $('saveBottom').onclick = () => void saveExercise();
  $('discard').onclick = () => void discardDraft();
  $('del').onclick = () => void deleteExercise();
  $('addCsv').onclick = () => void addCsv();
  $('addSql').onclick = () => void editSql(null);
  if ($('give')) $('give').onclick = () => void distribute();
  $('tryIt').onclick = () => void buildMine();

  for (const button of $('detail').querySelectorAll('[data-edit]')) {
    button.onclick = () => void editSql(Number(button.dataset.edit));
  }
  for (const button of $('detail').querySelectorAll('[data-drop]')) {
    button.onclick = () => void dropSource(Number(button.dataset.drop));
  }
  for (const button of $('detail').querySelectorAll('[data-up]')) {
    button.onclick = () => void move(Number(button.dataset.up), -1);
  }
  for (const button of $('detail').querySelectorAll('[data-down]')) {
    button.onclick = () => void move(Number(button.dataset.down), 1);
  }
  for (const button of $('detail').querySelectorAll('[data-take]')) {
    button.onclick = () => void takeBack(Number(button.dataset.take));
  }
  for (const button of $('detail').querySelectorAll('[data-handins]')) {
    button.onclick = () => void showClassHandins(Number(button.dataset.handins));
  }
}

// --- the teacher's actions ---------------------------------------------------

async function saveExercise() {
  const [payload, error] = await send(
    `/api/exercises/${open.id}`,
    json({ title: $('title').value, taskMd: $('task').value }, 'PATCH'),
  );
  const status = $('saveStatus');
  if (error) {
    status.className = 'msg bad';
    status.textContent = error;
    return;
  }
  // The list's titles and its ordering both come from what was just saved.
  open = { ...open, ...payload.exercise };
  // Saved is saved: the draft has become the exercise, and leaving it set would
  // keep the bar on screen claiming otherwise.
  draft = null;
  paintDirty();
  status.className = 'msg quiet';
  status.textContent = t('ex.saved');
  await reloadList();
}

/** Throw the draft away and put the saved text back on screen. */
async function discardDraft() {
  const yes = await confirmDialog({
    title: t('ex.discard'),
    body: t('ex.discard_confirm'),
    confirmLabel: t('ex.discard'),
    cancelLabel: t('common.cancel'),
  });
  if (!yes) return;
  draft = null;
  renderDetail();
}

async function deleteExercise() {
  if (
    !(await confirmDialog({
      title: t('common.delete'),
      body: t('ex.delete_confirm', { title: open.title }),
      confirmLabel: t('common.delete'),
      cancelLabel: t('common.cancel'),
    }))
  ) {
    return;
  }
  // The second dialog states what does not survive rather than repeating the
  // first. See this file's header, and `roster.js`'s.
  if (
    !(await confirmDialog({
      title: t('common.delete'),
      body: t('ex.delete_confirm_final', { title: open.title }),
      confirmLabel: t('common.delete'),
      cancelLabel: t('common.cancel'),
    }))
  ) {
    return;
  }
  const [, error] = await send(`/api/exercises/${open.id}`, json(undefined, 'DELETE'));
  if (error) {
    $('saveStatus').className = 'msg bad';
    $('saveStatus').textContent = error;
    return;
  }
  open = null;
  // The exercise it belonged to no longer exists.
  draft = null;
  await reloadList();
  renderDetail();
}

async function addCsv() {
  const result = await openImportDialog({
    previewUrl: '/api/exercises/preview',
    // No "replace": the target schema is built from these sources, so there is
    // never an existing table for a fixture to replace.
    showReplace: false,
    submit: async (payload) => {
      const { source } = await post(`/api/exercises/${open.id}/sources/csv`, {
        label: payload.table,
        csv: payload.csv,
        columns: payload.columns,
        delimiter: payload.delimiter,
        hasHeader: payload.hasHeader,
      });
      // Normalised to the shape the dialog expects to report on success.
      return { ok: true, table: source.label, rowCount: source.rowCount ?? 0 };
    },
  });
  if (result) await openExercise(open.id);
}

/** `sourceId` null adds a new script; a number edits by replacing it. */
async function editSql(sourceId) {
  let existing = null;
  if (sourceId !== null) {
    const payload = await get(`/api/exercises/${open.id}/sources/${sourceId}`);
    existing = payload?.source ?? null;
  }
  $('sqlLabel').value = existing?.label ?? '';
  $('sqlBody').value = existing?.sqlText ?? '';
  $('sqlStatus').textContent = '';
  $('sqlDialog').showModal();

  $('sqlCancel').onclick = () => $('sqlDialog').close();
  $('sqlSave').onclick = async () => {
    const body = json({ label: $('sqlLabel').value, sql: $('sqlBody').value });
    // Editing is delete-then-add rather than a PATCH route. A script has no
    // identity worth preserving — nothing references it — and one write path is
    // one thing to get right. It does move the script to the end of the order,
    // which the arrows fix and which is why they exist.
    const [, error] = await send(`/api/exercises/${open.id}/sources/sql`, body);
    if (error) {
      $('sqlStatus').className = 'msg bad';
      $('sqlStatus').textContent = error;
      return;
    }
    if (sourceId !== null) {
      await send(`/api/exercises/${open.id}/sources/${sourceId}`, json(undefined, 'DELETE'));
    }
    $('sqlDialog').close();
    await openExercise(open.id);
  };
}

async function dropSource(sourceId) {
  const source = open.sources.find((s) => s.id === sourceId);
  const yes = await confirmDialog({
    title: t('common.delete'),
    body: t('ex.drop_source_confirm', { label: source?.label ?? '' }),
    confirmLabel: t('common.delete'),
    cancelLabel: t('common.cancel'),
  });
  if (!yes) return;
  const [, error] = await send(
    `/api/exercises/${open.id}/sources/${sourceId}`,
    json(undefined, 'DELETE'),
  );
  if (error) {
    $('sourceStatus').className = 'msg bad';
    $('sourceStatus').textContent = error;
    return;
  }
  await openExercise(open.id);
}

/** `step` is -1 for the up arrow and +1 for the down one. */
async function move(sourceId, step) {
  const ids = open.sources.map((s) => s.id);
  const at = ids.indexOf(sourceId);
  const to = at + step;
  if (at < 0 || to < 0 || to >= ids.length) return;
  [ids[to], ids[at]] = [ids[at], ids[to]];
  const [, error] = await send(`/api/exercises/${open.id}/sources/order`, json({ ids }));
  if (error) {
    $('sourceStatus').className = 'msg bad';
    $('sourceStatus').textContent = error;
    return;
  }
  await openExercise(open.id);
}

async function distribute() {
  const [, error] = await send(
    `/api/exercises/${open.id}/classes`,
    json({ classId: Number($('klass').value) }),
  );
  if (error) {
    $('giveStatus').className = 'msg bad';
    $('giveStatus').textContent = error;
    return;
  }
  await openExercise(open.id);
}

async function takeBack(classId) {
  const assignment = open.assignments.find((a) => a.classId === classId);
  const asked = await confirmDialog({
    title: t('ex.take_back'),
    body: t('ex.take_back_confirm', { klass: assignment?.code ?? '' }),
    confirmLabel: t('ex.take_back'),
    cancelLabel: t('common.cancel'),
  });
  if (!asked) return;
  // The second dialog names the numbers rather than repeating the question:
  // this is the one action on the page that destroys other people's work, and
  // the count is what makes that concrete.
  const confirmed = await confirmDialog({
    title: t('ex.take_back'),
    body: t('ex.take_back_confirm_final', {
      klass: assignment?.code ?? '',
      workspaces: assignment?.openedBy ?? 0,
      handins: assignment?.submissions ?? 0,
    }),
    confirmLabel: t('ex.take_back'),
    cancelLabel: t('common.cancel'),
  });
  if (!confirmed) return;

  const [payload, error] = await send(
    `/api/exercises/${open.id}/classes/${classId}`,
    json(undefined, 'DELETE'),
  );
  if (error) {
    $('giveStatus').className = 'msg bad';
    $('giveStatus').textContent = error;
    return;
  }
  // The one repaint that does not go through `openExercise()`, so the draft has
  // to be taken here — `renderDetail()` is about to replace the fields.
  captureDraft();
  open = payload.exercise;
  renderDetail();
  // Reported rather than swallowed: one schema that would not drop leaves the
  // rest correct, and the teacher has to be able to see that it happened.
  if (payload.failures?.length) {
    $('giveStatus').className = 'msg bad';
    $('giveStatus').textContent = t('ex.take_back_partial', { count: payload.failures.length });
  }
}

async function showClassHandins(classId) {
  const assignment = open.assignments.find((a) => a.classId === classId);
  const payload = await get(`/api/exercises/${open.id}/submissions?classId=${classId}`);
  const submissions = payload?.submissions ?? [];
  $('handinTitle').textContent = `${open.title} — ${assignment?.code ?? ''}`;
  $('handinBody').innerHTML = submissions.length
    ? submissions
        .map(
          (s) => `
            <section class="handin">
              <div class="hstack">
                <strong>${esc(s.displayName)}</strong>
                <span class="tag">${esc(t('ex.attempt', { n: s.attempt }))}</span>
                <span class="small muted">${esc(when(s.createdAt))}</span>
                <a class="btn small"
                   href="/api/exercises/${open.id}/submissions/${s.id}/download"
                   >${esc(t('ex.download'))}</a>
              </div>
              ${s.note ? `<p class="small">${esc(s.note)}</p>` : ''}
              <pre><code>${esc(s.sqlText)}</code></pre>
            </section>`,
        )
        .join('')
    : `<p class="note">${esc(t('ex.no_handins_yet'))}</p>`;
  $('handinDialog').showModal();
}

/**
 * Build the teacher their own copy, so they can run the fixtures before a class
 * does. `openWorkspace` answers `ok: false` with the source that broke, which is
 * the only thing that makes a bad script fixable by the person who wrote it.
 */
async function buildMine() {
  $('tryStatus').className = 'small muted';
  $('tryStatus').textContent = t('ex.building');
  const [payload, error] = await send(`/api/my/exercises/${open.id}/open`, json(undefined));
  if (error) {
    $('tryStatus').className = 'small bad';
    $('tryStatus').textContent = error;
    return;
  }
  if (!payload.ok) {
    $('tryStatus').className = 'small bad';
    $('tryStatus').textContent = t('ex.build_failed', {
      label: payload.failedSource?.label ?? '',
      message: payload.error?.message ?? '',
    });
    return;
  }
  $('tryStatus').className = 'small ok';
  $('tryStatus').textContent = payload.materialised
    ? t('ex.built', { schema: payload.schema })
    : t('ex.already_built', { schema: payload.schema });
}

// --- boot --------------------------------------------------------------------

const mePromise = get('/api/me');
await paintCached();
const paintTheme = wireThemeToggle($('theme'), (dark) =>
  t(dark ? 'nav.theme_light' : 'nav.theme_dark'),
);

me = await mePromise;
if (!me) location.href = '/login';

await load(me.user.locale);
apply();
paintTheme();
wireLanguageToggle($('lang'));
// The demo countdown, if this session is a demo lease. `me.demo` is null for
// every real account, so the call is unconditional (HANDOFF §9g).
mountDemoBanner(me.demo, t);
void mountVersion($('version'), (date) => formats().dateTime(date));

const staff = me.user.role === 'teacher' || me.user.role === 'admin';
// The bar. This page used to gate four of its entries itself, and its rule for
// `/lesson` differed from `home.js`'s for no reason anyone recorded — teacher
// there, staff here. `util.js` holds the one version now.
mountNav(me.user.role);
wireLogout($('logout'));
$('handinClose').onclick = () => $('handinDialog').close();

/**
 * The last exit a repaint cannot cover: the tab, the back button, one of the
 * nav buttons above.
 *
 * The browser shows its own wording here and ignores ours — every engine stopped
 * honouring the returned string years ago, because a page could put anything in
 * it. That is fine: the point is the pause, and the bar on screen has already
 * said what is unsaved in the app's own words.
 */
addEventListener('beforeunload', (event) => {
  captureDraft();
  if (!draft) return;
  event.preventDefault();
  // Still assigned, for the handful of old builds that key off it rather than
  // off `preventDefault()`.
  event.returnValue = '';
});

if (staff) {
  $('teach').hidden = false;
  const [exercises, klasses] = await Promise.all([get('/api/exercises'), get('/api/classes')]);
  list = exercises?.exercises ?? [];
  classes = klasses?.classes ?? [];
  renderList();
  renderDetail();

  $('new').onclick = async () => {
    const [payload, error] = await send('/api/exercises', json({ title: t('ex.untitled') }));
    if (error) return;
    await reloadList();
    await openExercise(payload.exercise.id);
  };
} else {
  $('mine').hidden = false;
  const payload = await get('/api/my/exercises');
  list = payload?.exercises ?? [];
  renderMine();
}
