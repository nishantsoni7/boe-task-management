// POST /api/image-editor/studio
//
// Takes one factory-background furniture photograph and returns one square
// studio master. Backs /image-editor and nothing else.
//
// AUTH / STORAGE
// --------------
// A bearer token resolved server-side and confirmed against the `users` table.
//
// The UPLOAD is never stored: it is read into memory, sent to the provider, and
// dropped. The GENERATED MASTER is stored, in the private per-user history added
// by 20261022000000 — one PNG object plus one row, visible only to the employee
// who made it, deleted after seven days unless they mark it Keep.
//
// That storage is BEST EFFORT and is the last thing this route does. By the time
// it runs, two provider requests have been paid for and a finished image is in
// hand; a storage failure must never turn that into a failed generation. So it
// cannot throw, it cannot change a status code, and the response carries
// `historySaved: false` so the page can warn the employee to download now. The
// picture is delivered either way.
//
// HOW THE IMAGE IS MADE
// ---------------------
// TWO provider calls:
//
//   [1] fal-ai/bria/product-shot   the studio photograph. The ORIGINAL upload
//                                  is the main image and the approved studio
//                                  photograph is the reference. No scene
//                                  description — the reference drives the scene.
//   local                          find the product by STRUCTURE, check it
//                                  against the upload, crop the square so the
//                                  product fills 53% of it.
//   [2] fal-ai/seedvr/upscale/image  resolution only, to a 1440 master.
//   local                          check it again, then encode.
//
// WHAT THIS ARCHITECTURE TRADES
// -----------------------------
// The scene is the accepted one — the sweep, the light and the shadows come
// from the model that produced the result BOE approved, which local
// composition could not match.
//
// The cost is that PIXEL IDENTITY IS NOT AVAILABLE. Both stages are generative
// and neither has a pass-through mode. So the product is not trusted, it is
// CHECKED: preservationGate.ts measures the uploaded photograph and the
// generated one and refuses anything that lost its structure. That is a guard
// against obvious destruction, not a proof of fidelity, and it cannot be made
// into one without a segmentation mask that would cost a third billable
// request.
//
// WHAT IS BEING TESTED HERE
// -------------------------
// The rejected application pipeline was `background removal -> prepared CUT-OUT
// -> Product Shot`, and its result merged the fan of thin spindles under the
// Irvine chair's seat into an opaque block. The accepted direct playground run
// was `ORIGINAL photograph -> Product Shot with ref_image_url`, which is what
// this route now sends. Whether feeding the whole photograph preserves the
// chair better than feeding a cut-out did is the open question this experiment
// exists to answer, and it is unanswered until a real run is compared.
//
// COST
// ----
// One call of this route is TWO billable requests. A queue of five is ten,
// made one after another by the browser — nothing here batches or loops.
// Neither adapter retries, including after a timeout: a request that may
// already have been billed is not quietly billed again.
//
// THE API KEY
// -----------
// FAL_KEY, read here and passed to both adapters. Never in a response body,
// never in a client bundle, never in a provider URL.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { hasPermission } from '@/lib/permissions/resolver'
import { isAdminRole } from '@/lib/permissions/moduleVisibility'
import { IMAGE_EDITOR_MODULE_KEY } from '@/lib/permissions/imageEditor'
import { NextRequest, NextResponse } from 'next/server'
import {
  validateSourceImage,
  MAX_SOURCE_IMAGE_BYTES,
  MAX_SOURCE_IMAGE_LABEL,
} from '@/lib/imageEditor/validation'
import { prepareSourceImage } from '@/lib/imageEditor/prepareSource'
import { generateProductShot, isNoRetry, type ProductShotFailure } from '@/lib/imageEditor/briaProductShot'
import { upscaleImage, normaliseSquare, NO_RETRY_FAILURES } from '@/lib/imageEditor/seedvrUpscale'
import {
  VERIFICATION_HEADER, type VerificationStatus,
} from '@/lib/imageEditor/verification'
import { findProduct, planReframe, reframe } from '@/lib/imageEditor/generatedProduct'
import {
  profile as measureProfile, comparePreservation, checkFraming,
  PRESERVATION_REFUSAL, INCONCLUSIVE_MESSAGE,
} from '@/lib/imageEditor/preservationGate'
import {
  MASTER_SIDE, PRODUCT_HEIGHT_SHARE,
  PRODUCT_HEIGHT_MIN, PRODUCT_HEIGHT_MAX, SIDE_MARGIN_SHARE, ABOVE_SHARE_OF_LEFTOVER,
} from '@/lib/imageEditor/studioMaster'
import { saveResult } from '@/lib/imageEditor/history'
import { enhanceShadows } from '@/lib/imageEditor/shadowLift'
import { HISTORY_BUCKET } from '@/lib/imageEditor/retention'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'

