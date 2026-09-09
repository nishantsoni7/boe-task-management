// ── Showroom quotation PDF ──────────────────────────────────────
//
// The document itself: fetching the product photos and drawing the page.
//
// This lives beside the route rather than inside it because a Next route file
// may only export its handlers — so while the builder was a private function in
// route.ts, the single most intricate part of this module (a 350-line PDFKit
// layout, images pulled off a third-party origin, a customer-facing document
// nobody sees until it is already with a customer) could not be rendered by a
// test at all. Moving it changes no behaviour; it makes the behaviour provable.
//
// The image RULES — which value is the primary image, who may be sent Supabase
// credentials, what counts as an image, what a blank box should say — live in
// ./quotationImages and are pinned by their own tests.

import { createClient } from "@supabase/supabase-js"
import fsPromises from "fs/promises"
import path from "path"
import sharp from "sharp"
import {
  DEFAULT_PRODUCT_IMAGE_BUCKET,
  classifyImageSource,
  detectImageFormat,
  imagePlaceholder,
  imageRequestHeaders,
  needsConversion,
  resolveStoragePath,
  salespersonLine,
} from "./quotationImages"

// PDFKit is a CJS module. Next.js may wrap it so the constructor lands on .default.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PDFDocumentRaw = require("pdfkit")
const PDFDocument: typeof import("pdfkit") = PDFDocumentRaw.default ?? PDFDocumentRaw

/**
 * Turns a stored image value into a URL this server can actually fetch.
 *
 * Three shapes are supported, and which one a value is decides whether Supabase
 * credentials may travel with the request — see `classifyImageSource` in
 * `@/lib/showroom/quotationImages`, which also records what production really
 * stores (every row: an absolute https URL on bestofexports.com).
 */
async function resolveImageUrl(
  rawValue: string | null,
): Promise<{ url: string; kind: ReturnType<typeof classifyImageSource> } | null> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? null
  const kind = classifyImageSource(rawValue, supabaseUrl)

  if (kind === 'none') return null
  if (kind === 'external-url' || kind === 'supabase-url') {
    return { url: (rawValue ?? '').trim(), kind }
  }

  // Storage path — sign it. Unexercised by current data, but kept working.
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) {
    console.warn('[pdf-img] storage path but Supabase is not configured — cannot sign:', rawValue)
    return null
  }

  const bucketName = process.env.SHOWROOM_PRODUCT_IMAGE_BUCKET || DEFAULT_PRODUCT_IMAGE_BUCKET
  const { bucket, objectPath } = resolveStoragePath((rawValue ?? '').trim(), bucketName)

  try {
    const adminClient = createClient(supabaseUrl, serviceKey)
    const { data, error } = await adminClient.storage.from(bucket).createSignedUrl(objectPath, 3600)
    if (error || !data?.signedUrl) {
      console.warn('[pdf-img] createSignedUrl failed for', rawValue, error?.message)
      return null
    }
    // A signed URL carries its own authorization in the query string.
    return { url: data.signedUrl, kind: 'supabase-url' }
  } catch (err) {
    console.warn('[pdf-img] createSignedUrl threw for', rawValue, err)
    return null
  }
}

/**
 * The longest edge, in pixels, a product image is reduced to before embedding.
 *
 * The image box on the card is 160pt square. At PDF's 72dpi that is 160px, so
 * 480px is 3x the rendered size — well past the point of visible difference in
 * print, and a large saving: the stored originals are 60-300KB WordPress
 * uploads, and a fifteen-line quotation was embedding several megabytes of them
 * into a document that gets sent over WhatsApp.
 */
const EMBED_MAX_EDGE = 480

/**
 * Per-image download budget.
 *
 * Generous enough for a cold shared-hosting origin, and bounded so that one
 * unreachable image cannot eat the whole function budget: every image is
 * fetched concurrently, so the wall clock is roughly this, not this times N.
 */
const IMAGE_FETCH_TIMEOUT_MS = 15000

