/**
 * Shared support for the live-database test suites under src/lib/security
 * and src/app/api/payroll — the suites that create real Supabase auth users,
 * `public.users` profiles and business rows (payroll, attendance) to prove
 * RLS and route-level authorization against the actual database.
 *
 * Two responsibilities live here:
 *
 *   1. Target guard — refuse to run against a hosted Supabase project unless
 *      the operator explicitly names it, reusing the exact mechanism the UAT
 *      scripts already use (scripts/lib/uatEnv.mjs). Before this, these five
 *      suites read NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
 *      straight out of .env.local with no check at all, which is how 22
 *      `@example.invalid` fixture users ended up in production.
 *
 *   2. Cleanup runner — every `after()` in these suites deletes several rows
 *      per actor (business rows, then the profile, then the auth user).
 *      Supabase-js resolves with `{ data, error }` rather than throwing, so a
 *      blocked delete (an FK violation, an RLS surprise) was previously
 *      silent: the loop moved on as if it had succeeded. runCleanupSteps
 *      inspects every step's result, keeps going so one failure never stops
 *      the rest of the teardown, and throws at the end so a failure fails
 *      the suite instead of leaving an orphaned fixture behind unnoticed.
 */
import { resolveUatEnv, UatEnvError } from '../../../scripts/lib/uatEnv.mjs'

export { UatEnvError }

export interface LiveDbTestEnv {
  url: string
  serviceRoleKey: string
  anonKey: string
}

interface ResolveOptions {
  env?: Record<string, string | undefined>
  shellOverride?: string
}

/**
 * Resolves and guards the environment for a live-DB test suite, throwing a
 * `UatEnvError` on refusal. `env`/`shellOverride` are injectable so this can
 * be exercised in a unit test without real credentials or a real shell.
 */
export function resolveLiveDbTestEnvOrThrow(options: ResolveOptions = {}): LiveDbTestEnv {
  const resolved = resolveUatEnv({ ...options, requireAnonKey: true }) as {
    url: string
    serviceRoleKey: string
    anonKey: string | null
  }
  return { url: resolved.url, serviceRoleKey: resolved.serviceRoleKey, anonKey: resolved.anonKey as string }
}

/**
 * Script-facing wrapper for the five test files: resolve, or print the
 * refusal and exit non-zero. A guard failure is an expected outcome — a
 * developer's .env.local pointed at a hosted project without the override —
 * not a crash, so it is reported the same way the suites already reported a
 * missing environment variable, before any test registers.
 */
export function resolveLiveDbTestEnv(): LiveDbTestEnv {
  try {
    return resolveLiveDbTestEnvOrThrow()
  } catch (error) {
    if (error instanceof UatEnvError) {
      console.error(`\n${error.message}\n`)
      process.exit(1)
    }
    throw error
  }
}

/** The result shape supabase-js resolves with: `{ data, error }`, never a throw. */
type SupabaseLikeResult = { error?: unknown } | null | undefined | void

export interface CleanupStep {
  /** Identifies the step in a failure report. Not shown anywhere but a local console. */
  label: string
  run: () => PromiseLike<SupabaseLikeResult> | Promise<SupabaseLikeResult>
}

/**
 * Runs every cleanup step in order, regardless of earlier failures, and
 * inspects each result's `error` instead of discarding it. A blocked delete
 * no longer looks identical to a successful one: every failure is collected,
 * and — if any occurred — thrown as a single aggregated error so the
 * suite's `after()` fails visibly.
 *
 * Steps still run in the order given, so callers get FK-safe teardown by
 * listing dependent rows before the rows they reference — this only adds the
 * failure surfacing, it does not change the ordering contract.
 */
