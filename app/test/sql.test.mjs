/**
 * Migration checks, in two layers.
 *
 *  1. PARSE  — every .sql file through libpg-query, the real PostgreSQL
 *              grammar. Catches syntax errors without a server.
 *  2. EXECUTE — the migrations run in PGlite (Postgres compiled to WASM) and
 *              the resulting data is asserted. Catches what parsing cannot:
 *              wrong column types, broken FK targets, CHECK violations,
 *              non-deterministic seed data.
 *
 * KNOWN GAPS — neither layer covers these, they need a real server:
 *   - CREATE ROLE / GRANT / REVOKE / ALTER DEFAULT PRIVILEGES (PGlite is
 *     single-user, so grants are stripped before execution below)
 *   - the db/init bootstrap as a whole (roles, databases)
 *   - per-role SET statement_timeout etc.
 *   - PGlite tracks a newer Postgres major than the server's 17; everything
 *     used here is long-stable SQL, but the versions are not identical.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import pgQuery from 'libpg-query';

const SQL_ROOT = join(import.meta.dirname, '..', 'src', 'db', 'sql');
const BOOTSTRAP = join(import.meta.dirname, '..', '..', 'db', 'init', '00-bootstrap.sh');

const read = (p) => readFileSync(join(SQL_ROOT, p), 'utf8');

function migrationFiles() {
  const out = [];
  for (const target of readdirSync(SQL_ROOT)) {
    for (const f of readdirSync(join(SQL_ROOT, target))) {
      if (f.endsWith('.sql')) out.push(`${target}/${f}`);
    }
  }
  return out.sort();
}

/** PGlite has no roles; drop grant machinery so the rest can be executed. */
const stripGrants = (sql) =>
  sql
    .replace(/^GRANT .*?;$/gms, '')
    .replace(/^REVOKE .*?;$/gms, '')
    .replace(/^ALTER DEFAULT PRIVILEGES[\s\S]*?;$/gm, '');

// --- layer 1: parse ----------------------------------------------------------

for (const file of migrationFiles()) {
  test(`parse: ${file}`, async () => {
    const tree = await pgQuery.parse(read(file));
    assert.ok(tree.stmts.length > 0, 'should contain at least one statement');
  });
}

test('parse: db/init bootstrap heredocs', async () => {
  const shell = readFileSync(BOOTSTRAP, 'utf8');
  const blocks = [...shell.matchAll(/<<-'EOSQL'\n([\s\S]*?)\nEOSQL/g)].map((m) => m[1]);
  // Four: the databases, the two `public` schemas, the meta lockdown, and the
  // large-object revokes. The count is asserted rather than just iterated so
  // that a block someone deletes shows up here instead of silently ceasing to
  // be checked — which is the whole point of parsing them at all.
  assert.equal(blocks.length, 4, 'expected four SQL heredocs in the bootstrap script');
  for (const block of blocks) {
    // psql's :'var' interpolation is not SQL; substitute before parsing.
    const tree = await pgQuery.parse(block.replace(/:'app_pw'/g, "'placeholder'"));
    assert.ok(tree.stmts.length > 0);
  }
});

// --- layer 2: execute --------------------------------------------------------

/**
 * Every migration for one target, in filename order — the rule `db/migrate.ts`
 * applies, rather than a list to keep in step with the directory. A file that a
 * hardcoded list forgot is a migration this layer never executes, which is
 * precisely the thing it exists to catch.
 */
async function fresh(target) {
  const db = new PGlite();
  await db.waitReady;
  for (const file of migrationFiles().filter((f) => f.startsWith(`${target}/`))) {
    await db.exec(stripGrants(read(file)));
  }
  return db;
}

const freshMeta = () => fresh('meta');
const freshTeach = () => fresh('teach');

/**
 * One teaching database, shared by the `tonspur:` tests below.
 *
 * Every one of them is read-only, and a PGlite instance holding the Tonspur
 * data costs ~325 MB against ~230 MB without it (measured 2026-08-18) — six
 * fresh ones would put half a gigabyte on this file's peak to prove nothing
 * the first one does not. CLAUDE.md's note about `--test-concurrency=1` is why
 * that number is worth caring about.
 *
 * **Not a replacement for `freshTeach()`**, and specifically not for
 * 'demo: generated data is identical across deployments' — that test compares
 * two independently built databases, and handing it the same one twice would
 * leave it passing while testing nothing.
 */
