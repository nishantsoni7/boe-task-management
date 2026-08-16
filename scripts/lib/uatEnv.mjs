/**
 * Shared environment resolution and target guard for the UAT scripts.
 *
 * The three UAT scripts (uat-seed, uat-simulate, uat-cleanup) hold a
 * service-role key and delete rows in bulk. Three things therefore have to be
 * true before any of them opens a connection:
 *
 *   1. Credentials come from the environment, never from source. Nothing in
 *      this repo should carry a project URL or a key.
 *   2. A hosted project is refused by default. These scripts cannot tell one
 *      hosted Supabase project from another without embedding an identifier
 *      for the real one — which is exactly what we are removing.
 *   3. Authorization to run against a hosted project names *which* project.
 *      A bare "yes I mean it" phrase would authorize whatever URL happened to
 *      be configured, so the override carries the target's project reference
 *      and must match the reference parsed out of the configured URL. The
 *      operator supplies the UAT reference, so production is still never
 *      named in this repo — and an override that outlives the URL it was
 *      written for stops working the moment the URL changes.
 *
 * The override is read only from the real shell environment, captured before
 * dotenv runs. A value sitting in .env / .env.local / .env.production is
 * ignored, so remote authorization cannot be made permanent by editing a file;
 * it has to be typed for the run it applies to.
 *
 * Nothing here ever puts a key, a password, a URL or a project reference into
 * a log line or an error message. Errors name the variable and the required
 * shape, never a value.
 *
 * Run the tests:
 *   npx tsx --test scripts/lib/uatEnv.test.mjs
 */

import { config } from 'dotenv'

/** Variable that unlocks a hosted (non-local) target. */
export const REMOTE_OVERRIDE_VAR = 'UAT_ALLOW_REMOTE_TARGET'

/** Fixed half of the override. The other half is the target's project reference. */
export const REMOTE_OVERRIDE_PHRASE = 'I-KNOW-THIS-IS-NOT-PRODUCTION'

/**
 * The shell's value for the override, captured BEFORE the dotenv calls below.
 *
 * This ordering is the whole mechanism: `import` only binds `config`, it does
 * not call it, so at this point process.env still holds exactly what the
 * operator's shell exported. Once dotenv has run there is no way to tell a
 * typed value from a file-loaded one — hence the snapshot. This module is the
 * only dotenv caller in the UAT path, so nothing can populate the variable
 * ahead of it.
 */
const SHELL_REMOTE_OVERRIDE = process.env[REMOTE_OVERRIDE_VAR]

// Same convention as scripts/sync-permissions.ts: prefer .env.local, fall back
// to .env, and never clobber a variable the caller already exported.
config({ path: '.env.local' })
config()

/** Hostnames that are unambiguously the operator's own machine. */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'])

/**
 * Shape of a project reference: a DNS label, lowercase, at least three
 * characters, not starting or ending with a hyphen. Anything else is treated
 * as "no reference could be extracted" and fails closed.
 */
const PROJECT_REF_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/

/**
 * Thrown for every guard and validation failure, so callers can distinguish a
 * refusal to start from a runtime error once the script is running.
 */
export class UatEnvError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UatEnvError'
  }
}

/**
 * True when the URL points at the operator's own machine.
 *
 * `*.local` is deliberately absent: mDNS names resolve to other machines on
 * the same network, so they are not self-evidently a sandbox.
 */
export function isLocalTarget(rawUrl) {
  let parsed
  try {
    parsed = new URL(rawUrl)
  } catch {
    return false
  }
  const host = parsed.hostname.toLowerCase()
  return LOCAL_HOSTNAMES.has(host) || host.endsWith('.localhost')
}

/**
 * The project reference for a hosted target: the first label of the host,
 * e.g. the `abcd…` in `https://abcd….supabase.co`.
 *
 * Returns null — never a guess — when the URL will not parse, is not http(s),
 * has too few labels to carry a reference, or the label is not reference
 * shaped. Callers treat null as a refusal, so an unrecognisable target can
 * never be authorized.
 */
