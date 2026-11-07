'use client'

import { useMemo, type CSSProperties } from 'react'
import type { PreviewSheet, PreviewCell } from '@/lib/attachments/excelPreview'

const GRID = '1px solid #E3E3E3'

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

function cellCss(cell: PreviewCell, gridLines: boolean): CSSProperties {
  const s = cell.style
  const decoration = [s.underline && 'underline', s.strike && 'line-through'].filter(Boolean).join(' ')
  return {
    padding: '0 3px',
    overflow: cell.spill ? 'visible' : 'hidden',
    whiteSpace: s.wrap ? 'pre-wrap' : 'pre',
    wordBreak: s.wrap ? 'break-word' : undefined,
    textAlign: s.hAlign,
    verticalAlign: s.vAlign,
    fontWeight: s.bold ? 700 : 400,
    fontStyle: s.italic ? 'italic' : undefined,
    textDecoration: decoration || undefined,
    fontSize: s.fontSizePx ? `${s.fontSizePx}px` : '15px',
    fontFamily: s.fontFamily,
    color: s.color ?? '#000000',
    background: s.bg,
    borderTop: s.borderTop ?? (gridLines ? GRID : undefined),
    borderRight: s.borderRight ?? (gridLines ? GRID : undefined),
    borderBottom: s.borderBottom ?? (gridLines ? GRID : undefined),
    borderLeft: s.borderLeft ?? (gridLines ? GRID : undefined),
    lineHeight: 1.2,
  }
}

/** Draws one sheet from readWorkbookPreview: the grid, then its pictures on top. */
export function ExcelSheetView({ sheet }: { sheet: PreviewSheet }) {
  // Data URLs, not blob URLs: nothing to revoke, so no effect lifecycle to get wrong.
  const imageUrls = useMemo(() => sheet.images.map(img => `data:${img.mime};base64,${toBase64(img.data)}`), [sheet])

  const width = sheet.colWidths.reduce((a, b) => a + b, 0)

  return (
    <div style={{ position: 'relative', width, background: '#FFFFFF', fontFamily: 'Calibri, Carlito, Arial, sans-serif' }}>
      <table style={{ borderCollapse: 'collapse', tableLayout: 'fixed', width }}>
        <colgroup>
          {sheet.colWidths.map((w, i) => <col key={i} style={{ width: w }} />)}
        </colgroup>
        <tbody>
          {sheet.rows.map((row, r) => (
            <tr key={r} style={{ height: sheet.rowHeights[r] }}>
              {row.map((cell, c) => {
                if (!cell) return null
                // A hidden row or column stays in the table so merges still line
                // up, but draws nothing and takes no space.
                if (sheet.rowHeights[r] === 0 || (cell.colSpan === 1 && sheet.colWidths[c] === 0)) {
                  return <td key={c} colSpan={cell.colSpan} rowSpan={cell.rowSpan} style={{ padding: 0, border: 'none', fontSize: 0 }} />
                }
                return (
                  <td key={c} colSpan={cell.colSpan} rowSpan={cell.rowSpan} style={cellCss(cell, sheet.gridLines)}>
                    {cell.spill ? <span style={{ position: 'relative', zIndex: 1 }}>{cell.text}</span> : cell.text}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {sheet.images.map((img, i) => imageUrls[i] && (
        // Pictures sit at Excel's own anchor positions over the grid; next/image
        // needs known hosts and sizing that blob URLs do not fit.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={i}
          src={imageUrls[i]}
          alt=""
          style={{ position: 'absolute', left: img.left, top: img.top, width: img.width, height: img.height, zIndex: 2, pointerEvents: 'none' }}
        />
      ))}
    </div>
  )
}