let tonspurDb;
const sharedTonspur = async () => (tonspurDb ??= await freshTeach());

test('meta: schema creates the expected tables', async () => {
  const db = await freshMeta();
  const { rows } = await db.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema='public' ORDER BY table_name`,
  );
  assert.deepEqual(
    rows.map((r) => r.table_name),
    ['app_user', 'audit_log', 'class', 'class_member', 'demo_lease', 'exercise',
     'exercise_assignment', 'exercise_source', 'exercise_workspace',
     'query_log', 'session', 'setting', 'submission'],
  );
});

test('meta: 003 drops the auto-grading columns rather than leaving them', async () => {
  // The point of the assertion is the *absence*. 003's header argues that an
  // unused column with no writer and no UI is a decoy, and a decoy is exactly
  // what a later reader would re-grow a feature around.
  const db = await freshMeta();
  const { rows } = await db.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'exercise' ORDER BY column_name`,
  );
  const columns = rows.map((r) => r.column_name);
  for (const gone of ['solution_sql', 'compare', 'published', 'setup_sql']) {
    assert.ok(!columns.includes(gone), `exercise.${gone} should have been dropped by 003`);
  }
  const { rows: types } = await db.query(
    `SELECT typname FROM pg_type WHERE typname = 'compare_mode'`,
  );
  assert.equal(types.length, 0);
});

test('meta: a workspace schema name must look like one', async () => {
  // The CHECK is the second of db/ident.ts's two independent guards, restated in
  // the database. A role name must fail it: `u_…` is the string this constraint
  // exists to keep out of a column that gets interpolated into `DROP SCHEMA`.
  const db = await freshMeta();
  await db.exec(`INSERT INTO app_user (username, display_name, role, password_hash, pg_role)
                 VALUES ('lena','Lena','student','x','u_k3a_muster_lena')`);
  await db.exec(`INSERT INTO exercise (teacher_id, title)
                 SELECT id, 'Kunden' FROM app_user WHERE username = 'lena'`);

  const insert = (schema) =>
    db.query(
      `INSERT INTO exercise_workspace (exercise_id, user_id, schema_name)
       SELECT (SELECT id FROM exercise), (SELECT id FROM app_user), $1`,
      [schema],
    );

  await insert('x1_u_k3a_muster_lena');
  for (const bad of ['u_k3a_muster_lena', 'public', 'x_u_lena', 'X1_U_LENA']) {
    await assert.rejects(() => insert(bad), /exercise_workspace_name_ck/);
  }
});

test('meta: two hand-ins cannot both be attempt 2', async () => {
  const db = await freshMeta();
  await db.exec(`INSERT INTO app_user (username, display_name, role, password_hash, pg_role)
                 VALUES ('lena','Lena','student','x','u_k3a_muster_lena')`);
  await db.exec(`INSERT INTO exercise (teacher_id, title)
                 SELECT id, 'Kunden' FROM app_user WHERE username = 'lena'`);
  const submit = (attempt) =>
    db.query(
      `INSERT INTO submission (exercise_id, user_id, sql_text, attempt)
       SELECT (SELECT id FROM exercise), (SELECT id FROM app_user), 'SELECT 1', $1`,
      [attempt],
    );
  await submit(1);
  await submit(2);
  await assert.rejects(() => submit(2), /submission_attempt_key/);
});

test('meta: admins have no pg_role, everyone else must', async () => {
  const db = await freshMeta();
  await db.exec(`INSERT INTO app_user (username, display_name, role, password_hash)
                 VALUES ('admin','Admin','admin','x')`);
  await assert.rejects(
    () => db.exec(`INSERT INTO app_user (username, display_name, role, password_hash, pg_role)
                   VALUES ('a2','A2','admin','x','u_nope')`),
    /app_user_pg_role_ck/,
  );
  await assert.rejects(
    () => db.exec(`INSERT INTO app_user (username, display_name, role, password_hash)
                   VALUES ('s1','S1','student','x')`),
    /app_user_pg_role_ck/,
  );
});

test('meta: locale is restricted to supported values', async () => {
  const db = await freshMeta();
  await assert.rejects(
    () => db.exec(`INSERT INTO app_user (username, display_name, role, password_hash, locale)
                   VALUES ('s2','S2','student','x','fr')`),
    /locale/,
  );
});

