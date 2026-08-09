/**
 * The first-run tour: four or five popovers over the overview, once per
 * account, ending at the handbook.
 *
 * **A fifth module, and the bar in CLAUDE.md is "this part can be wrong without
 * anyone seeing it, and a test can reach it".** `STEPS` clears it on both
 * counts. A step names a target by selector and a body by translation key, and
 * both can be silently wrong: rename `#nav-roster` and the tour skips a step
 * with no error, mistype a key and `t()` returns the key itself and renders it.
 * Neither is visible unless someone logs in as a brand-new account of that
 * exact role, which is the one thing nobody does twice. `test/tour.test.mjs`
 * checks the keys against both locale files and `pages.test.mjs` checks the
 * selectors against `home.html`.
 *
 * The runner below is DOM and cannot be tested here; it is deliberately small
 * enough to read in one go.
 *
 * **No library.** A tour is four absolutely-positioned boxes and a click
 * handler; the smallest popover package is a fifth runtime dependency and
 * CLAUDE.md's bar for that is "an argument better than it's standard".
 *
 * **Positioning is `element.style`, not a `style=` attribute.** The app runs
 * `style-src-attr 'none'`, which blocks the attribute — including
 * `setAttribute('style', …)` — but not CSSOM writes. Verified against the real
 * server, because getting this wrong fails only under the deployed policy and
 * not under `npm run dev`. Everything that can live in `app.css` does.
 */

/**
 * What each role is shown, in order.
 *
 * Both lists end at the handbook, which is the point of the whole thing: the
 * tour is four sentences and a pointer at where the rest is written down.
 *
 * **Admins get nothing and that is a decision.** There is one of them, they
 * are the person who set the server up, and `/sql` and `/uebungen` — half of
 * what the tour is about — answer 403 for an account with no Postgres identity.
 *
 * Order is not arbitrary. Each list starts where that role actually goes first:
 * a teacher cannot do anything before a class exists, and a student is already
 * looking at the editor they were sent here for.
 */
export const STEPS = {
  teacher: [
    { target: '#nav-roster', key: 'tour.t.roster' },
    { target: '#nav-exercises', key: 'tour.t.exercises' },
    { target: '#nav-lesson', key: 'tour.t.lesson' },
    { target: '#nav-sql', key: 'tour.t.sql' },
    { target: '#help', key: 'tour.t.handbook' },
  ],
  student: [
    { target: '#nav-sql', key: 'tour.s.sql' },
    { target: '#nav-exercises', key: 'tour.s.exercises' },
    { target: '#lang', key: 'tour.s.settings' },
    { target: '#help', key: 'tour.s.handbook' },
  ],
};

/** Where the popover goes relative to its target, clamped to the viewport. */
function place(pop, target) {
  const box = target.getBoundingClientRect();
  const gap = 12;
  const margin = 8;

  // Below the target by default — every target is in the top bar, so there is
  // nothing above it but the edge of the window.
  let top = box.bottom + gap;
  let left = box.left + box.width / 2 - pop.offsetWidth / 2;

  const maxLeft = document.documentElement.clientWidth - pop.offsetWidth - margin;
  left = Math.max(margin, Math.min(left, maxLeft));

  // If it would run off the bottom — a short window, or a bar that has wrapped
  // to two rows — put it above instead rather than let it scroll out of reach.
  if (top + pop.offsetHeight > document.documentElement.clientHeight - margin) {
    top = Math.max(margin, box.top - gap - pop.offsetHeight);
  }

  pop.style.top = `${Math.round(top)}px`;
  pop.style.left = `${Math.round(left)}px`;
}

/**
 * Run the tour. Returns a promise that settles once it is finished or skipped —
 * both mean "do not show this again", which is why there is one callback and
 * not two.
 *
 * `t` is passed in rather than imported for the reason `util.js` gives: this
 * module is loaded by a page that has already resolved its locale, and reaching
 * for `i18n.js` here would give it a second opinion about which one is current.
 *
 * Steps whose target is missing are dropped rather than shown pointing at
 * nothing. That is what makes the same student list safe on a narrow window
 * where `mountNav` has hidden an entry — and it is why `test/tour.test.mjs`
 * exists, because the failure mode of a typo'd selector is a silently shorter
 * tour.
 */
export function runTour(steps, t) {
  const live = steps.filter((step) => document.querySelector(step.target));
  if (live.length === 0) return Promise.resolve();

  const scrim = document.createElement('div');
  scrim.className = 'tour-scrim';

  const pop = document.createElement('div');
  pop.className = 'tour-pop';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-modal', 'true');
  pop.setAttribute('aria-live', 'polite');

  const count = document.createElement('p');
  count.className = 'tour-count';
  const body = document.createElement('p');
  body.className = 'tour-body';

  const actions = document.createElement('div');
  actions.className = 'tour-actions';
  const skip = document.createElement('button');
  skip.type = 'button';
  skip.className = 'small';
  skip.textContent = t('tour.skip');
  const next = document.createElement('button');
  next.type = 'button';
  next.className = 'primary small';
  actions.append(skip, next);

  pop.append(count, body, actions);
  document.body.append(scrim, pop);

  let at = 0;
  let highlighted = null;

  const show = () => {
    const step = live[at];
    highlighted?.classList.remove('tour-target');
    highlighted = document.querySelector(step.target);
    highlighted?.classList.add('tour-target');

    count.textContent = t('tour.step', { n: at + 1, total: live.length });
    // `textContent`, never `innerHTML`. These strings come from the locale
    // files rather than from a user, which is an argument for it being safe
    // today and not an argument for the door being open — `markdown.js`'s
    // header is where that line is drawn for this app.
    body.textContent = t(step.key);
    next.textContent = at === live.length - 1 ? t('tour.done') : t('tour.next');
    place(pop, highlighted);
    next.focus();
  };

  return new Promise((resolve) => {
    const end = () => {
      highlighted?.classList.remove('tour-target');
      scrim.remove();
      pop.remove();
      window.removeEventListener('resize', reposition);
      document.removeEventListener('keydown', onKey);
      resolve();
    };

    const reposition = () => place(pop, document.querySelector(live[at].target) ?? document.body);

    // Escape ends it, like every other dialog in the app. A tour you cannot
    // dismiss with the key everyone tries is a modal, not a tour.
    const onKey = (event) => {
      if (event.key === 'Escape') end();
    };

    next.addEventListener('click', () => {
      at += 1;
      if (at >= live.length) end();
      else show();
    });
    skip.addEventListener('click', end);
    // The scrim ends it too. It is the second thing people try, and a click
    // that does nothing reads as a frozen page.
    scrim.addEventListener('click', end);
    window.addEventListener('resize', reposition);
    document.addEventListener('keydown', onKey);

    show();
  });
}
