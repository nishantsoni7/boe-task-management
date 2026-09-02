/**
 * 20261101000000_boe_credits_foundation.sql — what the migration SAYS.
 *
 * A text audit, in the style of src/lib/customerReviews/securityContract.test.ts.
 * It is worth having and it is not enough: supabase/tests/boe_credits_assertions.sql
 * EXECUTES the same file on a disposable database and proves the refusals with
 * their SQLSTATEs. This file catches the drift a text can show — a grant whose
 * signature no longer matches its function, a policy that stopped being
 * SELECT-only, a raise without an errcode — before a database is involved.
 *
 * Comments are stripped before every assertion, so a claim cannot be satisfied
 * by prose.
 *
 * Run:
 *   npx tsx --test src/lib/boeCredits/migration.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const FILE = '20261101000000_boe_credits_foundation.sql'
const MIGRATIONS = join(ROOT, 'supabase/migrations')
const sql = readFileSync(join(MIGRATIONS, FILE), 'utf8').replace(/\r\n/g, '\n')
/** Executable SQL only — comments explain, they do not run. */
const code = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')

const POST_SIG    = 'public.post_boe_credit_transaction(uuid, text, integer, text, uuid, text, uuid, uuid)'
const REVERSE_SIG = 'public.reverse_boe_credit_transaction(uuid, uuid, text)'

/** The body of one `create or replace function public.NAME(` … `$$;` block. */
function fn(name: string): string {
  const start = code.indexOf(`create or replace function public.${name}(`)
  assert.ok(start >= 0, `function ${name} is defined`)
  const end = code.indexOf('\n$$;', start)
  assert.ok(end > start, `function ${name} closes`)
  return code.slice(start, end + 4)
}

describe('the file, and where it sits', () => {
  test('it exists, is the only credits migration, and sorts after everything that was there before it', () => {
    const all = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()
    assert.ok(all.includes(FILE))
    assert.deepEqual(all.filter(f => /credit/i.test(f)), [FILE, '20261102000000_boe_credits_review_reward.sql'])
    const prior = all.filter(f => f < FILE)
    assert.equal(prior[prior.length - 1], '20261031000000_review_workflow_twelve_drafts_editing_and_images.sql')
  })

  test('it is additive: it creates its own two tables and alters no existing one', () => {
    const created = [...code.matchAll(/create table if not exists public\.(\w+)/g)].map(m => m[1])
    assert.deepEqual(created, ['boe_credit_transactions', 'boe_credit_settings'])
    const altered = [...code.matchAll(/alter table (?:only )?public\.(\w+)/g)].map(m => m[1])
    assert.deepEqual([...new Set(altered)].sort(), ['boe_credit_settings', 'boe_credit_transactions'])
    const inserts = [...code.matchAll(/insert into public\.(\w+)/g)].map(m => m[1])
    assert.deepEqual([...new Set(inserts)].sort(), ['boe_credit_settings', 'boe_credit_transactions'],
      'the seed row, and the INSERT inside the posting function — nothing into another module')
    assert.equal(/drop table|^\s*truncate\b/m.test(code), false)
  })

  test('it is not wrapped in an explicit transaction, like the eleven files before it', () => {
    assert.equal(/^\s*begin;\s*$/m.test(code), false)
    assert.equal(/^\s*commit;\s*$/m.test(code), false)
  })

  test('$$ blocks are balanced', () => {
    assert.equal((code.match(/\$\$/g) ?? []).length % 2, 0)
  })
})