// sharp is a native module and the whole image is held in memory. Neither works
// on the edge runtime.
export const runtime = 'nodejs'

export const maxDuration = 60

// ─── The time budget ──────────────────────────────────────────────────────────
//
// Two provider calls and some local work share one request:
//
//   local work         4s   prepare, measure, reframe, check, encode
//   product shot      22s   the studio photograph
//   hosted download    6s   sync_mode is not sent, so a URL comes back
//   upscale           20s   SeedVR2 to 1440
//   hosted download    6s
//                    ────
//                      58s ... which does NOT fit a 60s ceiling with any
//                      margin, so the deadline below is what actually holds it:
//                      every timeout is clamped to what is left, and a stage
//                      with no time returns without spending a request.
//
// This is tight. Two generative calls in one HTTP request is the real cost of
// the accepted architecture, and if the live runs overrun, the fix is a longer
// maxDuration on a plan that allows one — not a shorter upscale.

const ROUTE_BUDGET_MS = 56_000
const LOCAL_WORK_MS = 4_000
const PRODUCT_SHOT_TIMEOUT_MS = 24_000
const UPSCALE_TIMEOUT_MS = 22_000

// ─── Rate limiting ────────────────────────────────────────────────────────────
//
// Per user, in memory, same shape and the same reasoning as /api/payroll/ask:
// this is a spend guard on a route that costs money per call, not a security
// control.
//
// Six is deliberately left where it was even though a call now costs two
// requests: it is exactly the five-image queue plus one, so the ceiling still
// admits the largest run the page can start, and the real guard on spend is
// that a person has to press Generate.

const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 6

const recentCalls = new Map<string, number[]>()

function rateLimited(userId: string): boolean {
  const now = Date.now()
  const recent = (recentCalls.get(userId) ?? []).filter(t => now - t < RATE_LIMIT_WINDOW_MS)

  if (recent.length >= RATE_LIMIT_MAX) {
    recentCalls.set(userId, recent)
    return true
  }

  recent.push(now)
  recentCalls.set(userId, recent)

  if (recentCalls.size > 500) {
    for (const [id, times] of recentCalls) {
      if (times.every(t => now - t >= RATE_LIMIT_WINDOW_MS)) recentCalls.delete(id)
    }
  }
  return false
}

// ─── Failure → status ─────────────────────────────────────────────────────────
//
// The distinctions the page cannot make for itself. A refused key and a busy
// provider both mean "no image", but one of them is worth retrying and the
// other needs an administrator, and the status code is how that reaches any
// future caller as well as the browser.

function statusFor(reason: ProductShotFailure): number {
  switch (reason) {
    case 'timeout':             return 504
    case 'rate_limited':        return 429
    case 'unsupported_image':
    case 'moderation':
    case 'empty_result':        return 422
    case 'invalid_key':
    case 'insufficient_credit':
    case 'reference_missing':   return 503
    default:                    return 502
  }
}

// ─── Permission ───────────────────────────────────────────────────────────────

/** Said to somebody who may open the module but not generate in it. */
const GENERATION_FORBIDDEN =
  'You do not have permission to generate studio images. Ask an administrator for access.'

/**
 * Whether this caller may spend two provider requests.
 *
 * Admins bypass the engine, matching every other cut-over module. Everyone else
 * needs BOTH grants — see the note at the call site for why 'create' alone is
 * not enough here.
 */
