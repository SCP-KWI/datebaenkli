/**
 * The result caps — the row count and the byte budget. Pure, no db, no DOM.
 *
 * This file exists because the byte budget did not hold and nothing in the
 * suite could tell. `SELECT repeat('x', 100000000) FROM generate_series(1,20)`
 * against a real server came back as a **95 MB response carrying one row**: the
 * old check asked whether the budget was already spent *before* adding a row,
 * so the first row was admitted whatever it weighed. Every assertion about
 * `rows.length` still passed — the count was right, the memory was not.
 *
 * Both ways of being wrong here are quiet. Too slack is the heap, and it took a
 * deliberate probe to see it. Too strict is a grid that silently loses its tail
 * while claiming to show the first N, which nobody reading the screen could
 * catch. So the cases below pin the boundary from both sides, and the last one
 * pins the property that is easiest to break while "fixing" the first: what a
 * grid shows must be a **prefix** of the result, never a filtered subset.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = (p) => pathToFileURL(join(import.meta.dirname, '..', 'dist', p)).href;

process.env.DBK_ENCRYPTION_KEY ??= Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');
process.env.DBK_SESSION_SECRET ??= 'test-session-secret-0123456789abcdefghijklmnop';
process.env.DBK_APP_DB_PASSWORD ??= 'test';

const { makeResultLimiter, rowBytes } = await import(dist('services/query.js'));

/** Stands in for the per-statement Result object node-postgres hands over. */
const stmt = () => ({});

// --- the bug this file was written for ---------------------------------------

test('a single row larger than the whole budget is refused, not admitted', () => {
  const limiter = makeResultLimiter(1000, 100);
  const a = stmt();
  limiter.offer(a, ['x'.repeat(1000)]);
  assert.equal(limiter.rowsFor(a).length, 0);
  // And it says so. A grid that is empty because the data did not fit must not
  // look like a query that matched nothing.
  assert.equal(limiter.clippedOnBytes(a), true);
});

test('the budget spans the whole script, not one statement each', () => {
  const limiter = makeResultLimiter(1000, 100);
  const a = stmt();
  const b = stmt();
  limiter.offer(a, ['x'.repeat(90)]);
  assert.equal(limiter.rowsFor(a).length, 1);
  // 90 of 100 spent by the first statement, so the second gets what is left.
  limiter.offer(b, ['x'.repeat(50)]);
  assert.equal(limiter.rowsFor(b).length, 0);
  assert.equal(limiter.clippedOnBytes(b), true);
});

// --- what must keep working --------------------------------------------------

test('an ordinary grid is kept whole and is not marked clipped', () => {
  const limiter = makeResultLimiter(1000, 16 * 1024 * 1024);
  const a = stmt();
  for (let i = 0; i < 200; i++) limiter.offer(a, [i, `Kunde ${i}`, null, true]);
  assert.equal(limiter.rowsFor(a).length, 200);
  assert.equal(limiter.clippedOnBytes(a), false);
});

test('the row cap stops at maxRows without claiming the bytes ran out', () => {
  const limiter = makeResultLimiter(3, 16 * 1024 * 1024);
  const a = stmt();
  for (let i = 0; i < 10; i++) limiter.offer(a, [i]);
  assert.equal(limiter.rowsFor(a).length, 3);
  // `truncated` for the row cap is derived from Postgres's own count in
  // `execute`; saying "clipped on bytes" here as well would report the wrong
  // reason for the commonest truncation in the app.
  assert.equal(limiter.clippedOnBytes(a), false);
});

test('a statement asked about before it produced anything has no rows', () => {
  const limiter = makeResultLimiter(1000, 1000);
  // `execute` maps over every result in the script, including the ones that
  // returned no rows at all — an INSERT, a CREATE TABLE.
  assert.deepEqual(limiter.rowsFor(stmt()), []);
  assert.equal(limiter.clippedOnBytes(stmt()), false);
});

// --- the property that is easiest to break while fixing the first ------------

test('what is kept is a prefix: one row that does not fit ends the grid', () => {
  const limiter = makeResultLimiter(1000, 100);
  const a = stmt();
  limiter.offer(a, ['x'.repeat(40)]); // fits
  limiter.offer(a, ['x'.repeat(500)]); // does not
  limiter.offer(a, ['x']); // would fit in the 60 left — and must NOT be kept
  assert.equal(limiter.rowsFor(a).length, 1);
  assert.equal(limiter.clippedOnBytes(a), true);
});

// --- the estimate itself -----------------------------------------------------

test('strings are measured, everything else is a fixed guess', () => {
  // The estimate only has to be good enough to stop before the heap does, and
  // strings are the only cell that can be the thing that runs us out of memory.
  assert.equal(rowBytes(['abc']), 3);
  assert.equal(rowBytes([1, true, null]), 24);
  assert.equal(rowBytes([]), 0);
});
