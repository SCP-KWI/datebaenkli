/**
 * The public demo — a pool of accounts lent to strangers for half an hour.
 * HANDOFF §9 is the design; this header records the three things that decide
 * how the file is written rather than what it does.
 *
 * **This file builds no SQL by string, and it must not start.** Wiping a schema
 * and dropping an exercise workspace are both identifier-taking DDL, which is
 * exactly the hazard `services/provision.ts`'s header is about — so both go
 * through seams that already exist there (`resetSchema`, `listWorkspaces`,
 * `dropWorkspace`). CLAUDE.md's rule is that a third SQL-concatenating file
 * needs its argument made explicitly; this is deliberately not that file, in the
 * same way `services/exercise.ts` deliberately was not. If an edit here finds
 * itself wanting to quote an identifier, the seam belongs in `provision.ts`.
 *
 * **Reset happens on claim, never on release.** Every release path is skippable
 * — the visitor closes the tab, the container is redeployed, a lease simply
 * lapses — so a reset that runs on the way out is a guarantee with holes in it.
 * On the way in there are none: nothing is shown to a visitor before it has run.
 * A consequence worth knowing: a dirty account going *back* into the pool is
 * harmless and is not an error path.
 *
 * **A lease is claimed in the meta database; the wipe happens after it commits.**
 * The two databases cannot share a transaction (CLAUDE.md), so this follows the
 * shape the rest of the app already uses for provisioning — commit the row, act
 * afterwards, and repair rather than fail. If the wipe throws, the lease is
 * handed straight back instead of being served dirty.
 */

import { config } from '../config.js';
import type { Db, Queryable } from '../db/query.js';
import { destroyUserSessions } from '../auth/session.js';
import { audit } from './audit.js';
import type { Provisioner } from './provision.js';
import { createClass } from './classes.js';
import {
  createStudents,
  createTeacher,
  pgIdentity,
  ServiceError,
  type PgIdentity,
} from './users.js';

/** A claimable slot, as the admin page sees it. */
export interface DemoSlot {
  userId: number;
  username: string;
  role: 'student' | 'teacher';
  /** null when the slot is free. */
  busyUntil: Date | null;
  claims: number;
  lastResetAt: Date | null;
}

export interface ClaimedLease {
  userId: number;
  username: string;
  role: 'student' | 'teacher';
  /** When the visitor's session must stop, regardless of activity. */
  expiresAt: Date;
}

export interface EnsureReport {
  createdTeachers: string[];
  createdStudents: string[];
  /** Accounts that already existed and were left alone. */
  unchanged: number;
}

export interface DemoServiceDeps {
  db: Db;
  prov: Provisioner;
}

/**
 * The fixture class every claimable teacher gets, and the one thing about it
 * that is load-bearing: **these three are `demo` accounts without a lease.**
 * Nobody ever logs in as them (§9f — a demo teacher cannot enrol, so the class
 * has to arrive pre-built), and a lease row is what would make them claimable.
 */
const FIXTURE_STUDENTS: readonly { firstName: string; lastName: string }[] = [
  { firstName: 'Lena', lastName: 'Muster' },
  { firstName: 'Marco', lastName: 'Bianchi' },
  { firstName: 'Sara', lastName: 'Keller' },
];

/** The class holding the claimable student accounts. Code, then display name. */
const GUEST_CLASS = { code: 'demo', name: 'Demo — Gäste' };

