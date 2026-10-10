import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { attachExtras, forgetCard, newCardPath, peekCard, stashCard, takeCard } from './cardPhotos'
import { EMAIL_PATTERN, emailOf, emptyLeadForm, validateLeadForm } from './validation'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r/g, '')
const sql = read('../../../supabase/migrations/20270308000000_exhibition_lead_email_and_card.sql')

const UID = '11111111-1111-4111-8111-111111111111'
const noSupabase = {} as never
const photo = () => new Blob(['jpeg'], { type: 'image/jpeg' })

describe('email on the form', () => {
  it('is optional, but must be an address when given', () => {
    const ok = { ...emptyLeadForm(), contactName: 'A', mobile: '9876543210', clientType: 'consultant' as const, requirements: ['hotel' as const], leadType: 'hot' as const }
    assert.equal(validateLeadForm(ok).email, undefined)
    assert.equal(validateLeadForm({ ...ok, email: 'asha@raostudio.in' }).email, undefined)
    for (const bad of ['asha', 'asha@', '@x.in', 'a b@x.in', 'a@x']) {
      assert.equal(validateLeadForm({ ...ok, email: bad }).email, 'Enter a valid email address', bad)
    }
  })
  it('is trimmed and lower-cased before it is sent, and matches the database pattern', () => {
    assert.equal(emailOf({ ...emptyLeadForm(), email: '  Asha@RaoStudio.IN ' }), 'asha@raostudio.in')
    assert.equal(emailOf({ ...emptyLeadForm() }), '')
    assert.ok(EMAIL_PATTERN.test('a@b.co'))
    assert.ok(sql.includes(String.raw`'^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'`))
  })
})

describe('the photograph waits in memory, not in the outbox', () => {
  it('is stashed under the entry id and handed back once', () => {
    const p = photo()
    stashCard('e1', p)
    assert.equal(peekCard('e1'), p)
    assert.equal(takeCard('e1'), p)
    assert.equal(peekCard('e1'), undefined)
  })
  it('gets a path the bucket policy and the column CHECK both accept', () => {
    const path = newCardPath(UID)
    assert.match(path, new RegExp(`^${UID}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.jpg$`))
  })
})

describe('attachExtras: after the lead exists', () => {
  const init = (over = {}) => ({ userId: UID, submissionId: 's1', leadId: 'L1', email: '', ...over })
  const upload = (calls: string[], failFirst = 0) => ({
    storage: { from: () => ({
      upload: async (path: string) => { calls.push(path); return calls.length <= failFirst ? { error: { message: 'offline' } } : { error: null } },
    }) },
  }) as never

  it('does nothing when there is neither an email nor a photo', async () => {
    const sent: unknown[] = []
    assert.deepEqual(await attachExtras(noSupabase, async c => { sent.push(c) }, init(), () => 0), { ok: true })
    assert.equal(sent.length, 0)
  })
  it('sends the email alone, without touching storage', async () => {
    const sent: unknown[] = []
    const r = await attachExtras(noSupabase, async c => { sent.push(c) }, init({ email: 'a@b.co' }), () => 0)
    assert.deepEqual(r, { ok: true })
    assert.deepEqual(sent, [{ email: 'a@b.co' }])
  })
  it('uploads once, then attaches the path with the email', async () => {
    stashCard('s1', photo())
    const sent: { card_photo_path?: string | null; email?: string | null }[] = []
    const uploads: string[] = []
    const r = await attachExtras(upload(uploads), async c => { sent.push(c) }, init({ email: 'a@b.co' }), () => 0)
    assert.deepEqual(r, { ok: true })
    assert.equal(uploads.length, 1)
    assert.equal(sent[0].card_photo_path, uploads[0])
    assert.equal(sent[0].email, 'a@b.co')
    assert.equal(peekCard('s1'), undefined, 'the bytes are released')
  })
  it('retries, never uploading the same photograph twice', async () => {
    stashCard('s1', photo())
    const uploads: string[] = []
    let sends = 0
    const r = await attachExtras(upload(uploads), async () => { if (++sends < 3) throw new Error('offline') }, init(), () => 0)
    assert.deepEqual(r, { ok: true })
    assert.equal(uploads.length, 1)
    assert.equal(sends, 3)
  })
  it('says what was lost after three failures, and lets go of the bytes', async () => {
    stashCard('s1', photo())
    const r = await attachExtras(upload([], 99), async () => {}, init({ email: 'a@b.co' }), () => 0)
    assert.deepEqual(r, { ok: false, missing: ['email', 'photo'] })
    assert.equal(peekCard('s1'), undefined)
    forgetCard('s1')
  })
})

