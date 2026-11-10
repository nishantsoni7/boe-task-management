/**
 * Sales: what Meta's WhatsApp webhook may send to /api/sales/capture/whatsapp, and what is taken from it. Made-up data and a
 * made-up secret only.
 *
 * Run:
 *   npm run test:file -- src/lib/salesLeads/whatsapp.test.ts
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chatRows, safeEqual, signatureMatches } from './whatsapp'

const SECRET = 'not-a-real-app-secret'
const sign = (body: Buffer, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`

/** A delivery shaped as Meta's reference shows it. */
const delivery = (messages: unknown[], contacts: unknown[] = [{ profile: { name: 'Grand Hotel' }, wa_id: '919811100050' }], field = 'messages') => ({
  object: 'x',
  entry: [{ id: '1', changes: [{ field, value: { messaging_product: 'whatsapp', metadata: {}, contacts, messages } }] }],
})

const text = (id: string, from: string, body: string, extra: Record<string, unknown> = {}) => ({ from, id, timestamp: '1', type: 'text', text: { body }, ...extra })

describe('the signature', () => {
  const body = Buffer.from(JSON.stringify(delivery([text('wamid.1', '919811100050', 'Hello')])))

  test('the right secret over the bytes that arrived is accepted', () => {
    assert.equal(signatureMatches(body, sign(body), SECRET), true)
  })

  test('another secret, another body, a missing, short or odd header are all refused', () => {
    assert.equal(signatureMatches(body, sign(body, 'other'), SECRET), false)
    assert.equal(signatureMatches(Buffer.from(body.toString() + ' '), sign(body), SECRET), false)
    assert.equal(signatureMatches(body, null, SECRET), false)
    assert.equal(signatureMatches(body, '', SECRET), false)
    assert.equal(signatureMatches(body, 'sha256=abc', SECRET), false)
    assert.equal(signatureMatches(body, sign(body).replace('sha256=', 'sha1='), SECRET), false)
    assert.equal(signatureMatches(body, `${sign(body)}00`, SECRET), false)
  })

  test('safeEqual compares text of the same length only', () => {
    assert.equal(safeEqual('abc', 'abc'), true)
    assert.equal(safeEqual('abc', 'abd'), false)
    assert.equal(safeEqual('abc', 'abcd'), false)
  })
})

describe('the chats in a delivery', () => {
  test('a text from a client: the number with its plus, the profile name, the words and the message id', () => {
    const rows = chatRows(delivery([text('wamid.A', '919811100050', '  Need 40 chairs  ')]))
    assert.deepEqual(rows, [{
      key: 'wamid.A', phone: '+919811100050', name: 'Grand Hotel', message: 'Need 40 chairs',
      ad_id: null, ad_headline: null, ad_url: null, ctwa_clid: null,
    }])
  })

  test('a chat opened from an ad carries the ad', () => {
    const rows = chatRows(delivery([text('wamid.B', '919811100050', 'Price?', {
      referral: { source_url: 'https://fb.example/ad', source_id: '120226305854810726', source_type: 'ad', headline: 'Hotel furniture', ctwa_clid: 'AbC' },
    })]))
    assert.equal(rows.length, 1)
    assert.deepEqual([rows[0].ad_id, rows[0].ad_headline, rows[0].ad_url, rows[0].ctwa_clid], ['120226305854810726', 'Hotel furniture', 'https://fb.example/ad', 'AbC'])
  })

  test('a picture takes its caption, or is named by its kind; a button takes its label', () => {
    const rows = chatRows(delivery([
      { from: '919811100050', id: 'wamid.C', type: 'image', image: { id: 'm1', caption: 'This design' } },
      { from: '919811100050', id: 'wamid.D', type: 'image', image: { id: 'm2' } },
      { from: '919811100050', id: 'wamid.E', type: 'audio', audio: { id: 'm3' } },
      { from: '919811100050', id: 'wamid.F', type: 'button', button: { text: 'Get a quote', payload: 'q' } },
      { from: '919811100050', id: 'wamid.G', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: '1', title: 'Yes' } } },
    ]))
    assert.deepEqual(rows.map(r => r.message), ['This design', '[image]', '[audio]', 'Get a quote', 'Yes'])
  })

  test('a name is only taken from the contact with the same number', () => {
    const rows = chatRows(delivery([text('wamid.H', '919811100051', 'Hi')], [{ profile: { name: 'Someone else' }, wa_id: '919811100050' }]))
    assert.equal(rows[0].name, null)
  })

  test('receipts, reactions, other fields and rows that cannot be a lead are left out', () => {
    assert.deepEqual(chatRows({ entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id: 'wamid.S', status: 'delivered' }] } }] }] }), [])
    assert.deepEqual(chatRows(delivery([{ from: '919811100050', id: 'wamid.R', type: 'reaction', reaction: { emoji: 'x' } }])), [])
    assert.deepEqual(chatRows(delivery([text('wamid.T', '919811100050', 'Hi')], [], 'account_update')), [])
    assert.deepEqual(chatRows(delivery([{ from: '919811100050', type: 'text', text: { body: 'no id' } }])), [])
    assert.deepEqual(chatRows(delivery([text('wamid.U', '12345', 'too short')])), [])
    assert.deepEqual(chatRows(delivery([text('wamid.V', '+91 98111 00050', 'not digits only')])), [])
    assert.deepEqual(chatRows(delivery([{ id: 'wamid.W', type: 'text', text: { body: 'no sender (a hidden number)' } }])), [])
  })

  test('junk in, nothing out', () => {
    for (const junk of [null, undefined, 'x', 7, [], {}, { entry: 'x' }, { entry: [null, 3, { changes: 'x' }] }, { entry: [{ changes: [{ field: 'messages', value: { messages: 'x' } }] }] }]) {
      assert.deepEqual(chatRows(junk), [])
    }
  })

  test('words are cut to what the database takes, and one delivery can hold several clients', () => {
    const rows = chatRows(delivery([text('wamid.X', '919811100050', 'x'.repeat(5000)), text('wamid.Y', '919811100052', 'Hi')]))
    assert.equal(rows.length, 2)
    assert.equal(rows[0].message?.length, 4000)
    assert.equal(rows[1].phone, '+919811100052')
  })
})

