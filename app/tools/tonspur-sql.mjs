/**
 * Generates `src/db/sql/teach/003_tonspur.sql` from the Tonspur CSV export.
 *
 *   node tools/tonspur-sql.mjs <source-directory>
 *
 * The shape here is `tools/vendor-fonts.mjs`'s, for the same reason: the input
 * lives outside this repo, the *output* is committed, and the script is not
 * part of `npm run build`. Nothing at runtime reads a CSV — the migration is a
 * plain .sql file like every other one, so `migrate.ts` stays a file reader and
 * `psql -f` still works when debugging on the server.
 *
 * **This is not a third SQL-building file** in CLAUDE.md's sense. That rule is
 * about SQL this *app* assembles at runtime from data it does not control; this
 * runs on a developer's machine, its input is a fixed export the teacher wrote,
 * and its output is reviewed, checksummed by `migrate.ts` and immutable from
 * the moment it is applied. It still escapes every value (`lit()` below), and
 * it still refuses rather than guesses — a value that is not what SPEC says it
 * is aborts the whole file rather than reaching the output quoted.
 *
 * Re-running it is only ever useful *before* the migration is applied
 * anywhere. Afterwards the file is a hash the database holds (HANDOFF §7) and a
 * corrected dataset is a new migration, not an edit to this one.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const src = process.argv[2];
if (!src) {
  console.error('usage: node tools/tonspur-sql.mjs <source-directory>');
  process.exit(2);
}

const OUT = join(import.meta.dirname, '..', 'src', 'db', 'sql', 'teach', '003_tonspur.sql');

/** Rows per INSERT. Small enough to stay readable in a diff, large enough that
 *  the file is 150 statements rather than 77 000. */
const BATCH = 500;

/**
 * The tables, in dependency order — which here is *reading* order only, because
 * this schema deliberately declares no foreign keys (see the header of the
 * generated file). `ddl` is written out verbatim; `cols` drives the conversion
 * and must name the CSV's columns in the CSV's order.
 */