test('meta: username unique case-insensitively, reusable after deletion', async () => {
  const db = await freshMeta();
  await db.exec(`INSERT INTO app_user (username, display_name, role, password_hash)
                 VALUES ('admin','Admin','admin','x')`);
  await assert.rejects(
    () => db.exec(`INSERT INTO app_user (username, display_name, role, password_hash)
                   VALUES ('ADMIN','Dup','admin','x')`),
    /app_user_username_key/,
  );
  await db.exec(`UPDATE app_user SET state='deleted' WHERE username='admin'`);
  await db.exec(`INSERT INTO app_user (username, display_name, role, password_hash)
                 VALUES ('admin','Reused','admin','x')`);
});

test('meta: class codes must be lowercase slugs', async () => {
  const db = await freshMeta();
  // teachers are non-admin, so app_user_pg_role_ck requires a pg_role
  await db.exec(`INSERT INTO app_user (username, display_name, role, password_hash, pg_role)
                 VALUES ('t','T','teacher','x','t_schaffner')`);
  await assert.rejects(
    () => db.exec(`INSERT INTO class (code, name, teacher_id)
                   VALUES ('K3a!','Bad',(SELECT id FROM app_user LIMIT 1))`),
    /class_code_ck/,
  );
});

test('demo: row counts are as designed', async () => {
  const db = await freshTeach();
  const { rows } = await db.query(`
    SELECT 'kantone' t, count(*)::int c FROM demo.kantone
    UNION ALL SELECT 'gemeinden', count(*)::int FROM demo.gemeinden
    UNION ALL SELECT 'faecher', count(*)::int FROM demo.faecher
    UNION ALL SELECT 'schuelerinnen', count(*)::int FROM demo.schuelerinnen
    UNION ALL SELECT 'noten', count(*)::int FROM demo.noten
    UNION ALL SELECT 'artikel', count(*)::int FROM demo.artikel
    UNION ALL SELECT 'bestellungen', count(*)::int FROM demo.bestellungen`);
  const c = Object.fromEntries(rows.map((r) => [r.t, r.c]));
  assert.equal(c.kantone, 26, 'Switzerland has 26 cantons');
  assert.equal(c.schuelerinnen, 30);
  assert.equal(c.faecher, 8);
  assert.equal(c.noten, 30 * 8 * 3, 'three marks per student per subject');
  assert.equal(c.bestellungen, 60);
});

test('demo: Noten land on exact half steps (numeric(2,1) cannot hold quarters)', async () => {
  const db = await freshTeach();
  const { rows } = await db.query('SELECT DISTINCT note FROM demo.noten ORDER BY note');
  assert.deepEqual(rows.map((r) => Number(r.note)), [3, 3.5, 4, 4.5, 5, 5.5, 6]);
});

test('demo: no orphaned foreign keys', async () => {
  const db = await freshTeach();
  const { rows } = await db.query(`
    SELECT
      (SELECT count(*)::int FROM demo.gemeinden g
        LEFT JOIN demo.kantone k ON k.id=g.kanton_id WHERE k.id IS NULL) AS gem,
      (SELECT count(*)::int FROM demo.schuelerinnen s
        LEFT JOIN demo.gemeinden g ON g.id=s.gemeinde_id WHERE g.id IS NULL) AS sch,
      (SELECT count(*)::int FROM demo.bestellpositionen p
        LEFT JOIN demo.artikel a ON a.id=p.artikel_id WHERE a.id IS NULL) AS pos`);
  assert.deepEqual(rows[0], { gem: 0, sch: 0, pos: 0 });
});

test('demo: every canton has at least one Gemeinde, so JOINs are interesting', async () => {
  const db = await freshTeach();
  const { rows } = await db.query(
    `SELECT count(*)::int c FROM demo.kantone k
     WHERE NOT EXISTS (SELECT 1 FROM demo.gemeinden g WHERE g.kanton_id=k.id)`);
  assert.equal(rows[0].c, 0);
});

