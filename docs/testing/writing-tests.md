# Writing tests in this repository

CI (`verify`) runs `tsc`, `npm run lint` and `npm test` on every pull request and is a required check.
main must stay at 0 failures. If a test fails, it is yours until proven otherwise on a clean main.

## Prefer behaviour over source text

A test that reads a `.tsx` file and asserts that it contains an exact string
(`source.includes('<PaymentModeHint ...')`) breaks on any restyle or file split without anything having
gone wrong. Prefer, in this order:

1. **Render it.** `renderToStaticMarkup(createElement(Component, props))` and assert on what appears
   (see `src/app/finance/received/correctAllocation.render.test.tsx`).
2. **Test the pure function.** Rules belong in `src/lib/**` where they can be called directly.
3. **Source text, only for a structural guarantee** that cannot be observed any other way (an RPC name,
   "no browser writes this table"). Keep the string short and stable.

When you must read a screen's source, use `readScreenSource(path)` (`src/lib/testing/readScreenSource.ts`).
It returns the file plus its registered extracted siblings, so splitting a big screen does not break the test.
A test that slices ONE FUNCTION by name (`indexOf('function Foo(')`) should keep reading the single file that
holds that function; when you move such a function, update those slices in the same PR.

## Migration-order tests

Never `deepEqual` the whole tail of `supabase/migrations`. Use `assertNamedSuccessors`
(`src/lib/testing/migrationOrder.ts`): it pins the named run in order and allows new files at the end.

## Live-database suites

They skip without a database and run nightly against the disposable project.
See `docs/testing/live-db-test-project.md`. After re-syncing that project's schema, update
`supabase/tests/live-db-schema-version.txt` to the newest migration it reflects; the workflow warns when
the repository has a newer one.

## Branch-diff guards

The diff-against-main guards in `expenseSurfaces.test.ts` are opt-in (`EXPENSE_BRANCH_SCOPE_GUARD=1`).
Do not add new tests that fail merely because a branch touched a file.