describe('the migration', () => {
  it('is additive: create / update are not touched, and nothing is dropped from the lead table', () => {
    assert.ok(!/create or replace function public\.(create|update)_exhibition_lead\b/.test(sql))
    assert.ok(!/drop (table|column)/i.test(sql))
    assert.match(sql, /add column if not exists email text/)
    assert.match(sql, /add column if not exists card_photo_path text/)
  })
  it('keeps the bucket private, JPEG-only, and its reads as narrow as the lead', () => {
    assert.match(sql, /values \('exhibition-lead-cards', 'exhibition-lead-cards', false,/)
    assert.match(sql, /array\['image\/jpeg'\]/)
    assert.match(sql, /v_owner = v_uid\s+or exists \(select 1 from public\.users u where u\.id = v_uid and u\.role = 'admin'\)/)
  })
  it('lets a client upload only into its own folder, and delete only an unattached upload of its own', () => {
    assert.match(sql, /'\^' \|\| auth\.uid\(\)::text \|\| '\//)
    assert.match(sql, /owner_id = auth\.uid\(\)::text\s+and not exists \(select 1 from public\.exhibition_leads l where l\.card_photo_path = name\)/)
  })
  it('attaches through one definer function with the same actor rules as an edit', () => {
    const fn = sql.slice(sql.indexOf('create or replace function public.set_exhibition_lead_contact'))
    assert.match(fn, /security definer/)
    assert.match(fn, /exhibition_leads_actor\(\)/)
    assert.match(fn, /not \(v_admin or v_old\.owner_id = v_uid\)/)
    assert.match(fn, /EXHIBITION_LEADS_ARCHIVED/)
    assert.match(fn, /grant execute on function public\.set_exhibition_lead_contact\(uuid, jsonb\) to authenticated/)
    assert.match(fn, /revoke all on function public\.set_exhibition_lead_contact\(uuid, jsonb\) from public, anon/)
  })
  it('puts email and card_photo_path in the lead JSON and keeps that function private', () => {
    assert.match(sql, /'email', p_lead\.email,/)
    assert.match(sql, /'card_photo_path', p_lead\.card_photo_path,/)
    assert.match(sql, /revoke all on function public\.exhibition_lead_json\(uuid\) from public, anon, authenticated/)
  })
})

describe('the outbox attaches after Save has been answered', () => {
  const provider = read('../../components/exhibitionLeads/OutboxProvider.tsx')
  it('attaches only for a created / replayed lead, after the entry is marked saved', () => {
    const iSaved = provider.indexOf('patch(next.id, e => afterAnswer(e, res))')
    const iAttach = provider.indexOf('attachExtras(')
    assert.ok(iSaved > 0 && iAttach > iSaved)
    assert.match(provider, /if \(res\.lead_id\)/)
  })
  it('Save never awaits the photograph', () => {
    const add = read('../../components/exhibitionLeads/AddLeadScreen.tsx')
    const submit = add.slice(add.indexOf('function submit('), add.indexOf('function editEntry('))
    assert.doesNotMatch(submit, /await |uploadCard|attachExtras/)
    assert.match(submit, /stashCard\(id, photoRef\.current\)/)
  })
})