describe('the ledger table', () => {
  const table = code.slice(
    code.indexOf('create table if not exists public.boe_credit_transactions'),
    code.indexOf('comment on table public.boe_credit_transactions'),
  )

  test('exactly the four kinds, as a CHECK and not an enum', () => {
    assert.match(table, /transaction_type\s+text\s+not null check \(transaction_type in \(\s*'review_reward',\s*'redemption',\s*'reversal',\s*'admin_adjustment'\s*\)\)/)
    assert.equal(/create type/.test(code), false)
  })

  test('credits are signed whole numbers and never zero', () => {
    assert.match(table, /credits\s+integer\s+not null check \(credits <> 0\)/)
  })

  test('the source is a type/id pair, not a foreign key into another module', () => {
    assert.match(table, /source_type\s+text\s+not null check \(source_type ~ '\^\[a-z\]\[a-z0-9_\]\{0,63\}\$'\)/)
    assert.match(table, /source_id\s+uuid,/)
    assert.equal(/source_id\s+uuid\s+references/.test(table), false)
    assert.equal(/references public\.customer_review/.test(code), false)
  })

  test('each kind has one shape, and manual is exactly the sourceless kind', () => {
    assert.match(table, /when 'review_reward'\s+then credits > 0 and source_type <> 'manual'/)
    assert.match(table, /when 'redemption'\s+then credits < 0 and source_type <> 'manual'/)
    assert.match(table, /when 'reversal'\s+then source_type = 'boe_credit_transaction'/)
    assert.match(table, /when 'admin_adjustment' then source_type = 'manual' and description is not null/)
    assert.match(table, /\(source_type = 'manual'\) = \(source_id is null\)/)
  })

  test('the only foreign keys are users (employee, actor) and the nullable payroll period', () => {
    const refs = [...table.matchAll(/references public\.(\w+)\(id\)/g)].map(m => m[1])
    assert.deepEqual(refs, ['users', 'payroll_periods', 'users'])
    assert.match(table, /payroll_period_id uuid\s+references public\.payroll_periods\(id\),/)
    assert.equal(/payroll_period_id uuid\s+not null/.test(table), false)
  })

  test('THE UNIQUENESS RULE: (employee, type, source type, source id), partial on a present source id', () => {
    assert.match(code, /create unique index if not exists boe_credit_transactions_one_per_source_idx\s*\n\s*on public\.boe_credit_transactions \(employee_id, transaction_type, source_type, source_id\)\s*\n\s*where source_id is not null;/)
  })
})

describe('immutability', () => {
  test('one append-only trigger function, armed BEFORE UPDATE OR DELETE on both tables, refusing with 42501', () => {
    const guard = fn('boe_credits_append_only')
    assert.match(guard, /raise exception/)
    assert.match(guard, /using errcode = '42501'/)
    for (const t of ['boe_credit_transactions', 'boe_credit_settings']) {
      assert.match(code, new RegExp(`create trigger ${t}_append_only\\s*\\n\\s*before update or delete on public\\.${t}\\s*\\n\\s*for each row execute function public\\.boe_credits_append_only\\(\\);`))
    }
  })

  test('no client role holds a write on either table, and anon cannot read them', () => {
    for (const t of ['boe_credit_transactions', 'boe_credit_settings']) {
      assert.match(code, new RegExp(`revoke insert, update, delete, truncate, references, trigger\\s*\\n\\s*on public\\.${t} from authenticated, anon;`))
      assert.match(code, new RegExp(`revoke select on public\\.${t} from anon;`))
      assert.match(code, new RegExp(`grant  select on public\\.${t} to authenticated;`))
    }
  })
})

describe('row security', () => {
  const policies = [...code.matchAll(/create policy "([^"]+)"\s*\n\s*on public\.(\w+)\s*\n\s*for (\w+)/g)]

  test('both tables have RLS on, and exactly one policy each — SELECT', () => {
    assert.match(code, /alter table public\.boe_credit_transactions enable row level security;/)
    assert.match(code, /alter table public\.boe_credit_settings enable row level security;/)
    assert.deepEqual(policies.map(p => [p[2], p[3]]), [
      ['boe_credit_transactions', 'select'],
      ['boe_credit_settings', 'select'],
    ])
  })

  test('the ledger policy is own rows OR the management predicate, and nothing is bare true', () => {
    assert.match(code, /using \(employee_id = auth\.uid\(\) or public\.can_manage_boe_credits\(\)\);/)
    assert.equal(/using \(true\)|with check \(true\)/.test(code), false)
  })

  test('the management predicate is an ACTIVE, non-deleted admin', () => {
    const p = fn('can_manage_boe_credits')
    assert.match(p, /security definer/)
    assert.match(p, /set search_path = public, pg_temp/)
    assert.match(p, /id = auth\.uid\(\)/)
    assert.match(p, /role = 'admin'/)
    assert.match(p, /is_active = true/)
    assert.match(p, /coalesce\(is_deleted, false\) = false/)
    assert.equal(/resolve_permission|permission_modules/.test(code), false, 'no new permission key: management reuses the admin role')
  })
})

