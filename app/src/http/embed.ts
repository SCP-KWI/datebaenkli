/**
 * Being shown inside an exam platform's frame (HANDOFF §30, replacing §20a).
 *
 * **Off unless `DBK_FRAME_ANCESTORS` is set.** Exam.net shows an external
 * resource in an `<iframe>` even with its advanced SEB features on, and two
 * things stood in the way. Each is relaxed only as far as that use needs:
 *
 * 1. **`frame-ancestors`** names the configured origins instead of `'none'`
 *    (`server.ts`). Every other site is still refused.
 *
 * 2. **The session.** The cookie is `SameSite=Lax`, and a browser neither
 *    stores nor sends that in a frame under another site — nor, increasingly,
 *    *any* cookie there (WebKit, so SEB on macOS and iPadOS, has blocked them
 *    outright for years). So a framed page does not use a cookie at all. It
 *    detects that it is framed (`assets/embed-auth.js`), keeps the token in its
 *    own `sessionStorage`, and sends it as `Authorization: Bearer` — the shape
 *    YouTube's embed links get away with by needing no login at all, paid for
 *    here by carrying the login explicitly.
 *
 * **Why the bearer token is not the CSRF hole a `SameSite=None` cookie would
 * be:** a browser attaches a cookie to requests other sites cause; it never
 * attaches a header. The only code that can send this one is the app's own
 * script running in the frame. A custom header also forces a preflight, which
 * nothing here answers, so another origin cannot even *try*.
 *
 * **And why framing does not open clickjacking against the ordinary app:** a
 * framed page receives no Lax cookie, so a page framed without the student
 * having logged in *inside that frame* is a logged-out page. There is nothing
 * to trick anyone into clicking.
 *
 * **What it costs**, and the reason it is a setting rather than a default:
 * script can read a token in `sessionStorage`, where it cannot read an
 * `httpOnly` cookie. An injection in a framed page could take the session. That
 * is bounded by `script-src 'self'` and zero inline scripts — the same control
 * whose header in `server.ts` says not to weaken it — and by the token being
 * given out only to a page that asked with `x-dbk-embed` (`http/auth.ts`).
 *
 * Kept free of `config.ts` so a test can import it without an environment.
 */

/**
 * A scheme-and-host source, optionally with one leading `*.` label: what CSP
 * accepts in `frame-ancestors` and what an exam platform needs. Deliberately
 * narrower than CSP — no paths, no bare `*`, no `https:`, no `http:` — because
 * every one of those widens "the exam platform" to "anyone".
 */
const ANCESTOR = /^https:\/\/(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d{1,5})?$/;

/** Space-separated, as CSP writes it. Empty means "not frameable", the default. */
export function parseFrameAncestors(raw: string): string[] {
  const list = raw.trim().split(/\s+/).filter(Boolean);
  for (const source of list) {
    if (!ANCESTOR.test(source)) {
      throw new Error(
        `DBK_FRAME_ANCESTORS entries must look like https://exam.net or https://*.exam.net, got: ${source}`,
      );
    }
  }
  return list;
}

/**
 * The token from an `Authorization: Bearer` header, or null. Strict on shape —
 * one scheme, one base64url value, the alphabet `auth/session.ts` mints — so a
 * malformed header is "no session", never a lookup of whatever followed the
 * space.
 */
export function bearerToken(header: string | undefined): string | null {
  const m = typeof header === 'string' ? /^Bearer ([A-Za-z0-9_-]{16,128})$/.exec(header) : null;
  return m ? m[1]! : null;
}
