-- Tonspur — `pass` verliert `ticket_typ`.
--
-- The column and the scans were generated independently of each other, and it
-- shows: 124 of the 129 rows marked `Tagespass` have scans on more than one
-- day, 89 of them on all three. Nothing in the Lektionsreihe reads the column,
-- but Lektion 9 is *about* what data claims and what it can back up, and a
-- student who notices that a "Tagespass" was on the grounds for three days has
-- found a hole in the dataset instead of the one the lesson planted. Decision
-- of the teacher, 2026-09-26: the column goes.
--
-- Why a migration and not a regenerated `003_tonspur.sql`: 003 is applied on
-- production and `migrate.ts` holds its checksum (HANDOFF §7). A corrected
-- dataset is a new migration, as 003's own header says. `tools/tonspur-sql.mjs`
-- still lists the column in its SPEC — that script documents how 003 was
-- produced, and rewriting it would describe a file that no longer matches
-- the CSV it was generated from.
--
-- Nothing else changes: no rows, no grants, no other table. The teaching
-- properties `test/sql.test.mjs` pins (260 four-tuple matches, no key shared
-- with `nutzerin`) do not depend on this column, and the test now also pins
-- the column list so that the dataset cannot quietly grow it back.

ALTER TABLE tonspur.pass DROP COLUMN ticket_typ;

COMMENT ON TABLE tonspur.pass IS
  'Zweite Quelle (Festivalpaesse). Kein gemeinsamer Schluessel mit nutzerin — die Verbindung gelingt nur ueber Vorname, Nachname, Geburtsdatum und PLZ. Ohne ticket_typ seit 004.';
