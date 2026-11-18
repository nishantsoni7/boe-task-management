// Taking picture credits before a paid fal call, and giving them back when fal clearly refused the call.
// SERVER ONLY: it runs through the service-role client, because the wallet functions are not reachable by browsers.
// It builds that client itself (unless one is passed in), so a route that works as the signed-in person
// does not have to touch the service role.
//
// WHERE TO CALL IT: after everything that can be refused for free (access, rate limit, a bad upload), and
// immediately before the paying call. A press that is refused here has cost nothing.
//
// IF THE CHECK ITSELF FAILS the press is refused ("UNAVAILABLE"), never allowed through: a wallet that opens when
// it is broken is not a wallet.

import type { SupabaseClient } from '@supabase/supabase-js'
import { adminClient } from '@/lib/supabase/admin'
import { COST, type CreditTool } from './costs'

export type SpendCode = 'PAUSED' | 'NO_ALLOWANCE' | 'USER_MONTH' | 'USER_DAY' | 'POOL' | 'UNAVAILABLE'

export const SPEND_REFUSALS: Record<SpendCode, { status: number; message: string }> = {
  PAUSED: { status: 503, message: 'Picture making is switched off for now. Ask a founder.' },
  NO_ALLOWANCE: { status: 403, message: 'Picture credits are not switched on for your account. Ask a founder.' },
  USER_MONTH: { status: 403, message: 'You have used your picture credits for this month. They start again on the 1st.' },
  USER_DAY: { status: 429, message: 'That is a lot of pictures for one day. Try again tomorrow, or ask a founder.' },
  POOL: { status: 403, message: 'The team’s picture credits for this month are used up. Ask a founder.' },
  UNAVAILABLE: { status: 503, message: 'Picture credits could not be checked just now. Please try again in a minute.' },
}

export type Spend =
  /** `refundIfNotBilled(reason)`: call it with fal's failure reason; it gives the credits back only for NOT_BILLED reasons. */
  | { ok: true; ledgerId: string; refundIfNotBilled: (reason: string) => Promise<void> }
  | { ok: false; code: SpendCode; status: number; message: string }

/**
 * Failures where fal refused the request before running anything, so nothing was billed.
 * Everything else (a timeout, a 5xx, an empty answer) stays charged, because a request that may already
 * have been billed is not quietly written off, the same rule as the no-retry rule in falRequest.ts.
 * shortcut: assumes fal does not bill these refusals; compare the tracking page with fal's own usage, and
 * trim this list if fal bills any of them.
 */
export const NOT_BILLED: ReadonlySet<string> = new Set([
  'not_configured', 'invalid_key', 'insufficient_credit', 'unsupported_image', 'moderation', 'rate_limited',
])

const refused = (code: SpendCode): Spend => ({ ok: false, code, ...SPEND_REFUSALS[code] })

export async function spendCredits(userId: string, tool: CreditTool, client?: SupabaseClient): Promise<Spend> {
  let svc = client
  if (!svc) {
    const admin = adminClient()
    if (!admin.ok) { console.error('[image-credits] no service client:', admin.missing.join(', ')); return refused('UNAVAILABLE') }
    svc = admin.client as SupabaseClient
  }
  const db = svc

  const { credits, usd } = COST[tool]
  const { data, error } = await db.rpc('image_credit_spend', { p_user: userId, p_tool: tool, p_credits: credits, p_usd: usd })
  const answer = data as { ok?: boolean; ledger_id?: unknown; code?: unknown } | null

  if (!error && answer?.ok === true && typeof answer.ledger_id === 'string') {
    const ledgerId = answer.ledger_id
    return {
      ok: true,
      ledgerId,
      // Best effort: a refund that fails is logged, never allowed to turn a clear refusal into a different error.
      refundIfNotBilled: async reason => {
        if (!NOT_BILLED.has(reason)) return
        const { error: refundError } = await db.rpc('image_credit_refund', { p_ledger: ledgerId })
        if (refundError) console.error('[image-credits] refund failed:', refundError.message)
      },
    }
  }

  const known = !error && typeof answer?.code === 'string' && answer.code in SPEND_REFUSALS
  if (!known) console.error('[image-credits] spend failed:', error?.message ?? 'unexpected answer')
  return refused(known ? (answer!.code as SpendCode) : 'UNAVAILABLE')
}
