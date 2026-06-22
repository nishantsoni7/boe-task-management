'use client'

import { useEffect, useState } from 'react'
import { colors, font } from '@/lib/tokens'
import { getExt, getFileTypeLabel, IMAGE_EXTS } from '@/lib/attachment-utils'

const CSV_EXTS = ['csv']
const EXCEL_EXTS = ['xlsx', 'xls']
const MAX_PREVIEW_ROWS = 100

type SheetState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; sheetNames: string[]; rowsBySheet: Record<string, string[][]> }

const FILE_TYPE_COLORS: Record<string, { fg: string; bg: string }> = {
  PDF:     { fg: '#D94F4F', bg: 'rgba(217,79,79,0.08)'   },
  Image:   { fg: '#5585E8', bg: 'rgba(85,133,232,0.08)'  },
  Excel:   { fg: '#45A870', bg: 'rgba(69,168,112,0.08)'  },
  Word:    { fg: '#5585E8', bg: 'rgba(85,133,232,0.08)'  },
  CSV:     { fg: '#45A870', bg: 'rgba(69,168,112,0.08)'  },
  Archive: { fg: '#E8A030', bg: 'rgba(232,160,48,0.08)'  },
  File:    { fg: '#8C94A6', bg: 'rgba(140,148,166,0.08)' },
}

interface Props {
  url:      string
  fileName?: string
  onClose:  () => void
}

