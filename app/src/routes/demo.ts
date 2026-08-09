/**
 * The public demo's two routes, and one admin one. HANDOFF §9.
 *
 * `POST /api/demo/start` is the only route in this application that hands out a
 * session to a caller who proved nothing. That is deliberate and it is the
 * feature — §9d has the argument, and the short version is that the alternative
 * (a published username and password) makes `accountLimiter` a lever any
 * stranger can pull to lock the demo for everyone.
 *
 * What keeps it safe is not authentication but the narrowness of what it can
 * reach: it can only ever return one of a fixed set of pre-provisioned
 * accounts, each of which is an ordinary student or teacher as far as the rest
 * of the app is concerned, bounded by the same Postgres rails as a real one and
 * capped further by `demo` (services/*). It creates nothing.
 */

import type { FastifyInstance } from 'fastify';
import { demoClaimLimiter } from '../auth/ratelimit.js';
import { createSession } from '../auth/session.js';
import { config } from '../config.js';
import type { Db } from '../db/query.js';
import { clearSessionCookie, currentUser, requireRole, setSessionCookie } from '../http/auth.js';
import { HttpError, badRequest } from '../http/errors.js';
import { asObject, str } from '../http/validate.js';
import type { DemoService } from '../services/demo.js';

export function registerDemoRoutes(app: FastifyInstance, db: Db, demo: DemoService): void {
  /**
   * Whether this instance offers a demo, for `login.html` to decide whether to
   * show the buttons.
   *
   * Its own public route rather than a field on `/api/version` — the same call
   * `/api/version` itself makes and for the same reason: one of them is a fact
   * about the build and the other is a fact about what this deployment offers,
   * and a page that wanted only the second should not have to parse the first.
   *
   * It says nothing an unauthenticated caller could not learn by pressing the
   * button, and no counts: how full the pool is would tell a stranger when to
   * come back to find it empty.
   */
  app.get('/api/demo', { config: { public: true } }, async () => ({
    enabled: config.demo.enabled,
    leaseMinutes: Math.round(config.demo.leaseMs / 60_000),
  }));

  /**
   * Claim a slot and log the caller in.
   *
   * Public, and throttled twice: `demoClaimLimiter` here, plus the global
   * per-IP request budget in `server.ts`. Returns `landing` rather than issuing
   * a redirect, because the caller is `fetch` from `login.js` and a 302 on a
   * fetch is followed silently — the page would then have a session and no idea
   * where to go.
   */
  app.post('/api/demo/start', { config: { public: true } }, async (req, reply) => {
    if (!config.demo.enabled) {
      // 404 rather than 403: on an instance with the demo off, this route is
      // not a thing the caller lacks permission for, it is a thing that does
      // not exist. Saying otherwise advertises the feature to every scanner.
      throw new HttpError(404, 'not_found', `No route for ${req.url}.`);
    }

    const wait = demoClaimLimiter.retryAfterMs(req.ip);
    if (wait > 0) {
      const seconds = Math.ceil(wait / 1000);
      void reply.header('Retry-After', String(seconds));
      throw new HttpError(
        429,
        'too_many_attempts',
        `Too many demo sessions from this address. Try again in ${seconds} seconds.`,
      );
    }

    const body = asObject(req.body);
    const role = str(body, 'role', { max: 16 });
    if (role !== 'student' && role !== 'teacher') {
      throw badRequest('invalid_role', 'role must be "student" or "teacher".');
    }

    // Counted before the work, not after: the budget is against the *cost* of
    // claiming, and a claim that fails because the pool is busy has already
    // done the expensive part of the lookup.
    demoClaimLimiter.fail(req.ip);

    const lease = await demo.claim(role);
    const { token, expiresAt } = await createSession(
      db,
      lease.userId,
      { ip: req.ip, userAgent: req.headers['user-agent'] },
      lease.expiresAt,
    );
    setSessionCookie(reply, token, expiresAt);

    return {
      username: lease.username,
      role: lease.role,
      expiresAt: lease.expiresAt.toISOString(),
      /**
       * **The overview, for both roles, and the same page an ordinary login
       * lands on.** It used to deep-link — `/uebungen` for a teacher, `/sql`
       * for a student — on the reasoning that a 30-minute lease should not
       * spend a click getting to the point.
       *
       * 0.11.0 made that wrong and nothing failed: the first-run tour runs on
       * `/` only, so every demo visitor skipped past the one thing built to
       * explain the app to someone who has never seen it. Reported from
       * production, where a teacher pressed the demo button and got no tour.
       *
       * Landing here is also just better. A visitor dropped into `/uebungen`
       * sees an empty list and has to work out what the app *is* from the page
       * that assumes they already know; the overview says who they are, what
       * the sections are, and hands them the tour.
       *
       * `test/tour.test.mjs` now pins this to the page the tour runs on, so a
       * future deep link fails there rather than in front of a class.
       */
      landing: '/',
    };
  });

  /**
   * End a demo lease early, returning the slot to the pool.
   *
   * Separate from `/api/logout` rather than folded into it: logout is public
   * and idempotent and must never do work, and a caller with a real account
   * pressing it must not find its behaviour depends on a table they have no row
   * in. This one requires the session it is ending.
   */
  app.post('/api/demo/end', async (req, reply) => {
    const user = currentUser(req);
    if (!(await demo.isSlot(user.id))) {
      throw badRequest('not_a_demo_session', 'This account is not a demo account.');
    }
    await demo.release(user.id);
    // `clearSessionCookie`, not a bare `clearCookie`: the cookie is signed and
    // is named `__Host-dbk_sid` in production, and a `__Host-` cookie is only
    // cleared by a call carrying the same `secure` and `path` attributes. A
    // near-miss here leaves the browser holding a cookie whose session is gone,
    // which looks like a broken logout.
    clearSessionCookie(reply);
    return { ok: true };
  });

  /** The pool, for an admin deciding whether it is sized right. */
  app.get('/api/admin/demo', { preHandler: requireRole('admin') }, async () => ({
    enabled: config.demo.enabled,
    leaseMinutes: Math.round(config.demo.leaseMs / 60_000),
    slots: await demo.listSlots(),
  }));

  /**
   * Create whatever the pool is missing.
   *
   * A POST by a real admin rather than something `server.ts` does at boot,
   * because it creates Postgres login roles and a restart is not a decision
   * (§9c). Idempotent, so it is also how the pool is grown after raising
   * `DBK_DEMO_STUDENTS`.
   */
  app.post('/api/admin/demo/ensure', { preHandler: requireRole('admin') }, async (req) => {
    const admin = currentUser(req);
    return demo.ensurePool(admin.id);
  });
}
