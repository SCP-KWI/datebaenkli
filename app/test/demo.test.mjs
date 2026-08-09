/**
 * The public demo against migrated PGlite — phase 10, HANDOFF §9.
 *
 * The same split as every other service suite here, and the line falls in the
 * usual place: PGlite is the meta database, so this file covers the lease
 * bookkeeping and the caps, and a recording provisioner says *which* wipes the
 * service decided to perform. Whether those wipes actually isolate one visitor
 * from the next is `test/demo.live.test.mjs`, because PGlite cannot execute a
 * single GRANT and a demo account is a Postgres login role or it is nothing.
 *
 * `DBK_DEMO_ENABLED` is set before anything is imported: `config.ts` validates
 * at import and is a module singleton, so a later assignment would be read by
 * nobody.
 */

process.env.DBK_DEMO_ENABLED = 'true';
process.env.DBK_DEMO_STUDENTS = '2';
process.env.DBK_DEMO_TEACHERS = '1';
process.env.DBK_DEMO_LEASE_MINUTES = '30';

import assert from 'node:assert/strict';
import test from 'node:test';
import { dist, freshMeta } from './support/meta-db.mjs';

const users = await import(dist('services/users.js'));
const classes = await import(dist('services/classes.js'));
const provision = await import(dist('services/provision.js'));
const demoSvc = await import(dist('services/demo.js'));
const exerciseSvc = await import(dist('services/exercise.js'));
const sessions = await import(dist('auth/session.js'));

const noPool = () => ({
  connect: () => {
    throw new Error('this suite has no teaching database — see the header');
  },
});
const openQuota = {
  quotaBytes: 50 * 1024 * 1024,
  usage: async () => ({ bytes: 0, quotaBytes: 50 * 1024 * 1024, overQuota: false }),
  relationBytes: async () => 0,
  check: async () => {},
};

async function setup(options = {}) {
  const prov = provision.recordingProvisioner(options);
  const { db, adminId } = await freshMeta();
  const demo = demoSvc.makeDemoService({ db, prov });
  return { db, adminId, prov, demo };
}

const callsTo = (prov, op) => prov.calls.filter((c) => c.op === op).map((c) => c.args);
const usernamesOf = (slots, role) =>
  slots.filter((s) => s.role === role).map((s) => s.username).sort();

// --- building the pool -------------------------------------------------------

test('ensurePool creates one claimable slot per configured account, and a class for each teacher', async () => {
  const { db, adminId, demo } = await setup();
  const report = await demo.ensurePool(adminId);

  assert.equal(report.createdStudents.length, 2);
  assert.equal(report.createdTeachers.length, 1);

  const slots = await demo.listSlots();
  assert.equal(slots.length, 3);
  assert.deepEqual(usernamesOf(slots, 'student'), ['u_demo_gast_1', 'u_demo_gast_2']);
  assert.deepEqual(usernamesOf(slots, 'teacher'), ['t_demo']);
  assert.ok(slots.every((s) => s.busyUntil === null));

  // The teacher's three fixture students exist, are `demo`, and are NOT
  // claimable — a lease row on them would let a visitor land inside the roster
  // another visitor is looking at.
  const { rows: fixtures } = await db.query(
    `SELECT u.username, u.demo, (l.user_id IS NOT NULL) AS leased
       FROM app_user u
       LEFT JOIN demo_lease l ON l.user_id = u.id
       JOIN class_member cm ON cm.user_id = u.id
       JOIN class c ON c.id = cm.class_id
       JOIN app_user t ON t.id = c.teacher_id
      WHERE t.username = 't_demo'
      ORDER BY u.username`,
  );
  assert.deepEqual(
    fixtures.map((r) => r.username),
    ['u_demo1_bianchi_marco', 'u_demo1_keller_sara', 'u_demo1_muster_lena'],
  );
  assert.ok(fixtures.every((r) => r.demo === true));
  assert.ok(fixtures.every((r) => r.leased === false));
});

test('every demo account is exempt from the password gate', async () => {
  const { db, adminId, demo } = await setup();
  await demo.ensurePool(adminId);

  // A teacher is created with `must_change_password` set, which is right for a
  // real one and fatal for a demo: the gate is a global preHandler, so a
  // visitor would be handed a session that can reach nothing but the password
  // form and the demo would be a dead shell.
  const { rows } = await db.query(`SELECT count(*) AS n FROM app_user WHERE demo AND must_change_password`);
  assert.equal(Number(rows[0].n), 0);
});

