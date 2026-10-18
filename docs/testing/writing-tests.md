# Writing tests in this repository

CI (`verify`) runs `tsc`, `npm run lint` and `npm test` on every pull request and is a required check.
main must stay at 0 failures. If a test fails, it is yours until proven otherwise on a clean main.

## Prefer behaviour over source text

A test that reads a `.tsx` file and asserts that it contains an exact string
(`source.includes('<PaymentModeHint ...')`) breaks on any restyle or file split without anything having
gone wrong. Prefer, in this order:

1. **Run it in a DOM.** `src/lib/testing/domHarness.ts` mounts the real component in jsdom and drives it like a
   person: `ui.click(ui.button('Record payment'))`, `ui.type(input, '2500')`, `ui.press('Escape')`, then asserts on
   what is on screen and on what a fake database client was sent. Use it for anything about interaction: a button
   that must not be greyed out, a problem named after a press, an inert backdrop, one press = one send. Import
   the harness first in the file. Examples: `src/components/orders/addPiPayment.dom.test.tsx`,
   `src/app/finance/received/paymentForms.dom.test.tsx`, `src/app/finance/components/paymentFormParts.dom.test.tsx`.
   After writing one, break the behaviour on purpose and confirm the test fails.
1b. **Render it to markup.** `renderToStaticMarkup(createElement(Component, props))` is enough for what a screen
   shows in a given state (see `src/app/finance/received/correctAllocation.render.test.tsx`); it cannot click.
2. **Test the pure function.** Rules belong in `src/lib/**` where they can be called directly.
3. **Source text, only for a structural guarantee** that cannot be observed any other way (an RPC name,
   "no browser writes this table"). Keep the string short and stable.

## Splitting a screen

Big screens (`ReceivedPaymentsView.tsx`, `finance/page.tsx`) are split into sibling files with
`node scripts/dev/split-block.mjs <screen> "<start text>" "<end text>" <new file> [reexport...]`
(set `MSYS_NO_PATHCONV=1` in Git Bash so `//` arguments survive). It moves the block, exports what the block
declares, wires the imports and leaves a marker where the block was:

    // @split: src/app/finance/received/receivedPaymentsAtoms.tsx private=SectionHeader,DetailRow

Source-text tests keep working unchanged: **`npm test` and `npm run test:file -- <path>` preload
`scripts/testing/screen-source-preload.mjs`**, which puts each block back in place whenever a *test file* reads
a screen as text, so a test that slices a function out by name sees the original one-file layout. Run tests
with those commands, not bare `tsx --test` (`screenSplits.test.ts` says so if you forget). Code that
reads a screen through `readScreenSource(path)` gets the same expansion without the preload. After a split,
run `npx eslint <files>` and drop the imports the screen no longer needs.

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