export function projectRefFromUrl(rawUrl) {
  let parsed
  try {
    parsed = new URL(rawUrl)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null

  const labels = parsed.hostname.toLowerCase().split('.')
  // Needs <ref>.<domain>.<tld> at minimum; a bare host carries no reference.
  if (labels.length < 3) return null

  const ref = labels[0]
  return PROJECT_REF_PATTERN.test(ref) ? ref : null
}

/** The exact override value that authorizes one specific project reference. */
export function expectedOverrideFor(projectRef) {
  return `${REMOTE_OVERRIDE_PHRASE}:${projectRef}`
}

function readRequired(env, name) {
  const value = env[name]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new UatEnvError(
      `Missing ${name}. Set it in .env.local (see .env.example) before running a UAT script. ` +
        'The UAT scripts no longer carry any credentials of their own.',
    )
  }
  return value.trim()
}

/**
 * Refuses a hosted target unless the shell supplied an override naming that
 * exact project. Local targets pass without an override.
 *
 * `shellOverride` is the pre-dotenv snapshot, so a value written into an env
 * file arrives here as undefined and is refused like any other missing one.
 *
 * Every message below describes the required shape only. No host, project
 * reference or credential is ever echoed, so the failure output does not
 * identify the configured project.
 */
export function assertTargetAllowed(url, shellOverride) {
  if (isLocalTarget(url)) return

  const projectRef = projectRefFromUrl(url)
  if (projectRef === null) {
    throw new UatEnvError(
      'Refusing to run: no project reference could be read from NEXT_PUBLIC_SUPABASE_URL, so the ' +
        'target cannot be confirmed as a UAT project. Check that the variable holds a full ' +
        'https URL for a hosted project, or point it at a local stack.',
    )
  }

  if (shellOverride !== expectedOverrideFor(projectRef)) {
    throw new UatEnvError(
      'Refusing to run: NEXT_PUBLIC_SUPABASE_URL points at a hosted Supabase project, and the ' +
        'UAT scripts create, modify and delete records in bulk. They are blocked against every ' +
        'hosted project by default, production included.\n' +
        `If — and only if — the configured project is a disposable UAT project, run the script ` +
        `with ${REMOTE_OVERRIDE_VAR} set to exactly "${REMOTE_OVERRIDE_PHRASE}:<project-ref>", where ` +
        '<project-ref> is the first label of that project\'s hostname.\n' +
        'It must be supplied on the command line for that one run. A value stored in .env, ' +
        '.env.local or any other dotenv file is ignored on purpose, and an override written for a ' +
        'different project will not authorize this one.',
    )
  }
}

/**
 * Resolves and validates everything a UAT script needs, then checks the
 * target. Throws before the caller has any chance to open a connection.
 *
 * @param {object}  [options]
 * @param {object}  [options.env]                 Environment to read (injectable for tests).
 * @param {string}  [options.shellOverride]       Pre-dotenv override snapshot (injectable for tests).
 * @param {boolean} [options.requireAnonKey]      Script signs in as test users.
 * @param {boolean} [options.requireUserPassword] Script creates or uses test-user logins.
 */
export function resolveUatEnv({
  env = process.env,
  shellOverride = SHELL_REMOTE_OVERRIDE,
  requireAnonKey = false,
  requireUserPassword = false,
} = {}) {
  const url = readRequired(env, 'NEXT_PUBLIC_SUPABASE_URL')
  const serviceRoleKey = readRequired(env, 'SUPABASE_SERVICE_ROLE_KEY')
  const anonKey = requireAnonKey ? readRequired(env, 'NEXT_PUBLIC_SUPABASE_ANON_KEY') : null
  const userPassword = requireUserPassword ? readRequired(env, 'UAT_USER_PASSWORD') : null

  assertTargetAllowed(url, shellOverride)

  return { url, serviceRoleKey, anonKey, userPassword }
}

/**
 * Script-facing wrapper: resolve, or print the refusal and exit non-zero.
 *
 * A guard failure is an expected outcome, not a crash, so it prints the
 * message on its own rather than letting an unhandled throw dump a stack.
 */
export function resolveUatEnvOrExit(options = {}) {
  try {
    return resolveUatEnv(options)
  } catch (error) {
    if (error instanceof UatEnvError) {
      console.error(`\n${error.message}\n`)
      process.exit(1)
    }
    throw error
  }
}

/**
 * Builds the service-role client for a UAT script.
 *
 * `createClient` is a parameter rather than a module-level import so the tests
 * can prove the guard runs to completion and hands off to the client layer
 * without a real client — and therefore without a network call — ever existing.
 */
export function createUatAdminClient(resolved, createClient) {
  return createClient(resolved.url, resolved.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}
