/**
 * Two copies of one dialog, on disk — phase 9. No db, no DOM.
 *
 * `test/chalk.test.mjs`'s trick, applied to the second thing in this repo that
 * is deliberately duplicated. `routes/pages.ts` serves every page as a
 * byte-for-byte constant and has no template engine on purpose, so the CSV
 * import dialog's markup exists twice — once in `sql.html`, once in
 * `uebungen.html` — while `csv-import.js` drives both from one implementation.
 *
 * That is fine right up until somebody adds a field to one of them. The copy
 * that was not edited then has an element `csv-import.js` reaches for and does
 * not find, on whichever page nobody happened to open. This is the assertion
 * that turns that into a failing test instead.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const WEB = join(import.meta.dirname, '..', 'src', 'web');
const read = (name) => readFileSync(join(WEB, name), 'utf8');

/** The `<dialog id="importDialog">` block, verbatim, indentation and all. */
function importDialog(html) {
  const open = html.indexOf('<dialog id="importDialog">');
  assert.notEqual(open, -1, 'no import dialog in this page');
  const close = html.indexOf('</dialog>', open);
  assert.notEqual(close, -1, 'unterminated import dialog');
  return html.slice(open, close + '</dialog>'.length);
}

test('pages: the import dialog is identical in sql.html and uebungen.html', () => {
  assert.equal(importDialog(read('sql.html')), importDialog(read('uebungen.html')));
});

test('pages: the import dialog carries every id csv-import.js reaches for', () => {
  // Read out of the module rather than listed here: a list would be a third
  // copy, and the one that goes stale silently.
  const script = readFileSync(join(WEB, 'assets', 'csv-import.js'), 'utf8');
  const ids = [...script.matchAll(/\bel\('([A-Za-z]+)'\)/g)].map((m) => m[1]);
  assert.ok(ids.length > 5, 'expected to find the dialog ids in csv-import.js');

  for (const page of ['sql.html', 'uebungen.html']) {
    const html = read(page);
    for (const id of new Set(ids)) {
      assert.ok(html.includes(`id="${id}"`), `${page} is missing id="${id}"`);
    }
  }
});

test('pages: every page carries the Chalk head and a theme script', () => {
  // `theme.js` must be a classic script and must run before first paint; a page
  // added without it is a page that flashes white for every dark-mode reader.
  for (const page of [
    'home.html',
    'login.html',
    'password.html',
    'sql.html',
    'lesson.html',
    'roster.html',
    'uebungen.html',
  ]) {
    const html = read(page);
    assert.ok(html.includes('<script src="/assets/theme.js"></script>'), `${page}: no theme.js`);
    assert.ok(html.includes('/assets/chalk-tokens.css'), `${page}: no design tokens`);
    assert.ok(html.includes('/assets/app.css'), `${page}: no stylesheet`);
  }
});

const TOP_BAR_PAGES = ['home.html', 'sql.html', 'uebungen.html', 'lesson.html', 'roster.html'];

/** The `<nav class="topbar-actions">` block, verbatim. */
function topBar(html) {
  const open = html.indexOf('<nav class="topbar-actions">');
  assert.notEqual(open, -1, 'no top bar in this page');
  const close = html.indexOf('</nav>', open);
  assert.notEqual(close, -1, 'unterminated top bar');
  return html.slice(open, close + '</nav>'.length);
}

/**
 * **The bar is one bar, and this is what keeps it that way.**
 *
 * It was five. Five orders, two ids for the overview (`overview` and `home`),
 * and `/sql` reachable from neither `/lesson` nor `/roster` — each page had
 * dropped its own link and kept the rest in whatever order it was written in,
 * and nobody had decided any of it. Nothing failed, because nothing checked.
 *
 * Leading whitespace is normalised before comparing, and only that: `roster.html`
 * nests its bar inside `#main` — deliberately, so that `showSlips()` hiding
 * `#main` takes the language control with it — so its block is indented two
 * spaces deeper than the other four. Everything that could actually drift (an
 * entry added, removed, reordered, or renamed) still fails this.
 */
test('pages: the top bar is byte-identical on all five pages', () => {
  const dedent = (block) =>
    block
      .split('\n')
      .map((line) => line.replace(/^\s+/, ''))
      .join('\n');

  const [first, ...rest] = TOP_BAR_PAGES;
  for (const page of rest) {
    assert.equal(dedent(topBar(read(page))), dedent(topBar(read(first))), `${page} vs ${first}`);
  }
});