const SPEC = [
  {
    name: 'kuenstler',
    ddl: `CREATE TABLE tonspur.kuenstler (
  id              integer  PRIMARY KEY,
  name            text     NOT NULL,
  herkunftsland   char(2),
  gegruendet_jahr smallint,
  aktiv           boolean
);

COMMENT ON TABLE tonspur.kuenstler IS 'Bands und Solokuenstlerinnen. Alle erfunden.';`,
    cols: [
      ['id', 'int'],
      ['name', 'text'],
      ['herkunftsland', 'text'],
      ['gegruendet_jahr', 'int'],
      ['aktiv', 'bool'],
    ],
  },
  {
    name: 'album',
    ddl: `CREATE TABLE tonspur.album (
  id               integer  PRIMARY KEY,
  kuenstler_id     integer  NOT NULL,
  titel            text     NOT NULL,
  erscheinungsjahr smallint,
  label            text
);

COMMENT ON COLUMN tonspur.album.kuenstler_id IS 'Verweist auf kuenstler.id — ohne FOREIGN KEY, siehe Kopf der Migration.';
COMMENT ON COLUMN tonspur.album.label IS 'NULL bedeutet Eigenvertrieb.';`,
    cols: [
      ['id', 'int'],
      ['kuenstler_id', 'int'],
      ['titel', 'text'],
      ['erscheinungsjahr', 'int'],
      ['label', 'text'],
    ],
  },
  {
    name: 'song',
    ddl: `CREATE TABLE tonspur.song (
  id        integer PRIMARY KEY,
  album_id  integer NOT NULL,
  titel     text    NOT NULL,
  dauer_sek integer,
  explizit  boolean
);

COMMENT ON COLUMN tonspur.song.album_id IS 'Verweist auf album.id. Genau ein Verweis geht absichtlich ins Leere.';`,
    cols: [
      ['id', 'int'],
      ['album_id', 'int'],
      ['titel', 'text'],
      ['dauer_sek', 'int'],
      ['explizit', 'bool'],
    ],
  },
  {
    name: 'genre',
    ddl: `CREATE TABLE tonspur.genre (
  id   smallint PRIMARY KEY,
  name text     NOT NULL
);`,
    cols: [
      ['id', 'int'],
      ['name', 'text'],
    ],
  },
  {
    name: 'song_genre',
    ddl: `CREATE TABLE tonspur.song_genre (
  song_id  integer  NOT NULL,
  genre_id smallint NOT NULL,
  PRIMARY KEY (song_id, genre_id)
);

COMMENT ON TABLE tonspur.song_genre IS 'n:m ohne eigene Attribute — der einfache Fall.';`,
    cols: [
      ['song_id', 'int'],
      ['genre_id', 'int'],
    ],
  },
  {
    name: 'nutzerin',
    ddl: `CREATE TABLE tonspur.nutzerin (
  id              integer PRIMARY KEY,
  benutzername    text    NOT NULL UNIQUE,
  vorname         text    NOT NULL,
  nachname        text    NOT NULL,
  geburtsdatum    date,
  plz             integer,
  ort             text,
  abo_typ         text,
  angemeldet_seit date
);

COMMENT ON COLUMN tonspur.nutzerin.benutzername IS 'Der Schluesselkandidat, der funktioniert.';
COMMENT ON COLUMN tonspur.nutzerin.nachname IS 'Vorname + Nachname ist NICHT eindeutig — das ist der Punkt.';`,
    cols: [
      ['id', 'int'],
      ['benutzername', 'text'],
      ['vorname', 'text'],
      ['nachname', 'text'],
      ['geburtsdatum', 'date'],
      ['plz', 'int'],
      ['ort', 'text'],
      ['abo_typ', 'text'],
      ['angemeldet_seit', 'date'],
    ],
  },
  {
    name: 'wiedergabe',
    ddl: `CREATE TABLE tonspur.wiedergabe (
  id               integer   PRIMARY KEY,
  nutzerin_id      integer   NOT NULL,
  song_id          integer   NOT NULL,
  zeitpunkt        timestamp NOT NULL,
  geraet           text,
  sekunden_gehoert integer
);

COMMENT ON TABLE tonspur.wiedergabe IS 'Die grosse Faktentabelle: eine Zeile pro angehoertem Song.';
COMMENT ON COLUMN tonspur.wiedergabe.sekunden_gehoert IS 'Kleiner als song.dauer_sek heisst abgebrochen.';`,
    cols: [
      ['id', 'int'],
      ['nutzerin_id', 'int'],
      ['song_id', 'int'],
      ['zeitpunkt', 'timestamp'],
      ['geraet', 'text'],
      ['sekunden_gehoert', 'int'],
    ],
  },
  {
    name: 'playlist',
    ddl: `CREATE TABLE tonspur.playlist (
  id          integer PRIMARY KEY,
  nutzerin_id integer NOT NULL,
  name        text    NOT NULL,
  oeffentlich boolean,
  erstellt_am date
);`,
    cols: [
      ['id', 'int'],
      ['nutzerin_id', 'int'],
      ['name', 'text'],
      ['oeffentlich', 'bool'],
      ['erstellt_am', 'date'],
    ],
  },
  {
    name: 'playlist_song',
    ddl: `CREATE TABLE tonspur.playlist_song (
  playlist_id     integer NOT NULL,
  song_id         integer NOT NULL,
  position        integer NOT NULL,
  hinzugefuegt_am date,
  PRIMARY KEY (playlist_id, song_id)
);

COMMENT ON TABLE tonspur.playlist_song IS 'n:m MIT Attributen — der Fall, der eine eigene Tabelle erzwingt.';`,
    cols: [
      ['playlist_id', 'int'],
      ['song_id', 'int'],
      ['position', 'int'],
      ['hinzugefuegt_am', 'date'],
    ],
  },
  {
    name: 'pass',
    ddl: `CREATE TABLE tonspur.pass (
  id           integer PRIMARY KEY,
  vorname      text,
  nachname     text,
  geburtsdatum date,
  plz          integer,
  ticket_typ   text
);

COMMENT ON TABLE tonspur.pass IS
  'Zweite Quelle (Festivalpaesse). Kein gemeinsamer Schluessel mit nutzerin — die Verbindung gelingt nur ueber Vorname, Nachname, Geburtsdatum und PLZ.';`,
    cols: [
      ['id', 'int'],
      ['vorname', 'text'],
      ['nachname', 'text'],
      ['geburtsdatum', 'date'],
      ['plz', 'int'],
      ['ticket_typ', 'text'],
    ],
  },
  {
    name: 'scan',
    ddl: `CREATE TABLE tonspur.scan (
  id        integer   PRIMARY KEY,
  pass_id   integer   NOT NULL,
  zeitpunkt timestamp NOT NULL,
  bereich   text
);`,
    cols: [
      ['id', 'int'],
      ['pass_id', 'int'],
      ['zeitpunkt', 'timestamp'],
      ['bereich', 'text'],
    ],
  },
];

