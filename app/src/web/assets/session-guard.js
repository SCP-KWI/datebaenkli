/**
 * Stop a tab acting as somebody it is not.
 *
 * **The session lives in one `httpOnly` cookie, and a cookie jar belongs to the
 * browser profile, not to the tab.** So a second sign-in anywhere in the same
 * browser — most easily the demo button, which hands out a session to a caller
 * who proved nothing — silently re-points *every* open tab at the new session.
 * The tab that was there first keeps the DOM it rendered, its wired handlers
 * and its half-finished query, and everything it sends from then on executes as
 * the other account. Reported from testing as "the teacher tab became a student
 * mid-navigation, and the SQL editor showed a different guest's schema".
 *
 * **It is not localStorage**, which is where a reader of the symptom naturally
 * looks: this app keeps exactly two things in client storage, the theme and a
 * paint-ahead copy of the language (`util.js`, `i18n.js`), and neither is auth.
 * Nothing about the session is scoped per tab because nothing *can* be — the
 * one way to give a tab its own credential is to put a token somewhere the
 * page's JavaScript can read, which is precisely what `httpOnly` is for, and
 * trading an XSS-proof session for a tab-proof one is a bad trade in an app
 * whose whole job is to render text other people typed.
 *
 * So the fix is not isolation but **detection, in both directions**:
 *
 *   up   — every `/api` request carries the fingerprint of the session the page
 *          believes it is, and `http/auth.ts` refuses with `409 session_switched`
 *          when the cookie says otherwise. The action lands as nobody rather
 *          than as the wrong person, and that half is enforced by the server, so
 *          it holds even if this file is wrong.
 *   down — every `/api` response names the session that answered, and a tab that
 *          sees a name it did not expect stops dead and says so, rather than
 *          carrying on showing one account's data under another's heading.
 *
 * **This wraps `window.fetch` rather than exporting a helper the call sites
 * opt into**, which is the one design decision here worth arguing. There are
 * twenty-odd `fetch(` call sites across nine modules, the editor bundle has its
 * own, and the failure mode of a missed one is the exact bug being fixed — a
 * request that runs as the wrong user, invisibly, at the one moment nobody is
 * watching. An opt-in guard that has to be remembered is not a guard. `util.js`
 * makes the one install call, because every page already imports it.
 */

/** Both halves of the contract. `http/auth.ts` holds the same two strings. */
export const SESSION_HEADER = 'x-dbk-session';
export const NO_SESSION = 'none';

/**
 * What a response means for the identity this document is holding.
 *
 * Split out and exported for one reason: every way it can be wrong is silent.
 * Too eager and a lesson dies behind an interstitial nobody can dismiss; too
 * slack and the bug it exists for is back and looks exactly like working
 * software. `test/session-guard.test.mjs` is the only thing that can see the
 * difference, and it is a pure function so that it can.
 *
 * - `expected` — the fingerprint this document rendered as, or null before the
 *   first `/api` answer has come back.
 * - `seen` — the fingerprint on this response, or null if it carried none
 *   (a static asset, a route outside `/api`, or an older server).
 * - `ok` — `response.ok`.
 * - `labelled` — whether *this* request went out carrying `expected`.
 *
 * The one non-obvious verdict is `labelled && ok` on a changed fingerprint, and
 * it rests on the server's half of the contract: a labelled request is checked
 * against the cookie before the handler runs, so a 2xx means the server agreed
 * we were who we said, and any change on the way back is one it made itself —
 * a login, a demo claim, the new session `/api/me/password` issues. Following
 * it is right. An *unlabelled* request has been checked against nothing, so a
 * changed fingerprint there is unexplained, and unexplained is a halt.
 */
export function verdict({ expected, seen, ok, labelled }) {
  if (seen === null) return 'pass';
  if (expected === null) return 'adopt';
  if (seen === expected) return 'pass';
  return labelled && ok ? 'adopt' : 'halt';
}

/**
 * The two things that can have happened, and they are not the same sentence.
 *
 * Somebody signing in next door and somebody signing *out* next door both land
 * here, and telling a person their session was "replaced" when the browser is
 * simply logged out sends them looking for the other account. Which one it was
 * is the fingerprint that came back: `none` is nobody.
 *
 * Bilingual literals rather than `t()`, following `login.js`. This runs on
 * pages whose catalogue may not have loaded yet and — worse — on a page whose
 * own locale came from the account that is no longer signed in: a guest who
 * claimed the demo in English would otherwise be told in German that something
 * went wrong, at the one moment to be least confusing in.
 */
