// The punch feed for the operations ERP (same company, built separately).
//
// Every punch the machine sends is handed to that ERP in two ways, and the
// ERP takes what it needs:
//   * PUSH: right after Minop has been answered, the new punches are posted to
//     the ERP's own address (MINOP_PARTNER_PUSH_URL + MINOP_PARTNER_PUSH_TOKEN).
//   * PULL: GET /api/integrations/minop/partner/punches, which the ERP calls to
//     catch up after any outage (MINOP_PARTNER_PULL_KEY).
// Both carry the same shape and the same punch `id`, so a punch seen twice is
// the same punch. The feed is raw: machine id, device, time. No names, no
// attendance results, nothing from payroll. Each part is off while its settings
// are missing.
//
// Nothing here writes to the database or changes what Minop is told.

import { constantTimeEqual } from './webhook'
import { extractMinopPunches, isPlausiblePunchTime, mergePunchRows } from './punches'

/** Shortest push token or pull key accepted. Anything shorter fails closed. */
export const PARTNER_MIN_SECRET_LENGTH = 32
export const PARTNER_PAGE_DEFAULT = 500
export const PARTNER_PAGE_MAX = 500
export const PARTNER_MAX_MACHINE_IDS = 100

/** The machine's clock is IST; this is how a punch time is written to the ERP. */
const IST_OFFSET = '+05:30'

export type PartnerPunch = {
  /** Device, machine id and punch time together. Stable: the same punch always has the same id. */
  id: string
  machineId: string
  deviceId: string
  /** ISO-8601 with the IST offset, e.g. 2026-11-03T10:04:12+05:30. */
  punchTime: string
  /** UTC instant at which BOE first received the punch. */
  receivedAt: string
}

type PunchFields = { dvc_id: string; minop_user_id: string; punch_local: string; first_seen_at: string }

/** `2026-11-03 10:04:12` from the message, or `2026-11-03T10:04:12` from the table. */
function normaliseLocal(punchLocal: string): string {
  return punchLocal.replace('T', ' ').slice(0, 19)
}

export function partnerPunchId(dvcId: string, machineId: string, punchLocal: string): string {
  return `${dvcId}|${machineId}|${normaliseLocal(punchLocal)}`
}

export function toPartnerPunch(p: PunchFields): PartnerPunch {
  const local = normaliseLocal(p.punch_local)
  return {
    id: partnerPunchId(p.dvc_id, p.minop_user_id, local),
    machineId: p.minop_user_id,
    deviceId: p.dvc_id,
    punchTime: `${local.replace(' ', 'T')}${IST_OFFSET}`,
    receivedAt: new Date(p.first_seen_at).toISOString(),
  }
}

// ---------------------------------------------------------------------------
// PUSH
// ---------------------------------------------------------------------------

export type PartnerPushConfig = { url: string; token: string }

export function partnerPushConfig(env: Record<string, string | undefined>): PartnerPushConfig | null {
  const url = env.MINOP_PARTNER_PUSH_URL?.trim()
  const token = env.MINOP_PARTNER_PUSH_TOKEN?.trim()
  if (!url && !token) return null

  let https = false
  try {
    https = !!url && new URL(url).protocol === 'https:'
  } catch {
    https = false
  }
  if (!url || !token || !https || token.length < PARTNER_MIN_SECRET_LENGTH) {
    console.error('[minop/partner] push is switched off: the address must be https and the token at least 32 characters')
    return null
  }
  return { url, token }
}

type PushDeps = {
  fetch: typeof fetch
  sleep: (ms: number) => Promise<void>
}

const realDeps: PushDeps = { fetch: (...args) => fetch(...args), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) }

const ATTEMPT_TIMEOUT_MS = 5_000
/** Waits before the second and third attempt. */
const RETRY_DELAYS_MS = [1_000, 3_000]

/**
 * Posts punches to the ERP: three attempts at most, five seconds each. A reply
 * in the 2xx range is success. A 4xx (other than 408 and 429) means the ERP
 * refused them, which another attempt will not change. Never throws, and never
 * logs the address or the token.
 */
