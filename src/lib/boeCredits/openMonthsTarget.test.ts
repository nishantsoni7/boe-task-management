/**
 * A review month that is still OPEN follows the monthly target saved now.
 *
 * Reported 2026-11-05: the admin lowered "Minimum Approved Reviews Per Month" from 3 to 1 and
 * October's Month close table still read "2 of 3" and "1 of 3", "Below target"; closing October
 * would have lapsed those credits. Each month row copied the target in force when its first review
 * was approved, the guard refused any later change, and the recount qualified only against the copy.
 *
 * 20270605000000 changes that for months that are open. This file pins what the migration SAYS and
 * how the screens read it; the executed proof (the real migration chain on a real Postgres,
 * including the reported case and four deliberately broken copies) is
 * supabase/tests/boe_credits_open_months_target_pglite.mjs.
 *
 * Comments are stripped before every assertion, so a claim cannot be satisfied by prose.
 *
 * Run: npx tsx --test src/lib/boeCredits/openMonthsTarget.test.ts
 */
import { strict as assert } from 'node:assert'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'

const ROOT = process.cwd()
const MIGRATIONS = join(ROOT, 'supabase/migrations')
const FILE = '20270605000000_boe_credits_open_months_follow_target.sql'

const stripComments = (s: string) => s.replace(/\r\n/g, '\n').split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')
const code = stripComments(readFileSync(join(MIGRATIONS, FILE), 'utf8'))
const allFiles = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()

/** The body of the LAST migration that defines `name`, the way a replay of the migrations ends up. */
function latestFunction(name: string): string {
  let latest: string | null = null
  for (const f of allFiles) {
    const sql = stripComments(readFileSync(join(MIGRATIONS, f), 'utf8'))
    const start = sql.lastIndexOf(`create or replace function public.${name}(`)
    if (start < 0) continue
    const end = sql.indexOf('\n$$;', start)
    assert.ok(end > start, `${name} closes in ${f}`)
    latest = sql.slice(start, end + 4)
  }
  assert.ok(latest, `${name} is defined`)
  return latest
}

describe('where the migration sits', () => {
  test('it is the newest migration and the newest credits migration', () => {
    assert.equal(allFiles[allFiles.length - 1], FILE)
    const credits = allFiles.filter(f => /credit/i.test(f))
    assert.equal(credits[credits.length - 1], FILE)
  })
})

