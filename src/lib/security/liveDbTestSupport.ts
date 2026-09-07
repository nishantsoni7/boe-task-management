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

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message: unknown }).message
    if (typeof message === 'string') return message
  }
  return String(error)
}