/** Indexes worth having before 25 students join the 77 000-row fact table. */
const INDEXES = `CREATE INDEX wiedergabe_nutzerin_idx ON tonspur.wiedergabe (nutzerin_id);
CREATE INDEX wiedergabe_song_idx     ON tonspur.wiedergabe (song_id);
CREATE INDEX album_kuenstler_idx     ON tonspur.album (kuenstler_id);
CREATE INDEX song_album_idx          ON tonspur.song (album_id);
CREATE INDEX playlist_nutzerin_idx   ON tonspur.playlist (nutzerin_id);
CREATE INDEX scan_pass_idx           ON tonspur.scan (pass_id);
CREATE INDEX scan_bereich_zeit_idx   ON tonspur.scan (bereich, zeitpunkt);`;

// --- conversion --------------------------------------------------------------

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const INT = /^-?\d+$/;

/** The only place a value becomes SQL text. Doubling `'` is the whole job. */
const lit = (s) => `'${s.replaceAll("'", "''")}'`;

function convert(raw, kind, where) {
  if (raw === '') return 'NULL';
  switch (kind) {
    case 'int':
      if (!INT.test(raw)) throw new Error(`${where}: not an integer: ${JSON.stringify(raw)}`);
      return raw;
    case 'bool':
      if (raw !== '0' && raw !== '1') throw new Error(`${where}: not 0/1: ${JSON.stringify(raw)}`);
      return raw === '1' ? 'true' : 'false';
    case 'date':
      if (!DATE.test(raw)) throw new Error(`${where}: not a date: ${JSON.stringify(raw)}`);
      return lit(raw);
    case 'timestamp':
      if (!TIMESTAMP.test(raw)) throw new Error(`${where}: not a timestamp: ${JSON.stringify(raw)}`);
      return lit(raw);
    case 'text':
      // A newline or a stray `;` inside a value would mean the export is not
      // the single-line, unquoted CSV this reader assumes. Refuse.
      if (/[\r\n;]/.test(raw)) throw new Error(`${where}: separator or newline in value`);
      return lit(raw);
    default:
      throw new Error(`unknown kind ${kind}`);
  }
}

/** Deliberately *not* `services/csv.ts`: this export is unquoted and single-line
 *  by construction, and anything else must abort rather than be parsed leniently. */
function readCsv(table, cols) {
  const text = readFileSync(join(src, `${table}.csv`), 'utf8');
  const sha = createHash('sha256').update(text).digest('hex');
  // `\r?\n`: the export is mixed — some files were written on Windows. The
  // sha256 above is of the file as it is on disk, not of the normalised text.
  const lines = text.split(/\r?\n/).filter((l) => l !== '');
  const header = lines[0].split(';');
  const expected = cols.map(([n]) => n);
  if (header.join(';') !== expected.join(';')) {
    throw new Error(`${table}.csv: header is ${header.join(';')}, expected ${expected.join(';')}`);
  }
  const rows = lines.slice(1).map((line, i) => {
    const fields = line.split(';');
    if (fields.length !== cols.length) {
      throw new Error(`${table}.csv line ${i + 2}: ${fields.length} fields, expected ${cols.length}`);
    }
    return fields.map((f, c) =>
      convert(f, cols[c][1], `${table}.csv line ${i + 2} col ${cols[c][0]}`),
    );
  });
  return { rows, sha };
}

// --- emit --------------------------------------------------------------------

const tables = SPEC.map((t) => ({ ...t, ...readCsv(t.name, t.cols) }));

const provenance = tables
  .map((t) => `--   ${t.name.padEnd(14)} ${String(t.rows.length).padStart(6)} Zeilen  sha256:${t.sha.slice(0, 16)}`)
  .join('\n');

