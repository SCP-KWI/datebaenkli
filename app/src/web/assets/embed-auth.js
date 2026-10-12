/**
 * The session for a page shown inside an exam platform's frame.
 *
 * **Does nothing unless the page is framed**, and a page can only *be* framed
 * when the deployment set `DBK_FRAME_ANCESTORS` — `server.ts` sends
 * `frame-ancestors 'none'` otherwise, so the browser never runs this script
 * inside a frame at all. Outside a frame the app is exactly what it was: one
 * `httpOnly` cookie, and no token anywhere script can read it.
 *
 * Inside one, the browser will not store or send that cookie — it is `Lax`, and
 * the frame is under another site; WebKit, which is SEB on macOS and iPadOS,
 * would block it whatever it was. So this does what an embed link has to do
 * when the thing embedded needs a login: it carries the login itself.
 *
 *   out  — every same-origin `/api` request gets `x-dbk-embed: 1`, and the
 *          token if there is one, as `Authorization: Bearer`.
 *   back — a response that set or cleared the session names it in
 *          `x-dbk-token` (`http/auth.ts`'s `setSessionCookie` and
 *          `clearSessionCookie`, so login, demo, password change, logout and an
 *          expired session all arrive here without a line of their own).
 *
 * `http/embed.ts` has the security argument. The short form: a header is never
 * attached by the browser on another site's behalf, so this is not a CSRF
 * surface, and a framed page that has not signed in inside the frame holds
 * nothing to clickjack.
 *
 * **`sessionStorage`, not `localStorage` and not a module variable.** A module
 * variable dies with every navigation inside the frame — login to `/sql` would
 * log the student straight back out. `localStorage` outlives the exam window,
 * on a machine the next class sits down at. `sessionStorage` lasts exactly as
 * long as the frame's browsing context, and browsers partition it under the
 * top-level site, so the exam's copy is not the one a later tab would see.
 * It is also per *tab*, which incidentally gives framed pages the per-tab
 * session `session-guard.js` explains the cookie cannot.
 *
 * Installed by `util.js` *before* the session guard, so the guard wraps this
 * and sees the response with the token already taken care of. Both are fetch
 * wrappers for the same reason: twenty-odd call sites, and a missed one fails
 * as a student who is mysteriously logged out on one button.
 *
 * **Not covered:** a plain `<a href="/api/…/download">`, which is a navigation
 * and carries no header. The student's own hand-in download in `uebungen.js` is
 * the one such link a student sees; inside an exam it answers 401. SEB blocks
 * downloads by default anyway, so it was left rather than rebuilt as a fetch.
 */

/** Must match `http/auth.ts`. */
export const EMBED_HEADER = 'x-dbk-embed';
export const TOKEN_HEADER = 'x-dbk-token';
export const TOKEN_CLEARED = '-';

const STORAGE_KEY = 'dbk.embedToken';

/**
 * Whether this page is inside a frame. Comparing `self` and `top` is allowed
 * across origins; the `catch` is for an environment that throws on the read,
 * and leans framed, because the cost of being wrong that way is an unused
 * header and the cost of the other is a login that never holds.
 */
export function isFramed(win) {
  try {
    return win.self !== win.top;
  } catch {
    return true;
  }
}

/**
 * The token to hold after a response: unchanged when it said nothing, gone
 * when it said "cleared", replaced when it named one. Pure, so the one rule
 * that decides whether a student stays logged in is reachable from a test.
 */
export function nextToken(current, announced) {
  if (announced === null || announced === undefined) return current;
  if (announced === TOKEN_CLEARED) return null;
  return announced;
}

function read() {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function write(token) {
  try {
    if (token === null) sessionStorage.removeItem(STORAGE_KEY);
    else sessionStorage.setItem(STORAGE_KEY, token);
  } catch {
    // Storage refused (a browser setting). The session then lasts one page:
    // nothing better is available without putting the token somewhere worse.
  }
}

/** Idempotent; `util.js` calls it once at import. */
export function installEmbedAuth() {
  if (typeof window === 'undefined' || window.__dbkEmbedAuth || !isFramed(window)) return;
  window.__dbkEmbedAuth = true;

  const inner = window.fetch.bind(window);

  window.fetch = async (input, init) => {
    // The same parse as `session-guard.js`, for the same reason: anything that
    // is not plainly a same-origin `/api` URL is passed through untouched.
    let url = null;
    try {
      const href = typeof input === 'string' ? input : (input?.url ?? String(input));
      url = new URL(href, location.href);
    } catch {
      /* not a URL we can reason about */
    }
    const isApi =
      url !== null && url.origin === location.origin && url.pathname.startsWith('/api/');
    if (!isApi) return inner(input, init);

    const given = init?.headers ?? (typeof input === 'object' ? input?.headers : undefined);
    const headers = new Headers(given);
    headers.set(EMBED_HEADER, '1');
    const token = read();
    if (token !== null) headers.set('authorization', `Bearer ${token}`);

    const response = await inner(input, { ...init, headers });
    write(nextToken(token, response.headers.get(TOKEN_HEADER)));
    return response;
  };
}
