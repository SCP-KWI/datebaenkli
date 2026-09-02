/**
 * The one list whose *order* decides which table an unqualified name reads.
 *
 * Pure, so it runs against `dist` with no database at all — which is the point:
 * every claim here is about a string, and every one of them is a thing a
 * well-meaning edit would break without failing anywhere else. Sort the shared
 * schemas alphabetically and `demo` still comes before `tonspur`; sort them and
 * *include the head*, and `demo` comes before `x7_…` and every exercise silently
 * starts reading the shared copy of its own tables.
 *
 * The live suites prove Postgres agrees (`provision.live.test.mjs`,
 * `exercise.live.test.mjs`). This proves we asked it for the right thing.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { dist } from './support/meta-db.mjs';

const { PLAYGROUND_SEARCH_PATH, SHARED_SCHEMAS, fixtureSearchPath, workspaceSearchPath } =
  await import(dist('db/search-path.js'));

const parts = (path) => path.split(',').map((p) => p.trim());

test('the caller’s own writable schema is first, in every path', () => {
  // The invariant the whole file exists for. First place decides two separate
  // things — where an unqualified CREATE TABLE lands, and whose copy of a name
  // an unqualified SELECT reads — and a shared schema in front breaks both.
  assert.equal(parts(PLAYGROUND_SEARCH_PATH)[0], '"$user"');
  assert.equal(parts(workspaceSearchPath('x7_u_k3a_muster_lena'))[0], 'x7_u_k3a_muster_lena');
});

test('both shared datasets are on both paths, in the same order', () => {
  for (const path of [PLAYGROUND_SEARCH_PATH, workspaceSearchPath('x7_u_lena')]) {
    const indexes = SHARED_SCHEMAS.map((name) => parts(path).indexOf(name));
    assert.ok(
      indexes.every((i) => i > 0),
      `every shared schema must be on the path, behind the head: ${path}`,
    );
    assert.deepEqual(indexes, [...indexes].sort((a, b) => a - b), 'and in declaration order');
  }
});

test('an exercise path never carries "$user"', () => {
  // Not a style rule. An unqualified `DELETE FROM kunden` typed during an
  // exercise must not reach the playground `kunden`, or "reset this exercise
  // only" stops being an honest promise (HANDOFF §9).
  assert.ok(!workspaceSearchPath('x7_u_lena').includes('$user'));
});

test('public is last on both, so nothing shadows a student by accident', () => {
  assert.equal(parts(PLAYGROUND_SEARCH_PATH).at(-1), 'public');
  assert.equal(parts(workspaceSearchPath('x7_u_lena')).at(-1), 'public');
});

test('a fixture materialises in its workspace and nowhere else', () => {
  // The 0.14.1 regression, pinned (HANDOFF §25). `demo` and `tonspur` on this
  // path meant a fixture opening with `DROP TABLE IF EXISTS artikel;` resolved
  // `artikel` to `demo.artikel` — the workspace has no such table *yet* — and
  // `42501 must be owner` rolled the whole materialisation back. Every student
  // in the class opened the exercise and got an empty schema.
  //
  // So this is not "the same as workspaceSearchPath minus a bit". It is one
  // schema, and any shared name appearing here is the bug coming back.
  const path = fixtureSearchPath('x7_u_k3a_muster_lena');
  assert.equal(path, 'x7_u_k3a_muster_lena');
  for (const shared of SHARED_SCHEMAS) {
    assert.ok(!parts(path).includes(shared), `${shared} must not be on the fixture path`);
  }
  assert.ok(!parts(path).includes('public'));
  assert.notEqual(
    path,
    workspaceSearchPath('x7_u_k3a_muster_lena'),
    'the query path and the fixture path are deliberately different — see §25',
  );
});

test('the playground path is byte-identical to what the drift check compares', () => {
  // `provision.ts`'s `inventory()` asks Postgres whether `setconfig` contains
  // `'search_path=' || PLAYGROUND_SEARCH_PATH`, and Postgres stores a list GUC
  // as its own re-serialisation: `, ` between elements, quotes only where
  // needed. Pinning the literal here is what turns "somebody reformatted the
  // join" into a failing test rather than into a reconciler that repairs every
  // role on every boot for ever, silently.
  assert.equal(PLAYGROUND_SEARCH_PATH, '"$user", demo, tonspur, public');
});