export function makeDemoService({ db, prov }: DemoServiceDeps) {
  function requireEnabled(): void {
    if (!config.demo.enabled) {
      throw new ServiceError('demo_disabled', 'The public demo is not enabled on this instance.');
    }
  }

  // --- reading ---------------------------------------------------------------

  async function listSlots(): Promise<DemoSlot[]> {
    const { rows } = await db.query<{
      userId: number;
      username: string;
      role: 'student' | 'teacher';
      expiresAt: Date | null;
      claims: number;
      resetAt: Date | null;
    }>(
      `SELECT u.id AS "userId", u.username, u.role,
              l.expires_at AS "expiresAt", l.claims, l.reset_at AS "resetAt"
         FROM demo_lease l JOIN app_user u ON u.id = l.user_id
        ORDER BY u.role, u.username`,
    );
    const now = Date.now();
    return rows.map((r) => ({
      userId: r.userId,
      username: r.username,
      role: r.role,
      // Computed here rather than asked of SQL so that "free" means the same
      // thing to the admin page as it does to `claim`, which is the only other
      // reader of this column.
      busyUntil: r.expiresAt !== null && r.expiresAt.getTime() > now ? r.expiresAt : null,
      claims: Number(r.claims),
      lastResetAt: r.resetAt,
    }));
  }

  // --- resetting -------------------------------------------------------------

  /**
   * Everything one account owns, wiped: the playground, every exercise
   * workspace, and the meta rows that would otherwise show the previous
   * visitor's work to the next one.
   *
   * `query_log` is in that list and it is the one that is easy to forget. It
   * carries the SQL somebody typed, and the teacher's live lesson view reads it
   * — so leaving it would show visitor B what visitor A was doing, which is the
   * same disclosure the schema wipe exists to prevent.
   */
  async function wipeAccount(identity: PgIdentity): Promise<void> {
    // Postgres first, meta second. The reverse order would delete the
    // `exercise_workspace` rows that name the schemas still to be dropped,
    // leaving them orphaned and invisible — `listWorkspaces` asks
    // `pg_namespace` rather than the meta database precisely so this is
    // recoverable, but there is no reason to need the recovery.
    await prov.resetSchema(identity.pgRole, identity.teacherRoles);
    for (const schema of await prov.listWorkspaces(identity.pgRole)) {
      await prov.dropWorkspace(identity.pgRole, schema);
    }

    await db.tx(async (q) => {
      await q.query(`DELETE FROM exercise_workspace WHERE user_id = $1`, [identity.userId]);
      await q.query(`DELETE FROM submission WHERE user_id = $1`, [identity.userId]);
      await q.query(`DELETE FROM query_log WHERE user_id = $1`, [identity.userId]);
    });
    await destroyUserSessions(db, identity.userId);
  }

  /**
   * A whole slot, back to its fixture state.
   *
   * For a teacher that is more than their own schema: the exercises they wrote
   * are theirs, and their class's three students hold a copy of every one that
   * was distributed. Deleting the exercise rows cascades in the meta database
   * and touches no schema, so the students are wiped first — `listWorkspaces`
   * reads Postgres and would still find the schemas afterwards, but only
   * because that function is careful, and relying on it here would be relying
   * on it by accident.
   */
  async function resetSlot(userId: number): Promise<void> {
    const identity = await pgIdentity(db, userId);
    if (!identity) {
      throw new ServiceError('not_provisioned', 'This demo account has no database of its own.');
    }

    if (identity.role === 'teacher') {
      for (const student of await fixtureStudentIds(db, userId)) {
        const si = await pgIdentity(db, student);
        if (si) await wipeAccount(si);
      }
      await db.query(`DELETE FROM exercise WHERE teacher_id = $1`, [userId]);
    }

    await wipeAccount(identity);
    await db.query(`UPDATE demo_lease SET reset_at = now() WHERE user_id = $1`, [userId]);
  }

  // --- claiming --------------------------------------------------------------

  /**
   * Take a free slot for `role`, wipe it, and return the lease.
   *
   * The `SKIP LOCKED` is what makes two visitors clicking in the same second
   * get two different accounts rather than one of them getting an error: the
   * second claim steps over the row the first has locked instead of waiting for
   * it and then finding it taken.
   */
  async function claim(role: 'student' | 'teacher'): Promise<ClaimedLease> {
    requireEnabled();

    const expiresAt = new Date(Date.now() + config.demo.leaseMs);
    const { rows } = await db.query<{ userId: number; username: string }>(
      `UPDATE demo_lease l
          SET claimed_at = now(), expires_at = $2, claims = l.claims + 1
        WHERE l.user_id = (
                SELECT d.user_id
                  FROM demo_lease d JOIN app_user u ON u.id = d.user_id
                 WHERE u.role = $1 AND u.state = 'active' AND u.demo
                   AND (d.expires_at IS NULL OR d.expires_at < now())
                 ORDER BY d.expires_at NULLS FIRST, d.user_id
                   FOR UPDATE OF d SKIP LOCKED
                 LIMIT 1)
        RETURNING l.user_id AS "userId",
                  (SELECT username FROM app_user WHERE id = l.user_id) AS username`,
      [role, expiresAt],
    );

    const slot = rows[0];
    if (!slot) {
      throw new ServiceError(
        'demo_pool_busy',
        'Every demo account is in use right now. Try again in a few minutes.',
      );
    }

    try {
      await resetSlot(slot.userId);
    } catch (err) {
      // Hand the slot straight back. Serving it dirty is the one outcome this
      // whole design exists to prevent, and a slot that returns to the pool
      // un-wiped costs nothing: the *next* claim resets it before use.
      await db
        .query(`UPDATE demo_lease SET expires_at = now() WHERE user_id = $1`, [slot.userId])
        .catch(() => {});
      throw err;
    }

    await audit(db, {
      actorId: null,
      action: 'demo_claimed',
      targetType: 'app_user',
      targetId: slot.userId,
      detail: { role, expiresAt: expiresAt.toISOString() },
    });

    return { userId: slot.userId, username: slot.username, role, expiresAt };
  }

  /**
   * End a lease early — the visitor pressed "Beenden".
   *
   * Does **not** wipe: `claim` does that, and doing it here as well would double
   * the cost of the common path to buy a guarantee that only holds when the
   * visitor is polite enough to use the button. The sessions go, so the cookie
   * in that browser is dead either way.
   */
  async function release(userId: number): Promise<void> {
    await db.query(`UPDATE demo_lease SET expires_at = now() WHERE user_id = $1`, [userId]);
    await destroyUserSessions(db, userId);
  }

  /** True if this account is a claimable demo slot. */
  async function isSlot(userId: number): Promise<boolean> {
    const { rows } = await db.query(`SELECT 1 FROM demo_lease WHERE user_id = $1`, [userId]);
    return rows.length > 0;
  }

  // --- building the pool -----------------------------------------------------

  /**
   * Create whatever the pool is missing, and nothing else.
   *
   * Admin-triggered rather than run at boot (§9c): this creates real login roles
   * in the teaching database, and a restart is not a decision. It is idempotent,
   * so running it after raising `DBK_DEMO_STUDENTS` adds the difference.
   *
   * Every account it makes is `demo = true` and `must_change_password = false`.
   * The second is not cosmetic — the password gate is a *global* preHandler, so
   * a demo teacher created the ordinary way would be handed a session that can
   * reach nothing but the password form, and the demo would be a dead shell.
   */
  async function ensurePool(actorId: number): Promise<EnsureReport> {
    requireEnabled();

    const report: EnsureReport = { createdTeachers: [], createdStudents: [], unchanged: 0 };
    const existing = await listSlots();
    report.unchanged = existing.length;

    const haveTeachers = existing.filter((s) => s.role === 'teacher').length;
    const haveStudents = existing.filter((s) => s.role === 'student').length;

    // --- the claimable teachers, each with a class of three ---
    for (let i = haveTeachers; i < config.demo.teachers; i++) {
      const teacher = await createTeacher(db, prov, actorId, {
        firstName: 'Lehrperson',
        lastName: 'Demo',
      });
      await markDemo(db, teacher.user.id);
      await addLease(db, teacher.user.id);
      report.createdTeachers.push(teacher.user.username);

      const klass = await createClass(db, actorId, {
        // Unique per teacher, and short: it becomes part of every fixture
        // student's identifier (`u_demo1_muster_lena`).
        code: `demo${i + 1}`,
        name: 'Demo-Klasse',
        teacherId: teacher.user.id,
      });
      const students = await createStudents(db, prov, actorId, klass.id, [...FIXTURE_STUDENTS], {
        mustChangePassword: false,
      });
      for (const s of students) await markDemo(db, s.user.id);
    }

    // --- the claimable students, in one shared class ---
    if (haveStudents < config.demo.students) {
      const owner = await guestClassOwner(db, prov, actorId);
      const people = [];
      for (let i = haveStudents; i < config.demo.students; i++) {
        people.push({ firstName: String(i + 1), lastName: 'Gast' });
      }
      const students = await createStudents(db, prov, actorId, owner.classId, people, {
        mustChangePassword: false,
      });
      for (const s of students) {
        await markDemo(db, s.user.id);
        await addLease(db, s.user.id);
        report.createdStudents.push(s.user.username);
      }
    }

    await audit(db, {
      actorId,
      action: 'demo_pool_ensured',
      detail: {
        createdTeachers: report.createdTeachers,
        createdStudents: report.createdStudents,
      },
    });

    return report;
  }

  return { claim, release, resetSlot, listSlots, ensurePool, isSlot };
}