const out = [];

out.push(`-- Datebänkli — Tonspur, der zweite gemeinsame Datensatz.
--
-- GENERATED FILE. Written by \`app/tools/tonspur-sql.mjs\` from the CSV export
-- that belongs to the Lektionsreihe "Relationale Datenbanken"; do not edit it
-- by hand, and do not edit it at all once it has been applied — \`migrate.ts\`
-- holds a sha256 of this file and refuses to boot if it changes (HANDOFF §7).
-- A corrected dataset is a new migration.
--
-- Source rows, as generated:
--
${provenance}
--
-- ## Why a schema of its own rather than more tables in \`demo\`
--
-- \`demo\` is eight small Swiss tables that answer "show me something" in the
-- first five minutes of the first lesson. This is a 110 000-row dataset built
-- for one specific Lektionsreihe, and the two want opposite things from the
-- table tree: \`demo\` wants to be short, this wants to be complete. Separate
-- schemas keep both, and cost a student nothing — they are already writing
-- \`demo.kantone\`, so \`tonspur.song\` needs no new idea.
--
-- ## Why there are no FOREIGN KEY constraints
--
-- Deliberate, and it is the dataset's teaching point rather than an oversight:
-- \`song.album_id = 9999\` refers to an album that does not exist, so referential
-- integrity can be *shown* to be missing before it is declared. With the
-- constraints in place the data would not load at all. \`test/sql.test.mjs\`
-- asserts that the dangling row is still there, because "somebody helpfully
-- added the FKs" and "somebody quietly fixed the row" look identical afterwards.
--
-- Everything else the dataset leans on is likewise a property of the *data*,
-- not of a constraint: names are not unique, \`pass\` shares no key with
-- \`nutzerin\`, and a played song can be cut short. Those are also asserted.
--
-- ## Grants
--
-- The same shape as \`001_init.sql\`'s: USAGE and SELECT to PUBLIC, so every
-- student role provisioned later inherits read access with no extra grant, and
-- nobody but \`dbk_app\` can write, because \`dbk_app\` owns everything in here.

CREATE SCHEMA IF NOT EXISTS tonspur;

COMMENT ON SCHEMA tonspur IS
  'Tonspur — gemeinsamer Beispieldatensatz, nur lesbar. Shared read-only dataset.';

GRANT USAGE ON SCHEMA tonspur TO PUBLIC;
`);

for (const t of tables) {
  out.push(`\n-- --- ${t.name} ${'-'.repeat(Math.max(0, 72 - t.name.length))}\n`);
  out.push(t.ddl + '\n');
}

out.push(`\n-- --- Daten ${'-'.repeat(66)}\n`);

for (const t of tables) {
  const columns = t.cols.map(([n]) => n).join(', ');
  for (let i = 0; i < t.rows.length; i += BATCH) {
    const chunk = t.rows.slice(i, i + BATCH);
    out.push(
      `INSERT INTO tonspur.${t.name} (${columns}) VALUES\n` +
        chunk.map((r) => `  (${r.join(',')})`).join(',\n') +
        ';\n',
    );
  }
}

out.push(`\n-- --- Indizes ${'-'.repeat(64)}\n\n${INDEXES}\n`);

out.push(`\n-- --- read-only for everyone ${'-'.repeat(49)}\n
GRANT SELECT ON ALL TABLES IN SCHEMA tonspur TO PUBLIC;

-- Applies to tonspur tables added by future migrations, so we never have to
-- remember to re-grant. Scoped to dbk_app because it owns the schema.
ALTER DEFAULT PRIVILEGES FOR ROLE dbk_app IN SCHEMA tonspur
  GRANT SELECT ON TABLES TO PUBLIC;
`);

out.push(
  `\n-- --- statistics ${'-'.repeat(61)}\n\n` +
    tables.map((t) => `ANALYZE tonspur.${t.name};`).join('\n') +
    '\n',
);

writeFileSync(OUT, out.join(''));

const bytes = out.join('').length;
console.log(`wrote ${OUT}`);
for (const t of tables) console.log(`  ${t.name.padEnd(14)} ${String(t.rows.length).padStart(6)} rows`);
console.log(`  ${(bytes / 1024 / 1024).toFixed(1)} MiB`);
