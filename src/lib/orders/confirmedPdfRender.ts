// DRAWING THE CONFIRMED ORDER PDF.
//
// THIS FILE DECIDES NOTHING. What the document SAYS and where its pages break
// were decided by ./confirmedPdf, in pure functions with their own tests. This
// takes that model and puts ink on it.
//
// NODE ONLY. pdfkit is a CommonJS module that loads its font metrics through
// fs.readFileSync relative to its own directory, which is why next.config.ts
// lists it in serverExternalPackages. Nothing in a browser imports this file.
//
// THE SAME SETUP THE SHOWROOM QUOTATION PDF ALREADY USES — pdfkit, sharp, A4 at
// a 36pt margin, Helvetica, the BOE red. Deliberately: this is the second
// document the business sends, and the two should look like they came from the
// same company. No new PDF dependency, no headless browser, no conversion
// service.

import sharp from 'sharp'

import {
  PDF_COMMERCIAL_TITLE,
  PDF_BILL_TO_TITLE,
  PDF_MARGIN,
  PDF_ORDER_NUMBER_LABEL,
  PDF_PAGE_HEIGHT,
  PDF_PAGE_WIDTH,
  PDF_PAYMENT_TITLE,
  PDF_PRODUCTS_TITLE,
  PDF_PRODUCT_COLUMNS,
  PDF_SHIP_TO_TITLE,
  PDF_TABLE_HEAD_HEIGHT,
  PDF_TITLE,
  paginateProductRows,
  toPdfText,
  type ConfirmedPdfModel,
  type PdfField,
  type PdfPage,
  type PdfProductRow,
} from './confirmedPdf'

// pdfkit is CJS; Next may wrap it so the constructor lands on `.default`. The
// same two lines the showroom quotation route already uses.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PDFDocumentRaw = require('pdfkit')
const PDFDocument: typeof import('pdfkit') = PDFDocumentRaw.default ?? PDFDocumentRaw

// ── Palette ───────────────────────────────────────────────────────────────────
// Derived from the BOE logo, and identical to the quotation PDF's.

const RED = '#C41920'
const DARK = '#1F2937'
const GRAY = '#6B7280'
const LGRAY = '#9CA3AF'
const BORDER = '#E5E7EB'

const L = PDF_MARGIN
const R_EDGE = PDF_PAGE_WIDTH - PDF_MARGIN
const CONTENT_W = R_EDGE - L

/** Where the header block ends on page 1, and on a continuation page. Handed to
 *  the paginator so the plan and the drawing agree about how much room the
 *  header takes. */
export const FIRST_PAGE_TOP = 300
export const LATER_PAGE_TOP = 64

/** Space the commercial summary and the payment block need after the last
 *  product row. */
export const TAIL_HEIGHT = 230

// ── Images ────────────────────────────────────────────────────────────────────

/**
 * How the renderer gets a product photograph.
 *
 * A FUNCTION, not a storage client, for the same reason confirmedExcel takes an
 * ObjectReader: the tests exercise every image path — present, absent, corrupt —
 * without a network, and this module has no way to reach storage on its own.
 */
export type PdfImageLoader = (row: number) => Promise<Uint8Array | null>

/**
 * Bytes pdfkit will actually accept, or null.
 *
 * pdfkit embeds PNG and JPEG. Anything else — WEBP in particular, which the PI
 * pipeline stores — goes through sharp. A DECODE FAILURE IS NEVER FATAL: the
 * cell simply draws its empty box, exactly as the screen does for a picture it
 * could not sign. A missing thumbnail is a blemish; a failed Order document is
 * an incident.
 */
export async function toEmbeddableImage(bytes: Uint8Array | null): Promise<Buffer | null> {
  if (!bytes || bytes.length < 12) return null
  const b = Buffer.from(bytes)

  // PNG: 89 50 4E 47
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return b
  // JPEG: FF D8 FF
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return b

  try {
    // Everything else — WEBP, TIFF, an unexpected format — is normalised to
    // JPEG. `failOn: 'none'` so a slightly malformed but decodable image still
    // produces a picture rather than an exception.
    return await sharp(b, { failOn: 'none' }).jpeg({ quality: 82 }).toBuffer()
  } catch {
    // Deliberately swallowed, and deliberately not logged with the bytes: an
    // image that will not decode is a blank cell, not a failed document.
    return null
  }
}