export async function pushPartnerPunches(
  punches: PartnerPunch[],
  config: PartnerPushConfig,
  deps: PushDeps = realDeps,
): Promise<boolean> {
  if (punches.length === 0) return true
  const body = JSON.stringify({ punches })

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    let status = 0
    try {
      const response = await deps.fetch(config.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.token}` },
        body,
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      })
      status = response.status
      if (response.ok) return true
    } catch {
      // Network failure or timeout: try again.
    }
    if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
      console.error(`[minop/partner] the ERP refused the punches with status ${status}`)
      return false
    }
    if (attempt < RETRY_DELAYS_MS.length) await deps.sleep(RETRY_DELAYS_MS[attempt])
  }
  console.error('[minop/partner] the ERP did not accept the punches; it can catch up with the pull call')
  return false
}

/**
 * Called after Minop has been answered. Sends the punches of one stored message
 * that look real, once each. Never throws.
 */
export async function forwardPunchesToPartner(
  receivedAt: string,
  payload: unknown,
  env: Record<string, string | undefined> = process.env,
  deps?: PushDeps,
): Promise<void> {
  try {
    const config = partnerPushConfig(env)
    if (!config) return
    const rows = mergePunchRows(extractMinopPunches(payload).map(p => ({ ...p, first_seen_at: receivedAt })))
      .filter(p => isPlausiblePunchTime(p.punch_at, p.first_seen_at))
    await pushPartnerPunches(rows.map(toPartnerPunch), config, deps)
  } catch (error) {
    console.error('[minop/partner] push failed:', error instanceof Error ? error.message : 'unknown error')
  }
}

// ---------------------------------------------------------------------------
// PULL
// ---------------------------------------------------------------------------

/** Where the ERP stopped: when BOE first received the last punch it got, and that punch's row id. */
export type PartnerCursor = { t: string; i: string }

const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MACHINE_ID = /^[A-Za-z0-9_-]{1,32}$/

export function encodeCursor(cursor: PartnerCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url')
}

/** Null for anything that is not a cursor this feed made. The values go into a query filter, so they are checked strictly. */
export function decodeCursor(text: string): PartnerCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(text, 'base64url').toString('utf8')) as Partial<PartnerCursor>
    if (typeof parsed.t === 'string' && typeof parsed.i === 'string' && CURSOR_TIME.test(parsed.t) && UUID.test(parsed.i)) {
      return { t: parsed.t, i: parsed.i }
    }
  } catch {
    // fall through
  }
  return null
}

export type PartnerQuery = { cursor: PartnerCursor | null; limit: number; machineIds: string[] | null }

export function parsePartnerQuery(url: URL): { ok: true; query: PartnerQuery } | { ok: false; error: string } {
  const since = url.searchParams.get('since')
  let cursor: PartnerCursor | null = null
  if (since) {
    cursor = decodeCursor(since)
    if (!cursor) return { ok: false, error: 'since is not a cursor from this feed' }
  }

  const limitText = url.searchParams.get('limit')
  let limit = PARTNER_PAGE_DEFAULT
  if (limitText !== null) {
    limit = /^\d{1,4}$/.test(limitText) ? Number(limitText) : 0
    if (limit < 1 || limit > PARTNER_PAGE_MAX) return { ok: false, error: `limit must be 1 to ${PARTNER_PAGE_MAX}` }
  }

  const idsText = url.searchParams.get('machineIds')
  let machineIds: string[] | null = null
  if (idsText !== null) {
    machineIds = idsText.split(',').map(id => id.trim()).filter(Boolean)
    if (machineIds.length === 0 || machineIds.length > PARTNER_MAX_MACHINE_IDS || !machineIds.every(id => MACHINE_ID.test(id))) {
      return { ok: false, error: `machineIds must be 1 to ${PARTNER_MAX_MACHINE_IDS} ids made of letters, digits, - or _, separated by commas` }
    }
  }
  return { ok: true, query: { cursor, limit, machineIds } }
}

export type PartnerPage = {
  punches: PartnerPunch[]
  /** Pass this as `since` next time. It is the `since` you sent when nothing new came back. */
  cursor: string | null
  /** True when the page was full, so there may be more: call again at once with the new cursor. */
  more: boolean
}

export type PartnerRow = PunchFields & { id: string; punch_at: string }

/** Turns one fetched page of rows into the reply. Rows that are not real punches are left out but still move the cursor on. */
export function buildPartnerPage(rows: PartnerRow[], query: PartnerQuery): PartnerPage {
  const last = rows[rows.length - 1]
  return {
    punches: rows.filter(r => isPlausiblePunchTime(r.punch_at, r.first_seen_at)).map(toPartnerPunch),
    cursor: last ? encodeCursor({ t: last.first_seen_at, i: last.id }) : query.cursor ? encodeCursor(query.cursor) : null,
    more: rows.length >= query.limit,
  }
}

/** True when the Authorization header carries exactly the configured key. */
export function partnerKeyMatches(authorization: string | null, configuredKey: string | undefined): boolean {
  const key = configuredKey?.trim() ?? ''
  const provided = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
  return key.length >= PARTNER_MIN_SECRET_LENGTH && !!provided && constantTimeEqual(provided, key)
}
