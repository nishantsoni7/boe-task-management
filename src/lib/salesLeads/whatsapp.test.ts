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
import { chatRows, mergeByPhone, safeEqual, signatureMatches } from './whatsapp'

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
      ad_id: null, ad_headline: null, ad_url: null, ctwa_clid: null, kind: 'text', file: null,
    }])
  })

  test('a document keeps its file name for the judge only', () => {
    const rows = chatRows(delivery([
      { from: '919811100050', id: 'wamid.DOC', type: 'document', document: { id: 'm9', filename: 'Resume_Rahul.pdf' } },
      { from: '919811100050', id: 'wamid.IMG', type: 'image', image: { id: 'm8', filename: 'not-a-document.jpg' } },
    ]))
    assert.deepEqual(rows.map(r => [r.kind, r.file, r.message]), [['document', 'Resume_Rahul.pdf', '[document]'], ['image', null, '[image]']])
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

describe('one chat per client', () => {
  test('messages from the same number are merged in order: first id and ad, every word, the other ids in keys', () => {
    const rows = chatRows(delivery([
      text('wamid.1', '919811100050', 'Hi'),
      text('wamid.2', '919811100052', 'Job?'),
      text('wamid.3', '919811100050', 'Need 20 chairs', { referral: { source_id: 'AD1', headline: 'Chairs' } }),
    ], [{ profile: { name: 'Grand Hotel' }, wa_id: '919811100050' }]))
    const chats = mergeByPhone(rows)
    assert.deepEqual(chats.map(c => c.phone), ['+919811100050', '+919811100052'])
    assert.equal(chats[0].rows.length, 2)
    assert.deepEqual(chats[0].row, {
      key: 'wamid.1', phone: '+919811100050', name: 'Grand Hotel', message: 'Hi\nNeed 20 chairs',
      ad_id: 'AD1', ad_headline: 'Chairs', ad_url: null, ctwa_clid: null, keys: ['wamid.3'],
    })
    // A single message has no keys, and what the database gets never carries the judge's two fields.
    assert.equal('keys' in chats[1].row, false)
    assert.equal('kind' in chats[1].row || 'file' in chats[1].row, false)
  })

  test('the merged words are cut to what the database takes', () => {
    const chats = mergeByPhone(chatRows(delivery([text('a', '919811100050', 'x'.repeat(3000)), text('b', '919811100050', 'y'.repeat(3000))])))
    assert.equal(chats[0].row.message?.length, 4000)
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

  test('a known lead is never judged; an ad is a lead without judging; past the per-delivery cap a chat is Check', () => {
    const post = code.slice(code.indexOf('export async function POST'))
    const known = post.indexOf('if (known?.known && !known.check) return c.row')
    const ad = post.indexOf('if (c.row.ad_id) verdict = FROM_AD')
    const cap = post.indexOf('else if (i >= MAX_JUDGED) verdict = FALLBACK')
    const judge = post.indexOf('judgeChat(')
    assert.ok(known !== -1 && ad !== -1 && cap !== -1 && judge !== -1)
    assert.ok(known < ad && ad < cap && cap < judge, 'the checks come before any judging')
    // The context is read before anything is judged, and a failure to read it asks Meta to try again.
    assert.ok(post.indexOf("rpc('sales_chat_context'") < judge)
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

describe('the judging migration (20270613000000)', () => {
  const sql = readFileSync(join(process.cwd(), 'supabase/migrations/20270613000000_sales_whatsapp_classify.sql'), 'utf8').replace(/\r\n/g, '\n')

  test('the capture and its context stay service role only; Filtered chats is for signed-in people, never anon', () => {
    for (const fn of ['capture_sales_chats(jsonb)', 'sales_chat_context(jsonb)']) {
      assert.ok(sql.includes(`revoke all on function public.${fn} from public, anon, authenticated;`), fn)
      assert.ok(sql.includes(`grant execute on function public.${fn} to service_role;`), fn)
    }
    for (const fn of ['list_whatsapp_held_chats()', 'make_whatsapp_chat_a_lead(uuid)', 'clear_whatsapp_held_chat(uuid)']) {
      assert.ok(sql.includes(`revoke all on function public.${fn} from public, anon;`), fn)
      assert.ok(sql.includes(`grant execute on function public.${fn} to authenticated;`), fn)
    }
    assert.ok(sql.includes('alter table public.sales_whatsapp_held enable row level security;'))
    assert.ok(sql.includes('revoke all on table public.sales_whatsapp_held from public, anon, authenticated;'))
  })

  test('each Filtered chats door asks for Sales assign', () => {
    for (const fn of ['list_whatsapp_held_chats', 'make_whatsapp_chat_a_lead', 'clear_whatsapp_held_chat']) {
      const body = sql.slice(sql.indexOf(`create function public.${fn}(`))
      const end = body.indexOf('$$;')
      assert.ok(body.slice(0, end).includes("public.sales_leads_require('assign')"), fn)
    }
  })

  test('sales_lead_row keeps every field 20270602000000 had, and adds the tag', () => {
    const fields = (src: string) => {
      const body = src.slice(src.indexOf('create or replace function public.sales_lead_row('))
      return [...body.slice(0, body.indexOf('$$;', body.indexOf('$$') + 2)).matchAll(/'([a-z_]+)', /g)].map(m => m[1])
    }
    const before = fields(readFileSync(join(process.cwd(), 'supabase/migrations/20270602000000_sales_auto_allot.sql'), 'utf8'))
    const after = fields(sql)
    assert.ok(before.length > 30)
    assert.deepEqual(after, [...before, 'wa_tag', 'wa_reason'])
  })

  test('a chat from an ad is a lead whatever the verdict, and a row without a verdict behaves as before', () => {
    assert.ok(sql.includes("if v_ad is not null then v_kind := 'lead'; end if;"))
    assert.ok(sql.includes("else 'lead' end;"))
    assert.ok(sql.includes('v_tag := case when v_verdict is null then null'))
  })
})
