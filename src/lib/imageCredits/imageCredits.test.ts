import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { SupabaseClient } from '@supabase/supabase-js'
import { COST, CREDIT_TOOLS, TOOL_LABEL } from './costs'
import { NOT_BILLED, SPEND_REFUSALS, spendCredits, type SpendCode } from './spend'
import { readFalBalance } from './falBalance'
import { daysOfBalanceLeft, rupees } from './report'
import { creditNoteText } from './note'

const read = (p: string) => readFileSync(p, 'utf8').replace(/\r/g, '')

// A stand-in for the service client: answers image_credit_spend / image_credit_refund and remembers the calls.
function fakeClient(spendAnswer: { data?: unknown; error?: { message: string } | null }) {
  const calls: { fn: string; args: Record<string, unknown> }[] = []
  const client = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args })
      return fn === 'image_credit_spend' ? { data: spendAnswer.data ?? null, error: spendAnswer.error ?? null } : { data: true, error: null }
    },
  } as unknown as SupabaseClient
  return { client, calls }
}

test('every tool has a label and a cost: studio is 1 credit, the three edits are 2', () => {
  for (const tool of CREDIT_TOOLS) {
    assert.ok(TOOL_LABEL[tool].length > 0)
    assert.ok(COST[tool].credits >= 1 && COST[tool].usd > 0)
  }
  assert.equal(COST.studio.credits, 1)
  for (const t of ['pi_customize', 'quotation_clean', 'quotation_change'] as const) assert.equal(COST[t].credits, 2)
})

test('the tool names match the ones the database accepts', () => {
  const sql = read('supabase/migrations/20270808000000_picture_wallet.sql')
  const listed = /tool\s+text\s+not null check \(tool in \(([^)]*)\)\)/.exec(sql)![1].match(/'[a-z_]+'/g)!.map(s => s.slice(1, -1))
  assert.deepEqual([...listed].sort(), [...CREDIT_TOOLS].sort())
})

test('a press that passes the wallet carries its ledger row and sends the cost the tool is priced at', async () => {
  const { client, calls } = fakeClient({ data: { ok: true, ledger_id: 'L1' } })
  const spend = await spendCredits('U1', 'quotation_clean', client)
  assert.equal(spend.ok, true)
  assert.deepEqual(calls[0], { fn: 'image_credit_spend', args: { p_user: 'U1', p_tool: 'quotation_clean', p_credits: 2, p_usd: 0.08 } })
})

test('a refusal from the wallet becomes its status and a plain message; nothing is charged', async () => {
  for (const code of ['PAUSED', 'NO_ALLOWANCE', 'USER_MONTH', 'USER_DAY', 'POOL'] as SpendCode[]) {
    const { client } = fakeClient({ data: { ok: false, code } })
    const spend = await spendCredits('U1', 'studio', client)
    assert.equal(spend.ok, false)
    if (!spend.ok) { assert.equal(spend.code, code); assert.equal(spend.status, SPEND_REFUSALS[code].status); assert.match(spend.message, /\S/) }
  }
})

test('if the wallet cannot be checked, the press is refused rather than allowed', async () => {
  for (const answer of [{ error: { message: 'boom' } }, { data: null }, { data: { ok: false, code: 'SURPRISE' } }, { data: { ok: true } }]) {
    const { client } = fakeClient(answer)
    const spend = await spendCredits('U1', 'studio', client)
    assert.equal(spend.ok, false)
    if (!spend.ok) assert.equal(spend.code, 'UNAVAILABLE')
  }
})

test('credits come back only when fal refused the request before running it', async () => {
  for (const reason of ['not_configured', 'invalid_key', 'insufficient_credit', 'unsupported_image', 'moderation', 'rate_limited']) assert.ok(NOT_BILLED.has(reason))
  for (const reason of ['timeout', 'provider_error', 'empty_result']) assert.equal(NOT_BILLED.has(reason), false)

  const refunded = async (reason: string) => {
    const { client, calls } = fakeClient({ data: { ok: true, ledger_id: 'L9' } })
    const spend = await spendCredits('U1', 'studio', client)
    assert.ok(spend.ok)
    if (spend.ok) await spend.refundIfNotBilled(reason)
    return calls.filter(c => c.fn === 'image_credit_refund')
  }
  assert.deepEqual(await refunded('rate_limited'), [{ fn: 'image_credit_refund', args: { p_ledger: 'L9' } }])
  assert.deepEqual(await refunded('timeout'), [])
})

test('what staff are told never names money, a provider or a model', () => {
  for (const { message } of Object.values(SPEND_REFUSALS)) assert.doesNotMatch(message, /₹|\$|rupee|dollar|\bfal\b|nano|banana|bria|seedvr/i)
  for (const status of [{ enforce: true, allowed: true, month_left: 5, today_left: 5 }, { enforce: true, allowed: false }, { enforce: true, enabled: false }]) {
    assert.doesNotMatch(creditNoteText(status, 2)!.text, /₹|\$|rupee|dollar|\bfal\b|nano|banana|bria|seedvr/i)
  }
})

test('the note shows nothing while limits are off, and says what is left when they are on', () => {
  assert.equal(creditNoteText(null, 2), null)
  assert.equal(creditNoteText({ enforce: false }, 2), null)
  assert.deepEqual(creditNoteText({ enforce: true, allowed: true, month_left: 140, today_left: 30 }, 2), { text: 'Uses 2 credits · 140 left this month · 30 left today', warn: false })
  assert.equal(creditNoteText({ enforce: true, allowed: true, month_left: 1, today_left: 30 }, 2)!.warn, true)
  assert.equal(creditNoteText({ enforce: true, allowed: true, month_left: 10, today_left: 0 }, 1)!.warn, true)
  assert.match(creditNoteText({ enforce: true, allowed: true, month_left: 9, today_left: 9 }, 1)!.text, /^Uses 1 credit ·/)
  assert.match(creditNoteText({ enforce: true, allowed: false }, 2)!.text, /not switched on/)
})

