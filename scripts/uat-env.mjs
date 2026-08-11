/**
 * Required environment for the UAT scripts.
 *
 * WHY THIS EXISTS
 * ---------------
 * uat-seed.mjs, uat-cleanup.mjs and uat-simulate.mjs each hard-coded a Supabase
 * `service_role` JWT for the production project, plus a shared password. A
 * service_role key bypasses every RLS policy, so a copy in a tracked file gives
 * anyone with repository read access full read/write on payroll, salaries,
 * attendance and audit history.
 *
 * Moving the values to environment variables does NOT undo that exposure — the
 * committed value stays in Git history, and only rotating the key in Supabase
 * revokes it. What this does is stop the mistake continuing: from here, running
 * a UAT script requires credentials the operator supplies, and there is nothing
 * left in the repository to copy.
 *
 * FAIL LOUD, NEVER GUESS
 * ----------------------
 * Every value is REQUIRED. There is no default and no fallback, because a
 * silent fallback is how a script aimed at a scratch project quietly runs
 * against production instead. A missing variable stops the script with a
 * message naming what is absent and how to supply it.
 *
 * These scripts write and delete data. Read scripts/README.md before running one.
 */

/** The variables every UAT script needs. */
export const UAT_ENV_VARS = /** @type {const} */ ([
  {
    name: 'UAT_SUPABASE_URL',
    describe: 'Supabase project URL, e.g. https://<project-ref>.supabase.co',
  },
  {
    name: 'UAT_SUPABASE_SERVICE_ROLE_KEY',
    describe: 'Supabase service_role key. Bypasses RLS — never commit it, never paste it into a chat',
    secret: true,
  },
  {
    name: 'UAT_SUPABASE_ANON_KEY',
    describe: 'Supabase anon/publishable key, used to sign in as a test user',
    secret: true,
  },
  {
    name: 'UAT_PASSWORD',
    describe: 'Shared password for the seeded [TEST-UAT] accounts',
    secret: true,
  },
])

/**
 * Read and validate the UAT environment.
 *
 * `need` lets a script ask only for what it uses — uat-cleanup does not sign in
 * as anybody, so it has no reason to require an anon key or a password.
 *
 * Returns the values. Never logs them: a script that prints a service_role key
 * into a terminal has recreated the problem this file exists to end.
 *
 * @param {readonly string[]} need
 * @returns {Record<string, string>}
 */
export function requireUatEnv(need = UAT_ENV_VARS.map(v => v.name)) {
  /** @type {Record<string, string>} */
  const values = {}
  /** @type {string[]} */
  const missing = []

  for (const name of need) {
    const spec = UAT_ENV_VARS.find(v => v.name === name)
    if (!spec) throw new Error(`requireUatEnv: unknown variable ${name}`)

    const raw = process.env[name]
    if (typeof raw !== 'string' || raw.trim() === '') {
      missing.push(name)
      continue
    }
    values[name] = raw.trim()
  }

  if (missing.length > 0) {
    const lines = [
      '',
      '  UAT script cannot start — required environment variables are missing:',
      '',
      ...missing.map(name => {
        const spec = UAT_ENV_VARS.find(v => v.name === name)
        return `    ${name}\n      ${spec?.describe ?? ''}`
      }),
      '',
      '  Supply them for this command only, for example:',
      '',
      `    ${missing.map(n => `${n}=…`).join(' ')} node ${process.argv[1] ?? 'scripts/uat-*.mjs'}`,
      '',
      '  See scripts/uat.env.example for the full list.',
      '  Never commit these values. .env* is git-ignored for this reason.',
      '',
    ]
    console.error(lines.join('\n'))
    process.exit(1)
  }

  // A service_role key against a project nobody meant to touch is the failure
  // mode worth one extra line of noise. The URL is not a secret, so naming it
  // here is safe and it is the only way an operator can confirm the target.
  console.log(`  UAT target: ${values.UAT_SUPABASE_URL ?? '(url not requested)'}`)

  return values
}
