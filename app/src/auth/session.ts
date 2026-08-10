/**
 * Server-side sessions, stored in the meta database's `session` table.
 *
 * The cookie carries a 32-byte random token; the table stores only its SHA-256.
 * A stolen database dump (or a `SELECT * FROM session` by anyone who ever gets
 * read access to the meta DB) therefore cannot be replayed as a login. The
 * token has full entropy, so a plain hash is enough — there is nothing to
 * brute-force and no need for a KDF here.
 *
 * Sessions are rolling: a session in active use is extended, an idle one dies
 * on its own. Expired rows are swept periodically rather than at read time, so
 * a full table never accumulates from students who just close the laptop lid.
 *
 * Phase 10 adds a third kind of expiry, `hard_expires_at`: an absolute stop for
 * one session that activity cannot move. It is null for every real account, and
 * it is what makes a demo lease 30 minutes rather than 30 minutes of idleness.
 */

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { config } from '../config.js';
import type { Db, Queryable } from '../db/query.js';

export interface SessionUser {
  id: number;
  username: string;
  displayName: string;
  role: 'admin' | 'teacher' | 'student';
  state: 'active' | 'archived' | 'cold' | 'deleted';
  locale: string;
  mustChangePassword: boolean;
  pgRole: string | null;
}

export interface LoadedSession {
  user: SessionUser;
  expiresAt: Date;
  /** The lease's absolute stop, or null for an ordinary session. Phase 10. */
  hardExpiresAt: Date | null;
}

/** Opaque value handed to the browser. Never stored. */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