// ── Determinism ───────────────────────────────────────────────────────────────

/**
 * PDF metadata, PINNED.
 *
 * pdfkit stamps CreationDate and ModDate from the clock, which makes two runs
 * over identical inputs produce different bytes and therefore different hashes.
 * That would make the recorded sha256 meaningless as an identity — two
 * regenerations of the same version could never be compared.
 *
 * So both dates are set from a value the CALLER supplies. In production that is
 * the Order's confirm date, which is a fact about the document rather than about
 * when a machine happened to render it; in the tests it is a fixed instant, and
 * the tests assert that two renders of one model come out byte-identical.
 */
export type PdfMetadata = {
  /** Stamped as both CreationDate and ModDate. */
  date: Date
  /** Shown in a reader's title bar and in file listings. */
  title: string
}

// ── The render ────────────────────────────────────────────────────────────────

export type RenderConfirmedPdfInput = {
  model: ConfirmedPdfModel
  /** Null for an Order whose images could not be reached at all. */
  loadImage?: PdfImageLoader | null
  metadata: PdfMetadata
  /** The BOE mark, already read from disk. Optional: a missing logo falls back
   *  to the wordmark, exactly as the quotation PDF does. */
  logo?: Uint8Array | null
}

export async function renderConfirmedPdf(input: RenderConfirmedPdfInput): Promise<Buffer> {
  const { model, metadata } = input

  const pages = paginateProductRows({
    rows: model.products,
    firstPageTop: FIRST_PAGE_TOP,
    laterPageTop: LATER_PAGE_TOP,
    tailHeight: model.commercial.length > 0 ? TAIL_HEIGHT : 0,
  })

  // IMAGES ARE FETCHED BEFORE ANY INK GOES DOWN. pdfkit's drawing calls are
  // synchronous, so an await in the middle of laying out a table is how a row
  // ends up drawn after the page it belonged to was already finished.
  const images = new Map<number, Buffer>()
  if (input.loadImage) {
    const wanted = model.products.filter(p => p.hasImage).map(p => p.row)
    const loaded = await Promise.all(wanted.map(async row => {
      try {
        return [row, await toEmbeddableImage(await input.loadImage!(row))] as const
      } catch {
        // One unreachable picture must not take the document down with it.
        return [row, null] as const
      }
    }))
    for (const [row, buf] of loaded) if (buf) images.set(row, buf)
  }

  const logo = input.logo ? Buffer.from(input.logo) : null

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      // ── EVERY PAGE BREAK IN THIS DOCUMENT IS ONE THE PAGINATOR PLANNED ──
      //
      // autoFirstPage:false stops pdfkit opening a page before the loop below.
      // The BOTTOM MARGIN OF ZERO is the other half, and it is not cosmetic:
      // pdfkit adds a page automatically whenever a text call would cross the
      // bottom margin, and the footer is deliberately drawn in the band a 36pt
      // margin would forbid. With the default margin this produced SIX pages
      // for a two-page plan — three of them blank, each carrying a footer that
      // said "Page 4 of 2".
      //
      // Vertical space is not unmanaged as a result: the paginator reserves
      // PDF_FOOTER_HEIGHT at the foot of every page and places no row inside
      // it. And if pdfkit ever adds a page anyway, the guard below refuses the
      // document rather than shipping one with an unplanned page in it.
      autoFirstPage: false,
      margins: { top: PDF_MARGIN, left: PDF_MARGIN, right: PDF_MARGIN, bottom: 0 },
      info: {
        Title: toPdfText(metadata.title),
        Author: 'Best of Exports',
        Creator: 'BOE Task Management',
        Producer: 'BOE Task Management',
        CreationDate: metadata.date,
        ModDate: metadata.date,
      },
    })

    const chunks: Buffer[] = []
    doc.on('data', (c: Buffer) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    // THE PLAN IS THE DOCUMENT. Every page must come from an addPage call in the
    // loop below; a page pdfkit decided to add on its own is a page with no
    // planned content and a footer that misreports the total, and it is refused
    // rather than shipped.
    let added = 0
    doc.on('pageAdded', () => { added += 1 })

    try {
      for (const page of pages) {
        doc.addPage({ size: 'A4', margins: { top: PDF_MARGIN, left: PDF_MARGIN, right: PDF_MARGIN, bottom: 0 } })
        if (added !== page.index) {
          throw new Error(`PDF_PAGINATION_DRIFT: expected page ${page.index}, pdfkit is on ${added}`)
        }
        const first = page.index === 1
        let y = first ? drawFirstPageHeader(doc, model, logo) : drawContinuationHeader(doc, model)

        if (page.tableHead) {
          y = drawTableHead(doc, y)
          y = drawProductRows(doc, page, y, images)
        }

        if (isLastContentPage(pages, page)) {
          drawTail(doc, model, y)
        }

        drawFooter(doc, page, pages.length)

        if (added !== page.index) {
          throw new Error(`PDF_PAGINATION_DRIFT: drawing page ${page.index} added ${added - page.index} unplanned page(s)`)
        }
      }
      doc.end()
    } catch (err) {
      reject(err)
    }
  })
}