test('ensurePool is idempotent, and grows the pool rather than duplicating it', async () => {
  const { adminId, demo } = await setup();
  await demo.ensurePool(adminId);
  const again = await demo.ensurePool(adminId);

  assert.deepEqual(again.createdStudents, []);
  assert.deepEqual(again.createdTeachers, []);
  assert.equal(again.unchanged, 3);
  assert.equal((await demo.listSlots()).length, 3);
});

// --- claiming ----------------------------------------------------------------

test('a claim takes a free slot, marks it busy and wipes it first', async () => {
  const { adminId, demo, prov } = await setup({
    workspaces: { u_demo_gast_1: ['x7_u_demo_gast_1'] },
  });
  await demo.ensurePool(adminId);
  prov.calls.length = 0;

  const lease = await demo.claim('student');
  assert.equal(lease.role, 'student');
  assert.match(lease.username, /^u_demo_gast_/);
  assert.ok(lease.expiresAt.getTime() > Date.now());

  // The playground *and* the exercise workspace. `resetSchema` does not touch
  // the second, which is the leak this assertion exists for.
  assert.deepEqual(callsTo(prov, 'resetSchema')[0][0], lease.username);
  if (lease.username === 'u_demo_gast_1') {
    assert.deepEqual(callsTo(prov, 'dropWorkspace'), [['u_demo_gast_1', 'x7_u_demo_gast_1']]);
  }

  const busy = (await demo.listSlots()).filter((s) => s.busyUntil !== null);
  assert.deepEqual(busy.map((s) => s.username), [lease.username]);
  assert.equal(busy[0].claims, 1);
  assert.ok(busy[0].lastResetAt instanceof Date);
});

test('two claims never hand out the same slot', async () => {
  const { adminId, demo } = await setup();
  await demo.ensurePool(adminId);

  const first = await demo.claim('student');
  const second = await demo.claim('student');
  assert.notEqual(first.userId, second.userId);
});

test('an exhausted pool refuses rather than sharing', async () => {
  const { adminId, demo } = await setup();
  await demo.ensurePool(adminId);
  await demo.claim('student');
  await demo.claim('student');

  await assert.rejects(() => demo.claim('student'), (err) => {
    assert.equal(err.code, 'demo_pool_busy');
    return true;
  });

  // The teacher side is a separate pool and is untouched by a full student one.
  const teacher = await demo.claim('teacher');
  assert.equal(teacher.role, 'teacher');
});

test('a lapsed lease returns to the pool', async () => {
  const { db, adminId, demo } = await setup();
  await demo.ensurePool(adminId);
  const first = await demo.claim('student');
  await demo.claim('student');

  await db.query(`UPDATE demo_lease SET expires_at = now() - interval '1 minute' WHERE user_id = $1`, [
    first.userId,
  ]);

  const again = await demo.claim('student');
  assert.equal(again.userId, first.userId);
  const slot = (await demo.listSlots()).find((s) => s.userId === first.userId);
  assert.equal(slot.claims, 2);
});

test('a wipe that fails hands the slot straight back instead of serving it dirty', async () => {
  // The recording provisioner can be told to throw from one seam. `resetSchema`
  // is the one that matters: a slot whose schema was not wiped must never reach
  // a visitor, and the design's answer is that returning it dirty costs nothing
  // because the *next* claim wipes it.
  const { adminId, demo } = await setup({ failing: { resetSchema: 'no cluster' } });
  await demo.ensurePool(adminId);

  await assert.rejects(() => demo.claim('student'));

  const busy = (await demo.listSlots()).filter((s) => s.busyUntil !== null);
  assert.deepEqual(busy, []);
});

test('release ends a lease without wiping — the next claim does that', async () => {
  const { adminId, demo, prov } = await setup();
  await demo.ensurePool(adminId);
  const lease = await demo.claim('student');
  prov.calls.length = 0;

  await demo.release(lease.userId);
  assert.deepEqual(callsTo(prov, 'resetSchema'), []);
  assert.deepEqual(
    (await demo.listSlots()).filter((s) => s.busyUntil !== null),
    [],
  );
});

