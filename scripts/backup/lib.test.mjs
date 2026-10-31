import test from 'node:test'
import assert from 'node:assert/strict'
import { countCopyRows, mergedSince } from './lib.mjs'

// The COPY block of an empty table is only its COPY line and the terminator. The first version of the pg_dump
// step counted rows with a pattern that searched for the terminator, ran past the empty table's own terminator
// into the next table's data, and recorded rows that were not there (9 instead of 0, found on the first live run).

const dump = [
  'COPY public.holds (id) FROM stdin;',
  '\\.',
  '',
  'CREATE TABLE public.voids (id uuid);',
  'COPY public.voids (id, note) FROM stdin;',
  'aaaa\tone',
  'bbbb\ttwo',
  'cccc\tthree',
  '\\.',
  '',
  'COPY public.last_empty (id) FROM stdin;',
  '\\.',
].join('\n')

test('an empty table that is followed by other data counts as zero', () => {
  assert.equal(countCopyRows(dump, 'holds'), 0)
})

test('a table with rows counts exactly its rows', () => {
  assert.equal(countCopyRows(dump, 'voids'), 3)
})

test('an empty table at the end counts as zero', () => {
  assert.equal(countCopyRows(dump, 'last_empty'), 0)
})

test('a table that is not in the dump is reported as missing, not as empty', () => {
  assert.equal(countCopyRows(dump, 'nowhere'), null)
})

test('a table whose name is the start of another is not confused with it', () => {
  const two = 'COPY public.order_advance_holds (id) FROM stdin;\nx\ny\n\\.\nCOPY public.order_advance_holds_log (id) FROM stdin;\n\\.\n'
  assert.equal(countCopyRows(two, 'order_advance_holds'), 2)
  assert.equal(countCopyRows(two, 'order_advance_holds_log'), 0)
})

// The waiting list must never drop a merge: a backup covers only what was merged before it began.
const merges = [
  { number: 3, mergedAt: '2026-11-01T17:00:00Z' },
  { number: 1, mergedAt: '2026-11-01T15:59:59Z' },
  { number: 2, mergedAt: '2026-11-01T16:00:00Z' },
]

test('a merge before the backup began is covered, and one at or after that moment still waits', () => {
  assert.deepEqual(mergedSince(merges, '2026-11-01T16:00:00.000Z').map((p) => p.number), [2, 3])
})

test('the waiting list is oldest first and is empty when everything is covered', () => {
  assert.deepEqual(mergedSince(merges, '2026-11-01T00:00:00.000Z').map((p) => p.number), [1, 2, 3])
  assert.deepEqual(mergedSince(merges, '2026-11-01T18:00:00.000Z'), [])
})