/** The totals go on the last page the plan produced. */
function isLastContentPage(pages: PdfPage[], page: PdfPage): boolean {
  return page.index === pages.length
}

// ── Blocks ────────────────────────────────────────────────────────────────────

type Doc = InstanceType<typeof PDFDocument>

function drawFirstPageHeader(doc: Doc, model: ConfirmedPdfModel, logo: Buffer | null): number {
  doc.rect(0, 0, PDF_PAGE_WIDTH, 3).fillColor(RED).fill()

  let y = 40
  if (logo) {
    try { doc.image(logo, L, y, { height: 44 }) }
    catch { doc.fontSize(20).font('Helvetica-Bold').fillColor(RED).text('BOE', L, y) }
  } else {
    doc.fontSize(20).font('Helvetica-Bold').fillColor(RED).text('BOE', L, y)
  }
  doc.fontSize(6.5).font('Helvetica-Bold').fillColor(RED)
     .text('CRAFTING SPACES. DEFINING EXPERIENCES.', L, y + 52)

  doc.fontSize(18).font('Helvetica-Bold').fillColor(DARK)
     .text(PDF_TITLE, L, y, { width: CONTENT_W, align: 'right' })
  doc.fontSize(7.5).font('Helvetica-Bold').fillColor(LGRAY)
     .text(PDF_ORDER_NUMBER_LABEL.toUpperCase(), L, y + 24, { width: CONTENT_W, align: 'right' })
  doc.fontSize(15).font('Helvetica-Bold').fillColor(RED)
     .text(model.orderNumber, L, y + 34, { width: CONTENT_W, align: 'right' })

  y = 110
  doc.moveTo(L, y).lineTo(R_EDGE, y).strokeColor(BORDER).lineWidth(0.75).stroke()

  y += 12
  doc.fontSize(7).font('Helvetica-Bold').fillColor(LGRAY).text('CLIENT', L, y)
  doc.fontSize(14).font('Helvetica-Bold').fillColor(DARK)
     .text(model.clientName, L, y + 10, { width: CONTENT_W * 0.62 })

  // The two parties, side by side, and the meta column opposite them.
  const partyTop = y + 40
  const colW = CONTENT_W * 0.30
  drawFieldBlock(doc, PDF_BILL_TO_TITLE, model.billTo, L, partyTop, colW)
  drawFieldBlock(doc, PDF_SHIP_TO_TITLE, model.shipTo, L + colW + 14, partyTop, colW)
  drawFieldBlock(doc, '', model.meta, L + 2 * (colW + 14), partyTop, CONTENT_W - 2 * (colW + 14))

  doc.fontSize(9).font('Helvetica-Bold').fillColor(DARK)
     .text(PDF_PRODUCTS_TITLE, L, FIRST_PAGE_TOP - 16)

  return FIRST_PAGE_TOP
}