export type DemoService = ReturnType<typeof makeDemoService>;

// --- helpers -----------------------------------------------------------------

async function markDemo(db: Queryable, userId: number): Promise<void> {
  await db.query(`UPDATE app_user SET demo = true, must_change_password = false WHERE id = $1`, [
    userId,
  ]);
}

async function addLease(db: Queryable, userId: number): Promise<void> {
  await db.query(`INSERT INTO demo_lease (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [userId]);
}

/** The students sitting in the classes a demo teacher owns. */
async function fixtureStudentIds(db: Queryable, teacherId: number): Promise<number[]> {
  const { rows } = await db.query<{ id: number }>(
    `SELECT DISTINCT cm.user_id AS id
       FROM class c JOIN class_member cm ON cm.class_id = c.id
      WHERE c.teacher_id = $1`,
    [teacherId],
  );
  return rows.map((r) => r.id);
}

/**
 * The teacher who owns the guest class, created on first use.
 *
 * A class needs a teacher and a student needs a class, so the claimable
 * students need an owner who is *not* one of the claimable teachers — otherwise
 * a visitor claiming a teacher slot would open the roster and find eight guest
 * accounts in it, and resetting that teacher would wipe the student pool.
 */
async function guestClassOwner(
  db: Db,
  prov: Provisioner,
  actorId: number,
): Promise<{ userId: number; classId: number }> {
  const { rows } = await db.query<{ userId: number; classId: number }>(
    `SELECT c.teacher_id AS "userId", c.id AS "classId" FROM class c WHERE c.code = $1`,
    [GUEST_CLASS.code],
  );
  const found = rows[0];
  if (found) return found;

  const owner = await createTeacher(db, prov, actorId, {
    firstName: 'Demo',
    lastName: 'Verwaltung',
  });
  await markDemo(db, owner.user.id);
  // Deliberately *no* `demo_lease` row: this account administers the pool and
  // is never handed out.
  const klass = await createClass(db, actorId, {
    code: GUEST_CLASS.code,
    name: GUEST_CLASS.name,
    teacherId: owner.user.id,
  });
  return { userId: owner.user.id, classId: klass.id };
}