/**
 * How many images are downloaded and decoded at once.
 *
 * Four, not "all of them": decode memory is the binding constraint, and this
 * caps it at roughly four decoded bitmaps regardless of how long the quotation
 * is. Wall clock barely moves — at the ~0.9s per image measured against the
 * real origin, twelve images take about three rounds.
 */
const IMAGE_FETCH_CONCURRENCY = 4

/**
 * Largest source image sharp will decode, in pixels.
 *
 * sharp's own default is ~268 MP, which is a bound in name only. Real product
 * photos are WordPress `-scaled` uploads capped at 2560px (~6.5 MP), so 30 MP
 * is several times more headroom than any genuine image needs while making a
 * pasted 100-megapixel URL fail one image instead of the whole function.
 */
const MAX_DECODE_PIXELS = 30_000_000

/**
 * Run `fn` over `items` with at most `limit` in flight, preserving input order.
 *
 * Small on purpose — a dependency for this would be a worse trade than eight
 * lines. Every task is expected to resolve (fetchImageBuffer catches its own
 * failures), so there is no rejection path to unwind.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * Downloads one product image, ready for PDFKit, or null.
 *
 * Best-effort by contract: the quotation must still generate when an image is
 * missing, unreachable or corrupt. Every failure path is logged and every one
 * of them ends in a drawn placeholder rather than a blank rectangle, so a
 * missing photo is legible to whoever is holding the quotation.
 */
async function fetchImageBuffer(
  rawImageField: string | null,
  label: string,   // product code/name for logging
): Promise<Buffer | null> {
  const resolved = await resolveImageUrl(rawImageField)
  if (!resolved) {
    console.log(`[pdf-img] ${label} | no usable image value:`, JSON.stringify(rawImageField))
    return null
  }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? null
  const headers = imageRequestHeaders(resolved.kind, serviceKey)

  try {
    const res = await fetch(resolved.url, {
      headers,
      signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
    })
    if (!res.ok) {
      console.warn(`[pdf-img] ${label} | ${resolved.kind} fetch failed with status ${res.status}`)
      return null
    }

    const buf = Buffer.from(await res.arrayBuffer())
    const format = detectImageFormat(buf)
    if (!format) {
      // A WAF challenge page and an HTML 404 both arrive as a 200 with a body.
      console.warn(
        `[pdf-img] ${label} | unrecognised bytes (content-type: ${res.headers.get('content-type') ?? 'unknown'}, ${buf.length}b) — skipping`,
      )
      return null
    }

    // Re-encode: WebP because PDFKit cannot embed it at all, everything else
    // because a 300KB original in a 160pt box is bytes nobody sees.
    try {
      const out = await sharp(buf, { limitInputPixels: MAX_DECODE_PIXELS })
        // `inside` + `withoutEnlargement`: the whole piece is scaled to fit the
        // box with its aspect ratio intact and a small image is left alone.
        // Nothing is cropped and nothing is stretched — a chair keeps its legs.
        .resize(EMBED_MAX_EDGE, EMBED_MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82 })
        .toBuffer()
      console.log(`[pdf-img] ${label} | ${format} ${buf.length}b -> jpeg ${out.length}b`)
      return out
    } catch (convErr) {
      // sharp is the optimisation, not the dependency. PNG and JPEG can still
      // be embedded as they arrived; WebP genuinely cannot.
      console.warn(`[pdf-img] ${label} | sharp failed, falling back to original:`, convErr)
      return needsConversion(format) ? null : buf
    }
  } catch (err) {
    console.error(`[pdf-img] ${label} | fetch threw:`, err)
    return null
  }
}

export function fmt(n: number): string {
  // Use "Rs." instead of ₹ — Helvetica (built-in PDF font) only covers Latin-1;
  // the rupee sign U+20B9 is outside that range and causes PDFKit to throw.
  return 'Rs. ' + Math.round(n).toLocaleString('en-IN')
}

