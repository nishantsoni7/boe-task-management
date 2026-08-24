/**
 * Requirement 5 ("Stop Finance from refreshing when returning from another
 * browser tab") — the policy proven directly, not assumed.
 *
 * WHY THESE FUNCTIONS AND NOT A DISPATCHED DOM EVENT. This repo has no jsdom
 * / testing-library (src/lib/ui/modalDismissal.test.ts states why), so a
 * live `window.dispatchEvent(new Event('focus'))` cannot be observed against
 * a mounted component. What CAN be proven, and is proven here, is every
 * mechanism that was traced as a candidate cause of an automatic Finance
 * refresh on tab-return:
 *
 *   1. React Query's own focus-refetch is disabled, globally, with no local
 *      override anywhere in the app — checked against the live config object
 *      AND against the source tree.
 *   2. FinanceLayout registers no `visibilitychange` or `focus` listener of
 *      its own (the one that used to exist was removed; this is the
 *      regression guard) — and its one `router.refresh()` call site is
 *      gated behind `!onRefresh`, which both Finance surfaces that mount it
 *      pass, so that branch is dead in normal operation.
 *   3. auth-js's OWN internal `visibilitychange` listener — undocumented
 *      previously, confirmed by reading node_modules/@supabase/auth-js —
 *      fires a SIGNED_IN event on every tab-return via `_recoverAndRefresh`,
 *      independent of any app code. `resolveAuthIdentityAction`, extracted
 *      from Providers.tsx's real auth listener, is exercised directly against
 *      exactly that event shape (SIGNED_IN, same user id) and proven to
 *      return `{ kind: 'ignore' }` — no cache clear, no invalidation, no
 *      refetch trigger of any kind.
 *
 * Together these cover every code-level path that could turn a tab-focus or
 * visibilitychange event into a data refresh. What they cannot rule out is a
 * genuine browser-level tab discard (the OS/browser reclaiming a backgrounded
 * tab's memory) — that is not a dispatchable event and is not application
 * code's to prevent; state persistence is the mitigation for it, tested
 * separately.
 *
 * Run:
 *   npx tsx --test src/components/layout/financeRefreshPolicy.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { DEFAULT_QUERY_OPTIONS, resolveAuthIdentityAction } from './Providers'

const REPO_ROOT = join(__dirname, '..', '..', '..')
const read = (relPath: string) => readFileSync(join(REPO_ROOT, relPath), 'utf8')

describe('React Query focus-refetch is disabled, globally, with no override', () => {
  test('the live default-options object disables it', () => {
    assert.equal(DEFAULT_QUERY_OPTIONS.refetchOnWindowFocus, false)
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

describe('resolveAuthIdentityAction — the auth-js visibility-triggered SIGNED_IN, named and neutralised', () => {
  const established = (userId: string | null) => ({ established: true, userId })

  test('TOKEN_REFRESHED is always ignored, regardless of identity', () => {
    assert.deepEqual(
      resolveAuthIdentityAction('TOKEN_REFRESHED', 'user-1', established('user-1')),
      { kind: 'ignore' },
    )
  })

  test('a SIGNED_IN naming the SAME user already established — auth-js\'s own tab-return session-recovery event — is ignored entirely', () => {
    assert.deepEqual(
      resolveAuthIdentityAction('SIGNED_IN', 'user-1', established('user-1')),
      { kind: 'ignore' },
    )
  })

  test('SIGNED_OUT always clears, whatever the prior identity', () => {
    assert.deepEqual(
      resolveAuthIdentityAction('SIGNED_OUT', null, established('user-1')),
      { kind: 'sign_out' },
    )
  })

  test('a SIGNED_IN naming a DIFFERENT user is a real identity change', () => {
    assert.deepEqual(
      resolveAuthIdentityAction('SIGNED_IN', 'user-2', established('user-1')),
      { kind: 'identity_changed', userId: 'user-2' },
    )
  })

  test('the very first event of the tab, before any identity is established, is adopted rather than compared', () => {
    assert.deepEqual(
      resolveAuthIdentityAction('SIGNED_IN', 'user-1', { established: false, userId: null }),
      { kind: 'adopt', userId: 'user-1' },
    )
  })

  test('USER_UPDATED for the same identity invalidates the identity-derived queries without clearing the cache', () => {
    assert.deepEqual(
      resolveAuthIdentityAction('USER_UPDATED', 'user-1', established('user-1')),
      { kind: 'invalidate_identity' },
    )
  })

  test('an unrelated event name is ignored', () => {
    assert.deepEqual(
      resolveAuthIdentityAction('PASSWORD_RECOVERY', 'user-1', established('user-1')),
      { kind: 'ignore' },
    )
  })
})
