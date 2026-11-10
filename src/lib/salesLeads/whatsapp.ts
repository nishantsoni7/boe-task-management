// What Meta's WhatsApp webhook may send to /api/sales/capture/whatsapp, and what is taken from it. The route checks Meta's
// signature first, then reads the messages out of the body here; the database (capture_sales_chats) does the rest.
//
// RECEIVE ONLY. Nothing in this file or its route sends a message, and nothing reads the client's chat except the one text
// Meta delivers with each message.

import { createHmac, timingSafeEqual } from 'node:crypto'

export type ChatRow = {
  key: string
  phone: string
  name: string | null
  message: string | null
  ad_id: string | null
  ad_headline: string | null
  ad_url: string | null
  ctwa_clid: string | null
}

/** capture_sales_chats takes this many rows at a time. */
export const MAX_ROWS = 100

/** Message kinds that say nothing a salesperson needs: a reaction is not a client writing in. */
const SKIPPED_KINDS = new Set(['reaction', 'system', 'unsupported', 'unknown'])

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

const text = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string' && typeof v !== 'number') return null
  const s = String(v).trim()
  return s ? s.slice(0, max) : null
}

/** Same length and same bytes, in constant time. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * Meta signs every delivery: `X-Hub-Signature-256: sha256=<hex>`, an HMAC-SHA256 of the raw body with the app secret.
 * The body is checked as the bytes that arrived, never as parsed and written out again.
 */
export function signatureMatches(rawBody: Buffer, header: string | null, appSecret: string): boolean {
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header ?? '')
  if (!m) return false
  const want = createHmac('sha256', appSecret).update(rawBody).digest()
  return timingSafeEqual(want, Buffer.from(m[1], 'hex'))
}

/** The words of a message: its text, or the caption of a picture or document, or the label of a button. */
function wordsOf(message: Record<string, unknown>, kind: string): string | null {
  if (kind === 'text') return text(obj(message.text).body, 4000)
  if (kind === 'button') return text(obj(message.button).text, 4000)
  if (kind === 'interactive') {
    const i = obj(message.interactive)
    return text(obj(i.button_reply).title ?? obj(i.list_reply).title, 4000)
  }
  const caption = text(obj(message[kind]).caption, 4000)
  return caption ?? (kind ? `[${kind}]` : null)
}

/**
 * The chats in a delivery, one row per message from a client. Delivery receipts (they arrive as `statuses`, not
 * `messages`), reactions and anything without a message id or a usable number are left out: the id is how a message Meta
 * sends twice is counted once, and a client who hides their number behind a WhatsApp username cannot become a lead.
 */
export function chatRows(body: unknown): ChatRow[] {
  const out: ChatRow[] = []
  for (const entry of list(obj(body).entry)) {
    for (const change of list(obj(entry).changes)) {
      const c = obj(change)
      if (c.field !== 'messages') continue
      const value = obj(c.value)
      const names = new Map<string, string>()
      for (const contact of list(value.contacts)) {
        const k = obj(contact)
        const id = text(k.wa_id, 40)
        const name = text(obj(k.profile).name, 120)
        if (id && name) names.set(id, name)
      }
      for (const raw of list(value.messages)) {
        const m = obj(raw)
        const key = text(m.id, 200)
        const kind = text(m.type, 40) ?? ''
        const from = text(m.from, 40)
        if (!key || !from || SKIPPED_KINDS.has(kind) || !/^[0-9]{8,15}$/.test(from)) continue
        // Only the first message of a chat opened from an ad carries the ad.
        const ref = obj(m.referral)
        out.push({
          key,
          phone: `+${from}`,
          name: names.get(from) ?? null,
          message: wordsOf(m, kind),
          ad_id: text(ref.source_id, 100),
          ad_headline: text(ref.headline, 200),
          ad_url: text(ref.source_url, 500),
          ctwa_clid: text(ref.ctwa_clid, 500),
        })
      }
    }
  }
  return out
}