const TEXTS = {
  replaced: {
    heading: 'Diese Sitzung wurde ersetzt / This session was replaced',
    /**
     * **"Eine andere Sitzung", not "ein anderes Konto"**, and that is not
     * hedging. The commonest way to land here is somebody signing in as
     * *themselves* in a second tab, which replaces the session without
     * replacing the person — naming the account would make the box say
     * something the reader can see is false, on the one screen that has to be
     * believed. The demo case, where it really is a different account, is
     * covered by the same sentence.
     */
    de:
      'In diesem Browser wurde inzwischen eine andere Sitzung angemeldet — eine Anmeldung ' +
      'gilt für alle Tabs. Diese Seite wurde angehalten, damit sie nicht fremde Daten ' +
      'anzeigt oder in fremdem Namen etwas tut.',
    en:
      'A different session has since been signed in in this browser — a sign-in applies to ' +
      'every tab. This page has been stopped so that it cannot show another account’s data ' +
      'or act in its name.',
    action: 'Neu laden / Reload',
    // `reload`, not a link: whichever account the browser now holds, the page
    // comes back as *that* one, on the page the reader was already on.
    go: () => location.reload(),
  },
  ended: {
    heading: 'Diese Sitzung wurde beendet / This session has ended',
    de:
      'In diesem Browser ist niemand mehr angemeldet — abgemeldet in einem anderen Tab, ' +
      'oder die Zeit ist abgelaufen. Diese Seite wurde angehalten.',
    en:
      'Nobody is signed in in this browser any more — signed out in another tab, or the ' +
      'time ran out. This page has been stopped.',
    action: 'Zur Anmeldung / Sign in',
    // Straight to the login page rather than a reload that would land there in
    // two steps: there is no session to come back as. `replace`, for the reason
    // `wireLogout` gives — the halted page must not be one Back returns to.
    go: () => location.replace('/login'),
  },
};

/**
 * Put the stop on screen. Opaque and covering the page on purpose: what is
 * behind it belongs to another account, and leaving that legible under a
 * warning is half a fix.
 */
function halt(seen) {
  const text = seen === NO_SESSION ? TEXTS.ended : TEXTS.replaced;

  const box = document.createElement('div');
  box.className = 'session-lost';
  box.setAttribute('role', 'alertdialog');
  box.setAttribute('aria-modal', 'true');

  const card = document.createElement('div');
  const heading = document.createElement('h2');
  heading.textContent = text.heading;

  const body = document.createElement('p');
  body.textContent = text.de;

  const bodyEn = document.createElement('p');
  bodyEn.className = 'muted';
  bodyEn.textContent = text.en;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'primary';
  button.textContent = text.action;
  button.addEventListener('click', text.go);

  card.append(heading, body, bodyEn, button);
  box.append(card);
  document.body.append(box);
  button.focus();
}

/**
 * Wrap `fetch` so every `/api` call is labelled on the way out and checked on
 * the way back. Idempotent; `util.js` calls it once at import.
 */
export function installSessionGuard() {
  if (typeof window === 'undefined' || window.__dbkSessionGuard) return;
  window.__dbkSessionGuard = true;

  const inner = window.fetch.bind(window);
  let expected = null;
  let stopped = false;

  window.fetch = async (input, init) => {
    // Nothing runs after the stop. A never-settling promise rather than a
    // rejection, because every call site in this app has a `.catch` that turns
    // a failure into "render nothing" or "show an error" — and both would have
    // the page carry on quietly under a warning that says it has not.
    if (stopped) return new Promise(() => {});

    // Wrapped, because this is the one line here that can *throw* where the
    // native `fetch` would merely have rejected — and a guard that turns a bad
    // URL into a different kind of failure is a guard that broke something it
    // was not looking at. Anything unparseable is somebody else's problem: pass
    // it through and let `fetch` produce its own error.
    let url = null;
    try {
      const href = typeof input === 'string' ? input : (input?.url ?? String(input));
      url = new URL(href, location.href);
    } catch {
      /* not a URL we can reason about */
    }
    const isApi =
      url !== null && url.origin === location.origin && url.pathname.startsWith('/api/');

    let labelled = false;
    if (isApi && expected !== null) {
      // `Headers` rather than an object spread, so this composes with a
      // `Request` object and with `json()`'s literal alike — the app only ever
      // passes the latter, but a wrapper that quietly drops a caller's headers
      // is a trap with no symptom.
      const given = init?.headers ?? (typeof input === 'object' ? input?.headers : undefined);
      const headers = new Headers(given);
      headers.set(SESSION_HEADER, expected);
      init = { ...init, headers };
      labelled = true;
    }

    const response = await inner(input, init);
    if (!isApi) return response;

    const seen = response.headers.get(SESSION_HEADER);
    switch (verdict({ expected, seen, ok: response.ok, labelled })) {
      case 'adopt':
        expected = seen;
        return response;
      case 'halt':
        stopped = true;
        halt(seen);
        return new Promise(() => {});
      default:
        return response;
    }
  };
}