describe('the balance is derived', () => {
  test('a security_invoker view that sums the ledger, and a SECURITY INVOKER function doing the same', () => {
    assert.match(code, /create view public\.boe_credit_balances\s*\n\s*with \(security_invoker = true\) as/)
    assert.match(code, /coalesce\(sum\(credits\), 0\)::integer as available_credits/)
    const f = fn('boe_credit_balance')
    assert.equal(/security definer/.test(f), false, 'reads under the caller\'s own RLS')
    assert.match(f, /coalesce\(sum\(credits\), 0\)::integer/)
    assert.equal(/credit_balance\s+integer|balance\s+integer\s+not null/.test(code), false, 'no stored balance column anywhere')
  })
})

describe('the one write path', () => {
  const post = fn('post_boe_credit_transaction')
  const reverse = fn('reverse_boe_credit_transaction')

  test('both posting functions are SECURITY DEFINER with search_path pinned, pg_temp last', () => {
    for (const f of [post, reverse]) {
      assert.match(f, /security definer/)
      assert.match(f, /set search_path = public, pg_temp/)
    }
  })

  test('EXECUTE is revoked from public, anon AND authenticated, and granted to service_role — on the exact signatures', () => {
    for (const sig of [POST_SIG, REVERSE_SIG]) {
      const esc = sig.replace(/[.()]/g, m => `\\${m}`)
      assert.match(code, new RegExp(`revoke execute on function ${esc}\\s*\\n\\s*from public, anon, authenticated;`))
      assert.match(code, new RegExp(`grant  execute on function ${esc}\\s*\\n\\s*to service_role;`))
    }
    // the signature in the grant is the signature of the definition
    assert.match(post, /p_employee_id\s+uuid,\s*\n\s*p_transaction_type\s+text,\s*\n\s*p_credits\s+integer,\s*\n\s*p_source_type\s+text,\s*\n\s*p_source_id\s+uuid,\s*\n\s*p_description\s+text,\s*\n\s*p_actor_id\s+uuid,\s*\n\s*p_payroll_period_id uuid default null/)
    assert.match(reverse, /p_transaction_id uuid,\s*\n\s*p_actor_id\s+uuid,\s*\n\s*p_reason\s+text/)
  })

  test('the validations, each with its marker and errcode', () => {
    assert.match(post, /BOE_CREDITS_EMPLOYEE[^']*'\s*\n\s*using errcode = 'P0002'/)
    assert.match(post, /BOE_CREDITS_ZERO[^']*'\s*\n\s*using errcode = '22023'/)
    assert.match(post, /BOE_CREDITS_TYPE[^']*'[^\n]*\n\s*using errcode = '22023'/)
    assert.match(post, /BOE_CREDITS_REASON[^']*'\s*\n\s*using errcode = '22023'/)
    assert.match(post, /BOE_CREDITS_DUPLICATE_SOURCE[^\n]*\n\s*using errcode = '23505'/)
    assert.match(post, /BOE_CREDITS_INSUFFICIENT[^\n]*\n\s*using errcode = '23514'/)
    assert.match(post, /BOE_CREDITS_DENIED[^\n]*\n\s*using errcode = '42501'/)
  })

  test('an adjustment or reversal needs an ACTIVE ADMIN actor, checked inside the database', () => {
    assert.match(post, /if p_transaction_type in \('admin_adjustment', 'reversal'\) then/)
    const block = post.slice(post.indexOf("if p_transaction_type in ('admin_adjustment', 'reversal')"))
    assert.match(block, /id = p_actor_id\s*\n\s*and role = 'admin'\s*\n\s*and is_active = true\s*\n\s*and coalesce\(is_deleted, false\) = false/)
  })

  test('the duplicate check and the balance check run under a per-employee advisory lock, before the insert', () => {
    const lock   = post.indexOf('pg_advisory_xact_lock(')
    const dupe   = post.indexOf('BOE_CREDITS_DUPLICATE_SOURCE')
    const insuff = post.indexOf('BOE_CREDITS_INSUFFICIENT')
    const insert = post.indexOf('insert into public.boe_credit_transactions')
    assert.ok(lock > 0 && lock < dupe && dupe < insuff && insuff < insert)
  })

  test('the overdraft check guards REDEMPTION only — a reversal may take the balance below zero', () => {
    // Two halves of one rule. An employee cannot spend more than they have,
    // and a negative balance keeps them from spending until it is positive
    // again — but a reward invalidated after its credits were spent must still
    // be reversed, and the balance that produces is negative. History is never
    // rewritten to avoid it. The executable proof is §11 of
    // supabase/tests/boe_credits_assertions.sql; this pins the shape.
    const occurrences = post.match(/BOE_CREDITS_INSUFFICIENT/g) ?? []
    assert.equal(occurrences.length, 1, 'exactly one balance check')
    const guard = post.indexOf("if p_transaction_type = 'redemption' then\n    select coalesce(sum(credits), 0) into v_balance")
    assert.ok(guard > 0, 'the balance is read inside the redemption branch')
    const branch = post.slice(guard, post.indexOf('end if;', post.indexOf('BOE_CREDITS_INSUFFICIENT')))
    assert.match(branch, /if v_balance \+ p_credits < 0 then/)
    assert.ok(branch.includes('BOE_CREDITS_INSUFFICIENT'), 'the refusal lives inside that branch')
    // and nothing else in the function reads the balance
    assert.equal((post.match(/into v_balance/g) ?? []).length, 1)
  })

  test('a reversal negates the original exactly, for the same employee, and a reversal cannot be reversed', () => {
    assert.match(post, /v_original\.employee_id <> p_employee_id/)
    assert.match(post, /v_original\.transaction_type = 'reversal'/)
    assert.match(post, /p_credits <> -v_original\.credits/)
    assert.match(reverse, /-v_original\.credits,\s*\n\s*'boe_credit_transaction',\s*\n\s*v_original\.id,/)
    assert.equal(/update public\.boe_credit_transactions|delete from public\.boe_credit_transactions/.test(code), false,
      'the original is never touched')
  })

  test('every raise in the file carries a SQLSTATE', () => {
    const raises = code.match(/raise exception[\s\S]*?;/g) ?? []
    assert.ok(raises.length >= 15)
    for (const r of raises) {
      // The post-condition block raises plain migration failures; everything a
      // caller can trigger names its errcode.
      if (/^raise exception 'BOE_CREDITS: /.test(r)) continue
      assert.match(r, /using errcode = '[0-9A-Z]{5}'/, r)
    }
  })
})

describe('settings', () => {
  test('two numbers, bounded, append-only, readable by active employees, written by nobody from a client', () => {
    assert.match(code, /review_reward_credits integer\s+not null check \(review_reward_credits > 0 and review_reward_credits <= 100000\)/)
    assert.match(code, /credit_value\s+numeric\(12,2\) not null check \(credit_value >= 0\)/)
    assert.equal(/create policy "boe_credit_settings_[a-z_]*"\s*\n\s*on public\.boe_credit_settings\s*\n\s*for insert/.test(code), false,
      'no INSERT policy: the admin route on the service role is the one door')
    assert.match(code, /select 100, 1\.00, null, 'BOE Credits Phase 1A defaults'\s*\n\s*where not exists \(select 1 from public\.boe_credit_settings\);/)
  })
})

describe('the post-conditions the migration runs on itself', () => {
  test('it asserts RLS, the partial unique index, both triggers, SELECT-only policies, revoked privileges, service_role-only execution, the invoker view and the seeded pair', () => {
    const block = code.slice(code.lastIndexOf('do $$'))
    for (const needle of [
      "c.relrowsecurity",
      "boe_credit_transactions_one_per_source_idx",
      "where (source_id is not null)",
      "boe_credit_transactions_append_only', 'boe_credit_settings_append_only'",
      "cmd <> 'SELECT'",
      "has_table_privilege('authenticated', 'public.boe_credit_transactions', 'INSERT')",
      `has_function_privilege('authenticated', '${POST_SIG}', 'EXECUTE')`,
      `has_function_privilege('service_role', '${REVERSE_SIG}', 'EXECUTE')`,
      "security_invoker=true",
      "v_reward is distinct from 100 or v_value is distinct from 1.00",
    ]) {
      assert.ok(block.includes(needle), needle)
    }
  })
})
