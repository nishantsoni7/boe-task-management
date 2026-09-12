/**
 * Unit coverage for the live-DB test guard and cleanup runner — no real
 * Supabase connection, no environment variables. See liveDbTestSupport.ts
 * for why this exists: 22 `@example.invalid` fixture users leaked into
 * production because the five suites that use these helpers had no target
 * guard and silently discarded cleanup errors.
 *
 * Run:
 *   npx tsx --test src/lib/security/liveDbTestSupport.test.ts
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveLiveDbTestEnvOrThrow,
  runCleanupSteps,
  UatEnvError,
  type CleanupStep,
} from '@/lib/security/liveDbTestSupport'
import { PRODUCTION_PROJECT_REF } from '../../../scripts/lib/uatEnv.mjs'

// ─── The production-target guard ───────────────────────────────────────────

describe('resolveLiveDbTestEnvOrThrow — the target guard', () => {
  const baseEnv = {
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  }

  // A hosted project that is NOT production. These cases are about the
  // override mechanism, so they must not use the production ref: that is
  // refused outright now, and every assertion below would pass for a reason
  // it does not name.
  const UAT_URL = 'https://disposableuatproject.supabase.co'
  const PRODUCTION_URL = `https://${PRODUCTION_PROJECT_REF}.supabase.co`

  test('refuses a hosted project with no override — the exact leak scenario', () => {
    assert.throws(
      () =>
        resolveLiveDbTestEnvOrThrow({
          env: { ...baseEnv, NEXT_PUBLIC_SUPABASE_URL: UAT_URL },
          shellOverride: undefined,
        }),
      UatEnvError,
      'a hosted URL with no override must be refused, not silently connected to',
    )
  })

  test('refuses a hosted project when the override names a different project', () => {
    assert.throws(() =>
      resolveLiveDbTestEnvOrThrow({
        env: { ...baseEnv, NEXT_PUBLIC_SUPABASE_URL: UAT_URL },
        shellOverride: 'I-KNOW-THIS-IS-NOT-PRODUCTION:some-other-project',
      }),
    )
  })

  test('allows a hosted project when the override names that exact project', () => {
    const resolved = resolveLiveDbTestEnvOrThrow({
      env: { ...baseEnv, NEXT_PUBLIC_SUPABASE_URL: UAT_URL },
      shellOverride: 'I-KNOW-THIS-IS-NOT-PRODUCTION:disposableuatproject',
    })
    assert.equal(resolved.url, UAT_URL)
    assert.equal(resolved.serviceRoleKey, 'service-role-key')
    assert.equal(resolved.anonKey, 'anon-key')
  })

  // ─── Production is excluded by identity, not by promise ──────────────────

  test('refuses production even when the override names it exactly', () => {
    // This assertion used to run the other way: naming the production project
    // in the override authorized it. The override is a claim the operator
    // makes about the target, and "I-KNOW-THIS-IS-NOT-PRODUCTION:<production>"
    // is a claim that is simply false — one habit or one paste away.
    assert.throws(
      () =>
        resolveLiveDbTestEnvOrThrow({
          env: { ...baseEnv, NEXT_PUBLIC_SUPABASE_URL: PRODUCTION_URL },
          shellOverride: `I-KNOW-THIS-IS-NOT-PRODUCTION:${PRODUCTION_PROJECT_REF}`,
        }),
      UatEnvError,
      'the production project must not be reachable by any override value',
    )
  })

  test('refuses production with no override either', () => {
    assert.throws(
      () =>
        resolveLiveDbTestEnvOrThrow({
          env: { ...baseEnv, NEXT_PUBLIC_SUPABASE_URL: PRODUCTION_URL },
          shellOverride: undefined,
        }),
      UatEnvError,
    )
  })

  test('allows a local target with no override at all', () => {
    const resolved = resolveLiveDbTestEnvOrThrow({
      env: { ...baseEnv, NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:56321' },
      shellOverride: undefined,
    })
    assert.equal(resolved.url, 'http://127.0.0.1:56321')
  })

  test('an override left over from an earlier hosted project does not carry over', () => {
    // The override names one specific project ref, not "any hosted project" —
    // otherwise a value someone forgot to unset would silently re-authorize a
    // run against a completely different one later.
    assert.throws(() =>
      resolveLiveDbTestEnvOrThrow({
        env: { ...baseEnv, NEXT_PUBLIC_SUPABASE_URL: 'https://brandnewprojectref.supabase.co' },
        shellOverride: 'I-KNOW-THIS-IS-NOT-PRODUCTION:disposableuatproject',
      }),
    )
  })
})

// ─── The cleanup runner ─────────────────────────────────────────────────────

describe('runCleanupSteps', () => {
  test('does nothing and does not throw when there are no steps', async () => {
    await assert.doesNotReject(() => runCleanupSteps([]))
  })

  test('resolves quietly when every step succeeds', async () => {
    const calls: string[] = []
    const steps: CleanupStep[] = [
      { label: 'a', run: async () => { calls.push('a'); return { error: null } } },
      { label: 'b', run: async () => { calls.push('b'); return undefined } },
    ]
    await assert.doesNotReject(() => runCleanupSteps(steps))
    assert.deepEqual(calls, ['a', 'b'])
  })

  test('a step returning { error } fails the whole cleanup, surfaced, not swallowed', async () => {
    const steps: CleanupStep[] = [
      { label: 'attendance_records', run: async () => ({ error: { message: 'blocked by a foreign key', code: '23503' } }) },
    ]
    await assert.rejects(
      () => runCleanupSteps(steps),
      (err: Error) => {
        assert.match(err.message, /attendance_records/)
        assert.match(err.message, /blocked by a foreign key/)
        return true
      },
    )
  })

  test('a step that throws is caught, reported, and does not crash the runner', async () => {
    const steps: CleanupStep[] = [
      { label: 'auth user', run: async () => { throw new Error('network dropped') } },
    ]
    await assert.rejects(() => runCleanupSteps(steps), /network dropped/)
  })

  test('one failing step never stops the rest from being attempted — best-effort teardown', async () => {
    const attempted: string[] = []
    const steps: CleanupStep[] = [
      { label: 'first (fails)', run: async () => { attempted.push('first'); return { error: { message: 'nope' } } } },
      { label: 'second (throws)', run: async () => { attempted.push('second'); throw new Error('boom') } },
      { label: 'third (succeeds)', run: async () => { attempted.push('third'); return { error: null } } },
    ]
    await assert.rejects(() => runCleanupSteps(steps))
    assert.deepEqual(attempted, ['first', 'second', 'third'], 'every step must be attempted, not just the first')
  })

  test('every failure is named in the aggregated message, not just the first one', async () => {
    const steps: CleanupStep[] = [
      { label: 'users profile X', run: async () => ({ error: { message: 'fk violation' } }) },
      { label: 'auth user X', run: async () => ({ error: { message: 'auth admin error' } }) },
    ]
    await assert.rejects(
      () => runCleanupSteps(steps),
      (err: Error) => {
        assert.match(err.message, /users profile X/)
        assert.match(err.message, /fk violation/)
        assert.match(err.message, /auth user X/)
        assert.match(err.message, /auth admin error/)
        return true
      },
    )
  })
})