describe('the months guard after it', () => {
  const guard = latestFunction('boe_credit_review_months_guard')

  test('the minimum may move only while the month is open and not finalized', () => {
    assert.match(guard, /new\.minimum_reviews_snapshot <> old\.minimum_reviews_snapshot\s+and \(old\.status <> 'open' or old\.finalized_at is not null\) then/)
    assert.doesNotMatch(guard, /keeps its employee, month and minimum/)
  })

  test('identity, deletion, lapsed-is-final, qualified-stays-qualified and finalize-once are unchanged', () => {
    assert.match(guard, /new\.employee_id <> old\.employee_id or new\.review_month <> old\.review_month/)
    assert.match(guard, /if tg_op = 'DELETE' then/)
    assert.match(guard, /old\.status = 'lapsed' and \(new\.status <> 'lapsed'/)
    assert.match(guard, /old\.status = 'qualified' and new\.status <> 'qualified'/)
    assert.match(guard, /old\.finalized_at is not null and new\.finalized_at is distinct from old\.finalized_at/)
  })
})

describe('the recount after it', () => {
  const refresh = latestFunction('refresh_boe_credit_review_month')

  test('an open, unfinalized month reads the newest saved target', () => {
    assert.match(refresh, /if v_month\.status = 'open' and v_month\.finalized_at is null then\s+select s\.minimum_monthly_reviews into v_target\s+from public\.boe_credit_settings s\s+order by s\.created_at desc\s+limit 1;\s+v_min := coalesce\(v_target, v_min\);/)
  })

  test('it qualifies against that target, never against the stored column', () => {
    assert.match(refresh, /status\s+= case when status = 'open' and v_count >= v_min then 'qualified' else status end/)
    assert.doesNotMatch(refresh, /v_count >= minimum_reviews_snapshot/)
    assert.match(refresh, /minimum_reviews_snapshot = v_min/)
  })

  test('a qualified or closed month keeps its own minimum (v_min starts as the stored one and only an open month replaces it)', () => {
    assert.match(refresh, /v_min := v_month\.minimum_reviews_snapshot;/)
  })

  test('it still counts only rewards that were not reversed, and stays service-role only', () => {
    assert.match(refresh, /rv\.transaction_type = 'reversal'/)
    assert.match(code, /revoke execute on function public\.refresh_boe_credit_review_month\(uuid, date\) from public, anon, authenticated;/)
    assert.match(code, /grant\s+execute on function public\.refresh_boe_credit_review_month\(uuid, date\) to service_role;/)
  })

  test('closing a month recounts first, so it is judged against the target in force when it is closed', () => {
    const finalize = latestFunction('finalize_boe_credit_review_month')
    assert.match(finalize, /v_row := public\.refresh_boe_credit_review_month\(p_employee_id, p_review_month\);/)
  })
})

describe('saving a target applies it', () => {
  test('a trigger after every settings insert recounts the open months, and nothing else', () => {
    assert.match(code, /create trigger boe_credit_settings_refresh_open_months\s+after insert on public\.boe_credit_settings\s+for each row execute function public\.boe_credit_settings_refresh_open_months\(\);/)
    const trig = latestFunction('boe_credit_settings_refresh_open_months')
    assert.match(trig, /perform public\.refresh_open_boe_credit_review_months\(\);/)
  })

  test('the recount of all open months takes the per-employee lock, in a fixed order, and only looks at open unfinalized months', () => {
    const all = latestFunction('refresh_open_boe_credit_review_months')
    assert.match(all, /where m\.status = 'open' and m\.finalized_at is null\s+order by m\.review_month, m\.employee_id/)
    assert.match(all, /pg_advisory_xact_lock\(hashtext\('boe_credits'\), hashtext\(v_row\.employee_id::text\)\)/)
  })

  test('none of the new functions can be called by a client role', () => {
    for (const sig of ['refresh_open_boe_credit_review_months()', 'boe_credit_settings_refresh_open_months()']) {
      assert.ok(code.includes(`revoke execute on function public.${sig} from public, anon, authenticated;`), sig)
    }
    assert.ok(code.includes('grant  execute on function public.refresh_open_boe_credit_review_months() to service_role;'))
  })
})

describe('what the migration does not do', () => {
  test('it writes no ledger row, reverses nothing and deletes nothing', () => {
    assert.doesNotMatch(code, /insert into public\.boe_credit_transactions/)
    assert.doesNotMatch(code, /post_boe_credit_transaction\s*\(/)
    assert.doesNotMatch(code, /reverse_boe_credit_transaction\s*\(/)
    assert.doesNotMatch(code, /\bdelete\s+from\b/i)
    assert.doesNotMatch(code, /\bdrop\s+(table|column|function)\b/i)
  })

  test('the only table it updates is the review month, and only through the recount', () => {
    const updates = [...code.matchAll(/\bupdate\s+(public\.\w+)/gi)].map(m => m[1])
    assert.deepEqual([...new Set(updates)], ['public.boe_credit_review_months'])
  })

  test('the apply runs the recount once and aborts on its own checks if the result is wrong', () => {
    assert.match(code, /v_n := public\.refresh_open_boe_credit_review_months\(\);/)
    assert.match(code, /BOE_CREDITS_ASSERT: % open review month\(s\) still do not follow the saved target of %/)
    assert.match(code, /BOE_CREDITS_ASSERT: a lapsed review month lost its lapse row/)
    assert.match(code, /BOE_CREDITS_ASSERT: the settings trigger is missing/)
    assert.match(code, /BOE_CREDITS_ASSERT: a client role can execute a review month refresh/)
  })
})

describe('the screens read the month\'s own minimum', () => {
  const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8').replace(/\r\n/g, '\n')

  test('Month close shows "x of N" from the month row, so it moves with the database and never contradicts its own header', () => {
    const page = read('src/app/payroll/credits/page.tsx')
    assert.match(page, /\{r\.month\.qualifying_review_count\} of \{r\.month\.minimum_reviews_snapshot\}|`\$\{r\.month\.qualifying_review_count\} of \$\{r\.month\.minimum_reviews_snapshot\}`/)
    assert.match(page, /a month still open follows the target saved now/i)
    assert.match(page, /reviewTarget === 1 \? 'review' : 'reviews'/)
  })

  test('the settings form tells the admin the target reaches open months, and that qualified or closed ones keep theirs', () => {
    const form = read('src/components/boeCredits/CreditSettingsForm.tsx')
    assert.match(form, /It applies to every month that is still open/)
    assert.match(form, /A month that has qualified or been closed keeps the target it had/)
    assert.match(form, /except the monthly minimum, which also applies to months still\s+open/)
  })

  test('the employee view of a month reads the same stored minimum', () => {
    assert.match(read('src/app/my-credits/page.tsx'), /month\?\.minimum_reviews_snapshot \?\? settings\.minimum_monthly_reviews/)
  })
})

describe('the executed proof exists', () => {
  const script = join(ROOT, 'supabase/tests/boe_credits_open_months_target_pglite.mjs')

  test('the rehearsal script reproduces the reported defect, applies the migration twice, and mutates it four ways', () => {
    assert.ok(existsSync(script))
    const s = readFileSync(script, 'utf8')
    assert.ok(s.includes(FILE), 'it replays this very file')
    assert.equal((s.match(/THE DEFECT/g) ?? []).length >= 3, true)
    assert.match(s, /applying the file a second time is a no-op/)
    assert.equal((s.match(/MUTATION:/g) ?? []).length, 4)
  })
})