export function AttachmentPreviewModal({ url, fileName, onClose }: Props) {
  const ext      = getExt(url)
  const label    = getFileTypeLabel(url)
  const isImage  = (IMAGE_EXTS as readonly string[]).includes(ext)
  const isPdf    = ext === 'pdf'
  const isCsv    = CSV_EXTS.includes(ext)
  const isExcel  = EXCEL_EXTS.includes(ext)
  const chip     = FILE_TYPE_COLORS[label] ?? FILE_TYPE_COLORS.File
  const name     = fileName ?? decodeURIComponent(url.split('/').pop() ?? 'Attachment')

  const [sheetState, setSheetState] = useState<SheetState>({ status: 'loading' })
  const [activeSheet, setActiveSheet] = useState<string | null>(null)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  useEffect(() => {
    if (!isCsv) return
    let cancelled = false
    setSheetState({ status: 'loading' })

    ;(async () => {
      try {
        const XLSX = await import('xlsx')
        const res = await fetch(url)
        if (!res.ok) throw new Error('Failed to fetch file')
        const buffer = await res.arrayBuffer()
        const workbook = XLSX.read(buffer, { type: 'array' })
        const sheetNames = workbook.SheetNames
        if (sheetNames.length === 0) throw new Error('No sheets found')

        const rowsBySheet: Record<string, string[][]> = {}
        for (const sheetName of sheetNames) {
          const sheet = workbook.Sheets[sheetName]
          const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false })
          rowsBySheet[sheetName] = rows.slice(0, MAX_PREVIEW_ROWS).map(
            row => row.map(cell => cell ?? '')
          )
        }

        if (cancelled) return
        setSheetState({ status: 'ready', sheetNames, rowsBySheet })
        setActiveSheet(sheetNames[0])
      } catch {
        if (!cancelled) setSheetState({ status: 'error' })
      }
    })()

    return () => { cancelled = true }
  }, [isCsv, url])

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.65)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '16px',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: colors.base,
          borderRadius: '12px',
          boxShadow: '0 8px 40px rgba(0,0,0,0.3)',
          width: '100%',
          maxWidth: isCsv ? '1100px' : '860px',
          maxHeight: '90dvh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: '10px',
          padding: '12px 16px',
          borderBottom: `1px solid ${colors.border}`,
          flexShrink: 0,
          flexWrap: 'wrap',
        }}>
          {/* File type chip */}
          <span style={{
            fontSize: '10px', fontWeight: 700, letterSpacing: '0.05em',
            textTransform: 'uppercase',
            color: chip.fg, background: chip.bg,
            padding: '2px 8px', borderRadius: '20px',
            border: `1px solid ${chip.fg}30`,
            flexShrink: 0,
          }}>
            {label}
          </span>

          {/* File name */}
          <span style={{
            fontSize: '12.5px', fontWeight: 600, color: colors.primary,
            fontFamily: font.body,
            flex: 1, minWidth: 0,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {name}
          </span>

          {/* Sheet selector */}
          {isCsv && sheetState.status === 'ready' && sheetState.sheetNames.length > 1 && (
            <select
              value={activeSheet ?? ''}
              onChange={e => setActiveSheet(e.target.value)}
              style={{
                fontSize: '11px', fontWeight: 500,
                color: colors.primary,
                padding: '4px 8px', borderRadius: '6px',
                border: `1px solid ${colors.border}`,
                background: colors.float,
                flexShrink: 0,
              }}
            >
              {sheetState.sheetNames.map(sn => (
                <option key={sn} value={sn}>{sn}</option>
              ))}
            </select>
          )}

          {/* Actions */}
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexShrink: 0 }}>
            <a
              href={url}
              download
              style={{
                fontSize: '11px', fontWeight: 500,
                color: colors.blue, textDecoration: 'none',
                padding: '4px 10px', borderRadius: '6px',
                border: `1px solid ${colors.blue}40`,
                background: colors.blueTint,
              }}
            >
              ⬇ Download
            </a>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                fontSize: '11px', fontWeight: 500,
                color: colors.secondary, textDecoration: 'none',
                padding: '4px 10px', borderRadius: '6px',
                border: `1px solid ${colors.border}`,
                background: colors.float,
              }}
            >
              ↗ Open in Tab
            </a>
            <button
              onClick={onClose}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: colors.muted, fontSize: '18px', lineHeight: 1,
                padding: '2px 6px', borderRadius: '4px',
              }}
              aria-label="Close preview"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Preview area */}
        <div style={{
          flex: 1, overflow: 'auto',
          display: 'flex', alignItems: isCsv ? 'stretch' : 'center', justifyContent: isCsv ? 'flex-start' : 'center',
          padding: isImage ? '16px' : 0,
          minHeight: 0,
        }}>
          {/* Excel: Office Online viewer for full formatting/merged-cell preview */}
          {isExcel && (
            <iframe
              src={`https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(url)}`}
              title={name}
              style={{ width: '100%', height: '70dvh', border: 'none', display: 'block' }}
            />
          )}
          {/* CSV: plain table preview */}
          {isCsv && sheetState.status === 'loading' && (
            <div style={{ margin: 'auto', textAlign: 'center', padding: '40px 24px' }}>
              <p style={{ fontSize: '13px', color: colors.muted }}>Loading preview…</p>
            </div>
          )}
          {isCsv && sheetState.status === 'error' && (
            <div style={{ margin: 'auto', textAlign: 'center', padding: '40px 24px' }}>
              <div style={{ fontSize: '44px', marginBottom: '14px' }}>📋</div>
              <p style={{ fontSize: '14px', fontWeight: 600, color: colors.primary, marginBottom: '6px' }}>
                Couldn&apos;t preview this file
              </p>
              <p style={{ fontSize: '12px', color: colors.muted, marginBottom: '20px' }}>
                The file may be corrupted or in an unsupported format.
              </p>
              <a
                href={url}
                download
                style={{
                  display: 'inline-block',
                  fontSize: '13px', fontWeight: 500,
                  color: colors.blue, textDecoration: 'none',
                  padding: '8px 18px', borderRadius: '8px',
                  border: `1px solid ${colors.blue}40`,
                  background: colors.blueTint,
                }}
              >
                ⬇ Download {label}
              </a>
            </div>
          )}
          {isCsv && sheetState.status === 'ready' && activeSheet && (
            <div style={{ width: '100%', overflow: 'auto', padding: '12px' }}>
              <table style={{ borderCollapse: 'collapse', fontSize: '12px', fontFamily: font.body, width: '100%' }}>
                <tbody>
                  {sheetState.rowsBySheet[activeSheet].map((row, i) => (
                    <tr key={i} style={{ background: i === 0 ? colors.float : 'transparent' }}>
                      {row.map((cell, j) => (
                        <td
                          key={j}
                          style={{
                            border: `1px solid ${colors.border}`,
                            padding: '4px 8px',
                            whiteSpace: 'nowrap',
                            fontWeight: i === 0 ? 600 : 400,
                            color: colors.primary,
                          }}
                        >
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {sheetState.rowsBySheet[activeSheet].length >= MAX_PREVIEW_ROWS && (
                <p style={{ fontSize: '11px', color: colors.muted, marginTop: '10px' }}>
                  Showing first {MAX_PREVIEW_ROWS} rows. Download the file to see more.
                </p>
              )}
            </div>
          )}
          {isImage && (
            <img
              src={url}
              alt={name}
              style={{ maxWidth: '100%', maxHeight: '100%', borderRadius: '8px', objectFit: 'contain' }}
            />
          )}
          {isPdf && (
            <iframe
              src={url}
              title={name}
              style={{ width: '100%', height: '70dvh', border: 'none', display: 'block' }}
            />
          )}
          {!isImage && !isPdf && !isExcel && !isCsv && (
            <div style={{ textAlign: 'center', padding: '40px 24px' }}>
              <div style={{ fontSize: '44px', marginBottom: '14px' }}>
                {label === 'Excel'   ? '📊'
                 : label === 'Word'  ? '📝'
                 : label === 'CSV'   ? '📋'
                 : label === 'Archive' ? '🗜️'
                 : '📄'}
              </div>
              <p style={{ fontSize: '14px', fontWeight: 600, color: colors.primary, marginBottom: '6px' }}>
                Preview not available
              </p>
              <p style={{ fontSize: '12px', color: colors.muted, marginBottom: '20px' }}>
                {label} files cannot be previewed in the browser.
              </p>
              <a
                href={url}
                download
                style={{
                  display: 'inline-block',
                  fontSize: '13px', fontWeight: 500,
                  color: colors.blue, textDecoration: 'none',
                  padding: '8px 18px', borderRadius: '8px',
                  border: `1px solid ${colors.blue}40`,
                  background: colors.blueTint,
                }}
              >
                ⬇ Download {label}
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
