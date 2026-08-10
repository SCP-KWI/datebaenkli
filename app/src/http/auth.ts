/**
 * Cookie authentication and role guards.
 *
 * Three global hooks do the work:
 *
 *   onRequest   — resolve the session cookie into `req.auth` (or null).
 *   preHandler  — deny anything not marked `public`, deny a request made in the
 *                 name of a session this browser no longer has, and deny
 *                 *everything* to a user who still owes a password change
 *                 except the handful of routes needed to make that change.
 *   onSend      — tell the caller which session actually answered.
 *
 * Making the password gate a global default rather than a per-route opt-in is
 * deliberate: a route added later without thinking about it is closed, not
 * open. The same reasoning applies to authentication itself, and to the
 * session-switch check — a route is subject to it unless it says otherwise.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import type { Db } from '../db/query.js';
import {
  loadSession,
  refreshSession,
  sessionFingerprint,
  type SessionUser,
} from '../auth/session.js';
import type { AppRole } from '../services/users.js';
import { HttpError, forbidden, unauthorized } from './errors.js';

export interface AuthContext {
  user: SessionUser;
  token: string;
  /**
   * When this session stops regardless of activity, or null for an ordinary
   * one. Phase 10's demo lease is what sets it; `/api/me` hands it to the page
   * so a visitor sees a countdown rather than a sudden 401 (HANDOFF §9g).
   */
  hardExpiresAt: Date | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
    /**
     * Which session answered this request, as `sessionFingerprint` names it, or
     * `NO_SESSION`. Written by the auth hook, rewritten by `setSessionCookie` /
     * `clearSessionCookie` so a handler that rotates the session reports the
     * *new* one, and sent back on every `/api` response.
     */
    sessionKey: string;
  }
  interface FastifyContextConfig {
    /** Reachable without a session (login, health, static assets). */
    public?: boolean;
    /** Reachable while `must_change_password` is still set. */
    passwordChangeExempt?: boolean;
    /**
     * This route's whole job is to change who the caller is, so a request that
     * names a different session than the cookie holds is not a mistake — it is
     * the point. Three routes: login, logout, and claiming a demo slot.
     *
     * Everything else is checked, including the routes that *rotate* a session
     * without changing the person behind it (`/api/me/password`): those must
     * still be refused when the browser has moved on to somebody else, and the
     * new fingerprint on a 2xx is how the page learns to follow along.
     */
    changesIdentity?: boolean;
  }
}

/**
 * The response header naming the session that answered, and the request header
 * naming the one the caller believes it is.
 *
 * `assets/session-guard.js` is the other half; it knows both names too.
 */
export const SESSION_HEADER = 'x-dbk-session';

/** The fingerprint of not being logged in. No HMAC can collide with it. */
export const NO_SESSION = 'none';

const COOKIE_OPTIONS = {
  path: '/',
  httpOnly: true,
  sameSite: 'lax',
  secure: config.session.secure,
  signed: true,
} as const;

/**
 * Both of these also update `req.sessionKey`, and that is not bookkeeping for
 * its own sake: the `onSend` hook below reports it, and a login, a demo claim
 * or a password change would otherwise answer under the fingerprint of the
 * session it *replaced*. The page would then compare that stale value against
 * the next response and stop itself for a switch it performed on purpose.
 *
 * Writing it here rather than at the four call sites is the same argument
 * `clearSessionCookie` itself makes in `routes/demo.ts`: the cookie and the
 * name it answers to are one fact, and two places to keep in step is one too
 * many.
 */
export function setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date): void {
  reply.setCookie(config.session.cookieName, token, { ...COOKIE_OPTIONS, expires: expiresAt });
  reply.request.sessionKey = sessionFingerprint(token);
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(config.session.cookieName, { ...COOKIE_OPTIONS });
  reply.request.sessionKey = NO_SESSION;
}

function readToken(req: FastifyRequest): string | null {
  const raw = req.cookies[config.session.cookieName];
  if (raw === undefined) return null;
  const unsigned = req.unsignCookie(raw);
  return unsigned.valid && unsigned.value !== null ? unsigned.value : null;
}

