/**
 * The public demo against a REAL PostgreSQL server — phase 10, HANDOFF §9.
 *
 * `demo.test.mjs` pins the lease bookkeeping and the caps. This suite exists
 * for the two claims that only a cluster can answer, and both are claims a mock
 * reports as passing while being wrong:
 *
 *   - **a wipe is a wipe.** `resetSlot` calls `resetSchema` and then drops every
 *     exercise workspace the account owns. Against a recording provisioner that
 *     is a list of calls; here it is whether the *next* visitor can still read
 *     the previous one's tables. That is the entire promise of the feature.
 *   - **two demo visitors are isolated from each other**, by Postgres and not by
 *     the app. A shared demo account was the design this phase rejected (§9a),
 *     so the thing it was rejected in favour of has to be shown to hold.
 *
 * PGlite cannot execute a single `GRANT`, so neither is askable there.
 *
 * SKIPPED unless a server is reachable. Bring one up without Docker or sudo:
 *
 *   SP=/tmp/dbk && rm -rf $SP && mkdir -p $SP
 *   initdb -D $SP/data -U postgres --locale=C.UTF-8 --encoding=UTF8 -A trust
 *   pg_ctl -D $SP/data -o "-p 55432 -k /tmp -c listen_addresses=127.0.0.1" -l $SP/pg.log start
 *   PGHOST=127.0.0.1 PGPORT=55432 POSTGRES_USER=postgres \
 *     DBK_APP_DB_PASSWORD=secret bash db/init/00-bootstrap.sh
 *   cd app && npm run build
 *   PGHOST=127.0.0.1 PGPORT=55432 DBK_APP_DB_PASSWORD=secret \
 *     node --test test/demo.live.test.mjs
 *
 * Creates and destroys roles prefixed `u_dmo` / `t_dmo`. Do NOT point it at an
 * instance where those could be real people.
 *
 * The roles here are driven through `provision.ts` directly rather than through
 * `demo.ensurePool`, which would need the meta database as well. What is under
 * test is what a *wipe* does to real schemas, and that is `resetSlot`'s two
 * seams — so the suite builds the same shape by hand and then asks the same
 * questions of it.
 */
import assert from 'node:assert/strict';
import { dist } from './support/meta-db.mjs';
import { asUser as connectAs, dropRoles, liveSuite, tryAsUser } from './support/live-pg.mjs';

const TEACHER = 't_dmo_lehrer';
const GAST1 = 'u_dmo_gast_1';
const GAST2 = 'u_dmo_gast_2';
/** Students first: a teacher holding grants on a student's schema fails 2BP01. */
const ALL = [GAST1, GAST2, TEACHER];
const PW = Object.fromEntries(ALL.map((r) => [r, `pw-${r}-x1`]));

/** An exercise workspace, the same recipe `auth/identifiers.ts` builds. */
const WS = (student) => `x10_${student}`;

const { LIVE, live, releaseLock } = await liveSuite('live demo suite');

const { makeProvisioner } = await import(dist('services/provision.js'));
const { makeDb } = await import(dist('db/query.js'));
const { teachAdminPool, closeAllPools } = await import(dist('db/pools.js'));

const teach = LIVE ? makeDb(teachAdminPool) : null;
const prov = LIVE ? makeProvisioner(teach) : null;

const asUser = (role, sql) => connectAs(role, PW[role], sql);

async function schemasOwnedBy(role) {
  const { rows } = await teach.query(
    `SELECT n.nspname FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner
      WHERE r.rolname = $1 ORDER BY 1`,
    [role],
  );
  return rows.map((r) => r.nspname);
}

const teardown = () => dropRoles(ALL);

/**
 * What `services/demo.ts`'s `wipeAccount` does to Postgres, in the same order.
 *
 * Written out rather than called, because `resetSlot` needs the meta database
 * for the rows it also clears and this suite has none. If the order in the
 * service changes, this has to change with it — which is the trade a live suite
 * of this shape always makes, and the reason the two seams are named in the
 * comment there.
 */
async function wipe(role) {
  await prov.resetSchema(role, [TEACHER]);
  for (const schema of await prov.listWorkspaces(role)) {
    await prov.dropWorkspace(role, schema);
  }
}

live('setup', async () => {
  await teardown();
  await prov.ensureTeacher({ pgRole: TEACHER, pgPassword: PW[TEACHER], canLogin: true });
  for (const gast of [GAST1, GAST2]) {
    await prov.ensureStudent({
      pgRole: gast,
      pgPassword: PW[gast],
      canLogin: true,
      teacherRoles: [TEACHER],
    });
  }
});