function drawContinuationHeader(doc: Doc, model: ConfirmedPdfModel): number {
  doc.rect(0, 0, PDF_PAGE_WIDTH, 3).fillColor(RED).fill()
  doc.fontSize(8).font('Helvetica-Bold').fillColor(LGRAY)
     .text(`${PDF_TITLE}  ${model.orderNumber}`, L, 26)
  doc.fontSize(8).font('Helvetica').fillColor(LGRAY)
     .text(model.clientName, L, 26, { width: CONTENT_W, align: 'right' })
  return LATER_PAGE_TOP
}

function drawFieldBlock(doc: Doc, title: string, fields: PdfField[], x: number, y: number, w: number): void {
  let cursor = y
  if (title) {
    doc.fontSize(7).font('Helvetica-Bold').fillColor(LGRAY).text(title.toUpperCase(), x, cursor, { width: w })
    cursor += 11
  }
  if (fields.length === 0) {
    // A block with nothing in it says so once, rather than printing a run of
    // labelled holes.
    doc.fontSize(8).font('Helvetica').fillColor(LGRAY).text('Not provided', x, cursor, { width: w })
    return
  }
  for (const field of fields) {
    doc.fontSize(6.5).font('Helvetica-Bold').fillColor(LGRAY).text(field.label.toUpperCase(), x, cursor, { width: w })
    doc.fontSize(8).font('Helvetica').fillColor(DARK).text(field.value, x, cursor + 8, { width: w })
    cursor += 8 + Math.max(10, doc.heightOfString(field.value, { width: w })) + 4
  }
}

// Column widths, left to right, summing to CONTENT_W.
const COL_W = [34, 46, 104, 26, 68, 62, 82, 46, 55] as const

function drawTableHead(doc: Doc, y: number): number {
  doc.rect(L, y, CONTENT_W, PDF_TABLE_HEAD_HEIGHT).fillColor('#F9FAFB').fill()
  doc.fontSize(6.5).font('Helvetica-Bold').fillColor(LGRAY)
  let x = L
  PDF_PRODUCT_COLUMNS.forEach((label, i) => {
    const right = i >= PDF_PRODUCT_COLUMNS.length - 2
    doc.text(label.toUpperCase(), x + 3, y + 6, { width: COL_W[i] - 6, align: right ? 'right' : 'left' })
    x += COL_W[i]
  })
  doc.moveTo(L, y + PDF_TABLE_HEAD_HEIGHT).lineTo(R_EDGE, y + PDF_TABLE_HEAD_HEIGHT)
     .strokeColor(BORDER).lineWidth(0.75).stroke()
  return y + PDF_TABLE_HEAD_HEIGHT
}

function drawProductRows(doc: Doc, page: PdfPage, top: number, images: Map<number, Buffer>): number {
  let y = top
  for (const row of page.rows) {
    drawProductRow(doc, row, y, images.get(row.row) ?? null)
    y += row.height
    doc.moveTo(L, y).lineTo(R_EDGE, y).strokeColor(BORDER).lineWidth(0.5).stroke()
  }
  return y
}

function drawProductRow(doc: Doc, row: PdfProductRow, y: number, image: Buffer | null): void {
  const cells: { text: string; align: 'left' | 'right' }[] = [
    { text: row.code, align: 'left' },
    { text: '', align: 'left' },                 // the image column
    { text: row.name, align: 'left' },
    { text: row.quantity, align: 'left' },
    { text: row.dimensions, align: 'left' },
    { text: row.material, align: 'left' },
    { text: row.customization, align: 'left' },
    { text: row.rate, align: 'right' },
    { text: row.lineTotal, align: 'right' },
  ]

  let x = L
  cells.forEach((cell, i) => {
    if (i === 1) {
      if (image) {
        try {
          doc.image(image, x + 3, y + 4, {
            fit: [COL_W[1] - 6, Math.min(row.height - 8, 54)],
            align: 'center',
            valign: 'center',
          })
        } catch {
          // An image pdfkit refuses at draw time — a truncated PNG that sniffed
          // correctly — leaves the empty box below rather than an exception.
          drawEmptyImageBox(doc, x, y, row.height)
        }
      } else {
        drawEmptyImageBox(doc, x, y, row.height)
      }
      x += COL_W[1]
      return
    }
    doc.fontSize(7.5).font(i === 8 ? 'Helvetica-Bold' : 'Helvetica')
       .fillColor(i === 8 ? DARK : GRAY)
       .text(cell.text, x + 3, y + 6, {
         width: COL_W[i] - 6,
         align: cell.align,
         // CLIPPED, NOT WRAPPED PAST THE ROW. The paginator reserved this row's
         // height; text allowed to grow past it would run into the next row.
         height: Math.max(10, row.height - 10),
         ellipsis: true,
       })
    x += COL_W[i]
  })
}