async function canGenerate(
  svc: SupabaseClient,
  userId: string,
  role: string | null | undefined,
): Promise<boolean> {
  if (isAdminRole(role)) return true
  if (!role) return false
  const [view, create] = await Promise.all([
    hasPermission(svc, userId, IMAGE_EDITOR_MODULE_KEY, 'view'),
    hasPermission(svc, userId, IMAGE_EDITOR_MODULE_KEY, 'create'),
  ])
  return view && create
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // Anchored before anything else, so reading a large upload counts against the
  // budget rather than quietly eating into the provider's share. The local work
  // is subtracted rather than hoped for: what is reserved here is the time
  // still needed AFTER the last provider call to encode the master and answer.
  const deadlineAt = Date.now() + ROUTE_BUDGET_MS - LOCAL_WORK_MS

  const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '').trim()
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const svc = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const { data: { user }, error: authErr } = await svc.auth.getUser(token)
  if (authErr || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await svc.from('users').select('id, role').eq('id', user.id).single()
  if (!profile) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // ── Permission, before anything that costs ──────────────────────────────────
  //
  // Generating costs TWO billable provider requests, so the grant is checked
  // here — before the upload is read, before the studio reference is loaded,
  // and before any provider call. A 403 from this route has spent nothing.
  //
  // BOTH actions, not just 'create'. Control Center lets an administrator leave
  // 'create' stored while 'view' is off, and that dormant-child state must
  // grant nothing. Every module before this one inherits that gate from
  // RESTRICTIVE row-level security (module_entry_open, 20260905000000), but the
  // Image Editor has no tables for a policy to attach to, and
  // resolve_permission() returns the raw value for the action it is asked
  // about. So the gate is applied here, explicitly.
  if (!(await canGenerate(svc, user.id, profile.role))) {
    return NextResponse.json({ error: GENERATION_FORBIDDEN, noRetry: true }, { status: 403 })
  }

  const apiKey = process.env.FAL_KEY
  // Answered before the upload is read: with no key there is nothing this route
  // can do with the bytes, and the page needs to say so honestly.
  if (!apiKey) return NextResponse.json({ configured: false }, { status: 200 })

  if (rateLimited(user.id)) {
    return NextResponse.json(
      { error: 'That is a lot of images at once. Please wait a moment and try again.' },
      { status: 429 },
    )
  }

  let file: File
  try {
    const form = await req.formData()
    const uploaded = form.get('image')
    if (!uploaded || typeof uploaded === 'string') {
      return NextResponse.json({ error: 'Choose a photograph to upload.' }, { status: 400 })
    }
    file = uploaded as File
  } catch {
    return NextResponse.json({ error: 'Failed to read the uploaded photograph.' }, { status: 400 })
  }

  // The same check the browser ran, run again here. The client-side one saves a
  // pointless upload; this one is the one that counts.
  const validation = validateSourceImage({ name: file.name, type: file.type, size: file.size })
  if (!validation.ok) return NextResponse.json({ error: validation.error }, { status: 400 })

  const bytes = Buffer.from(await file.arrayBuffer())
  // `file.size` is what the multipart part claimed. This is what actually
  // arrived, and it is what the size limit is enforced against.
  if (bytes.byteLength === 0) {
    return NextResponse.json({ error: 'That file is empty. Choose another photograph.' }, { status: 400 })
  }
  if (bytes.byteLength > MAX_SOURCE_IMAGE_BYTES) {
    return NextResponse.json({ error: `That photograph is larger than ${MAX_SOURCE_IMAGE_LABEL}. Upload a smaller file.` }, { status: 400 })
  }

  // ── Everything below touches sharp ──────────────────────────────────────────
  //
  // Guarded so a decode or encode failure becomes a JSON refusal rather than an
  // opaque 500. Without this the browser gets a non-JSON error page, the page's
  // `payload?.error` is undefined, and an employee is told only "The studio
  // image could not be generated" — which is what happened on the first
  // production run and is why it took a log to diagnose.
  //
  // WHAT THIS CANNOT CATCH: sharp failing to LOAD. `import sharp` runs when
  // this module is first required, before any handler exists, so a missing
  // native library kills the function itself and nothing here executes. That
  // failure is fixed in next.config.ts, not caught here.
  try {
    const prepared = await prepareSourceImage(bytes, validation.mimeType)
    if (!prepared.ok) return NextResponse.json({ error: prepared.error }, { status: 400 })

    // ── Ground truth, measured before anything is generated ─────────────────────
    // The uploaded photograph is what the result will be checked against, and it
    // costs nothing because it is already here.
    const originalProfile = await measureProfile(prepared.bytes)

    // ── [1] Product Shot ────────────────────────────────────────────────────────
    const shot = await generateProductShot({
      photograph: prepared.bytes,
      mimeType: prepared.mimeType,
      apiKey,
      timeoutMs: PRODUCT_SHOT_TIMEOUT_MS,
      deadlineAt,
    })

    if (!shot.ok) {
      console.error(
        '[image-editor/studio] product shot failed:',
        `category ${shot.reason}`, `phase ${shot.phase ?? '-'}`,
        `status ${shot.status ?? '-'}`, `request ${shot.requestId || '-'}`,
        `${shot.durationMs} ms`, shot.detail ?? '',
      )
      return NextResponse.json(
        { error: shot.message, ...(isNoRetry(shot.reason) ? { noRetry: true } : {}) },
        { status: statusFor(shot.reason) },
      )
    }

    // ── Local: find the product by structure, and check it ──────────────────────
    const shotFound = await findProduct(shot.image)
    if (!shotFound) {
      console.warn('[image-editor/studio] no product found in the generated image, request', shot.requestId || '-')
      return NextResponse.json({ error: PRESERVATION_REFUSAL, noRetry: false }, { status: 422 })
    }

    // ── What the gate can establish, and what it cannot ─────────────────────────
    //
    // Three outcomes, and the difference between the second and the third is the
    // whole point:
    //
    //   CONFIRMED FAILURE   a check ran and failed. Refuse, and refuse HERE so
    //                       the second billable request is never made.
    //   INCONCLUSIVE        the comparison could not run, because the upload's
    //                       own background defeated it. Continue, deliver, and
    //                       say plainly that nobody verified it.
    //   PASSED              compared, and the structure survived.
    //
    // Inconclusive used to be refused. That was wrong for this module's real
    // traffic: BOE photographs furniture against textured concrete, so the
    // located bounds fill the frame and the upload cannot be ground truth — on
    // most genuine uploads, including ones where the product came back perfectly.
    // Refusing them would refuse the module on the strength of a check that never
    // ran. The rule that survives is the one that matters: an unverified image is
    // never presented as a verified one.
    let verification: VerificationStatus = 'manual_review_required'

    const shotProfile = await measureProfile(shot.image)
    if (originalProfile && shotProfile) {
      const report = comparePreservation(originalProfile, shotProfile, 'after product shot')
      console.info('[image-editor/studio] preservation', report.summary)

      // A failed check is a failed check whether or not other checks were
      // skipped: everything in `checks` was measured on the generated image and
      // reached a verdict. Only the comparison against the upload can be missing.
      if (!report.ok) {
        return NextResponse.json({ error: PRESERVATION_REFUSAL, noRetry: true }, { status: 422 })
      }
      if (report.inconclusive) {
        console.warn('[image-editor/studio]', INCONCLUSIVE_MESSAGE, `request ${shot.requestId || '-'}`)
        verification = 'manual_review_required'
      } else {
        verification = 'passed'
      }
    } else {
      console.warn('[image-editor/studio] preservation unmeasurable, request', shot.requestId || '-')
      verification = 'manual_review_required'
    }

    // ── Local: reframe to the approved composition ──────────────────────────────
    const shotMeta = await sharp(shot.image).metadata()
    const plan = planReframe(
      shotFound.bounds,
      { width: shotMeta.width ?? 0, height: shotMeta.height ?? 0 },
      {
        heightShare: PRODUCT_HEIGHT_SHARE,
        aboveSplit: ABOVE_SHARE_OF_LEFTOVER,
        maxWidthShare: 1 - 2 * SIDE_MARGIN_SHARE,
      },
    )
    const reframed = await reframe(shot.image, plan)

    // ── [2] SeedVR2, for resolution only ────────────────────────────────────────
    const upscaled = await upscaleImage({
      image: reframed,
      mimeType: 'image/png',
      sourceSide: plan.crop.size,
      targetSide: MASTER_SIDE,
      apiKey,
      timeoutMs: UPSCALE_TIMEOUT_MS,
      deadlineAt,
    })

    if (!upscaled.ok) {
      console.error(
        '[image-editor/studio] upscale failed:',
        `category ${upscaled.reason}`, `phase ${upscaled.phase ?? '-'}`,
        `status ${upscaled.status ?? '-'}`, `request ${upscaled.requestId || '-'}`,
        `${upscaled.durationMs} ms`,
      )
      return NextResponse.json(
        { error: upscaled.message, ...(NO_RETRY_FAILURES.has(upscaled.reason) ? { noRetry: true } : {}) },
        { status: statusFor(upscaled.reason) },
      )
    }

    // ── Local: check again, then make it exactly the master size ────────────────
    const finalProfile = await measureProfile(upscaled.image)
    if (originalProfile && finalProfile) {
      const report = comparePreservation(originalProfile, finalProfile, 'after upscale')
      const framing = checkFraming(finalProfile, { min: PRODUCT_HEIGHT_MIN, max: PRODUCT_HEIGHT_MAX }, plan.widthLimited)
      console.info('[image-editor/studio] preservation', report.summary, `; framing ${framing.ok ? 'ok' : 'FAILED'} [${framing.detail}]`)
      if (!report.ok) {
        return NextResponse.json({ error: PRESERVATION_REFUSAL, noRetry: true }, { status: 422 })
      }
      // The verdict can only get weaker across the two stages, never stronger: a
      // stage that could not compare leaves the whole result unverified.
      if (report.inconclusive) {
        console.warn('[image-editor/studio]', INCONCLUSIVE_MESSAGE, `request ${upscaled.requestId || '-'}`)
        verification = 'manual_review_required'
      }
    } else {
      console.warn('[image-editor/studio] preservation unmeasurable, request', upscaled.requestId || '-')
      verification = 'manual_review_required'
    }

    // What SeedVR2 returned is inspected, not assumed: the factor's accepted
    // range is undocumented and nothing promises the model rounds as we would.
    // A non-square result is refused rather than squeezed.
    const normalised = await normaliseSquare(upscaled.image, MASTER_SIDE)
    if (!normalised.ok) {
      console.error('[image-editor/studio] upscale returned an unusable image:',
        normalised.returned ? `${normalised.returned.width}x${normalised.returned.height}` : 'unreadable',
        `request ${upscaled.requestId || '-'}`)
      return NextResponse.json({ error: normalised.error }, { status: 422 })
    }
    const normalisedMaster = normalised.image

    // ── Local: the dark-product correction ──────────────────────────────────────
    //
    // The LAST pixel operation, after the size is settled and after the
    // preservation gate above has already passed on the upscaled image. It is
    // cosmetic and it is optional: `enhanceShadows` never throws, validates its
    // own output, and returns the UNMODIFIED master on any doubt — a shadow
    // curve must never turn two paid provider requests into a lost result.
    //
    // The gate is deliberately NOT moved down here. A point operation fixes
    // GEOMETRY but not the answer a THRESHOLD gives: measured on a production
    // master, the correction moves `structureUnderseat` 17.06 -> 16.89 and
    // pushes 0.11% of pixels across the gate's Sobel threshold. Re-pointing the
    // gate at these bytes would therefore silently re-baseline the accepted
    // pass / manual-review / refuse classifications.
    //
    // What covers the delivered pixels instead is enhanceShadows' own
    // validation: per pixel during the pass — nothing at or above the knee
    // touched, pure black held, no unclipped channel driven to 255, no channel
    // moved past a derived bound — and after the encode, a byte-for-byte
    // comparison of the decoded PNG against what was computed, with its width,
    // height and channel count. That is a check on THIS step, not a re-run of a
    // check about the provider.
    const enhanced = await enhanceShadows(normalisedMaster)
    if (!enhanced.applied) {
      console.warn('[image-editor/studio] shadow lift not applied:', enhanced.reason ?? 'unknown')
    }
    // Everything downstream — history and the response — uses this one buffer,
    // so what an employee downloads and what their history holds cannot differ.
    const master = enhanced.image

    console.info(
      '[image-editor/studio] ok:',
      `shot ${shot.requestId || '-'} ${shot.durationMs} ms`,
      `upscale ${upscaled.requestId || '-'} ${upscaled.durationMs} ms factor ${upscaled.factor}x`,
      `product ${shotFound.bounds.width}x${shotFound.bounds.height}`,
      `crop ${plan.crop.size} at ${plan.crop.left},${plan.crop.top}`,
      `share ${(plan.productHeightShare * 100).toFixed(1)}%`,
      `seedvr returned ${normalised.returned.width}x${normalised.returned.height}`,
      `delivered ${normalised.delivered.width}x${normalised.delivered.height}`,
      normalised.resized ? 'normalised locally' : 'exact from the model',
      enhanced.applied
        ? `shadow lift on ${enhanced.changedPixels} px, max ${enhanced.maxChange}, ${enhanced.durationMs} ms`
        : `shadow lift skipped (${enhanced.reason ?? 'unknown'})`,
      plan.widthLimited ? 'width-limited' : '',
      plan.clamped ? 'crop clamped to canvas' : '',
      `verification ${verification}`,
    )

    // ── History, and only now ───────────────────────────────────────────────────
    //
    // The LAST thing, deliberately. Everything above has already happened and
    // been paid for; this either adds a copy the employee can come back to, or
    // it does not, and the difference must not cost them the image.
    //
    // saveResult never throws — every path returns an outcome — so there is no
    // try/catch here and no way for a storage fault to become a 500 after two
    // billable requests have succeeded. The verdict is carried across unchanged,
    // so history can never claim a result was verified when the response did
    // not.
    const saved = await saveResult(
      {
        storage: svc.storage.from(HISTORY_BUCKET),
        insertRow: async row => {
          const { error } = await svc.from('image_editor_results').insert(row)
          return { error: error ? { message: error.message } : null }
        },
        newId: randomUUID,
      },
      {
        userId: user.id,
        master,
        sourceFileName: file.name,
        verification,
      },
    )

    if (!saved.ok) {
      // A category and a reason, for whoever reads the log. The employee is told
      // only that this one was not saved — a storage message is not something to
      // put on a screen.
      console.error('[image-editor/studio] history not saved:', saved.reason)
    }

    // The header carries the verdict and nothing else. The body stays the image:
    // no bounds, no densities, no request ids, no model names — an employee is
    // preparing a catalogue photograph, not reading a provider's telemetry.
    //
    // `historySaved` is the one addition, and it is about THIS page's promise
    // rather than the provider: false means "download it now, it will not be
    // here later", which the card says in words.
    return NextResponse.json(
      {
        configured: true,
        image: {
          dataUrl: `data:image/png;base64,${master.toString('base64')}`,
          mimeType: 'image/png',
        },
        historySaved: saved.ok,
        ...(saved.ok ? { historyId: saved.id } : {}),
      },
      { headers: { [VERIFICATION_HEADER]: verification } },
    )
  } catch (e) {
    // The category, never the stack: a libvips message can carry file paths.
    console.error(
      '[image-editor/studio] unhandled image failure:',
      e instanceof Error ? `${e.name}: ${e.message}` : 'unknown',
    )
    return NextResponse.json(
      { error: 'The image service could not process this photograph. Please try again.' },
      { status: 500 },
    )
  }
}