// --- what a reset actually clears -------------------------------------------

test('a reset clears the query log, the hand-ins and the sessions left behind', async () => {
  const { db, adminId, demo } = await setup();
  await demo.ensurePool(adminId);
  const lease = await demo.claim('student');

  await db.query(`INSERT INTO query_log (user_id, sql_text) VALUES ($1, 'SELECT geheim')`, [
    lease.userId,
  ]);
  await sessions.createSession(db, lease.userId, {});

  await demo.resetSlot(lease.userId);

  // The query log is the one that is easy to forget and it is a disclosure:
  // the teacher's live lesson view reads it, so leaving it would show visitor
  // B what visitor A typed.
  const { rows: logs } = await db.query(`SELECT count(*) AS n FROM query_log WHERE user_id = $1`, [
    lease.userId,
  ]);
  assert.equal(Number(logs[0].n), 0);
  const { rows: live } = await db.query(`SELECT count(*) AS n FROM session WHERE user_id = $1`, [
    lease.userId,
  ]);
  assert.equal(Number(live[0].n), 0);
});

test('resetting a teacher slot drops its exercises and wipes its three students', async () => {
  const { db, adminId, demo, prov } = await setup();
  await demo.ensurePool(adminId);
  const lease = await demo.claim('teacher');

  const exercises = exerciseSvc.makeExerciseService({ db, prov, quota: openQuota, getPool: noPool });
  await exercises.createExercise(lease.userId, { title: 'Kunden', taskMd: '# Los' });
  prov.calls.length = 0;

  await demo.resetSlot(lease.userId);

  const { rows } = await db.query(`SELECT count(*) AS n FROM exercise WHERE teacher_id = $1`, [
    lease.userId,
  ]);
  assert.equal(Number(rows[0].n), 0);

  // The teacher's own playground plus all three fixture students.
  assert.deepEqual(callsTo(prov, 'resetSchema').map((a) => a[0]).sort(), [
    't_demo',
    'u_demo1_bianchi_marco',
    'u_demo1_keller_sara',
    'u_demo1_muster_lena',
  ]);
});

// --- the caps ----------------------------------------------------------------

test('a demo teacher cannot create a class, enrol anyone, or archive', async () => {
  const { db, adminId, demo, prov } = await setup();
  await demo.ensurePool(adminId);
  const lease = await demo.claim('teacher');

  const refuses = async (fn) =>
    assert.rejects(fn, (err) => {
      assert.equal(err.code, 'demo_not_allowed');
      return true;
    });

  await refuses(() =>
    classes.createClass(db, lease.userId, { code: 'neu', name: 'Neu', teacherId: lease.userId }),
  );

  const { rows: klass } = await db.query(`SELECT id FROM class WHERE code = 'demo1'`);
  await refuses(() =>
    users.createStudents(db, prov, lease.userId, klass[0].id, [
      { firstName: 'Neu', lastName: 'Person' },
    ]),
  );
  await refuses(() => classes.archiveClass(db, lease.userId, klass[0].id));
  await refuses(() => classes.updateClass(db, prov, lease.userId, klass[0].id, { name: 'X' }));

  const { rows: student } = await db.query(`SELECT id FROM app_user WHERE username = 'u_demo1_muster_lena'`);
  await refuses(() => users.setUserState(db, prov, lease.userId, student[0].id, 'archived'));
});

test('a real teacher is untouched by the caps', async () => {
  const { db, adminId, prov } = await setup();
  const { user: teacher } = await users.createTeacher(db, prov, adminId, {
    firstName: 'Petra',
    lastName: 'Lehrer',
  });
  const klass = await classes.createClass(db, adminId, {
    code: 'k3a',
    name: '3a',
    teacherId: teacher.id,
  });
  const made = await users.createStudents(db, prov, teacher.id, klass.id, [
    { firstName: 'Lena', lastName: 'Muster' },
  ]);
  assert.equal(made.length, 1);
});

