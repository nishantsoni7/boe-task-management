// The logo mark is optional per quotation, on by default (owner, 18 Nov 2026).
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { pictureRequestProblem } from './pictureStore'
import { pictureSrc } from './api'

const read = (p: string) => readFileSync(p, 'utf8')
const ME = '0370f30b-d0b8-43d1-999a-e2f6487e8213'
const FILE = '8c2d5b6e-1d3a-4f6b-9a77-2b1c9d0e4f11'
const PATH = `${ME}/${FILE}.jpg`
const TOKEN = 'a'.repeat(32)
// pictureSrc only reads the bucket's public address from the client it is handed
const fakeClient = { storage: { from: () => ({ getPublicUrl: (p: string) => ({ data: { publicUrl: `https://pics.example/${p}` } }) }) } } as never

describe('pictureRequestProblem', () => {
  test('a client token or a quotation id, exactly one, with a real picture path', () => {
    assert.equal(pictureRequestProblem(PATH, TOKEN, null), null)
    assert.equal(pictureRequestProblem(PATH, null, ME), null)
    assert.match(pictureRequestProblem(PATH, TOKEN, ME) ?? '', /not both/)
    assert.match(pictureRequestProblem(PATH, null, null) ?? '', /not neither/)
    assert.match(pictureRequestProblem('../x.jpg', TOKEN, null) ?? '', /not valid/)
    assert.match(pictureRequestProblem(PATH, 'short', null) ?? '', /link/)
    assert.match(pictureRequestProblem(PATH, null, 'not-a-uuid') ?? '', /quotation id/)
  })
})

describe('pictureSrc', () => {
  test('staff see the marked public copy while the mark is on (or not yet known)', () => {
    assert.equal(pictureSrc(fakeClient, PATH), `https://pics.example/${PATH}`)
    assert.equal(pictureSrc(fakeClient, PATH, { markOn: true, quotationId: ME }), `https://pics.example/${PATH}`)
    assert.equal(pictureSrc(fakeClient, PATH, { markOn: undefined, quotationId: ME }), `https://pics.example/${PATH}`)
  })
  test('with the mark off, staff go through the server route, signed in', () => {
    assert.equal(pictureSrc(fakeClient, PATH, { markOn: false, quotationId: ME }), `/api/quotations/picture-file?path=${encodeURIComponent(PATH)}&q=${ME}`)
  })
  test('the client link always goes through the server route with its token', () => {
    assert.equal(pictureSrc(fakeClient, PATH, { token: TOKEN }), `/api/quotations/picture-file?path=${encodeURIComponent(PATH)}&t=${TOKEN}`)
  })
})

describe('the switch', () => {
  const route = read('src/app/api/quotations/picture-file/route.ts')
  const builder = read('src/components/quotations/BuilderScreen.tsx')
  const screens = read('src/components/quotations/DocumentScreens.tsx')
  const sql = read('supabase/migrations/20270806000200_quotation_picture_mark_switch.sql')
  test('on by default: no row means on, in the function and in the route', () => {
    assert.ok(sql.includes('coalesce((select m.enabled from public.quotation_picture_marks m where m.quotation_id = p_id), true)'))
    assert.ok(route.includes('markOn = m ? !!m.enabled : true'))
  })
  test('on redirects to the public marked copy; off returns the clean original only for a picture the quotation uses', () => {
    assert.ok(route.includes('NextResponse.redirect(`${base}/storage/v1/object/public/quotation-images/${path}`, 302)'))
    assert.ok(route.indexOf('quotation_lines') < route.indexOf('download(path as string)'))
    assert.ok(route.includes(".contains('doc', { lines: [{ image_path: path }] })"))
    assert.ok(route.includes("'Cache-Control': 'private, max-age=300'"))
  })
  test('a link that is not shared, or an archived quotation, gets nothing', () => {
    assert.ok(route.includes(".eq('share_token', token).neq('status', 'archived')"))
  })
  test('only people who may edit the quotation can switch it; the table is closed to client roles', () => {
    assert.ok(sql.includes('public.quotation_may_edit('))
    assert.ok(sql.includes("revoke all on table public.quotation_picture_marks from public, anon, authenticated;"))
    assert.ok(sql.includes("raise exception 'QUOTATION_LOCKED: an archived quotation cannot be changed'"))
    assert.ok(!/alter table public\.quotations\b/i.test(sql), 'no existing table changes')
  })
  test('the builder has the switch in the share card; the print and the client link follow it', () => {
    const card = read('src/components/quotations/ShareCard.tsx')
    assert.ok(card.includes('id="q-mark"') && card.includes('role="switch"'))
    assert.ok(card.includes("disabled={busy || !base.may_edit || base.status === 'archived'"))
    assert.ok(builder.includes('setPictureMark(supabase, id, on)') && builder.includes('markOn={markQ.data}'))
    assert.ok(!builder.includes('pictureUrl('), 'the builder asks pictureSrc, not the public bucket directly')
    assert.ok(screens.includes("pictureSrc(supabase, path, { markOn: mq.data !== false, quotationId: id })"))
    assert.ok(screens.includes('pictureSrc(supabase, path, { token })'))
  })
})