export function registerAuthHooks(app: FastifyInstance, db: Db): void {
  app.decorateRequest('auth', null);
  app.decorateRequest('sessionKey', NO_SESSION);

  app.addHook('onRequest', async (req, reply) => {
    const token = readToken(req);
    if (token === null) return;

    let session: Awaited<ReturnType<typeof loadSession>>;
    try {
      session = await loadSession(db, token);
    } catch (err) {
      // The database is unreachable. Letting this propagate would 500 *every*
      // route for anyone holding a cookie — including /health, which exists to
      // report the outage, and /login, which is where they would go next. Fall
      // through as unauthenticated instead: /api routes answer 401 and the
      // pages render.
      //
      // Deliberately does NOT clear the cookie: the session is not known to be
      // invalid, only unverifiable, so it must still work once the database is
      // back rather than forcing everyone to log in again.
      req.log.error({ err }, 'session lookup failed; treating request as unauthenticated');
      return;
    }

    if (!session) {
      // Expired, revoked, or the account was archived. Drop the stale cookie so
      // the browser stops sending it and the user sees the login page.
      clearSessionCookie(reply);
      return;
    }

    req.auth = { user: session.user, token, hardExpiresAt: session.hardExpiresAt };
    req.sessionKey = sessionFingerprint(token);

    const extended = await refreshSession(db, token, session).catch((err: unknown) => {
      // Same reasoning: failing to *extend* a session is not a reason to fail
      // the request the user actually made.
      req.log.warn({ err }, 'session refresh failed');
      return null;
    });
    if (extended) setSessionCookie(reply, token, extended);
  });

  app.addHook('preHandler', async (req) => {
    // No route matched — there is nothing behind this URL to protect, and
    // answering 401 would make a typo look like a permissions problem. Let the
    // not-found handler have it. (`is404` is Fastify's own contract for this;
    // `routeOptions.url === undefined` derives the same thing from an accessor
    // that rebuilds an object on every access.)
    if (req.is404) return;

    const routeConfig = req.routeOptions.config;

    /**
     * **The request is made in the name of a session this browser no longer
     * has.** Refuse it before the handler runs, so the action lands as nobody
     * rather than as whoever the cookie now names.
     *
     * This is the write half of the tab-bleed fix (HANDOFF §18). Cookies are
     * scoped to a browser profile, so a second login — most easily a second
     * demo slot claimed in another tab — re-points *every* open tab at the new
     * session. The old tab keeps its rendered DOM and its click handlers, and
     * the next thing it sends executes with someone else's privileges: a
     * teacher's "reset this student's schema" arriving as a student, or the
     * reverse. Postgres still bounds what that identity may do, which is what
     * kept this from being worse than it was, but "the request ran as somebody
     * the person clicking never was" is not a thing to leave standing.
     *
     * Before `public`, deliberately. `/api/logout` is public and destroys a
     * session — the one it destroys must be the one the caller meant, and the
     * three routes for which the answer is genuinely "any" say so with
     * `changesIdentity`.
     *
     * A caller that sends no header at all is unaffected: this is a guarantee
     * offered to a page that asks for it, not an authentication step. `curl`,
     * the verify scripts and the live suites never send it and never see this.
     */
    const claimed = req.headers[SESSION_HEADER];
    if (typeof claimed === 'string' && claimed !== req.sessionKey && !routeConfig.changesIdentity) {
      throw new HttpError(
        409,
        'session_switched',
        'This browser is signed in as somebody else than the page that sent this request.',
      );
    }

    if (routeConfig.public) return;

    if (!req.auth) throw unauthorized();

    if (req.auth.user.mustChangePassword && !routeConfig.passwordChangeExempt) {
      throw forbidden(
        'password_change_required',
        'Set a new password before using the rest of the application.',
      );
    }
  });

  /**
   * Name the session that answered, so the page can notice when it stops being
   * the one it rendered as. The read half of the check above.
   *
   * `onSend` and not `onRequest`, for the reason `setSessionCookie` states: a
   * handler may replace the session, and the browser needs the fingerprint it
   * now holds rather than the one it arrived with. It is also what makes the
   * header reach error replies and 404s — a 401 after somebody logged out in
   * another tab is exactly a response the page must not ignore.
   *
   * `/api` only, matching `cache-control: no-store` in `server.ts` and for a
   * related reason: the pages and `/assets` are constants that say nothing
   * about anyone, and a per-session header on them would make them unable to
   * be cached.
   */
  app.addHook('onSend', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    void reply.header(SESSION_HEADER, req.sessionKey);
  });
}

/** The signed-in user, or 401. Use in handlers where the global hook guarantees one. */
export function currentUser(req: FastifyRequest): SessionUser {
  if (!req.auth) throw unauthorized();
  return req.auth.user;
}

/** Route-level `preHandler` restricting a route to the given app roles. */
export function requireRole(...roles: AppRole[]) {
  return async (req: FastifyRequest): Promise<void> => {
    const user = currentUser(req);
    if (!roles.includes(user.role)) {
      throw forbidden('wrong_role', `This action requires: ${roles.join(' or ')}.`);
    }
  };
}