// ── POST /api/showroom/quotation/[id] ────────────────────────────────────────
// Accepts edited item rates, quantities, customization notes, and discount.
// Builds an enhanced PDF with product images and dimensions.

export type OverrideItem = {
  id: string
  quantity: number
  rate: number
  customization_note?: string | null
}

export type PdfItem = {
  quantity: number
  rate: number
  mrp_at_time: number
  customization_note: string | null
  product: {
    product_code: string
    name: string
    image_url: string | null
    dimensions: { width?: number | null; depth?: number | null; height?: number | null; unit?: string } | null
  } | null
}

export type PdfData = {
  customer_name: string
  customer_mobile: string
  company: string | null
  city: string | null
  project_name: string | null
  salesperson_name: string
  discount_percent: number
  quotation_no: string | null
  created_at: string
  items: PdfItem[]
}

// ── PDF builder ───────────────────────────────────────────────────────────────

export type BuildOptions = {
  /**
   * Compress the page content streams. Production leaves this on (PDFKit's
   * default); the tests turn it off so the text they assert on can be read back
   * out of the document. It changes no drawing call and no glyph on the page.
   */
  compress?: boolean
}

export async function buildEnhancedPdf(
  data: PdfData,
  options: BuildOptions = {},
): Promise<Buffer> {
  // Load BOE logo from project public assets
  const logoPath = path.join(process.cwd(), 'public', 'branding', 'boe-logo-full.png')
  let logoBuffer: Buffer | null = null
  try {
    logoBuffer = await fsPromises.readFile(logoPath)
  } catch {
    console.warn('[pdf] logo not found at', logoPath)
  }

  // Pre-fetch product images — bounded, de-duplicated, best-effort.
  //
  // This used to be a plain `Promise.all` over every line, which meant a
  // twenty-line quotation opened twenty simultaneous downloads and handed
  // twenty images to sharp at once. Decoding is where the memory goes: a
  // 2560px WordPress "-scaled" upload is ~26 MB once decoded, so the peak grew
  // linearly with the quotation and the largest quotation nobody had written
  // yet was the one that would exhaust the function.
  //
  // De-duplication matters for the same reason and is not hypothetical:
  // showroom_inquiry_items has no uniqueness on product_id, and the admin's
  // "add product" action inserts a new row without merging, so the same photo
  // can appear on several lines of one quotation. Keyed on the STORED value
  // rather than the resolved URL, because signing a storage path produces a
  // different URL every time.
  const cache = new Map<string, Promise<Buffer | null>>()
  const imageBuffers = await mapWithConcurrency(
    data.items,
    IMAGE_FETCH_CONCURRENCY,
    item => {
      const raw = item.product?.image_url ?? null
      if (!raw) return Promise.resolve(null)
      const cached = cache.get(raw)
      if (cached) return cached
      const label = `${item.product?.product_code ?? '?'} / ${item.product?.name ?? '?'}`
      const pending = fetchImageBuffer(raw, label)
      cache.set(raw, pending)
      return pending
    },
  )

  return new Promise<Buffer>((resolve, reject) => {
    const doc      = new PDFDocument({ margin: 36, size: 'A4', compress: options.compress ?? true })
    const buffers: Buffer[] = []
    doc.on('data',  (chunk: Buffer) => buffers.push(chunk))
    doc.on('end',   ()              => resolve(Buffer.concat(buffers)))
    doc.on('error', reject)

    const pageW    = doc.page.width   // 595
    const L        = 36
    const contentW = pageW - L - 36   // 523
    const R_EDGE   = pageW - 36       // 559

    // Brand palette — derived from BOE logo
    const RED    = '#C41920'
    const DARK   = '#1F2937'
    const GRAY   = '#6B7280'
    const LGRAY  = '#9CA3AF'
    const BORDER = '#E5E7EB'

    const date = new Date(data.created_at).toLocaleDateString('en-IN', {
      day: 'numeric', month: 'long', year: 'numeric',
    })

    // ── Red top accent stripe ─────────────────────────────────────────────────
    doc.rect(0, 0, pageW, 3).fillColor(RED).fill()

    // ── Header: logo left, quotation meta right ───────────────────────────────
    let y = 40

    // Logo — natural ratio ~2.65:1, rendered at height 44 → width ≈ 117
    if (logoBuffer) {
      try {
        doc.image(logoBuffer, L, y, { height: 44 })
      } catch {
        doc.fontSize(20).font('Helvetica-Bold').fillColor(RED).text('BOE', L, y)
      }
    } else {
      doc.fontSize(20).font('Helvetica-Bold').fillColor(RED).text('BOE', L, y)
    }

    // Tagline sits below the logo
    doc.fontSize(6.5).font('Helvetica-Bold').fillColor(RED)
       .text('CRAFTING SPACES. DEFINING EXPERIENCES.', L, y + 52)

    // Right: QUOTATION heading, right-aligned
    doc.fontSize(22).font('Helvetica-Bold').fillColor(DARK)
       .text('QUOTATION', L, y, { align: 'right', width: contentW })

    // Short red accent dash under the heading
    doc.moveTo(R_EDGE - 36, y + 29).lineTo(R_EDGE, y + 29)
       .strokeColor(RED).lineWidth(2).stroke()

    // Quotation details — two-column grid anchored to the right
    const qLabelW  = 96
    const qBlockX  = R_EDGE - 260
    const qValueX  = qBlockX + qLabelW + 8
    const qValueW  = R_EDGE - qValueX
    const qRow1    = y + 38
    const qRow2    = qRow1 + 17
    const qRow3    = qRow2 + 17

    doc.fontSize(7.5).font('Helvetica-Bold').fillColor(LGRAY)
       .text('QUOTATION NO.', qBlockX, qRow1, { width: qLabelW })
    doc.fontSize(9).font('Helvetica-Bold').fillColor(DARK)
       .text(data.quotation_no ?? '—', qValueX, qRow1, { width: qValueW })

    doc.fontSize(7.5).font('Helvetica-Bold').fillColor(LGRAY)
       .text('DATE', qBlockX, qRow2, { width: qLabelW })
    doc.fontSize(9).font('Helvetica-Bold').fillColor(DARK)
       .text(date, qValueX, qRow2, { width: qValueW })

    // Who the customer deals with. Third row of the same meta grid rather than a
    // line of its own, so it reads as a property of the quotation next to its
    // number and date — and, unlike a footer signature, it is the first place
    // anyone looks. The NAME IS THE INQUIRY'S OWNER, never the caller: an admin
    // downloading a colleague's quotation must not put their own name in front
    // of that colleague's customer.
    const spLine = salespersonLine(data.salesperson_name)
    const spRowUsed = spLine !== null
    if (spLine) {
      doc.fontSize(7.5).font('Helvetica-Bold').fillColor(LGRAY)
         .text('SALES CONSULTANT', qBlockX, qRow3, { width: qLabelW })
      doc.fontSize(9).font('Helvetica-Bold').fillColor(DARK)
         .text(data.salesperson_name.trim(), qValueX, qRow3, { width: qValueW })
    }

    // Advance past whichever header column is taller
    y = Math.max(y + 52 + 10, (spRowUsed ? qRow3 : qRow2) + 18) + 10

    doc.moveTo(L, y).lineTo(R_EDGE, y).strokeColor(BORDER).lineWidth(0.5).stroke()
    y += 20

    // ── Client block ─────────────────────────────────────────────────────────
    doc.fontSize(7).font('Helvetica-Bold').fillColor(RED)
       .text('QUOTATION FOR', L, y)
    doc.moveTo(L, y + 10).lineTo(L + 40, y + 10).strokeColor(RED).lineWidth(1.5).stroke()
    y += 18

    doc.fontSize(16).font('Helvetica-Bold').fillColor(DARK)
       .text(data.customer_name, L, y)
    y += 22

    doc.fontSize(8.5).font('Helvetica').fillColor(GRAY)
       .text(data.customer_mobile, L, y)
    y += 13

    if (data.company) {
      doc.fontSize(8.5).font('Helvetica').fillColor(GRAY)
         .text(data.company, L, y)
      y += 13
    }
    if (data.city) {
      doc.fontSize(8.5).font('Helvetica').fillColor(GRAY)
         .text(data.city, L, y)
      y += 13
    }
    if (data.project_name) {
      doc.fontSize(8).font('Helvetica').fillColor(LGRAY)
         .text(`Project: ${data.project_name}`, L, y)
      y += 13
    }

    y += 22
    doc.moveTo(L, y).lineTo(R_EDGE, y).strokeColor(BORDER).lineWidth(0.5).stroke()
    y += 20

    // ── Product cards ─────────────────────────────────────────────────────────
    // Single horizontal card per product — image left, all info right.
    // Spec row sits inside the right column (no full-width bottom section).
    // Target: 4 cards per page, ~180pt each.
    const CARD_PAD = 10
    const IMG_SIZE = 160                          // 160×160 fit box
    const IMG_X    = L + CARD_PAD                // 46
    const INFO_X   = IMG_X + IMG_SIZE + 14       // 220
    const INFO_W   = R_EDGE - INFO_X - CARD_PAD  // 329
    const CARD_H   = CARD_PAD + IMG_SIZE + CARD_PAD  // 180
    const CARD_GAP = 8

    let subtotal = 0

    data.items.forEach((item, idx) => {
      const prod      = item.product
      const lineTotal = item.rate * item.quantity
      subtotal       += lineTotal

      // Build dimension string
      const dimParts: string[] = []
      if (prod?.dimensions) {
        const d = prod.dimensions
        const u = d.unit === 'inches' ? '"' : ` ${d.unit ?? 'in'}`
        if (d.width  != null) dimParts.push(`W ${d.width}${u}`)
        if (d.depth  != null) dimParts.push(`D ${d.depth}${u}`)
        if (d.height != null) dimParts.push(`H ${d.height}${u}`)
      }
      const dimStr = dimParts.join(' × ') || '—'

      if (y + CARD_H > doc.page.height - 80) {
        doc.addPage()
        y = 50
      }

      const cardY = y

      // Card border
      doc.rect(L, cardY, contentW, CARD_H).strokeColor(BORDER).lineWidth(0.5).stroke()

      // ── Image (left column) ──────────────────────────────────────────────────
      const imgBuf = imageBuffers[idx]
      let imageDrawn = false
      if (imgBuf) {
        try {
          doc.image(imgBuf, IMG_X, cardY + CARD_PAD, {
            fit: [IMG_SIZE, IMG_SIZE],
            align: 'center',
            valign: 'center',
          })
          imageDrawn = true
        } catch (imgErr) {
          const label = `${prod?.product_code ?? '?'} / ${prod?.name ?? '?'}`
          console.error(`[pdf-img] ${label} | image insert failed:`, imgErr)
        }
      }

      // An image that is absent, unreachable or unembeddable used to leave the
      // left third of the card as bare white — indistinguishable from a layout
      // bug. Fill it deliberately instead: a tinted panel that says which of the
      // two things happened, with the product code under it so the salesperson
      // can still name the item they are pointing at.
      if (!imageDrawn) {
        const box = imagePlaceholder({
          hasStoredImage: item.product?.image_url != null,
          productCode: prod?.product_code,
        })
        const boxY = cardY + CARD_PAD
        doc.rect(IMG_X, boxY, IMG_SIZE, IMG_SIZE).fillColor('#F9FAFB').fill()
        doc.rect(IMG_X, boxY, IMG_SIZE, IMG_SIZE)
           .strokeColor(BORDER).lineWidth(0.5).dash(3, { space: 3 }).stroke()
        doc.undash()

        const textY = boxY + IMG_SIZE / 2 - (box.subtitle ? 14 : 5)
        doc.fontSize(7).font('Helvetica-Bold').fillColor(LGRAY)
           .text(box.title, IMG_X, textY, { width: IMG_SIZE, align: 'center' })
        if (box.subtitle) {
          doc.fontSize(9).font('Helvetica-Bold').fillColor(GRAY)
             .text(box.subtitle, IMG_X, textY + 13, { width: IMG_SIZE, align: 'center' })
        }
      }

      // ── Right column: name → code → note → spec row ──────────────────────────
      let infoY = cardY + CARD_PAD

      // Product name
      doc.fontSize(11).font('Helvetica-Bold').fillColor(DARK)
         .text(prod?.name ?? 'Unknown product', INFO_X, infoY, { width: INFO_W })
      infoY += 17

      // Product code
      if (prod?.product_code && prod.product_code !== '—') {
        doc.fontSize(7).font('Helvetica').fillColor(LGRAY)
           .text(prod.product_code, INFO_X, infoY, { width: INFO_W })
        infoY += 13
      }

      // Customization note — compact tinted strip
      if (item.customization_note) {
        const np    = 7
        const noteH = 26
        doc.rect(INFO_X, infoY, INFO_W, noteH).fillColor('#F9FAFB').fill()
        doc.fontSize(6).font('Helvetica-Bold').fillColor(LGRAY)
           .text('CUSTOMIZATION', INFO_X + np, infoY + 5, { width: INFO_W - np * 2 })
        doc.fontSize(7.5).font('Helvetica').fillColor(GRAY)
           .text(item.customization_note, INFO_X + np, infoY + 14, { width: INFO_W - np * 2 })
        infoY += noteH + 6
      } else {
        infoY += 4
      }

      // Thin separator before spec row
      doc.moveTo(INFO_X, infoY + 4).lineTo(R_EDGE - CARD_PAD, infoY + 4)
         .strokeColor(BORDER).lineWidth(0.5).stroke()

      // Spec row — four blocks across INFO_W, sized to what each one holds.
      //
      // They used to be equal quarters (~82pt). A full three-axis dimension —
      // `W 22" × D 24" × H 33"` — is about 100pt at 9pt bold, so it wrapped, and
      // the overflow line landed on top of the row below it. QTY needs a
      // fraction of a quarter and DIMENSIONS needs more than one, so the widths
      // follow the content instead of the arithmetic.
      const specLabelY = infoY + 10
      const specValueY = specLabelY + 10

      const specs: Array<{ label: string; value: string; weight: number }> = [
        { label: 'DIMENSIONS', value: dimStr,                weight: 1.6 },
        { label: 'MRP',        value: fmt(item.rate),        weight: 1.0 },
        { label: 'QTY',        value: String(item.quantity), weight: 0.5 },
        { label: 'LINE TOTAL', value: fmt(lineTotal),        weight: 1.1 },
      ]
      const totalWeight = specs.reduce((sum, s) => sum + s.weight, 0)

      let bx = INFO_X
      specs.forEach(spec => {
        const blkW = (INFO_W * spec.weight) / totalWeight
        doc.fontSize(6).font('Helvetica-Bold').fillColor(LGRAY)
           .text(spec.label, bx, specLabelY, { width: blkW, align: 'center' })
        doc.fontSize(9).font('Helvetica-Bold').fillColor(DARK)
           .text(spec.value, bx, specValueY, { width: blkW, align: 'center', lineBreak: false })
        bx += blkW
      })

      y = cardY + CARD_H + CARD_GAP
    })

    y += 6

    // ── Commercial summary card ───────────────────────────────────────────────
    const discAmt    = subtotal * data.discount_percent / 100
    const finalTotal = subtotal - discAmt

    const SUM_PAD = 20
    const nRows   = 1 + (data.discount_percent > 0 ? 1 : 0)
    const SUM_H   = SUM_PAD + nRows * 20 + 12 + 46 + SUM_PAD

    if (y + SUM_H > doc.page.height - 80) {
      doc.addPage()
      y = 50
    }

    const sumCardY = y
    doc.rect(L, sumCardY, contentW, SUM_H).strokeColor(BORDER).lineWidth(0.5).stroke()

    const sumLabelX = L + SUM_PAD
    const sumValueX = R_EDGE - 200
    const sumLabelW = sumValueX - sumLabelX - 8
    const sumValueW = 200 - SUM_PAD

    let sumY = sumCardY + SUM_PAD

    doc.fontSize(8.5).font('Helvetica').fillColor(LGRAY)
       .text('Subtotal (Ex-Factory)', sumLabelX, sumY, { width: sumLabelW })
    doc.fontSize(8.5).font('Helvetica').fillColor(GRAY)
       .text(fmt(subtotal), sumValueX, sumY, { width: sumValueW, align: 'right' })
    sumY += 20

    if (data.discount_percent > 0) {
      doc.fontSize(8.5).font('Helvetica').fillColor(LGRAY)
         .text(`Discount (${data.discount_percent}%)`, sumLabelX, sumY, { width: sumLabelW })
      doc.fontSize(8.5).font('Helvetica').fillColor(LGRAY)
         .text(`- ${fmt(discAmt)}`, sumValueX, sumY, { width: sumValueW, align: 'right' })
      sumY += 20
    }

    doc.moveTo(L + SUM_PAD, sumY + 6).lineTo(R_EDGE - SUM_PAD, sumY + 6)
       .strokeColor(RED).lineWidth(0.75).stroke()
    sumY += 14

    doc.fontSize(8).font('Helvetica-Bold').fillColor(RED)
       .text('FINAL QUOTATION VALUE', sumLabelX, sumY + 10, { width: sumLabelW })
    doc.fontSize(22).font('Helvetica-Bold').fillColor(RED)
       .text(fmt(finalTotal), sumValueX, sumY, { width: sumValueW, align: 'right' })

    y += SUM_H + 20

    // ── Commercial notes ──────────────────────────────────────────────────────
    if (y > doc.page.height - 180) {
      doc.addPage()
      y = 50
    }

    y += 4
    doc.moveTo(L, y).lineTo(R_EDGE, y).strokeColor(BORDER).lineWidth(0.5).stroke()
    y += 16

    doc.fontSize(7.5).font('Helvetica-Bold').fillColor(DARK)
       .text('COMMERCIAL NOTES', L, y)
    doc.moveTo(L, y + 11).lineTo(L + 32, y + 11).strokeColor(RED).lineWidth(1.5).stroke()
    y += 20

    const notes = [
      'Prices are ex-factory.',
      'GST @ 18% extra.',
      'Fabric cost extra depending on selected fabric.',
      'Packing charges extra.',
      'Transport / logistics charges extra, if applicable.',
      'This is a preliminary showroom quotation. Final detailed quotation will be shared after confirmation.',
    ]

    doc.fontSize(8.5).font('Helvetica').fillColor(GRAY)
    for (const note of notes) {
      doc.text(`•  ${note}`, L + 4, y, { width: contentW - 4 })
      y += 13
    }

    // ── Footer ────────────────────────────────────────────────────────────────
    const footerY = doc.page.height - 44
    doc.moveTo(L, footerY).lineTo(R_EDGE, footerY).strokeColor(RED).lineWidth(0.75).stroke()

    doc.fontSize(7.5).font('Helvetica').fillColor(GRAY)
       .text(
         'B-7, Trade World, Basni Phase-II, Jodhpur, Rajasthan 342005',
         L, footerY + 9, { width: contentW * 0.44 },
       )
    doc.fontSize(7.5).font('Helvetica').fillColor(GRAY)
       .text(
         '+91 80030 34966   |   info@bestofexports.com   |   bestofexports.com',
         L, footerY + 9, { width: contentW, align: 'right' },
       )

    doc.end()
  })
}
