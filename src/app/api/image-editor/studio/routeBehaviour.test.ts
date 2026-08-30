/**
 * The route, actually executed.
 *
 * `route.test.ts` beside this one reads the source for invariants a running
 * test cannot see. This one runs the handler end to end with `fetch` stubbed —
 * which covers BOTH Supabase (auth and the profile lookup are HTTP) and fal, so
 * no module mocking is needed and the real pipeline runs: prepare, Product
 * Shot, locate, gate, reframe, upscale, normalise, respond.
 *
 * WHAT IT IS FOR
 * --------------
 * The decision the live Irvine review changed. BOE photographs furniture
 * against textured concrete, so on most genuine uploads the structural
 * comparison cannot run at all. Those results must be DELIVERED and marked for
 * manual review — not refused. A confirmed failure must still be refused, and
 * must not pay for the upscale first.
 *
 * The three cases are driven by the FIXTURES, not by stubbing the gate: a
 * cluttered upload really does defeat the location step, and a filled-in fan
 * really does collapse the structure measurement. Stubbing the gate would test
 * the test.
 *
 * Run:
 *   npx tsx --test src/app/api/image-editor/studio/routeBehaviour.test.ts
 */

import { test, describe, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, writeFileSync, unlinkSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import sharp from 'sharp'
import { VERIFICATION_HEADER } from '@/lib/imageEditor/verification'
import { MASTER_WIDTH, MASTER_HEIGHT } from '@/lib/imageEditor/studioMaster'
import { REFERENCE_PATH, resetReferenceCache } from '@/lib/imageEditor/studioReference'

// The approved reference is licensed and deliberately not in git, so a checkout
// usually has no copy. The route refuses before any request without one — which
// is correct, and would make every test here a 503. A stand-in is written for
// the run and removed afterwards; a real one, if a developer has it, is left
// exactly where it is.
let borrowedReference = false

before(async () => {
  if (existsSync(REFERENCE_PATH)) return
  mkdirSync(dirname(REFERENCE_PATH), { recursive: true })
  writeFileSync(REFERENCE_PATH, await sharp({
    create: { width: 512, height: 512, channels: 3, background: { r: 200, g: 195, b: 188 } },
  }).png().toBuffer())
  borrowedReference = true
  resetReferenceCache()
})

after(() => {
  if (!borrowedReference) return
  unlinkSync(REFERENCE_PATH)
  resetReferenceCache()
})

const SUPABASE_URL = 'https://stub.supabase.co'
const realFetch = globalThis.fetch
const realEnv = { ...process.env }

// ─── Fixtures ─────────────────────────────────────────────────────────────────
//
// A chair with a fan of thin verticals under the seat, on either a plain studio
// sweep or a textured factory wall, with the fan optionally filled solid.

type Fixture = { size?: number; cluttered?: boolean; mergedFan?: boolean; product?: Bounds }
type Bounds = { left: number; top: number; width: number; height: number }

async function chair(o: Fixture = {}): Promise<Buffer> {
  const {
    size = 900, cluttered = false, mergedFan = false,
    product = { left: 250, top: 160, width: 380, height: 540 },
  } = o

  const d = Buffer.alloc(size * size * 3)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const o2 = (y * size + x) * 3
    const tone = cluttered
      ? 120 + ((x / 37 | 0) % 2 ? 14 : 0) + ((y / 53 | 0) % 2 ? 9 : 0)
      : 148 + (214 - 148) * (y / size)
    d[o2] = tone + 4; d[o2 + 1] = tone; d[o2 + 2] = tone - 6
  }

  const ink = (l: number, t: number, w: number, h: number, v = 80) => {
    for (let y = t; y < t + h; y++) for (let x = l; x < l + w; x++) {
      if (x < 0 || y < 0 || x >= size || y >= size) continue
      const o2 = (y * size + x) * 3
      d[o2] = v + 20; d[o2 + 1] = v; d[o2 + 2] = v - 15
    }
  }

  const { left, top, width, height } = product
  ink(left, top, width, Math.round(height * 0.36))
  ink(left, top + Math.round(height * 0.40), width, Math.round(height * 0.06))
  const fanTop = top + Math.round(height * 0.46)
  const fanH = Math.round(height * 0.42)
  if (mergedFan) ink(left, fanTop, width, fanH)
  else for (let i = 0; i < 16; i++) {
    ink(left + Math.round((i + 0.5) * width / 16) - 1, fanTop, 3, fanH)
  }
  ink(left, top + height - Math.round(height * 0.04), width, Math.round(height * 0.04))

  return sharp(d, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer()
}

// ─── The stub ─────────────────────────────────────────────────────────────────

type Call = { url: string; body: unknown; headers: Record<string, string> }

/**
 * Auth and the profile lookup, answered as a DIFFERENT user each time.
 *
 * The route rate-limits 6 requests a minute per user id. One id shared across a
 * suite means every test after the sixth is throttled rather than tested — a
 * failure that looks like a pipeline bug and is not.
 */
let userSeq = 0

/**
 * What the permission engine says for this test. Keyed by action, so a test can
 * store the dormant-child state (view false, create true) that Control Center
 * genuinely allows.
 */
let permissionGrants: Record<string, boolean> = { view: true, create: true }
let permissionRole: string | null = 'member'
/** Every resolve_permission action asked for, in order. */
let permissionCalls: string[] = []

function supabaseReply(url: string, init?: RequestInit): Response {
  // resolve_permission(p_user_id, p_module_key, p_action_key)
  if (url.includes('/rpc/resolve_permission')) {
    const body = JSON.parse(String(init?.body ?? '{}'))
    permissionCalls.push(String(body.p_action_key))
    return new Response(JSON.stringify(permissionGrants[String(body.p_action_key)] === true), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
  }
  const id = url.includes('/auth/') ? `user-${++userSeq}` : `user-${userSeq}`
  const json = url.includes('/auth/')
    ? { id, aud: 'authenticated', email: 'e@boe.test', app_metadata: {}, user_metadata: {}, created_at: '2020-01-01T00:00:00Z' }
    : { id, role: permissionRole }
  return new Response(JSON.stringify(json), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })
}

/** Everything sent to a provider, in order. Supabase traffic is not recorded —
 *  a provider call is the thing that costs money. */
let providerCalls: Call[] = []

function stubFetch(shotImage: Buffer, opts: { upscaleSide?: number } = {}) {
  providerCalls = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(typeof input === 'object' && 'url' in input ? input.url : input)

    if (url.startsWith(SUPABASE_URL)) return supabaseReply(url, init)

    const body = JSON.parse(String(init?.body ?? '{}'))
    providerCalls.push({
      url, body,
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
    })

    if (url.includes('product-shot')) {
      return new Response(JSON.stringify({
        images: [{ url: `data:image/png;base64,${shotImage.toString('base64')}`, content_type: 'image/png' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json', 'x-fal-request-id': 'shot-req' } })
    }

    // SeedVR2. The side is deliberately NOT 1440 by default, so the local
    // normalisation is exercised on every run rather than skipped.
    const src = Buffer.from(String(body.image_url).split(',')[1], 'base64')
    const side = opts.upscaleSide ?? 1456
    const up = await sharp(src).resize(side, side, { kernel: 'lanczos3' }).png().toBuffer()
    return new Response(JSON.stringify({
      image: { url: `data:image/png;base64,${up.toString('base64')}`, content_type: 'image/png' }, seed: 1,
    }), { status: 200, headers: { 'Content-Type': 'application/json', 'x-fal-request-id': 'up-req' } })
  }) as typeof globalThis.fetch
}

// ─── Driving the handler ──────────────────────────────────────────────────────

async function post(upload: Buffer) {
  const { POST } = await import('./route')
  const form = new FormData()
  form.append('image', new File([new Uint8Array(upload)], 'chair.png', { type: 'image/png' }))
  const req = new Request('http://localhost/api/image-editor/studio', {
    method: 'POST',
    headers: { authorization: 'Bearer stub-session-token' },
    body: form,
  })
  return POST(req as unknown as Parameters<typeof POST>[0])
}

beforeEach(() => {
  permissionGrants = { view: true, create: true }
  permissionRole = 'member'
  permissionCalls = []
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-service-key'
  process.env.FAL_KEY = 'stub-fal-key'
})
afterEach(() => {
  globalThis.fetch = realFetch
  process.env = { ...realEnv }
})

const bodyOf = (url: string) =>
  providerCalls.find(c => c.url.includes(url))?.body as Record<string, unknown> | undefined

// ═══ Inconclusive: the case the live review was about ═════════════════════════

describe('a textured factory background', () => {
  test('continues to SeedVR2 instead of being refused', async () => {
    // The whole point. BOE's real photographs look like this, and refusing them
    // would refuse the module on the strength of a check that never ran.
    stubFetch(await chair())
    const res = await post(await chair({ cluttered: true }))

    assert.equal(res.status, 200, 'a textured upload must not be refused')
    assert.equal(providerCalls.length, 2, 'both stages must run')
    assert.ok(providerCalls[1].url.includes('seedvr'), 'the second call is the upscale')
  })

  test('costs exactly two provider requests, never a third', async () => {
    stubFetch(await chair())
    await post(await chair({ cluttered: true }))
    assert.equal(providerCalls.length, 2)
    assert.equal(providerCalls.filter(c => c.url.includes('product-shot')).length, 1)
    assert.equal(providerCalls.filter(c => c.url.includes('seedvr')).length, 1)
  })

  test('returns 200 with a real PNG', async () => {
    stubFetch(await chair())
    const res = await post(await chair({ cluttered: true }))
    assert.equal(res.status, 200)

    const payload = await res.json()
    assert.equal(payload.image.mimeType, 'image/png')
    assert.match(payload.image.dataUrl, /^data:image\/png;base64,/)
    const png = Buffer.from(payload.image.dataUrl.split(',')[1], 'base64')
    assert.equal((await sharp(png).metadata()).format, 'png')
  })

  test('the delivered image is exactly 1440 x 1440', async () => {
    // The stub returns 1456, so this proves the local normalisation, not luck.
    stubFetch(await chair(), { upscaleSide: 1456 })
    const res = await post(await chair({ cluttered: true }))
    const payload = await res.json()
    const meta = await sharp(Buffer.from(payload.image.dataUrl.split(',')[1], 'base64')).metadata()
    assert.equal(meta.width, MASTER_WIDTH)
    assert.equal(meta.height, MASTER_HEIGHT)
    assert.equal(meta.width, 1440)
    assert.equal(meta.height, 1440)
  })

  test('the verification header says manual_review_required', async () => {
    stubFetch(await chair())
    const res = await post(await chair({ cluttered: true }))
    assert.equal(res.headers.get(VERIFICATION_HEADER), 'manual_review_required')
  })

  test('it is never described as verified or passed', async () => {
    stubFetch(await chair())
    const res = await post(await chair({ cluttered: true }))
    assert.notEqual(res.headers.get(VERIFICATION_HEADER), 'passed')
    const text = JSON.stringify(await res.json()).replace(/base64,[^"]*/g, 'base64,…')
    for (const word in { verified: 1, passed: 1, approved: 1 }) {
      assert.ok(!text.toLowerCase().includes(word), `the body claims "${word}"`)
    }
  })
})

// ═══ Confirmed failure ════════════════════════════════════════════════════════

describe('a confirmed structural failure', () => {
  /** A plain upload — so the comparison CAN run — against a shot whose fan came
   *  back as one solid block. This is the rejected result, reproduced. */
  const destroyed = async () => {
    stubFetch(await chair({ mergedFan: true }))
    return post(await chair())
  }

  test('returns 422', async () => {
    const res = await destroyed()
    assert.equal(res.status, 422)
  })

  test('SeedVR2 is never called — the failure is established first', async () => {
    // The cost control. Paying for an upscale of an image already known to be
    // wrong is money spent to produce a refusal.
    await destroyed()
    assert.equal(providerCalls.length, 1, 'only Product Shot should have been paid for')
    assert.ok(providerCalls[0].url.includes('product-shot'))
    assert.ok(!providerCalls.some(c => c.url.includes('seedvr')))
  })

  test('it carries noRetry and a preservation message', async () => {
    const res = await destroyed()
    const payload = await res.json()
    assert.equal(payload.noRetry, true)
    assert.match(payload.error, /preserve the product/i)
    assert.equal(payload.image, undefined, 'a refusal must not carry an image')
  })

  test('no verification header accompanies a refusal', async () => {
    const res = await destroyed()
    assert.equal(res.headers.get(VERIFICATION_HEADER), null)
  })
})

// ═══ Confirmed pass ═══════════════════════════════════════════════════════════

describe('a confirmed pass', () => {
  test('continues normally and is marked passed', async () => {
    stubFetch(await chair())
    const res = await post(await chair())

    assert.equal(res.status, 200)
    assert.equal(providerCalls.length, 2)
    assert.equal(res.headers.get(VERIFICATION_HEADER), 'passed')

    const payload = await res.json()
    const meta = await sharp(Buffer.from(payload.image.dataUrl.split(',')[1], 'base64')).metadata()
    assert.equal(meta.width, 1440)
    assert.equal(meta.height, 1440)
  })
})

// ═══ Nothing was added that costs money ═══════════════════════════════════════

describe('no retry was introduced', () => {
  test('a provider failure is answered once, not retried', async () => {
    let n = 0
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(typeof input === 'object' && 'url' in input ? input.url : input)
      if (url.startsWith(SUPABASE_URL)) return supabaseReply(url, init)
      n++
      return new Response('upstream detail', { status: 500 })
    }) as typeof globalThis.fetch

    const res = await post(await chair())
    assert.equal(n, 1, 'one failed provider call must stay one call')
    assert.ok(res.status >= 400)
  })

  test('a run that succeeds makes two calls, and a second run makes two more', async () => {
    // Proves the count is per-photograph, not a total that hides a retry.
    stubFetch(await chair())
    await post(await chair({ cluttered: true }))
    assert.equal(providerCalls.length, 2)
    stubFetch(await chair())
    await post(await chair({ cluttered: true }))
    assert.equal(providerCalls.length, 2)
  })
})

// ═══ Nothing about the provider reaches the browser ═══════════════════════════

describe('what the browser is told', () => {
  test('no provider detail, key or measurement is in the response', async () => {
    stubFetch(await chair())
    const res = await post(await chair({ cluttered: true }))
    const payload = await res.json()

    // The body's shape is fixed: the image and whether the service is set up.
    assert.deepEqual(Object.keys(payload).sort(), ['configured', 'image'])
    assert.deepEqual(Object.keys(payload.image).sort(), ['dataUrl', 'mimeType'])

    const text = JSON.stringify({ ...payload, image: { ...payload.image, dataUrl: '' } })
      + JSON.stringify([...res.headers.entries()])
    for (const secret of [
      'stub-fal-key', 'fal.run', 'fal-ai', 'bria', 'seedvr', 'product-shot',
      'ref_image_url', 'shot-req', 'up-req', 'stub-service-key', 'supabase',
    ]) {
      assert.ok(!text.toLowerCase().includes(secret.toLowerCase()), `"${secret}" reached the browser`)
    }
  })

  test('an upstream error body is never forwarded', async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(typeof input === 'object' && 'url' in input ? input.url : input)
      if (url.startsWith(SUPABASE_URL)) return supabaseReply(url, init)
      return new Response('SECRET-UPSTREAM-DIAGNOSTIC', { status: 500 })
    }) as typeof globalThis.fetch

    const res = await post(await chair())
    const text = JSON.stringify(await res.json())
    assert.ok(!text.includes('SECRET-UPSTREAM-DIAGNOSTIC'))
  })

  test('the key travels in a header to fal and nowhere else', async () => {
    stubFetch(await chair())
    await post(await chair({ cluttered: true }))
    for (const call of providerCalls) {
      assert.equal(call.headers.Authorization, 'Key stub-fal-key')
      assert.ok(!call.url.includes('stub-fal-key'))
    }
  })
})

// ═══ The reviewed requests are unchanged ══════════════════════════════════════
//
// The live Irvine result was accepted with these exact bodies. This correction
// was to the DECISION made about a result, not to what is asked for — so any
// change to either body is a change to something already approved.

describe('the request bodies are byte-for-byte the reviewed ones', () => {
  test('Product Shot is unchanged', async () => {
    stubFetch(await chair())
    await post(await chair({ cluttered: true }))
    const body = bodyOf('product-shot')!

    assert.deepEqual(Object.keys(body).sort(), [
      'fast', 'image_url', 'manual_placement_selection', 'num_results',
      'optimize_description', 'placement_type', 'ref_image_url', 'shot_size',
    ])
    assert.equal(body.fast, true)
    assert.equal(body.num_results, 1)
    assert.equal(body.optimize_description, false)
    assert.equal(body.placement_type, 'manual_placement')
    assert.equal(body.manual_placement_selection, 'bottom_center')
    assert.deepEqual(body.shot_size, [1000, 1000])
    assert.match(String(body.image_url), /^data:image\/\w+;base64,/)
    assert.match(String(body.ref_image_url), /^data:image\/\w+;base64,/)
    // The two that must never come back.
    assert.equal('scene_description' in body, false)
    assert.equal('sync_mode' in body, false)
  })

  test('SeedVR2 is unchanged', async () => {
    stubFetch(await chair())
    await post(await chair({ cluttered: true }))
    const body = bodyOf('seedvr')!

    assert.deepEqual(Object.keys(body).sort(), [
      'image_url', 'noise_scale', 'output_format', 'upscale_factor', 'upscale_mode',
    ])
    assert.equal(body.noise_scale, 0)
    assert.equal(body.output_format, 'png')
    assert.equal(body.upscale_mode, 'factor')
    assert.ok(Number(body.upscale_factor) >= 1)
    assert.equal('sync_mode' in body, false)
    assert.equal('target_resolution' in body, false)
  })

  test('the reference image is sent, and it is not the photograph', async () => {
    stubFetch(await chair())
    await post(await chair({ cluttered: true }))
    const body = bodyOf('product-shot')!
    assert.notEqual(body.ref_image_url, body.image_url,
      'the reference must be the approved studio image, not the upload')
  })
})

// ═══ Permission, and the state that must not leak ═════════════════════════════
//
// Generating costs two billable provider requests, so the grant is resolved
// before the upload is read, before the studio reference is loaded, and before
// any provider call. These tests execute the real route and count what it did.

describe('permission enforcement', () => {
  /** Run one POST under a stored permission state. */
  async function attempt(grants: Record<string, boolean>, role = 'member') {
    stubFetch(await chair())
    permissionGrants = grants
    permissionRole = role
    const res = await post(await chair({ cluttered: true }))
    return { res, providerCalls: [...providerCalls], asked: [...permissionCalls] }
  }

  test('View + Use generates normally', async () => {
    const { res, providerCalls: calls } = await attempt({ view: true, create: true })
    assert.equal(res.status, 200)
    assert.equal(calls.length, 2)
  })

  test('View only is refused with 403, and spends nothing', async () => {
    const { res, providerCalls: calls } = await attempt({ view: true, create: false })
    assert.equal(res.status, 403)
    assert.equal(calls.length, 0, 'a refusal must not reach a provider')
    const payload = await res.json()
    assert.match(payload.error, /permission to generate/i)
    assert.equal(payload.noRetry, true, 'pressing again cannot grant permission')
  })

  test('neither grant is refused with 403', async () => {
    const { res, providerCalls: calls } = await attempt({ view: false, create: false })
    assert.equal(res.status, 403)
    assert.equal(calls.length, 0)
  })

  test('Use stored WITHOUT View is refused — the dormant-child state', async () => {
    // Control Center allows this pair to be stored. The Image Editor has no
    // tables, so no RESTRICTIVE policy applies it and resolve_permission returns
    // `create` = true on its own. The route must still refuse.
    const { res, providerCalls: calls, asked } = await attempt({ view: false, create: true })
    assert.equal(res.status, 403)
    assert.equal(calls.length, 0, 'the dormant-child state must not spend money')
    assert.ok(asked.includes('view'), 'the route must resolve `view`, not only `create`')
  })

  test('BOTH actions are resolved, never `create` alone', async () => {
    const { asked } = await attempt({ view: true, create: true })
    assert.ok(asked.includes('view'))
    assert.ok(asked.includes('create'))
  })

  test('the refusal happens BEFORE the upload is read', async () => {
    // Proved from the source: a body read after the refusal would still be a
    // body read. The 403 must precede formData().
    const SOURCE = readFileSync(
      join(process.cwd(), 'src/app/api/image-editor/studio/route.ts'), 'utf8')
    const guard = SOURCE.indexOf('canGenerate(svc')
    assert.ok(guard > -1, 'the guard must exist')
    for (const later of ['req.formData()', 'loadStudioReference', 'generateProductShot(', 'upscaleImage(']) {
      const at = SOURCE.indexOf(later)
      if (at === -1) continue
      assert.ok(guard < at, `the permission check must precede ${later}`)
    }
  })

  test('an admin generates without any grant row', async () => {
    const { res, providerCalls: calls } = await attempt({ view: false, create: false }, 'admin')
    assert.equal(res.status, 200)
    assert.equal(calls.length, 2)
  })

  test('a missing role is refused, not treated as an ordinary employee', async () => {
    const { res, providerCalls: calls } = await attempt({ view: true, create: true }, null as unknown as string)
    assert.equal(res.status, 403)
    assert.equal(calls.length, 0)
  })

  test('the refusal names no provider, module key or action', async () => {
    const { res } = await attempt({ view: true, create: false })
    const text = JSON.stringify(await res.json())
    for (const leak of ['fal', 'bria', 'seedvr', 'image_editor', 'resolve_permission', 'create']) {
      assert.ok(!text.toLowerCase().includes(leak.toLowerCase()), `"${leak}" reached the browser`)
    }
  })
})
