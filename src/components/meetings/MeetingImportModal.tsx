'use client'

import { useMemo, useRef, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { AlertTriangle, Download, FileSpreadsheet, Upload } from 'lucide-react'
import { colors } from '@/lib/tokens'
import { MeetingModal, MeetingModalActions, MeetingModalError } from './MeetingModal'
import { meetingErrorMessage, logMeetingFailure } from '@/lib/meetings/errors'
import {
  IMPORT_TEMPLATE_COLUMNS, summarizeImportMatches,
  type ImportPreview, type ExistingItemKey,
} from '@/lib/meetings/import'

// Spreadsheet import, in four deliberate steps: download the template, upload a
// file, LOOK at what will happen, then confirm.
//
// The preview is not decoration. It names every row that will not import and
// why, and it states — using the same normalisation the database uses — how
// many lines will be added versus updated. Nothing is written until Confirm.
//
// What an import can never do, stated here because it is the thing people fear:
// it does not delete. A line already in the meeting but absent from the sheet
// is left alone, with its history and its linked task intact.

type Step = 'choose' | 'preview'

export function MeetingImportModal({
  supabase, meetingId, existingKeys, onClose, onImported,
}: {
  supabase: SupabaseClient
  meetingId: string
  /** Order+SKU pairs already in this meeting, for the added/updated split. */
  existingKeys: ExistingItemKey[]
  onClose: () => void
  onImported: (summary: string) => void
}) {
  const [step, setStep]       = useState<Step>('choose')
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [fileName, setFileName] = useState('')
  const [busy, setBusy]       = useState(false)
  const [error, setError]     = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const matches = useMemo(
    () => (preview ? summarizeImportMatches(preview.valid, existingKeys) : null),
    [preview, existingKeys],
  )

  const authHeader = async (): Promise<Record<string, string>> => {
    const { data: { session } } = await supabase.auth.getSession()
    return session ? { Authorization: `Bearer ${session.access_token}` } : {}
  }

  const downloadTemplate = async () => {
    setError(null)
    try {
      const res = await fetch('/api/meetings/template', { headers: await authHeader() })
      if (!res.ok) {
        setError('Could not download the template. Please try again.')
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'BOE-Meeting-Review-Template.xlsx'
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch {
      setError('Could not download the template. Please try again.')
    }
  }

  const handleFile = async (file: File) => {
    setBusy(true)
    setError(null)
    setFileName(file.name)

    try {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch('/api/meetings/import', {
        method: 'POST',
        headers: await authHeader(),
        body: form,
      })
      const body = await res.json()

      if (!res.ok) {
        setError(body?.error ?? 'Could not read that file.')
        setBusy(false)
        return
      }

      setPreview(body as ImportPreview)
      setStep('preview')
    } catch {
      setError('Could not upload the file. Check your connection and try again.')
    }
    setBusy(false)
  }

  const confirm = async () => {
    if (!preview || preview.valid.length === 0 || busy) return
    setBusy(true)
    setError(null)

    const { data, error: rpcErr } = await supabase.rpc('import_meeting_rows', {
      p_meeting_id: meetingId,
      p_rows: preview.valid,
    })

    if (rpcErr) {
      logMeetingFailure('import', rpcErr)
      setError(meetingErrorMessage('import', rpcErr))
      setBusy(false)
      return
    }

    const result = (data ?? {}) as {
      orders_created?: number; orders_matched?: number
      items_created?: number; items_updated?: number
    }
    setBusy(false)
    onImported(
      `Imported — ${result.items_created ?? 0} added, ${result.items_updated ?? 0} updated`,
    )
  }

  return (
    <MeetingModal
      title="Import from Spreadsheet"
      subtitle={step === 'preview' ? fileName : 'One controlled BOE template. Nothing is saved until you confirm.'}
      onClose={onClose}
      width={600}
    >
      {error && <MeetingModalError message={error} />}

      {step === 'choose' ? (
        <>
          <button
            onClick={downloadTemplate}
            style={{
              display: 'flex', alignItems: 'center', gap: '10px', width: '100%',
              padding: '12px 14px', borderRadius: '9px', cursor: 'pointer', textAlign: 'left',
              border: `1px solid ${colors.border}`, background: colors.raised,
            }}
          >
            <Download size={16} strokeWidth={1.9} color={colors.blue} style={{ flexShrink: 0 }} />
            <span style={{ minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: colors.primary }}>
                Download the blank template
              </span>
              <span style={{ display: 'block', fontSize: '11.5px', color: colors.muted, marginTop: '1px' }}>
                {IMPORT_TEMPLATE_COLUMNS.length} columns, with a “How to fill” sheet
              </span>
            </span>
          </button>

          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            style={{ display: 'none' }}
            onChange={e => {
              const file = e.target.files?.[0]
              if (file) handleFile(file)
              if (fileRef.current) fileRef.current.value = ''
            }}
          />

          <button
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
              width: '100%', padding: '22px 14px', borderRadius: '9px',
              border: `1.5px dashed ${colors.borderMed}`, background: 'transparent',
              cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1,
            }}
          >
            <Upload size={16} strokeWidth={1.9} color={colors.secondary} />
            <span style={{ fontSize: '13px', fontWeight: 600, color: colors.secondary }}>
              {busy ? 'Reading the file…' : 'Choose a filled spreadsheet'}
            </span>
          </button>

          <div style={{ fontSize: '11.5px', color: colors.muted, lineHeight: 1.5 }}>
            Rows are matched on <strong>Order Number + SKU</strong>. A matching line is updated, a new
            one is added, and a blank cell leaves the existing value alone. Nothing is ever deleted,
            and no update history or linked task is touched.
          </div>
        </>
      ) : preview ? (
        <>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <PreviewStat label="Rows to import" value={preview.valid.length} tone="primary" />
            <PreviewStat label="New lines"      value={matches?.additions ?? 0} tone="green" />
            <PreviewStat label="Updates"        value={matches?.updates ?? 0} tone="blue" />
            <PreviewStat label="Orders"         value={preview.orderCount} tone="primary" />
            <PreviewStat label="Rows skipped"   value={preview.errors.length} tone={preview.errors.length > 0 ? 'red' : 'muted'} />
          </div>

          {preview.errors.length > 0 && (
            <div style={{
              border: '1px solid rgba(217,79,79,0.28)', borderRadius: '9px', overflow: 'hidden',
            }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: '7px',
                padding: '8px 12px', background: colors.redTint,
                fontSize: '12px', fontWeight: 700, color: '#991B1B',
              }}>
                <AlertTriangle size={13} strokeWidth={2.2} />
                {preview.errors.length} {preview.errors.length === 1 ? 'row' : 'rows'} will NOT be imported
              </div>
              <div style={{ maxHeight: '150px', overflowY: 'auto' }}>
                {preview.errors.map(err => (
                  <div key={err.rowNumber} style={{
                    display: 'flex', gap: '10px', padding: '6px 12px',
                    fontSize: '11.5px', borderTop: `1px solid ${colors.border}`,
                  }}>
                    <span style={{ fontWeight: 700, color: colors.secondary, flexShrink: 0, minWidth: '52px' }}>
                      Row {err.rowNumber}
                    </span>
                    <span style={{ color: colors.secondary }}>{err.message}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {preview.unknownHeaders.length > 0 && (
            <div style={{ fontSize: '11.5px', color: colors.muted }}>
              Ignored columns not in the template: {preview.unknownHeaders.join(', ')}
            </div>
          )}

          {preview.valid.length > 0 ? (
            <div style={{ border: `1px solid ${colors.border}`, borderRadius: '9px', overflow: 'hidden' }}>
              <div style={{
                padding: '7px 12px', background: colors.raised,
                fontSize: '11px', fontWeight: 700, color: colors.muted,
                textTransform: 'uppercase', letterSpacing: '0.05em',
              }}>
                Preview — first {Math.min(8, preview.valid.length)} of {preview.valid.length}
              </div>
              <div style={{ overflowX: 'auto', maxHeight: '190px', overflowY: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11.5px' }}>
                  <thead>
                    <tr>
                      {['Order', 'SKU', 'Product', 'Update', 'Follow-up'].map(h => (
                        <th key={h} style={{
                          padding: '6px 10px', textAlign: 'left', whiteSpace: 'nowrap',
                          fontSize: '10px', fontWeight: 600, color: colors.muted,
                          textTransform: 'uppercase', letterSpacing: '0.04em',
                          borderBottom: `1px solid ${colors.border}`,
                        }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.valid.slice(0, 8).map((row, i) => (
                      <tr key={i} style={{ borderBottom: `1px solid ${colors.border}` }}>
                        <td style={{ padding: '6px 10px', fontWeight: 600, color: colors.primary, whiteSpace: 'nowrap' }}>{row.order_number}</td>
                        <td style={{ padding: '6px 10px', color: colors.primary, whiteSpace: 'nowrap' }}>{row.sku}</td>
                        <td style={{ padding: '6px 10px', color: colors.secondary, maxWidth: '160px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.product_name}</td>
                        <td style={{ padding: '6px 10px', color: colors.secondary, maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.latest_update ?? '—'}</td>
                        <td style={{ padding: '6px 10px', color: colors.secondary, whiteSpace: 'nowrap' }}>{row.next_follow_up_date ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div style={{
              display: 'flex', alignItems: 'center', gap: '9px',
              padding: '14px', borderRadius: '9px', background: colors.raised,
              fontSize: '12.5px', color: colors.secondary,
            }}>
              <FileSpreadsheet size={16} strokeWidth={1.8} color={colors.muted} />
              No row in that file can be imported. Fix the rows listed above and upload it again.
            </div>
          )}

          <MeetingModalActions
            onClose={onClose}
            onSave={confirm}
            saving={busy}
            disabled={preview.valid.length === 0}
            saveLabel={`Import ${preview.valid.length} ${preview.valid.length === 1 ? 'row' : 'rows'}`}
            secondary={
              <button
                onClick={() => { setStep('choose'); setPreview(null); setError(null) }}
                className="boe-btn boe-btn-ghost"
                style={{ padding: '8px 14px', fontSize: '13px' }}
              >
                Choose another file
              </button>
            }
          />
        </>
      ) : null}
    </MeetingModal>
  )
}

function PreviewStat({
  label, value, tone,
}: { label: string; value: number; tone: 'primary' | 'green' | 'blue' | 'red' | 'muted' }) {
  const color = {
    primary: colors.primary, green: '#166534', blue: '#1E40AF', red: '#991B1B', muted: colors.muted,
  }[tone]
  return (
    <div style={{
      flex: '1 1 92px', padding: '8px 10px', borderRadius: '8px',
      border: `1px solid ${colors.border}`, background: colors.raised,
    }}>
      <div style={{ fontSize: '17px', fontWeight: 800, color, fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 }}>
        {value}
      </div>
      <div style={{ fontSize: '10.5px', color: colors.muted, marginTop: '2px' }}>{label}</div>
    </div>
  )
}
