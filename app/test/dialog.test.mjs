/**
 * The confirmation dialog, and the one thing about it a browser knows that
 * nothing else here does.
 *
 * ## Why this file exists at all
 *
 * `confirmDialog` in `assets/util.js` silently broke **every two-step
 * confirmation in the app** for four releases — deleting a student, deleting an
 * exercise, and taking an exercise back from a class. All three are the
 * destructive actions the second question was added to make safe, and all three
 * became no-ops: you clicked through both dialogs and nothing happened, with no
 * error, no request and nothing in the console. HANDOFF §23 has the full story.
 *
 * Nothing in the existing suite could have caught it, because the bug is not in
 * a pure function — it is in the *order* two browser mechanisms run in.
 *
 * ## The fake, and the one behaviour it encodes
 *
 * There is no DOM here and no jsdom (a fifth dependency, for one file). What
 * `fakeDom()` builds is a `<dialog>` with the single property this bug turns
 * on:
 *
 *   **`close()` does not fire `close` synchronously — it queues a task**, while
 *   an `await` in the caller resumes on a *microtask*, which runs first.
 *
 * That is the HTML specification's wording ("queue an element task … fire an
 * event named close"), and it was confirmed in a real browser before this file
 * was written. Everything else the fake does is scaffolding.
 *
 * **If that one sentence is ever wrong, this file proves nothing** — which is
 * the honest limit of testing a browser without one, and the reason the fake
 * models the ordering rather than a `<dialog>`. Do not "simplify" `close()` to
 * dispatch synchronously: that is precisely the bug's absence, and every test
 * below would pass against the broken code.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// `names.test.mjs`'s three lines rather than `support/meta-db.mjs`'s `dist`:
// that module imports PGlite at module scope, and pulling a WASM Postgres into
// a file that needs a fake `<dialog>` is exactly the memory CLAUDE.md's
// `--test-concurrency=1` note is about.
const dist = (p) => pathToFileURL(join(import.meta.dirname, '..', 'dist', p)).href;

/** A node with the handful of properties `confirmDialog` actually touches. */
function fakeNode(tag, attrs = {}) {
  return {
    tag,
    attrs,
    textContent: '',
    hidden: false,
    className: '',
    onclick: null,
    focus() {},
    click() {
      this.onclick?.();
    },
  };
}

function fakeDom() {
  const children = {
    h2: fakeNode('h2'),
    '.confirm-body': fakeNode('p'),
    '[data-no]': fakeNode('button', { 'data-no': '' }),
    '[data-yes]': fakeNode('button', { 'data-yes': '' }),
  };

  const listeners = new Set();
  const box = {
    className: '',
    open: false,
    returnValue: '',
    // `confirmDialog` writes the markup once; the fake answers the four
    // selectors it then reads back rather than parsing any of it.
    set innerHTML(_html) {},
    querySelector: (sel) => children[sel] ?? null,
    addEventListener: (type, fn) => type === 'close' && listeners.add(fn),
    removeEventListener: (type, fn) => type === 'close' && listeners.delete(fn),
    showModal() {
      this.open = true;
    },
    close(value = '') {
      this.returnValue = value;
      this.open = false;
      // THE POINT OF THIS FILE. A task, not a microtask and not a synchronous
      // call — so an `await` in the caller resumes before this runs.
      setTimeout(() => {
        for (const fn of [...listeners]) fn();
      }, 0);
    },
  };

  globalThis.document = {
    createElement: () => box,
    body: { append() {} },
  };
  return { box, children };
}

const { box, children } = fakeDom();
const { confirmDialog, alertDialog } = await import(dist('web/assets/util.js'));

const ask = (title = 'q') =>
  confirmDialog({ title, confirmLabel: 'ja', cancelLabel: 'nein' });

/** Answer the open dialog the way a teacher does. */
const clickYes = () => children['[data-yes]'].click();
const clickNo = () => children['[data-no]'].click();

/** Let any queued `close` task run, so a test sees what the *next* question would. */
const drainTasks = () => new Promise((resolve) => setTimeout(resolve, 0));

test('one question answers what was clicked', async () => {
  const yes = ask();
  clickYes();
  assert.equal(await yes, true);

  await drainTasks();

  const no = ask();
  clickNo();
  assert.equal(await no, false);
});

test('two questions in a row both answer what was clicked', async () => {
  // The regression, and the whole reason for this file. Before the fix the
  // second call resolved `false` from the *first* question's queued close
  // event, against a `returnValue` it had just cleared — so `deleteStudent`
  // returned at `if (!sure)` and never sent its request.
  const first = ask('are you sure');
  clickYes();
  assert.equal(await first, true);

  const second = ask('really sure');

  // **`drainTasks()` before the click, and this line is the test.** The first
  // draft clicked straight after opening the second question and passed
  // against the broken code, because the second question answered itself
  // before the stale event could land. A reader takes a second or two to read
  // a dialog that says "this cannot be undone" — so in the browser the stale
  // event always arrives *first*, into an open dialog nobody has touched.
  // Modelling that wait is the difference between a regression test and a
  // green tick.
  await drainTasks();

  clickYes();
  assert.equal(await second, true, 'the second question must not answer from the first');
});

test('a question that follows a cancelled one is not answered by it', async () => {
  // The mirror image, and the more dangerous direction: a stale `close` whose
  // `returnValue` still said `yes` would answer the *next* question yes. It
  // cannot happen while `returnValue` is cleared per call, but the guard is
  // what makes that a second line of defence rather than the only one.
  const first = ask();
  clickYes();
  assert.equal(await first, true);

  const second = ask();
  await drainTasks();
  clickNo();
  assert.equal(await second, false, 'a stale yes must never confirm a later question');
});

test('escape still answers, and answers no', async () => {
  // Escape and the backdrop have no button to speak from, so they come through
  // `close` — which is why the listener cannot simply be deleted. A dialog the
  // reader dismissed must read as a refusal.
  const dismissed = ask();
  box.close(''); // what a `<dialog>` does on Escape: no returnValue set
  assert.equal(await dismissed, false);
});

test('the box is not left open, and listeners do not pile up', async () => {
  for (let i = 0; i < 25; i++) {
    const q = ask();
    clickYes();
    assert.equal(await q, true, `question ${i + 1}`);
  }
  await drainTasks();
  assert.equal(box.open, false, 'the last question closed the box');
});

test('an alert following a question is not dismissed by it', async () => {
  // `roster.js` reports a partial delete this way — question, then a one-button
  // report. The stale event would have resolved the alert before the reader had
  // seen it, and the code would carry on and re-render the page underneath.
  const asked = ask();
  clickYes();
  assert.equal(await asked, true);

  let alertSettled = false;
  const report = alertDialog({ title: 'incomplete', okLabel: 'ok' }).then(() => {
    alertSettled = true;
  });

  await drainTasks();
  assert.equal(alertSettled, false, 'the alert must still be on screen');
  assert.equal(box.open, true);

  clickYes();
  await report;
  assert.equal(alertSettled, true);
});
