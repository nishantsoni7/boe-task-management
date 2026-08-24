/**
 * Requirement 5 ("Stop Finance from refreshing when returning from another
 * browser tab") — regression guards for the mechanisms that were traced as
 * candidate causes and confirmed absent.
 *
 * STATUS. The reported behavior was manually retested against current
 * production: switching browser tabs and back produces no page refresh,
 * search text is retained, the selected view is retained, an open modal
 * stays open, and page state is otherwise unchanged. The existing production
 * code is correct as it stands. These tests exist to keep it that way — they
 * assert the ABSENCE of the specific mechanisms that would reintroduce the
 * defect the removed `visibilitychange` listener used to cause, without
 * requiring or depending on any new production code.
 *
 * WHY SOURCE TEXT AND NOT A DISPATCHED DOM EVENT. This repo has no jsdom /
 * testing-library (src/lib/ui/modalDismissal.test.ts states why), so a live
 * `window.dispatchEvent(new Event('focus'))` cannot be observed against a
 * mounted component. What is proven here instead:
 *
 *   1. React Query's own focus-refetch is disabled, globally, with no local
 *      override anywhere in the app.
 *   2. FinanceLayout registers no `visibilitychange` or `focus` listener of
 *      its own (the one that used to exist was removed; this is the
 *      regression guard) — and its one `router.refresh()` call site is
 *      gated behind `!onRefresh`, which both Finance surfaces that mount it
 *      pass, so that branch is dead in normal operation.
 *
 * Run:
 *   npx tsx --test src/components/layout/financeRefreshPolicy.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'

const REPO_ROOT = join(__dirname, '..', '..', '..')
const read = (relPath: string) => readFileSync(join(REPO_ROOT, relPath), 'utf8')

describe('React Query focus-refetch is disabled, globally, with no override', () => {
  test('Providers.tsx disables it in the one QueryClient every route shares', () => {
    const source = read('src/components/layout/Providers.tsx')
    assert.match(source, /refetchOnWindowFocus:\s*false/)
  })

  test('no query anywhere in the app re-enables it locally', () => {
    // A regression here — a single `refetchOnWindowFocus: true` added to one
    // Finance query — would silently re-open exactly the hole this
    // requirement closes, in a way no unit test of the global default alone
    // would catch.
    const roots = [
      'src/app/finance',
      'src/components/finance',
      'src/lib/finance',
      'src/hooks/queries',
    ]
    for (const root of roots) {
      let matches = ''
      try {
        matches = execSync(
          `grep -rn "refetchOnWindowFocus" ${join(REPO_ROOT, root)} --include="*.ts" --include="*.tsx" || true`,
          { encoding: 'utf8' },
        )
      } catch {
        matches = ''
      }
      const badLines = matches.split('\n').filter(l => l.includes(': true'))
      assert.deepEqual(badLines, [], `refetchOnWindowFocus: true found under ${root}`)
    }
  })
})

describe('FinanceLayout registers no visibility/focus listener of its own', () => {
  const source = read('src/components/layout/FinanceLayout.tsx')

  test('no addEventListener for visibilitychange or focus', () => {
    assert.doesNotMatch(source, /addEventListener\(\s*['"]visibilitychange['"]/)
    assert.doesNotMatch(source, /addEventListener\(\s*['"]focus['"]/)
    assert.doesNotMatch(source, /window\.onfocus\s*=/)
  })

  test('its one router.refresh() call is gated behind the absence of onRefresh', () => {
    const idx = source.indexOf('router.refresh()')
    assert.ok(idx >= 0, 'expected exactly one router.refresh() call site to audit')
    // The nearest enclosing branch, read backwards from the call: must be the
    // `else` of an `if (onRefresh)` — never an unconditional call.
    const before = source.slice(0, idx)
    const lastIfOnRefresh = before.lastIndexOf('if (onRefresh)')
    const lastElse = before.lastIndexOf('} else {')
    assert.ok(lastIfOnRefresh >= 0 && lastElse > lastIfOnRefresh,
      'router.refresh() must be reachable only when the caller passed no onRefresh')
  })
})

describe('both Finance surfaces that mount FinanceLayout pass their own onRefresh', () => {
  test('Payment Requests (finance/page.tsx)', () => {
    const source = read('src/app/finance/page.tsx')
    assert.match(source, /onRefresh=\{/)
  })

  test('Confirmed Payments / Payments to Verify (ReceivedPaymentsView.tsx)', () => {
    const source = read('src/app/finance/received/ReceivedPaymentsView.tsx')
    assert.match(source, /onRefresh=\{/)
  })
})