/**
 * Every section is in it, every time — the current page included, which is the
 * decision the whole redesign rests on: a set that changes under the reader
 * cannot be learned. Role gating happens in `mountNav()` at runtime, so the
 * markup carries all five and hides some; that is what makes the block above
 * identical in the first place.
 *
 * The logout is asserted to be *last* rather than merely present. "Always at
 * the right-hand end" is the sort of promise a sixth page breaks by accident.
 */
test('pages: the bar carries all five sections, and logout is last', () => {
  const bar = topBar(read('home.html')).replace(/<!--[\s\S]*?-->/g, '');
  for (const href of ['/', '/sql', '/uebungen', '/lesson', '/roster']) {
    assert.ok(bar.includes(`href="${href}"`), `no nav entry for ${href}`);
  }
  const ids = [...bar.matchAll(/\bid="([A-Za-z-]+)"/g)].map((m) => m[1]);
  assert.equal(ids.at(-1), 'logout', 'logout is not the last control in the bar');

  // No top bar to hold one: this is the page the forced-change gate can *hold*
  // someone on, so it is the one that most needs a way off. Corner-fixed there.
  assert.ok(read('password.html').includes('id="logout"'), 'password.html: no logout');
});

/**
 * `/sql`'s two actions are on the page, not in the bar — half of why that bar
 * used to look unlike the other four, and the fix for a usability finding that
 * "Datenbank zurücksetzen" sat flush against "CSV importieren". This asserts the
 * separation itself, because moving either one back into the nav is the obvious
 * thing to do to a bar that feels empty.
 */
test('pages: sql.html keeps its own actions out of the top bar', () => {
  const html = read('sql.html');
  const bar = topBar(html);
  for (const id of ['import', 'reset']) {
    assert.ok(html.includes(`id="${id}"`), `sql.html lost id="${id}"`);
    assert.ok(!bar.includes(`id="${id}"`), `sql.html: id="${id}" is back in the top bar`);
  }
});

test('pages: no inline event handlers or inline scripts survive', () => {
  // `script-src 'self'` and `style-src 'self'` in server.ts are only worth
  // having while this is true. Both were paid for once (phase 8.2); a new page
  // is the obvious way to spend it back.
  for (const page of ['home.html', 'sql.html', 'uebungen.html', 'lesson.html', 'roster.html']) {
    const html = read(page);
    assert.ok(!/\son[a-z]+\s*=/.test(html.replace(/<!--[\s\S]*?-->/g, '')), `${page}: inline handler`);
    assert.ok(!/<script(?![^>]*\ssrc=)/.test(html), `${page}: inline <script>`);
    assert.ok(!/\sstyle="/.test(html), `${page}: inline style`);
  }
});

/**
 * The auth pages' submit buttons are **direct children** of their `<form>`.
 *
 * `app.css` styles them with `body[data-page='auth'] form > button`, and the
 * child combinator is not cosmetic: as a plain descendant selector the same
 * rule also caught the password reveal nested inside `.pw-field`, gave a 34 px
 * slot a 44 px button plus a 1.1rem top margin, and put the eye half outside
 * the field on the deployed 0.10.2 (HANDOFF §16).
 *
 * Narrowing the selector fixed that and moved the fragility: wrap a submit
 * button in a `<div>` and it silently loses its height and spacing, with
 * nothing failing. This is what fails instead.
 *
 * Deliberately not a check that the reveal is *unstyled* by that rule — that is
 * layout, and there is no browser in this suite. This asserts the one half that
 * is a fact about the markup.
 */
test('pages: the auth submit buttons are direct children of their form', () => {
  for (const page of ['login.html', 'password.html']) {
    const html = read(page).replace(/<!--[\s\S]*?-->/g, '');
    const open = html.indexOf('<form');
    assert.notEqual(open, -1, `${page}: no form`);
    const form = html.slice(open, html.indexOf('</form>', open));

    const submit = form.indexOf('<button type="submit"');
    assert.notEqual(submit, -1, `${page}: no submit button in the form`);

    // Every tag between the form and the submit, with the closed ones cancelled
    // out. Anything left open is a wrapper the `> button` rule cannot see past.
    const stack = [];
    for (const [, slash, tag] of form.slice(0, submit).matchAll(/<(\/?)([a-z][a-z0-9]*)/g)) {
      if (tag === 'form' || tag === 'input' || tag === 'br') continue;
      if (slash) stack.pop();
      else stack.push(tag);
    }
    assert.deepEqual(stack, [], `${page}: submit button is nested inside <${stack.join('><')}>`);
  }
});
