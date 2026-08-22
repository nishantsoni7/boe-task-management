import { createClient as createSupabaseClient } from '@supabase/supabase-js'

/**
 * THE PRIVILEGED SUPABASE CLIENT, BUILT FROM A CHECKED CREDENTIAL.
 *
 * ── THE CANONICAL NAME ─────────────────────────────────────────────────────
 *
 * BOE has exactly ONE server-only Supabase credential and it is called
 * `SUPABASE_SERVICE_ROLE_KEY`. That was established by reading the repository
 * rather than assumed: the name appears 104 times across src/, it is the name
 * documented in .env.example, and no other variant — SUPABASE_SERVICE_ROLE_SECRET,
 * SUPABASE_SECRET, SERVICE_KEY — exists anywhere in the codebase, the docs or
 * the example environment file.
 *
 * So nothing needs a new secret. Any deployment already running BOE has this
 * value; a route that could not find it was looking correctly and finding
 * nothing, which is a deployment gap rather than a naming disagreement.
 *
 * ── WHY A HELPER AT ALL ────────────────────────────────────────────────────
 *
 * Every route built its own client inline, and they did not agree on what to do
 * when the value was absent. Most wrote:
 *
 *     createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,
 *                         process.env.SUPABASE_SERVICE_ROLE_KEY!)
 *
 * The `!` is an assertion the type system cannot actually vouch for. When the
 * variable is missing, supabase-js throws `supabaseKey is required.` at the
 * moment of construction — and if that construction sits outside a route's
 * try/catch, the throw escapes, Next returns a bare 500 with no body the client
 * can read, and the user is shown whatever generic sentence the UI falls back
 * to. That is exactly how a missing environment variable came to be reported to
 * Nishant as though it were a permission refusal.
 *
 * `adminClient()` returns a RESULT rather than throwing, so a caller cannot
 * accidentally let a configuration fault escape as an unhandled error. The
 * absent case is a value you have to handle, not an exception you might not.
 *
 * ── WHY THIS FILE CANNOT REACH A BROWSER ───────────────────────────────────
 *
 * It reads `process.env.SUPABASE_SERVICE_ROLE_KEY`, which Next does not inline
 * into a client bundle — only NEXT_PUBLIC_* names are — so importing this from
 * a Client Component would produce `undefined` rather than a leaked key. That
 * is the language's guarantee, and it is the weaker half of the argument.
 *
 * The stronger half is enforced: `adminClient.test.ts` walks every file under
 * src/ that carries the 'use client' directive and fails if any of them imports
 * this module, directly or through a re-export. The repository already had this
 * property (noStarSelect.test.ts checks the raw variable name); centralising the
 * credential must not weaken it, so it is checked for the helper too.
 */

/**
 * The client, built from values already proven present.
 *
 * A named wrapper rather than an inline call so its INFERRED type can be
 * exported — the same idiom the routes used before this helper existed. Taking
 * ReturnType off the generic `createClient` itself instead resolves its type
 * parameters to their defaults, which narrows `rpc()` until it accepts no
 * arguments at all.
 */
function build(url: string, key: string) {
  return createSupabaseClient(url, key)
}

/** The inferred client type, so route code can name it without re-deriving it. */
export type AdminSupabaseClient = ReturnType<typeof build>

/** What a caller gets back. Never a throw, so a missing key cannot escape. */
export type AdminClientResult =
  | { ok: true; client: AdminSupabaseClient }
  | { ok: false; missing: readonly string[] }

/** The two names this helper needs, in the order a reader would check them. */
export const ADMIN_CLIENT_ENV = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
] as const

/**
 * Build the privileged client, or report exactly which names are missing.
 *
 * `missing` names the VARIABLES, never their values — an empty string and an
 * absent one are the same answer here, because both mean the deployment cannot
 * do privileged work. Callers may put those names in a server log; they must
 * not put them in a response, and a test asserts the confirmed-document route
 * does not.
 */
export function adminClient(): AdminClientResult {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  const missing: string[] = []
  if (!url) missing.push('NEXT_PUBLIC_SUPABASE_URL')
  if (!key) missing.push('SUPABASE_SERVICE_ROLE_KEY')
  if (missing.length > 0) return { ok: false, missing }

  return { ok: true, client: build(url as string, key as string) }
}

/**
 * Is privileged work possible on this deployment?
 *
 * For a caller that wants to decide before doing anything — a health surface, a
 * pre-flight — without constructing a client it will not use.
 */
export function adminClientConfigured(): boolean {
  return adminClient().ok
}
