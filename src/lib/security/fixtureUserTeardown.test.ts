/**
 * The invariant that the production incident turned on:
 *
 *   an auth row is deleted ONLY after its public.users profile is
 *   positively confirmed gone.
 *
 * The original teardown did the opposite. It deleted the profile, discarded
 * the error, and deleted the auth row anyway. Because four tables reference
 * `public.users` with ON DELETE NO ACTION, a single leftover child row failed
 * the profile delete — and what survived was a profile with no auth row behind
 * it, still carrying its role and `is_active` flag. Payroll generation reads
 * active employees, so thirteen of those were enrolled as staff and paid
 * ₹24,375 of fictional salary inside a real, unlocked payroll period.
 *
 * `runCleanupSteps` alone does not fix this. It reports failures but keeps
 * going by design, which is right for independent steps and wrong for these:
 * the auth delete would still run after the profile delete had failed, so the
 * orphan was still created — just noisily. These tests pin the ordering, not
 * the reporting.
 *
 * Every case here uses an injected gateway. No Supabase connection, no
 * environment variables, no database.
 *
 * Run:
 *   npx tsx --test src/lib/security/fixtureUserTeardown.test.ts
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  purgeFixtureUser,
  FIXTURE_USER_DEPENDANTS,
  type FixtureUserGateway,
} from '@/lib/security/liveDbTestSupport'

const USER = '00000000-0000-4000-8000-00000000abcd'

interface RecorderOptions {
  /** `${table}.${column}` that should fail its delete. */
  failDependant?: string
  profileError?: { message: string }
  readError?: { message: string }
  /** true = the profile is still there when read back. */
  profileSurvives?: boolean
  authError?: { message: string }
}

/** Records the call order so the assertions can be about sequence, not effect. */
function recorder(options: RecorderOptions = {}) {
  const calls: string[] = []
  const gateway: FixtureUserGateway = {
    deleteDependant: async (table, column) => {
      calls.push(`dependant:${table}.${column}`)
      return options.failDependant === `${table}.${column}`
        ? { error: { message: 'blocked by a foreign key' } }
        : { error: null }
    },
    deleteProfile: async () => {
      calls.push('profile')
      return { error: options.profileError ?? null }
    },
    readProfile: async () => {
      calls.push('readBack')
      if (options.readError) return { error: options.readError }
      return { data: options.profileSurvives ? { id: USER } : null }
    },
    deleteAuthUser: async () => {
      calls.push('auth')
      return { error: options.authError ?? null }
    },
  }
  return { calls, gateway }
}

describe('purgeFixtureUser — auth deletion is gated on verified profile absence', () => {
  test('a failed profile delete never reaches the auth delete', async () => {
    const { calls, gateway } = recorder({ profileError: { message: 'fk violation' } })

    const failures = await purgeFixtureUser(gateway, USER)

    assert.equal(calls.includes('auth'), false, 'the auth row must survive a failed profile delete')
    assert.equal(failures.length, 1)
    assert.match(failures[0], /fk violation/)
    assert.match(failures[0], /auth user left in place/)
  })

  test('a profile still present on read-back never reaches the auth delete', async () => {
    // A delete that matched nothing reports no error at all, so the absence of
    // an error is not proof of removal. Only the read-back is.
    const { calls, gateway } = recorder({ profileSurvives: true })

    const failures = await purgeFixtureUser(gateway, USER)

    assert.deepEqual(calls.at(-1), 'readBack', 'nothing may run after a failed read-back')
    assert.equal(calls.includes('auth'), false)
    assert.match(failures[0], /still present after delete/)
  })

  test('a read-back that errors never reaches the auth delete', async () => {
    const { calls, gateway } = recorder({ readError: { message: 'permission denied' } })

    const failures = await purgeFixtureUser(gateway, USER)

    assert.equal(calls.includes('auth'), false, 'an unverifiable profile must not authorize auth deletion')
    assert.match(failures[0], /could not confirm removal/)
  })

  test('a failed dependant purge stops before both the profile and the auth delete', async () => {
    const { calls, gateway } = recorder({ failDependant: 'notifications.user_id' })

    const failures = await purgeFixtureUser(gateway, USER)

    assert.equal(calls.includes('profile'), false, 'the profile delete would only fail anyway')
    assert.equal(calls.includes('auth'), false)
    assert.match(failures[0], /notifications\.user_id/)
  })

  test('the full happy path deletes the auth row last, and reports nothing', async () => {
    const { calls, gateway } = recorder()

    const failures = await purgeFixtureUser(gateway, USER)

    assert.deepEqual(failures, [])
    assert.deepEqual(calls.slice(-3), ['profile', 'readBack', 'auth'])
    assert.equal(calls.at(-1), 'auth', 'the auth row goes last or not at all')
  })

  test('an auth row that is already gone is not a failure', async () => {
    // The expected state when an earlier run got this far and then died.
    const { gateway } = recorder({ authError: { message: 'User not found' } })

    assert.deepEqual(await purgeFixtureUser(gateway, USER), [])
  })
})

describe('purgeFixtureUser — dependant order follows the schema', () => {
  test('settlements are deleted before payroll results', async () => {
    // payroll_settlements.payroll_result_id references payroll_results with
    // NO ACTION, so the reverse order fails on a foreign-key violation.
    const { calls, gateway } = recorder()
    await purgeFixtureUser(gateway, USER)

    const settlements = calls.indexOf('dependant:payroll_settlements.employee_id')
    const results = calls.indexOf('dependant:payroll_results.employee_id')
    assert.ok(settlements >= 0 && results >= 0, 'both must be purged')
    assert.ok(settlements < results, 'settlements must precede results')
  })

  test('every dependant runs before the profile delete', async () => {
    const { calls, gateway } = recorder()
    await purgeFixtureUser(gateway, USER)

    const profileAt = calls.indexOf('profile')
    for (const [index, call] of calls.entries()) {
      if (call.startsWith('dependant:')) {
        assert.ok(index < profileAt, `${call} must run before the profile delete`)
      }
    }
  })

  test('the five references proven in production are all covered', async () => {
    // These are exactly the columns that held rows against the 22 leaked
    // accounts. Deleting by remembered row id missed all of them: the
    // notifications came from triggers, and the payroll rows were written by a
    // real generation run days after the suite had finished.
    assert.deepEqual(
      FIXTURE_USER_DEPENDANTS.map(d => `${d.table}.${d.column}`),
      [
        'notifications.user_id',
        'customer_review_test_cards.assigned_to',
        'customer_review_test_cards.assigned_by',
        'payroll_settlements.employee_id',
        'payroll_results.employee_id',
      ],
    )
  })
})