export async function runCleanupSteps(steps: CleanupStep[]): Promise<void> {
  const failures: string[] = []
  for (const step of steps) {
    try {
      const result = await step.run()
      const error = result && typeof result === 'object' && 'error' in result ? result.error : null
      if (error) failures.push(`${step.label}: ${describeError(error)}`)
    } catch (err) {
      failures.push(`${step.label}: ${describeError(err)}`)
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Live-DB test cleanup left fixtures behind (${failures.length} step${failures.length === 1 ? '' : 's'} failed):\n` +
        failures.map(f => `  - ${f}`).join('\n'),
    )
  }
}

/**
 * Tables that reference `public.users` with ON DELETE NO ACTION and were
 * proven, in the production incident, to hold rows against fixture accounts.
 *
 * Scoped BY USER ID rather than by a row id the suite remembered. That is the
 * whole point: the rows that actually blocked the profile deletes were ones no
 * suite ever tracked — notifications raised by a trigger, and payroll results
 * written days later by a real generation run that read the leftover fixture
 * profiles as active employees.
 *
 * Order is load-bearing. `payroll_settlements.payroll_result_id` references
 * `payroll_results` with NO ACTION, so settlements must go before results.
 */
export const FIXTURE_USER_DEPENDANTS: ReadonlyArray<{ table: string; column: string }> = [
  { table: 'notifications', column: 'user_id' },
  { table: 'customer_review_test_cards', column: 'assigned_to' },
  { table: 'customer_review_test_cards', column: 'assigned_by' },
  { table: 'payroll_settlements', column: 'employee_id' },
  { table: 'payroll_results', column: 'employee_id' },
]

/**
 * The four operations fixture teardown needs, isolated behind an interface so
 * the ordering rules below can be tested without a database.
 */
export interface FixtureUserGateway {
  deleteDependant(table: string, column: string, userId: string): Promise<SupabaseLikeResult>
  deleteProfile(userId: string): Promise<SupabaseLikeResult>
  /** Resolves `{ data }` — a row when the profile is still present, null when gone. */
  readProfile(userId: string): Promise<{ data?: unknown; error?: unknown }>
  deleteAuthUser(userId: string): Promise<SupabaseLikeResult>
}

const errorOf = (result: SupabaseLikeResult) =>
  result && typeof result === 'object' && 'error' in result ? result.error : null

/**
 * Remove one fixture account, refusing to delete its auth row unless the
 * profile is positively confirmed gone.
 *
 * The incident this prevents: `public.users` delete fails on a NO ACTION
 * reference, the error is not acted on, and `auth.admin.deleteUser` runs
 * anyway. What survives is a profile with no auth row behind it — still
 * carrying its role and `is_active` flag, and therefore still an employee as
 * far as payroll generation is concerned. Thirteen such rows were paid a
 * fictional salary in a real payroll period.
 *
 * `runCleanupSteps` deliberately continues past failures so it can report all
 * of them, which is right for independent steps. These four are NOT
 * independent: each one is a precondition for the next, so this returns early
 * at the first failure rather than pressing on to the destructive step.
 *
 * Returns the failures for the caller to aggregate; it never throws.
 */
export async function purgeFixtureUser(
  gateway: FixtureUserGateway,
  userId: string,
): Promise<string[]> {
  for (const { table, column } of FIXTURE_USER_DEPENDANTS) {
    const error = errorOf(await gateway.deleteDependant(table, column, userId))
    if (error) {
      // Stop here. A dependant still standing is exactly what makes the
      // profile delete fail, and pressing on would reach the auth delete.
      return [`${table}.${column} for ${userId}: ${describeError(error)}`]
    }
  }

  const profileError = errorOf(await gateway.deleteProfile(userId))
  if (profileError) {
    return [`users profile ${userId}: ${describeError(profileError)} (auth user left in place)`]
  }

  // The read-back. A delete that matched nothing reports no error at all, so
  // asking whether the row is gone is the only thing that actually proves it.
  const readBack = await gateway.readProfile(userId)
  if (readBack.error) {
    return [
      `could not confirm removal of profile ${userId}: ${describeError(readBack.error)} ` +
        '(auth user left in place)',
    ]
  }
  if (readBack.data) {
    return [
      `profile ${userId} still present after delete (auth user left in place). Some table ` +
        'references public.users with ON DELETE NO ACTION and is not in ' +
        'FIXTURE_USER_DEPENDANTS.',
    ]
  }

  const authError = errorOf(await gateway.deleteAuthUser(userId))
  // A missing auth user is the expected state when an earlier run got this far
  // and then failed; it is not a cleanup failure.
  if (authError && !/not found/i.test(describeError(authError))) {
    return [`auth user ${userId}: ${describeError(authError)}`]
  }
  return []
}

/** Binds the gateway to a real service-role client. */
export function supabaseFixtureUserGateway(
  // The suites' service-role client. Typed structurally so this module does
  // not depend on @supabase/supabase-js.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  svc: any,
): FixtureUserGateway {
  return {
    deleteDependant: (table, column, userId) => svc.from(table).delete().eq(column, userId),
    deleteProfile: userId => svc.from('users').delete().eq('id', userId),
    readProfile: userId => svc.from('users').select('id').eq('id', userId).maybeSingle(),
    deleteAuthUser: userId => svc.auth.admin.deleteUser(userId),
  }
}

/**
 * One cleanup step per fixture account, for the tail of a suite's `after()`.
 *
 * Replaces the `[delete profile, delete auth user]` pair every suite used to
 * end with. One step per user keeps `runCleanupSteps`' aggregate reporting:
 * one account failing still lets the others be attempted and reported.
 */
export function fixtureUserCleanupSteps(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  svc: any,
  userIds: readonly string[],
): CleanupStep[] {
  const gateway = supabaseFixtureUserGateway(svc)
  return userIds.filter(Boolean).map(userId => ({
    label: `fixture user ${userId}`,
    run: async () => {
      const failures = await purgeFixtureUser(gateway, userId)
      return failures.length > 0 ? { error: new Error(failures.join('; ')) } : {}
    },
  }))
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message: unknown }).message
    if (typeof message === 'string') return message
  }
  return String(error)
}
