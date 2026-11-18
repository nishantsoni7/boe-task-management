// How much credit is left in the fal account, read from fal itself.
// SERVER ONLY. GET https://api.fal.ai/v1/account/billing?expand=credits answers `credits.current_balance`.
//
// It needs a SEPARATE key with the BILLING (read-only) preset, set as FAL_BILLING_KEY. The key that makes pictures
// (FAL_KEY) cannot read billing, and this one cannot make pictures, so a leak of either is limited.
// Not set: the page says "not connected" and everything else works.
//
// The key is sent in a header only and never returned, logged or put in an error.

import type { FalBalance } from './report'

const BILLING_URL = 'https://api.fal.ai/v1/account/billing?expand=credits'

export async function readFalBalance(opts: { key?: string; fetchImpl?: typeof fetch } = {}): Promise<FalBalance> {
  const key = opts.key ?? process.env.FAL_BILLING_KEY
  if (!key) return { connected: false }

  try {
    const res = await (opts.fetchImpl ?? fetch)(BILLING_URL, {
      headers: { Authorization: `Key ${key}` },
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) return { connected: true, usd: null, error: `fal answered ${res.status}` }

    const credits = ((await res.json()) as { credits?: { current_balance?: unknown; currency?: unknown } }).credits
    if (typeof credits?.current_balance !== 'number' || credits.currency !== 'USD') {
      return { connected: true, usd: null, error: 'fal gave an answer this page does not understand' }
    }
    return { connected: true, usd: credits.current_balance }
  } catch {
    return { connected: true, usd: null, error: 'fal could not be reached' }
  }
}