test('demo: generated data is identical across deployments', async () => {
  // v2 exercises compare a student result to a reference solution, so two
  // installations must agree on what the data is.
  const fingerprint = async (db) => {
    const { rows } = await db.query(`
      SELECT md5(string_agg(x, '|' ORDER BY x)) AS h FROM (
        SELECT id||':'||schuelerin_id||':'||fach_id||':'||note||':'||datum AS x FROM demo.noten
        UNION ALL
        SELECT 'b'||id||':'||schuelerin_id||':'||datum||':'||status FROM demo.bestellungen
        UNION ALL
        SELECT 'p'||bestellung_id||':'||artikel_id||':'||menge||':'||einzelpreis
          FROM demo.bestellpositionen
      ) s`);
    return rows[0].h;
  };
  assert.equal(await fingerprint(await freshTeach()), await fingerprint(await freshTeach()));
});

test('demo: a representative lesson query works', async () => {
  const db = await freshTeach();
  const { rows } = await db.query(`
    SELECT k.name AS kanton, count(DISTINCT s.id)::int AS lernende,
           round(avg(n.note), 2) AS schnitt
    FROM demo.kantone k
    JOIN demo.gemeinden g ON g.kanton_id = k.id
    JOIN demo.schuelerinnen s ON s.gemeinde_id = g.id
    JOIN demo.noten n ON n.schuelerin_id = s.id
    GROUP BY k.name HAVING count(DISTINCT s.id) > 1
    ORDER BY schnitt DESC`);
  assert.ok(rows.length > 0);
  for (const r of rows) {
    assert.ok(Number(r.schnitt) >= 1 && Number(r.schnitt) <= 6);
  }
});

// --- tonspur -----------------------------------------------------------------
//
// `003_tonspur.sql` is generated from a CSV export (`tools/tonspur-sql.mjs`),
// so what these tests are guarding is not the SQL — it parses, or layer 1 would
// have said so. It is the half-dozen *properties of the data* the Lektionsreihe
// is built on. Each one is something a well-meaning edit would remove while
// making the dataset look tidier, and none of them shows up as an error: a
// dataset with the hole filled in runs every query in the lesson and quietly
// answers the wrong question.

test('tonspur: row counts are as exported', async () => {
  const db = await sharedTonspur();
  const { rows } = await db.query(`
    SELECT 'kuenstler' t, count(*)::int c FROM tonspur.kuenstler
    UNION ALL SELECT 'album', count(*)::int FROM tonspur.album
    UNION ALL SELECT 'song', count(*)::int FROM tonspur.song
    UNION ALL SELECT 'genre', count(*)::int FROM tonspur.genre
    UNION ALL SELECT 'song_genre', count(*)::int FROM tonspur.song_genre
    UNION ALL SELECT 'nutzerin', count(*)::int FROM tonspur.nutzerin
    UNION ALL SELECT 'wiedergabe', count(*)::int FROM tonspur.wiedergabe
    UNION ALL SELECT 'playlist', count(*)::int FROM tonspur.playlist
    UNION ALL SELECT 'playlist_song', count(*)::int FROM tonspur.playlist_song
    UNION ALL SELECT 'pass', count(*)::int FROM tonspur.pass
    UNION ALL SELECT 'scan', count(*)::int FROM tonspur.scan`);
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.t, r.c])), {
    kuenstler: 120,
    album: 336,
    song: 2644,
    genre: 14,
    song_genre: 5296,
    nutzerin: 500,
    wiedergabe: 77722,
    playlist: 845,
    playlist_song: 19364,
    pass: 380,
    scan: 3189,
  });
});

test('tonspur: the one dangling reference is still dangling', async () => {
  // The dataset's teaching point, and the reason the schema declares no foreign
  // keys at all. Two ways to lose it, both of which look like an improvement:
  // adding the constraints (the migration would then fail to load, loudly), and
  // "fixing" the row (silent). The second is what this asserts.
  const db = await sharedTonspur();
  const { rows: fks } = await db.query(`
    SELECT count(*)::int c
      FROM pg_constraint co
      JOIN pg_class cl ON cl.oid = co.conrelid
      JOIN pg_namespace n ON n.oid = cl.relnamespace
     WHERE n.nspname = 'tonspur' AND co.contype = 'f'`);
  assert.equal(fks[0].c, 0, 'tonspur declares no FOREIGN KEYs, on purpose');

  const { rows } = await db.query(`
    SELECT s.id, s.album_id FROM tonspur.song s
     WHERE NOT EXISTS (SELECT 1 FROM tonspur.album a WHERE a.id = s.album_id)`);
  assert.deepEqual(rows, [{ id: 2644, album_id: 9999 }]);
});