function tokenKey(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

/**
 * A name one session answers to, safe to hand to the page's own JavaScript.
 *
 * The browser's cookie jar is per *profile*, not per tab, so every tab of this
 * app shares one session and a second login anywhere in the browser silently
 * re-points all of them (HANDOFF §18). A tab therefore has to be able to ask
 * "am I still the session I rendered as?", which needs a value it can compare —
 * and the two obvious candidates are both wrong to expose.
 *
 * The cookie token is the credential itself: `httpOnly` exists so that a missed
 * `esc()` cannot read it, and putting it in a response header hands it back to
 * exactly the script that must not have it. `tokenKey(token)` — the row's
 * primary key — is not a credential, since the server only ever compares
 * `sha256(presented)` against it, but it is the database identifier for a live
 * session, and "cannot be replayed as a login" is a thin thing to be relying on
 * in a value we publish on every response.
 *
 * So: an HMAC under the session secret, which is unforgeable without that
 * secret, reveals nothing about the token, and is stable for the life of the
 * session — which is what makes it comparable across two requests from the same
 * tab. Truncated because 128 bits is far past what "did this change?" needs.
 *
 * It changes when the *session* changes, not merely when the user does. That is
 * deliberate: the demo pool hands the same account to a new visitor half an
 * hour later, and a tab left open on the old lease must not quietly decide it
 * is still looking at its own data.
 */
export function sessionFingerprint(token: string): string {
  return createHmac('sha256', config.secrets.session)
    .update(tokenKey(token))
    .digest('base64url')
    .slice(0, 22);
}

export interface SessionOrigin {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export async function createSession(
  db: Queryable,
  userId: number,
  origin: SessionOrigin = {},
  /**
   * An absolute stop for this one session, on top of the global ceiling.
   *
   * Phase 10's demo lease is the only caller that passes one: a visitor gets 30
   * minutes and no amount of clicking extends it. A property of the *session*
   * rather than of the account on purpose — see `meta/004_demo.sql`.
   */
  hardExpiresAt: Date | null = null,
): Promise<{ token: string; expiresAt: Date }> {
  const token = newSessionToken();
  const rolling = new Date(Date.now() + config.session.ttlMs);
  // The row's own expiry never exceeds its ceiling, so nothing downstream has to
  // remember to check both. `refreshSession` and `loadSession` check anyway;
  // this is what makes the *first* twelve hours of a 30-minute lease impossible
  // rather than merely refused later.
  const expiresAt =
    hardExpiresAt !== null && hardExpiresAt.getTime() < rolling.getTime() ? hardExpiresAt : rolling;

  await db.query(
    `INSERT INTO session (id, user_id, expires_at, hard_expires_at, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      tokenKey(token),
      userId,
      expiresAt,
      hardExpiresAt,
      // `inet` rejects junk; an unparseable forwarded address should not fail a
      // login, so hand Postgres NULL rather than something it will reject.
      origin.ip !== undefined && isIP(origin.ip) !== 0 ? origin.ip : null,
      origin.userAgent?.slice(0, 500) ?? null,
    ],
  );

  return { token, expiresAt };
}

interface SessionRow {
  expires_at: Date;
  hard_expires_at: Date | null;
  id: number;
  username: string;
  display_name: string;
  role: SessionUser['role'];
  state: SessionUser['state'];
  locale: string;
  must_change_password: boolean;
  pg_role: string | null;
}

/**
 * Resolve a cookie token to its user, or null.
 *
 * Deliberately joins rather than doing two queries: a session whose user has
 * since been archived or deleted must stop working immediately, not at the next
 * expiry. `last_active_at` is *not* touched here — that would mean a write on
 * every request; it is updated on login and by the query runner in phase 3.
 */
export async function loadSession(db: Queryable, token: string): Promise<LoadedSession | null> {
  // The `hard_expires_at` test is redundant while `createSession` and
  // `refreshSession` both clamp `expires_at` to it, and it is kept anyway: this
  // is the one place a demo lease's 30 minutes is checked against the row
  // actually being used, so a future writer that sets `expires_at` directly
  // cannot silently hand a visitor an unbounded session.
  const { rows } = await db.query<SessionRow>(
    `SELECT s.expires_at, s.hard_expires_at,
            u.id, u.username, u.display_name, u.role, u.state, u.locale,
            u.must_change_password, u.pg_role
       FROM session s
       JOIN app_user u ON u.id = s.user_id
      WHERE s.id = $1 AND s.expires_at > now() AND u.state = 'active'
        AND (s.hard_expires_at IS NULL OR s.hard_expires_at > now())`,
    [tokenKey(token)],
  );

  const row = rows[0];
  if (!row) return null;

  return {
    expiresAt: row.expires_at,
    hardExpiresAt: row.hard_expires_at,
    user: {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      state: row.state,
      locale: row.locale,
      mustChangePassword: row.must_change_password,
      pgRole: row.pg_role,
    },
  };
}

/**
 * Extend a session that is more than halfway through its life, up to an
 * absolute ceiling measured from when it was created.
 *
 * The halfway check keeps this to at most one UPDATE per six hours per user
 * instead of one per request, which matters when 25 students are clicking Run
 * every few seconds.
 *
 * **The ceiling is the part that is about security rather than about writes.**
 * Rolling extension with no maximum means a session in continuous use never
 * ages out at all: a token lifted off a shared classroom machine stays valid
 * for as long as it keeps being used, which is indefinitely. `created_at` has
 * been written since the table existed and was never read; this is what reads
 * it.
 *
 * A week, against a 12-hour TTL. It cannot interrupt a lesson — reaching it
 * takes seven days of using the same session without ever logging out — and it
 * lands the re-authentication on a login page rather than mid-query.
 *
 * A demo lease's own ceiling (phase 10) is deliberately *not* expressed here as
 * a shorter `absoluteTtlMs`: that value is global, and a demo visitor and a
 * class share this code path.
 */
export async function refreshSession(
  db: Queryable,
  token: string,
  session: Pick<LoadedSession, 'expiresAt' | 'hardExpiresAt'>,
): Promise<Date | null> {
  // A session with an absolute stop has nothing to extend: `createSession`
  // already set `expires_at` to the stop itself, and the `LEAST` below would
  // write the same value back.
  //
  // This is not merely an optimisation, which is why it is a guard rather than
  // a comment on the clamp. The halfway test underneath is measured against the
  // *global* 12-hour TTL, so a 30-minute demo session is always inside it — and
  // without this line every single request a demo visitor makes would issue an
  // UPDATE, which is the exact per-request write the halfway test exists to
  // prevent.
  if (session.hardExpiresAt !== null) return null;

  const halfLife = config.session.ttlMs / 2;
  if (session.expiresAt.getTime() - Date.now() > halfLife) return null;

  const next = new Date(Date.now() + config.session.ttlMs);
  // `LEAST` in SQL rather than a read-then-write: the row is right here, and
  // two round trips would leave a window where a session past the ceiling is
  // extended anyway. A session already past it simply stops being extended and
  // expires on its own — no separate deletion, and the sweeper collects it.
  //
  // Phase 10 adds a third term. `LEAST` ignores NULLs, so an ordinary session —
  // where `hard_expires_at` is NULL — is clamped by exactly the two terms it
  // always was, and a demo lease is additionally pinned to its 30 minutes no
  // matter how busy the visitor is. That NULL-skipping is the reason this is one
  // expression rather than a branch in TypeScript.
  //
  // **`RETURNING` rather than trusting `next`.** The old version returned the
  // value it had *asked* for, which is what the cookie was then set to — so a
  // clamped session handed the browser an expiry later than the row's, and the
  // 30-minute lease would have looked like twelve hours to the countdown in
  // §9g. It never mattered while the only clamp was seven days away.
  const { rows } = await db.query<{ expires_at: Date }>(
    `UPDATE session
        SET expires_at = LEAST($2::timestamptz, created_at + $3::interval, hard_expires_at)
      WHERE id = $1
      RETURNING expires_at`,
    [tokenKey(token), next, config.session.absoluteTtlMs + ' milliseconds'],
  );
  return rows[0]?.expires_at ?? null;
}

export async function destroySession(db: Queryable, token: string): Promise<void> {
  await db.query(`DELETE FROM session WHERE id = $1`, [tokenKey(token)]);
}

/**
 * Drop every session of a user. Called on password change and on any state
 * change that should take effect now: a student whose password a teacher has
 * just reset must not keep browsing on the old one.
 */
export async function destroyUserSessions(db: Queryable, userId: number): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `DELETE FROM session WHERE user_id = $1 RETURNING id`,
    [userId],
  );
  return rows.length;
}

export async function sweepExpiredSessions(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `DELETE FROM session WHERE expires_at <= now() RETURNING id`,
  );
  return rows.length;
}

let sweeper: NodeJS.Timeout | undefined;

export function startSessionSweeper(db: Db, log: { warn: (msg: string) => void }): void {
  if (sweeper) return;
  sweeper = setInterval(
    () => {
      sweepExpiredSessions(db).catch((err: unknown) => {
        log.warn(`session sweep failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    },
    15 * 60 * 1000,
  );
  sweeper.unref();
}

export function stopSessionSweeper(): void {
  if (sweeper) clearInterval(sweeper);
  sweeper = undefined;
}
