/**
 * Which schemas resolve without a qualifier, and in what order.
 *
 * One file because the ordering rule is the whole feature and it has to be the
 * same rule in four places: the role default a playground connection inherits
 * (`provision.ts`), the path a query against an exercise runs under
 * (`query.ts`), the path a teacher's setup script materialises under
 * (`exercise.ts`), and what the editor tells the browser will complete bare
 * (`catalog.ts`). Four copies of a list whose *order* decides which table a
 * student's `SELECT * FROM kantone` reads is four chances to disagree, and the
 * way they would disagree is silent: the query still runs, against the wrong
 * table.
 *
 * ## The rule
 *
 * **The caller's own writable schema comes first, always.** Everything else on
 * the path is read-only to a student, so first place is what decides two
 * separate things at once — where an unqualified `CREATE TABLE` lands, and
 * whose `kantone` an unqualified `SELECT` reads. Putting a shared schema ahead
 * of it would break both in the same edit: the create would fail with a
 * permission error (`demo` is owned by `dbk_app`), and reads would silently
 * leave the student's own work unreachable.
 *
 * ## Why `demo` and `tonspur` are on it at all
 *
 * Before 0.14 they were not, so every table in the two shared datasets had to
 * be written `demo.kantone` / `tonspur.song` — including inside an exercise,
 * where nothing else needs qualifying. Students read that inconsistency as a
 * rule they had failed to learn rather than as a schema they had failed to
 * name. The qualifier still works and still means what it says; it is no longer
 * the only thing that does.
 *
 * ## What is deliberately *not* here
 *
 * `"$user"` is absent from `workspaceSearchPath`. An unqualified
 * `DELETE FROM kunden` typed during an exercise must not be able to reach the
 * `kunden` in the student's own playground, or "reset this exercise only" stops
 * being an honest promise. That predates this file (HANDOFF §9) and adding the
 * shared schemas does not soften it: they are read-only, so nothing an exercise
 * can type reaches anything of the student's that a reset would not restore.
 */

import { assertPlainIdent } from './ident.js';

/**
 * The shared read-only datasets, in precedence order.
 *
 * Both are created by teach migrations, owned by `dbk_app` and granted `SELECT`
 * to `PUBLIC`, so every provisioned role can read them and none can write them.
 * A collision between the two resolves to `demo`, which is the smaller and
 * older of the pair; there is none today and `test/sql.test.mjs` says so.
 *
 * Run through `assertPlainIdent` at import for the reason `config.ts` validates
 * at import: this list is interpolated into `ALTER ROLE ... SET search_path` by
 * `provision.ts`, and a name that cannot be an identifier should crash the
 * container on boot rather than surface as a provisioning failure mid-lesson.
 */
export const SHARED_SCHEMAS: readonly string[] = ['demo', 'tonspur'].map(assertPlainIdent);

/**
 * The default every provisioned role carries: their own schema, the shared
 * datasets, then `public`.
 *
 * This exact string is also what `provision.ts` diffs `pg_db_role_setting`
 * against, so it has to be byte-identical to what Postgres stores. It is:
 * Postgres re-serialises a list GUC with `, ` between elements and quotes only
 * what needs it, which for this list means `"$user"` alone. Verified against
 * a real cluster rather than assumed — a drift check that never matches repairs
 * every role on every pass, and one that always matches repairs none.
 */
export const PLAYGROUND_SEARCH_PATH = ['"$user"', ...SHARED_SCHEMAS, 'public'].join(', ');

/**
 * The path a query or a fixture runs under inside an exercise workspace.
 *
 * `schema` comes from `exercise_workspace` and reaches Postgres as a bind
 * parameter to `set_config`, never as SQL text — which is why this returns a
 * value and not a statement.
 */
export function workspaceSearchPath(schema: string): string {
  return [schema, ...SHARED_SCHEMAS, 'public'].join(', ');
}