test('tonspur: and nothing else dangles', async () => {
  // Which is what makes the row above a lesson rather than a broken export. A
  // second hole would make "find the orphan" ambiguous in front of a class.
  const db = await sharedTonspur();
  const { rows } = await db.query(`
    SELECT
      (SELECT count(*)::int FROM tonspur.album a
        LEFT JOIN tonspur.kuenstler k ON k.id = a.kuenstler_id WHERE k.id IS NULL) AS album,
      (SELECT count(*)::int FROM tonspur.wiedergabe w
        LEFT JOIN tonspur.nutzerin n ON n.id = w.nutzerin_id WHERE n.id IS NULL) AS w_nutzerin,
      (SELECT count(*)::int FROM tonspur.wiedergabe w
        LEFT JOIN tonspur.song s ON s.id = w.song_id WHERE s.id IS NULL) AS w_song,
      (SELECT count(*)::int FROM tonspur.playlist_song ps
        LEFT JOIN tonspur.song s ON s.id = ps.song_id WHERE s.id IS NULL) AS ps_song,
      (SELECT count(*)::int FROM tonspur.song_genre sg
        LEFT JOIN tonspur.genre g ON g.id = sg.genre_id WHERE g.id IS NULL) AS sg_genre,
      (SELECT count(*)::int FROM tonspur.scan sc
        LEFT JOIN tonspur.pass p ON p.id = sc.pass_id WHERE p.id IS NULL) AS scan`);
  assert.deepEqual(rows[0], {
    album: 0, w_nutzerin: 0, w_song: 0, ps_song: 0, sg_genre: 0, scan: 0,
  });
});

test('tonspur: the name pair is not a key, the benutzername is', async () => {
  // The lesson on candidate keys stands on both halves. Three colliding pairs
  // is few enough that a student can look at them and many enough that the
  // collision is not a fluke of one row.
  const db = await sharedTonspur();
  const { rows } = await db.query(`
    SELECT
      (SELECT count(*)::int FROM (
         SELECT 1 FROM tonspur.nutzerin GROUP BY vorname, nachname HAVING count(*) > 1) x) AS kollisionen,
      (SELECT count(DISTINCT benutzername)::int FROM tonspur.nutzerin) AS benutzernamen`);
  assert.equal(rows[0].kollisionen, 3);
  assert.equal(rows[0].benutzernamen, 500, 'benutzername is the candidate key that works');
});

test('tonspur: the second source shares no key with the first', async () => {
  // `pass` is the L12 record-linkage exercise: no id in common with `nutzerin`,
  // so the only join available is the four-tuple — and it has to find enough
  // rows to be worth doing.
  const db = await sharedTonspur();
  const { rows: cols } = await db.query(`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'tonspur' AND table_name = 'pass'
       AND column_name LIKE '%nutzerin%'`);
  assert.deepEqual(cols, [], 'pass must not gain a foreign key into nutzerin');

  const { rows } = await db.query(`
    SELECT count(*)::int c
      FROM tonspur.pass p
      JOIN tonspur.nutzerin n
        ON n.vorname = p.vorname AND n.nachname = p.nachname
       AND n.geburtsdatum = p.geburtsdatum AND n.plz = p.plz`);
  assert.equal(rows[0].c, 260);
});

test('tonspur: a representative lesson query works', async () => {
  // The four-table join the Lektionsreihe builds up to, plus the `abgebrochen`
  // comparison that only means anything because `sekunden_gehoert` is allowed
  // to fall short of `dauer_sek`.
  const db = await sharedTonspur();
  const { rows } = await db.query(`
    SELECT k.name AS kuenstler,
           count(*)::int AS wiedergaben,
           count(*) FILTER (WHERE w.sekunden_gehoert < s.dauer_sek)::int AS abgebrochen
      FROM tonspur.wiedergabe w
      JOIN tonspur.song s      ON s.id = w.song_id
      JOIN tonspur.album a     ON a.id = s.album_id
      JOIN tonspur.kuenstler k ON k.id = a.kuenstler_id
     GROUP BY k.name
     ORDER BY wiedergaben DESC, k.name
     LIMIT 5`);
  assert.equal(rows.length, 5);
  for (const r of rows) {
    assert.ok(r.wiedergaben > 0);
    assert.ok(r.abgebrochen > 0 && r.abgebrochen < r.wiedergaben);
  }
});