describe('the route', () => {
  const route = readFileSync(join(process.cwd(), 'src/app/api/sales/capture/whatsapp/route.ts'), 'utf8').replace(/\r\n/g, '\n')
  const code = route.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

  test('the signature is checked before the body is read as JSON', () => {
    const post = code.slice(code.indexOf('export async function POST'))
    assert.ok(post.indexOf('signatureMatches(') !== -1 && post.indexOf('signatureMatches(') < post.indexOf('JSON.parse('))
  })

  test('it answers 503 with its settings missing, and the challenge only as a number', () => {
    assert.ok(code.includes('WA_VERIFY_TOKEN') && code.includes('META_APP_SECRET'))
    assert.equal((code.match(/status: 503/g) ?? []).length, 2)
    assert.ok(code.includes('/^[0-9]{1,20}$/.test(challenge)'))
  })

  test('RECEIVE ONLY: the route makes no outbound call and names no address', () => {
    assert.equal(/\bfetch\s*\(/.test(code), false)
    assert.equal(/https?:\/\//.test(code), false)
  })

  test('it logs no number, name or message, and a failed save asks Meta to try again', () => {
    for (const line of code.split('\n').filter(l => l.includes('console.'))) {
      // Meta's or the database's own error text (error.message) is fine; the client's data is not.
      assert.equal(/rows|phone|name|message|body/.test(line.replace('[sales/capture/whatsapp]', '').replace('error.message', '')), false, line)
    }
    assert.ok(code.includes('{ status: 500 }'))
  })
})

describe('the migration', () => {
  const sql = readFileSync(join(process.cwd(), 'supabase/migrations/20270609000000_sales_whatsapp_capture.sql'), 'utf8').replace(/\r\n/g, '\n')

  test('the chat capture is for the service role only, and the ad table is closed to browsers', () => {
    assert.ok(sql.includes('revoke all on function public.capture_sales_chats(jsonb) from public, anon, authenticated;'))
    assert.ok(sql.includes('grant execute on function public.capture_sales_chats(jsonb) to service_role;'))
    assert.ok(sql.includes('alter table public.sales_lead_ad_clicks enable row level security;'))
    assert.ok(sql.includes('revoke all on table public.sales_lead_ad_clicks from public, anon, authenticated;'))
  })

  test('the website capture is not replaced, and the source it writes is one the Lead Master accepts', () => {
    assert.equal(/function public\.capture_sales_leads/.test(sql), false)
    const master = readFileSync(join(process.cwd(), 'supabase/migrations/20270524000000_sales_lead_master.sql'), 'utf8')
    assert.ok(master.includes(`'website', 'whatsapp', 'instagram'`))
    assert.ok(sql.includes(`values (v_phone, 'whatsapp', v_name, v_msg)`))
  })
})