test('a demo teacher may hold two exercises and not a third', async () => {
  const { db, adminId, demo, prov } = await setup();
  await demo.ensurePool(adminId);
  const lease = await demo.claim('teacher');
  const exercises = exerciseSvc.makeExerciseService({ db, prov, quota: openQuota, getPool: noPool });

  await exercises.createExercise(lease.userId, { title: 'Eins', taskMd: 'a' });
  await exercises.createExercise(lease.userId, { title: 'Zwei', taskMd: 'b' });
  await assert.rejects(
    () => exercises.createExercise(lease.userId, { title: 'Drei', taskMd: 'c' }),
    (err) => {
      assert.equal(err.code, 'demo_not_allowed');
      return true;
    },
  );

  // And deleting one makes room again — the cap is on what is held, not on how
  // many were ever written.
  const { rows } = await db.query(`SELECT id FROM exercise WHERE teacher_id = $1 ORDER BY id`, [
    lease.userId,
  ]);
  await exercises.deleteExercise(lease.userId, rows[0].id);
  const third = await exercises.createExercise(lease.userId, { title: 'Drei', taskMd: 'c' });
  assert.equal(third.title, 'Drei');
});

// --- the nightly sweep -------------------------------------------------------

test('the archive sweep never takes a demo slot out of the pool', async () => {
  const lifecycle = await import(dist('services/lifecycle.js'));
  const { db, adminId, demo, prov } = await setup();
  await demo.ensurePool(adminId);

  // Older than any threshold. A demo slot is idle by design between visitors,
  // so without the exclusion the whole pool ages out and every later claim
  // hands a visitor a NOLOGIN role.
  await db.query(`UPDATE app_user SET created_at = now() - interval '900 days',
                         last_active_at = now() - interval '900 days'
                   WHERE demo`);

  const report = await lifecycle.sweepInactiveStudents(db, prov, null);
  assert.deepEqual(report.archived, []);
  assert.equal(report.considered, 0);
});

// --- the session ceiling -----------------------------------------------------

test('a demo session expires on the lease, and activity does not extend it', async () => {
  const { db, adminId, demo } = await setup();
  await demo.ensurePool(adminId);
  const lease = await demo.claim('student');

  const hard = new Date(Date.now() + 30 * 60_000);
  const { token, expiresAt } = await sessions.createSession(db, lease.userId, {}, hard);

  // Not the global 12-hour TTL: `createSession` clamps to the ceiling, so the
  // cookie the browser is handed already carries the shorter date.
  assert.equal(expiresAt.getTime(), hard.getTime());

  const loaded = await sessions.loadSession(db, token);
  assert.equal(loaded.hardExpiresAt.getTime(), hard.getTime());

  // The rolling refresh is skipped outright for a leased session. Without that
  // guard it would fire on *every* request — the halfway test is measured
  // against the 12-hour TTL, which 30 minutes is always inside.
  assert.equal(await sessions.refreshSession(db, token, loaded), null);

  const { rows } = await db.query(`SELECT expires_at FROM session WHERE user_id = $1`, [
    lease.userId,
  ]);
  assert.equal(rows[0].expires_at.getTime(), hard.getTime());
});

test('an ordinary session is unaffected by the ceiling', async () => {
  const { db, adminId, prov } = await setup();
  const { user: teacher } = await users.createTeacher(db, prov, adminId, {
    firstName: 'Petra',
    lastName: 'Lehrer',
  });
  const { token } = await sessions.createSession(db, teacher.id, {});
  const loaded = await sessions.loadSession(db, token);
  assert.equal(loaded.hardExpiresAt, null);
  // Freshly created, so more than half its life remains and there is nothing to
  // do — the same answer as before phase 10.
  assert.equal(await sessions.refreshSession(db, token, loaded), null);
});

test('a session past its hard stop does not load, even if expires_at says otherwise', async () => {
  const { db, adminId, demo } = await setup();
  await demo.ensurePool(adminId);
  const lease = await demo.claim('student');
  const { token } = await sessions.createSession(
    db,
    lease.userId,
    {},
    new Date(Date.now() + 60_000),
  );

  // Exactly the state the redundant check in `loadSession` exists for: a writer
  // that moved `expires_at` on its own would otherwise have handed this visitor
  // an unbounded session.
  await db.query(
    `UPDATE session SET expires_at = now() + interval '12 hours',
            hard_expires_at = now() - interval '1 second'
      WHERE user_id = $1`,
    [lease.userId],
  );
  assert.equal(await sessions.loadSession(db, token), null);
});
