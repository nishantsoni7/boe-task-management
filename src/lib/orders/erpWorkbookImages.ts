// ── Pictures and frozen columns for the ERP sheet ─────────────────────────────
//
// The `xlsx` community build can write neither pictures nor panes, so — like
// the cell styles — they are added to the finished .xlsx by patching its parts:
//   · one picture per product, laid over the first column ("Item Type"), whose
//     cells stay EMPTY (the ERP reads cell values; a picture is not one);
//   · the first four columns frozen, so Item Type, Inventory Code, Item Name and
//     Description stay in view while the rest of the sheet scrolls sideways.
// The header row's words and order are untouched.

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'

/** A picture already sized to its on-sheet size, as JPEG or PNG bytes. */
export type ErpSheetImage = {
  bytes: Uint8Array
  /** On-sheet size in pixels (96 dpi). */
  width: number
  height: number
  ext: 'jpeg' | 'png'
}

/** The square a picture is fitted into, in pixels. */
export const ERP_IMAGE_BOX_PX = 110
/** Column A's width in characters, wide enough for that square. */
export const ERP_IMAGE_COLUMN_CHARS = 20
/** What Excel makes of that width, in pixels (7px a character + 5px padding). */
const COLUMN_A_PX = ERP_IMAGE_COLUMN_CHARS * 7 + 5
/** Breathing room above and below a picture, in pixels. */
const ROW_PAD_PX = 6
/** The columns kept in view: A, B, C and D. */
export const ERP_FROZEN_COLUMNS = 4

const EMU_PER_PX = 9525

/** Row height in points for a row that carries a picture of this height. */
export function erpRowHeightPoints(imageHeightPx: number): number {
  return Math.ceil((Math.max(imageHeightPx, 20) + ROW_PAD_PX * 2) * 0.75)
}

/** Scale (w, h) to fit inside a square of `box` pixels, never enlarging. */
export function fitInBox(width: number, height: number, box = ERP_IMAGE_BOX_PX): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: box, height: box }
  const scale = Math.min(1, box / width, box / height)
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

const NS_XDR = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing'
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'

function anchorXml(image: ErpSheetImage, sheetRow: number, index: number): string {
  const cx = image.width * EMU_PER_PX
  const cy = image.height * EMU_PER_PX
  const colOff = Math.max(0, Math.round((COLUMN_A_PX - image.width) / 2)) * EMU_PER_PX
  const rowOff = ROW_PAD_PX * EMU_PER_PX
  return `<xdr:oneCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>${colOff}</xdr:colOff><xdr:row>${sheetRow - 1}</xdr:row><xdr:rowOff>${rowOff}</xdr:rowOff></xdr:from>`
    + `<xdr:ext cx="${cx}" cy="${cy}"/>`
    + `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${index + 1}" name="Picture ${index}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>`
    + `<xdr:blipFill><a:blip r:embed="rId${index}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>`
    + `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>`
    + `<xdr:clientData/></xdr:oneCellAnchor>`
}

/**
 * Freezes the header row and columns A–D, and lays each picture over column A of its worksheet row.
 *
 * `images[i]` belongs to product i, which sits on worksheet row i + 2 (row 1 is
 * the header); a null leaves that row without a picture. A workbook with no
 * pictures still gets its header and columns frozen.
 */
export function finishErpWorkbook(xlsx: Uint8Array, images: readonly (ErpSheetImage | null)[]): Uint8Array {
  const files: Record<string, Uint8Array> = unzipSync(xlsx)
  const sheetPath = 'xl/worksheets/sheet1.xml'
  if (!files[sheetPath]) return xlsx

  let sheet = strFromU8(files[sheetPath])

  // FROZEN HEADER ROW + COLUMNS. The first cell of the scrolling part is E2.
  const pane = `<sheetView workbookViewId="0"><pane xSplit="${ERP_FROZEN_COLUMNS}" ySplit="1" topLeftCell="E2" activePane="bottomRight" state="frozen"/>`
    + '<selection pane="topRight"/><selection pane="bottomLeft"/><selection pane="bottomRight" activeCell="E2" sqref="E2"/></sheetView>'
  sheet = sheet.replace(/<sheetView workbookViewId="0"\s*\/>/, pane)

  const placed = images
    .map((image, i) => (image ? { image, sheetRow: i + 2 } : null))
    .filter((p): p is { image: ErpSheetImage; sheetRow: number } => p !== null)

  if (placed.length > 0) {
    // Taller rows for the rows that carry a picture.
    for (const { image, sheetRow } of placed) {
      const ht = erpRowHeightPoints(image.height)
      sheet = sheet.replace(new RegExp(`<row r="${sheetRow}"([^>]*)>`), `<row r="${sheetRow}"$1 ht="${ht}" customHeight="1">`)
    }
    sheet = sheet.replace('</worksheet>', '<drawing r:id="rId1"/></worksheet>')

    const anchors = placed.map((p, i) => anchorXml(p.image, p.sheetRow, i + 1)).join('')
    files['xl/drawings/drawing1.xml'] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="${NS_XDR}" xmlns:a="${NS_A}" xmlns:r="${NS_R}">${anchors}</xdr:wsDr>`,
    )
    const drawingRels = placed
      .map((p, i) => `<Relationship Id="rId${i + 1}" Type="${NS_R}/image" Target="../media/image${i + 1}.${p.image.ext}"/>`)
      .join('')
    files['xl/drawings/_rels/drawing1.xml.rels'] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${REL_NS}">${drawingRels}</Relationships>`,
    )
    placed.forEach((p, i) => { files[`xl/media/image${i + 1}.${p.image.ext}`] = p.image.bytes })
    files['xl/worksheets/_rels/sheet1.xml.rels'] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${REL_NS}"><Relationship Id="rId1" Type="${NS_R}/drawing" Target="../drawings/drawing1.xml"/></Relationships>`,
    )
    const types = strFromU8(files['[Content_Types].xml']).replace(
      '</Types>',
      '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>',
    )
    files['[Content_Types].xml'] = strToU8(types)
  }

  files[sheetPath] = strToU8(sheet)
  return zipSync(files)
}