function drawEmptyImageBox(doc: Doc, x: number, y: number, height: number): void {
  const size = Math.min(COL_W[1] - 8, height - 10, 44)
  if (size < 8) return
  doc.rect(x + 4, y + 5, size, size).strokeColor(BORDER).lineWidth(0.5).stroke()
}

function drawTail(doc: Doc, model: ConfirmedPdfModel, top: number): void {
  let y = top + 18

  if (model.commercial.length > 0) {
    doc.fontSize(9).font('Helvetica-Bold').fillColor(DARK).text(PDF_COMMERCIAL_TITLE, L, y)
    y += 14

    const boxX = L + CONTENT_W * 0.46
    const boxW = CONTENT_W - (boxX - L)

    for (const row of model.commercial) {
      if (row.groupStart) {
        doc.moveTo(boxX, y - 3).lineTo(R_EDGE, y - 3).strokeColor(BORDER).lineWidth(0.5).stroke()
      }
      doc.fontSize(row.emphasis ? 9.5 : 8).font(row.emphasis ? 'Helvetica-Bold' : 'Helvetica')
         .fillColor(row.emphasis ? DARK : GRAY)
         .text(row.label, boxX, y, { width: boxW * 0.55 })
      doc.fontSize(row.emphasis ? 9.5 : 8).font(row.emphasis ? 'Helvetica-Bold' : 'Helvetica')
         // MISSING IS MUTED, never rendered as a zero somebody could act on.
         .fillColor(row.missing ? LGRAY : (row.emphasis ? DARK : GRAY))
         .text(row.value, boxX + boxW * 0.55, y, { width: boxW * 0.45, align: 'right' })
      y += row.emphasis ? 16 : 12
    }
  }

  if (model.payment) {
    y += 10
    doc.fontSize(9).font('Helvetica-Bold').fillColor(DARK).text(PDF_PAYMENT_TITLE, L, y)
    y += 13
    for (const field of model.payment) {
      doc.fontSize(6.5).font('Helvetica-Bold').fillColor(LGRAY).text(field.label.toUpperCase(), L, y)
      doc.fontSize(8.5).font('Helvetica').fillColor(DARK).text(field.value, L + 120, y - 1)
      y += 14
    }
  }

  doc.fontSize(6.5).font('Helvetica').fillColor(LGRAY)
     .text(model.currencyNote, L, y + 10, { width: CONTENT_W })
}

function drawFooter(doc: Doc, page: PdfPage, total: number): void {
  const y = PDF_PAGE_HEIGHT - PDF_FOOTER_Y_OFFSET
  doc.moveTo(L, y).lineTo(R_EDGE, y).strokeColor(RED).lineWidth(0.75).stroke()
  doc.fontSize(7.5).font('Helvetica').fillColor(GRAY)
     .text('B-7, Trade World, Basni Phase-II, Jodhpur, Rajasthan 342005', L, y + 9,
       { width: CONTENT_W * 0.6 })
  // PAGE NUMBERS, on every page, including the first.
  doc.fontSize(7.5).font('Helvetica').fillColor(GRAY)
     .text(`Page ${page.index} of ${total}`, L, y + 9, { width: CONTENT_W, align: 'right' })
}

const PDF_FOOTER_Y_OFFSET = 44