live('one demo visitor cannot read another demo visitor s tables', async () => {
  // The claim the pool exists to make. A shared account — the design §9a
  // rejected — would make this pass trivially and mean nothing, so it is asked
  // of two *different* slots holding data with the same table name.
  await asUser(GAST1, `CREATE TABLE ${GAST1}.notizen (id int, wert text)`);
  await asUser(GAST1, `INSERT INTO ${GAST1}.notizen VALUES (1, 'geheim-1')`);
  await asUser(GAST2, `CREATE TABLE ${GAST2}.notizen (id int, wert text)`);
  await asUser(GAST2, `INSERT INTO ${GAST2}.notizen VALUES (1, 'geheim-2')`);

  const both = await Promise.all([
    tryAsUser(GAST2, PW[GAST2], `SELECT wert FROM ${GAST1}.notizen`),
    tryAsUser(GAST1, PW[GAST1], `SELECT wert FROM ${GAST2}.notizen`),
  ]);
  for (const attempt of both) {
    assert.equal(attempt.ok, false, 'a demo visitor read another one s schema');
    assert.match(attempt.error, /permission denied|does not exist/i);
  }

  // And each still reads their own, so the refusal above is isolation rather
  // than something being broken for everyone.
  const mine = await tryAsUser(GAST1, PW[GAST1], `SELECT wert FROM notizen`);
  assert.equal(mine.ok, true);
  assert.equal(mine.rows[0].wert, 'geheim-1');
});

live('a wipe leaves nothing of the previous visitor behind', async () => {
  // The whole feature in one assertion. `notizen` was written by the last test
  // as GAST1; after a wipe the schema is there, empty, and the next visitor
  // starts from nothing.
  await wipe(GAST1);

  const still = await tryAsUser(GAST1, PW[GAST1], `SELECT wert FROM ${GAST1}.notizen`);
  assert.equal(still.ok, false);
  assert.match(still.error, /does not exist/i);

  // The schema itself survives, and is writable — a wipe that left the account
  // without a schema would be indistinguishable from a broken slot.
  assert.deepEqual(await schemasOwnedBy(GAST1), [GAST1]);
  const fresh = await tryAsUser(GAST1, PW[GAST1], `CREATE TABLE neu (id int)`);
  assert.equal(fresh.ok, true);

  // GAST2 is untouched: a claim wipes one slot, not the pool.
  const other = await tryAsUser(GAST2, PW[GAST2], `SELECT wert FROM notizen`);
  assert.equal(other.ok, true);
  assert.equal(other.rows[0].wert, 'geheim-2');
});

live('a wipe takes the exercise workspaces with it', async () => {
  // The half `resetSchema` does not do. A demo visitor who opened an exercise
  // owns a second schema, and `resetSchema` drops the playground by name — so
  // without the `listWorkspaces` loop the next visitor inherits the last one's
  // exercise work, in a schema nothing in the app would show them.
  await prov.createWorkspace(GAST1, WS(GAST1), [TEACHER]);
  await asUser(GAST1, `CREATE TABLE ${WS(GAST1)}.kunden (id int)`);
  assert.deepEqual(await schemasOwnedBy(GAST1), [GAST1, WS(GAST1)].sort());

  await wipe(GAST1);
  assert.deepEqual(await schemasOwnedBy(GAST1), [GAST1]);
});

live('the wiped account can still log in — a reset is not a deprovision', async () => {
  // The failure mode this guards is quiet: a wipe that also removed CONNECT or
  // set NOLOGIN leaves a pool of slots that claim fine and then cannot open a
  // connection, which surfaces to a visitor as the app being broken.
  const { rows } = await teach.query(
    `SELECT rolcanlogin FROM pg_roles WHERE rolname = $1`,
    [GAST1],
  );
  assert.equal(rows[0].rolcanlogin, true);
  const check = await tryAsUser(GAST1, PW[GAST1], `SELECT 1 AS ok`);
  assert.equal(check.ok, true);
});

live('teardown', async () => {
  // Not optional, and the assertion inside `dropRoles` is the half that matters:
  // HANDOFF §4u is the run where a swallowed teardown failure leaked a role into
  // a production cluster and permanently burned an identifier.
  await teardown();
  await releaseLock();
  await closeAllPools();
});
