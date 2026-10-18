import assert from 'node:assert/strict'

/**
 * "These are the migrations that sit behind this one" — as an ORDER check.
 *
 * Several suites pin a migration and name the files that follow it. They used to
 * compare the WHOLE tail with deepEqual, so every migration anyone added to
 * main broke a dozen unrelated suites at once, and the list was patched (or not)
 * by whoever merged last. That is how main came to carry failing tests.
 *
 * What those suites defend is that nothing slipped in BEFORE, or BETWEEN, the
 * files they have accounted for — i.e. that the order the named files apply in
 * is the order the suite reasoned about. A file added at the END sorts after
 * everything named and cannot change any of that, so it is allowed. A file
 * inserted anywhere inside the named run, or a named file that vanished or
 * moved, still fails.
 *
 * Same call shape as assert.deepEqual(actual, named, message) so a suite changes
 * one word.
 */
export function assertNamedSuccessors(actual: readonly string[], named: readonly string[], message?: string): void {
  assert.deepEqual(actual.slice(0, named.length), [...named], message)
}
