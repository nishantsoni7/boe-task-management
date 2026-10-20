// ── Cell styles for the ERP sheet ─────────────────────────────────────────────
//
// The `xlsx` community build cannot write styles, and the ERP template has a bold
// header on a grey background (owner, 2026-10-20), with cells that wrap so the
// Description's three lines show. So the finished .xlsx is patched: its
// styles.xml is replaced and each cell is given a style index.
//   0 = default, 1 = header (bold, grey, thin border), 2 = body (top-aligned, wrapped)

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'

const STYLES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
  + '<fonts count="2"><font><sz val="10"/><name val="Arial"/></font><font><b/><sz val="10"/><name val="Arial"/></font></fonts>'
  + '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FFDBDBDB"/><bgColor indexed="64"/></patternFill></fill></fills>'
  + '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>'
  + '<border><left style="thin"><color rgb="FFA5A5A5"/></left><right style="thin"><color rgb="FFA5A5A5"/></right>'
  + '<top style="thin"><color rgb="FFA5A5A5"/></top><bottom style="thin"><color rgb="FFA5A5A5"/></bottom><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="3">'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>'
  + '</cellXfs>'
  + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
  + '</styleSheet>'

/** Adds the header and wrap styles to a workbook produced by `xlsx`. */
export function styleErpWorkbook(xlsx: Uint8Array): Uint8Array {
  const files = unzipSync(xlsx)
  const sheetPath = Object.keys(files).find(p => /^xl\/worksheets\/sheet1\.xml$/.test(p))
  if (!sheetPath) return xlsx
  files['xl/styles.xml'] = strToU8(STYLES_XML)
  const sheet = strFromU8(files[sheetPath]).replace(
    /<c r="([A-Z]+)(\d+)"([^>]*?)(\/?)>/g,
    (whole, col: string, row: string, attrs: string, selfClose: string) =>
      / s="/.test(attrs) ? whole : `<c r="${col}${row}"${attrs} s="${row === '1' ? 1 : 2}"${selfClose}>`,
  )
  files[sheetPath] = strToU8(sheet)
  return zipSync(files)
}