test('fal balance: not connected without a key; the key goes in a header and never comes back', async () => {
  assert.deepEqual(await readFalBalance({ key: '' , fetchImpl: (async () => { throw new Error('must not be called') }) as unknown as typeof fetch }), { connected: false })

  let seen: { url: string; auth: string } | null = null
  const ok = (async (url: string, init: RequestInit) => {
    seen = { url, auth: String((init.headers as Record<string, string>).Authorization) }
    return new Response(JSON.stringify({ username: 'x', credits: { current_balance: 41.5, currency: 'USD' } }), { status: 200 })
  }) as unknown as typeof fetch
  const result = await readFalBalance({ key: 'SECRET-KEY', fetchImpl: ok })
  assert.deepEqual(result, { connected: true, usd: 41.5 })
  assert.equal(seen!.url, 'https://api.fal.ai/v1/account/billing?expand=credits')
  assert.equal(seen!.auth, 'Key SECRET-KEY')
  assert.doesNotMatch(JSON.stringify(result), /SECRET/)
})

test('fal balance: a refusal, a strange answer or an outage is reported, not thrown, and never shows the key', async () => {
  const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
  const cases = [answer(401, { detail: 'no' }), answer(200, { credits: { current_balance: 'lots', currency: 'USD' } }), answer(200, { credits: { current_balance: 5, currency: 'EUR' } }),
    (async () => { throw new Error('SECRET-KEY leaked?') }) as unknown as typeof fetch]
  for (const fetchImpl of cases) {
    const result = await readFalBalance({ key: 'SECRET-KEY', fetchImpl })
    assert.equal(result.connected, true)
    if (result.connected) assert.equal(result.usd, null)
    assert.doesNotMatch(JSON.stringify(result), /SECRET/)
  }
})

test('days of balance left: at the last seven days’ pace, and nothing when there is no pace', () => {
  assert.equal(daysOfBalanceLeft(70, 7), 70)
  assert.equal(daysOfBalanceLeft(10, 7), 10)
  assert.equal(daysOfBalanceLeft(5, 14), 2)
  assert.equal(daysOfBalanceLeft(50, 0), null)
  assert.equal(daysOfBalanceLeft(-1, 7), null)
  assert.equal(rupees(0.08, 88), 7)
})

// ── The doors: every paid press takes credits first, and gives them back only on a refusal ───────────────────

const ROUTES = {
  studio: ['src/app/api/image-editor/studio/route.ts', 'generateProductShot({', "'studio'"],
  customize: ['src/app/api/orders/pi-edits/regenerate-image/route.ts', 'callFal({', "'pi_customize'"],
  quotation: ['src/app/api/quotations/picture/route.ts', 'callFal({', "'quotation_clean' : 'quotation_change'"],
} as const

for (const [name, [file, paid, tool]] of Object.entries(ROUTES)) {
  test(`${name}: credits are taken before the paying call, and refunded only through the refusal list`, () => {
    const src = read(file)
    const spendAt = src.indexOf('spendCredits(')
    assert.ok(spendAt > 0, 'the route takes credits')
    assert.ok(src.slice(spendAt).includes(tool), 'with the right tool name')
    assert.ok(spendAt < src.indexOf(paid), 'before the paid call')
    assert.equal(src.split('spendCredits(').length - 1, 1, 'exactly once')
    assert.match(src, /if \(!spend\.ok\)/)
    assert.match(src, /spend\.refundIfNotBilled\(/)
    assert.doesNotMatch(src, /image_credit_refund/, 'the route does not refund by itself')
  })
}

test('the founders’ routes check for an administrator; the staff note route only for a signed-in person', () => {
  for (const f of ['report', 'settings', 'allowance']) assert.match(read(`src/app/api/image-credits/${f}/route.ts`), /creditCaller\(req, true\)/)
  assert.match(read('src/app/api/image-credits/me/route.ts'), /creditCaller\(req\)/)
  assert.match(read('src/lib/imageCredits/caller.ts'), /isAdminRole\(profile\.role\)/)
})

test('the wallet functions are reachable by the service role only, and the tables are closed', () => {
  const sql = read('supabase/migrations/20270808000000_picture_wallet.sql')
  for (const fn of ['image_credit_spend', 'image_credit_refund', 'image_credit_status', 'image_credit_report']) {
    assert.match(sql, new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\)\\s+from public, anon, authenticated`))
    assert.match(sql, new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\)\\s+to service_role`))
  }
  assert.equal((sql.match(/enable row level security/g) ?? []).length, 3)
  assert.doesNotMatch(sql, /create policy/i)
  assert.match(sql, /set search_path = public, pg_temp/)
})

test('the founders’ switches say what state they are in, and limits cannot be ticked while nobody has credits', () => {
  const page = read('src/app/image-editor/usage/page.tsx')
  // A box labelled "Limits are on." while unticked reads as a status, which it is not (found on the live page, 18 Nov 2026).
  assert.doesNotMatch(page, /<strong>(Limits|Picture making) are? on\.<\/strong>/)
  assert.match(page, /settings\.enforce \? 'ON' : 'OFF'/)
  assert.match(page, /settings\.enabled \? 'ON' : 'OFF'/)
  // With limits on and an empty list every press would be refused, so the box stays locked until someone has credits.
  assert.match(page, /disabled=\{saving \|\| \(!settings\.enforce && allowances\.length === 0\)\}/)
})
