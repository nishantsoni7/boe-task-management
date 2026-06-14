'use client'

import { useEffect, useState, useMemo, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { AttendanceLayout } from '@/components/layout/AttendanceLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import Link from 'next/link'

// ─── Types ────────────────────────────────────────────────────────────────────

type ImportedEmployee = {
  name:          string
  employee_code: string | null
  inserted:      number
  updated:       number
}

type SkippedEmployee = {
  excel_code:   string
  excel_name:   string
  days_skipped: number
  reason:       string
}

type ImportSummary = {
  month:    number
  year:     number
  total:    number
  imported: number
  updated:  number
  skipped:  number
  // kept for compat
  unmappedCodes: string[]
  unmappedCount: number
  errors:        string[]
  // new
  importedEmployees: ImportedEmployee[]
  skippedEmployees:  SkippedEmployee[]
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
]

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AttendanceUploadPage() {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [token, setToken]     = useState('')

  const [file, setFile]         = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [summary, setSummary]   = useState<ImportSummary | null>(null)
  const [importError, setImportError] = useState<string | null>(null)

  const fileRef = useRef<HTMLInputElement>(null)
  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }
      setToken(session.access_token)
      const { data: me } = await supabase
        .from('users')
        .select('id, full_name, email, phone, role, team, position, is_active, created_at, employee_code, joining_date, monthly_salary, office_timing')
        .eq('id', session.user.id)
        .single()
      setProfile(me as UserProfile)
      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null
    setFile(f)
    setSummary(null)
    setImportError(null)
  }

  const handleImport = async () => {
    if (!file) return
    setUploading(true)
    setSummary(null)
    setImportError(null)

    const form = new FormData()
    form.append('file', file)

    try {
      const res  = await fetch('/api/attendance/import', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: form,
      })
      const json = await res.json()
      if (!res.ok) {
        setImportError(json.error ?? 'Import failed')
      } else {
        setSummary(json.summary)
      }
    } catch {
      setImportError('Network error. Please try again.')
    }

    setUploading(false)
  }


  if (loading) return <LoadingScreen />

  const canImport = profile?.role === 'admin' || profile?.role === 'manager'

  const inputStyle: React.CSSProperties = {
    fontSize: 13, border: `1px solid ${colors.border}`, borderRadius: 7,
    background: colors.base, color: colors.primary, outline: 'none',
    padding: '8px 12px', width: '100%', boxSizing: 'border-box',
  }

  return (
    <AttendanceLayout
      profile={profile}
      title="Attendance Upload"
      subtitle="Import attendance records from fingerprint machine export"
      onSignOut={handleSignOut}
    >
      <div style={{ maxWidth: 680, padding: '24px 0' }}>

        <Link
          href="/attendance"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: colors.tertiary, textDecoration: 'none', marginBottom: 24 }}
          onMouseEnter={e => (e.currentTarget.style.color = colors.primary)}
          onMouseLeave={e => (e.currentTarget.style.color = colors.tertiary)}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" />
          </svg>
          Back to Attendance Dashboard
        </Link>

        {!canImport && (
          <div style={{
            padding: '12px 16px', borderRadius: 8, marginBottom: 20,
            background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.2)',
            fontSize: 13, color: '#DC2626',
          }}>
            Only admin and manager users can import attendance records.
          </div>
        )}

        {/* ── Upload card ── */}
        <div style={{
          background: colors.base, border: `1px solid ${colors.border}`,
          borderRadius: 10, padding: '24px',
        }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: colors.primary, marginBottom: 4 }}>
            Fingerprint Machine Import
          </div>
          <div style={{ fontSize: 12, color: colors.tertiary, marginBottom: 20, lineHeight: 1.6 }}>
            Upload the monthly attendance report exported from the fingerprint machine (<code style={{ background: colors.raised, padding: '1px 5px', borderRadius: 4 }}>.xls</code> or <code style={{ background: colors.raised, padding: '1px 5px', borderRadius: 4 }}>.xlsx</code>).
            Employees are matched by <strong>fingerprint employee code</strong> (e.g. 0014, 0017).
            Existing records for the same employee + date will be updated.
          </div>

          {/* Expected format */}
          <div style={{
            background: colors.raised, border: `1px solid ${colors.border}`,
            borderRadius: 8, padding: '12px 14px', marginBottom: 20,
            fontFamily: 'monospace', fontSize: 11.5, color: colors.secondary,
            lineHeight: 1.7,
          }}>
            <div style={{ fontWeight: 700, marginBottom: 4, fontFamily: 'inherit', color: colors.tertiary, textTransform: 'uppercase', fontSize: 10, letterSpacing: '0.06em' }}>Expected file</div>
            Monthly performance report from fingerprint machine
            <div style={{ marginTop: 6, color: colors.tertiary, fontSize: 11 }}>
              • Format: XLS/XLSX monthly attendance export<br />
              • Employee codes must be mapped in Employee Master<br />
              • Days with no punch (--:--) are automatically skipped
            </div>
          </div>

          {/* File picker */}
          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 11, fontWeight: 600, color: colors.tertiary, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 6 }}>
              Select CSV file
            </label>
            <input
              ref={fileRef}
              type="file"
              accept=".xls,.xlsx,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={handleFileChange}
              disabled={!canImport}
              style={inputStyle}
            />
            {file && (
              <div style={{ fontSize: 12, color: colors.tertiary, marginTop: 5 }}>
                {file.name} · {(file.size / 1024).toFixed(1)} KB
              </div>
            )}
          </div>

          {/* Actions */}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <button
              onClick={handleImport}
              disabled={!file || uploading || !canImport}
              style={{
                padding: '9px 22px', fontSize: 13, fontWeight: 600, borderRadius: 7,
                border: 'none', cursor: !file || uploading || !canImport ? 'not-allowed' : 'pointer',
                background: '#3B82F6', color: '#fff',
                opacity: !file || uploading || !canImport ? 0.5 : 1,
              }}
            >
              {uploading ? 'Importing…' : 'Import File'}
            </button>

          </div>
        </div>

        {/* ── Import error ── */}
        {importError && (
          <div style={{
            marginTop: 16, padding: '12px 16px', borderRadius: 8,
            background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.2)',
            fontSize: 13, color: '#DC2626',
          }}>
            <strong>Error:</strong> {importError}
          </div>
        )}

        {/* ── Import report ── */}
        {summary && (
          <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>

            {/* ── Header + stat row ── */}
            <div style={{
              background: colors.base, border: `1px solid ${colors.border}`,
              borderRadius: 10, overflow: 'hidden',
            }}>
              <div style={{ padding: '14px 20px', borderBottom: `1px solid ${colors.border}` }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: colors.primary }}>
                  Import Complete
                  {summary.month > 0 && (
                    <span style={{ fontWeight: 400, color: colors.secondary, marginLeft: 8 }}>
                      — {MONTH_NAMES[summary.month - 1]} {summary.year}
                    </span>
                  )}
                </div>
              </div>
              <div style={{ padding: '16px 20px', display: 'flex', gap: 24, flexWrap: 'wrap' }}>
                {[
                  { label: 'Records Inserted', value: summary.imported, color: '#3B82F6' },
                  { label: 'Records Updated',  value: summary.updated,  color: '#10B981' },
                  { label: 'Records Skipped',  value: summary.skipped,  color: summary.skipped > 0 ? '#F59E0B' : colors.tertiary },
                  { label: 'Employees in File', value: summary.importedEmployees.length + summary.skippedEmployees.length, color: colors.primary },
                ].map(s => (
                  <div key={s.label} style={{ minWidth: 80 }}>
                    <div style={{ fontSize: 24, fontWeight: 700, color: s.color, fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>{s.value}</div>
                    <div style={{ fontSize: 11, color: colors.tertiary, marginTop: 5 }}>{s.label}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* ── Imported employees table ── */}
            {summary.importedEmployees.length > 0 && (
              <div style={{
                background: colors.base, border: `1px solid ${colors.border}`,
                borderRadius: 10, overflow: 'hidden',
              }}>
                <div style={{ padding: '12px 16px', borderBottom: `1px solid ${colors.border}` }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: colors.tertiary, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    Imported ({summary.importedEmployees.length} employee{summary.importedEmployees.length !== 1 ? 's' : ''})
                  </span>
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: colors.raised }}>
                        {['Employee', 'HR Code', 'Inserted', 'Updated'].map(h => (
                          <th key={h} style={{
                            padding: '8px 14px', textAlign: h === 'Inserted' || h === 'Updated' ? 'center' : 'left',
                            fontSize: 11, fontWeight: 600, color: colors.tertiary,
                            textTransform: 'uppercase', letterSpacing: '0.05em',
                            borderBottom: `1px solid ${colors.border}`,
                          }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {summary.importedEmployees.map((emp, i) => (
                        <tr key={i} style={{ borderBottom: i < summary.importedEmployees.length - 1 ? `1px solid ${colors.border}` : 'none' }}>
                          <td style={{ padding: '9px 14px', color: colors.primary, fontWeight: 500 }}>{emp.name}</td>
                          <td style={{ padding: '9px 14px', color: colors.tertiary, fontFamily: 'monospace', fontSize: 12 }}>
                            {emp.employee_code ?? '—'}
                          </td>
                          <td style={{ padding: '9px 14px', textAlign: 'center', color: emp.inserted > 0 ? '#3B82F6' : colors.tertiary, fontWeight: emp.inserted > 0 ? 600 : 400 }}>
                            {emp.inserted}
                          </td>
                          <td style={{ padding: '9px 14px', textAlign: 'center', color: emp.updated > 0 ? '#10B981' : colors.tertiary, fontWeight: emp.updated > 0 ? 600 : 400 }}>
                            {emp.updated}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ── Skipped employees ── */}
            {summary.skippedEmployees.length > 0 && (
              <div style={{
                border: '1.5px solid #F59E0B',
                background: 'rgba(245,158,11,0.05)',
                borderRadius: 10, overflow: 'hidden',
              }}>
                {/* Header */}
                <div style={{
                  padding: '12px 16px', borderBottom: '1px solid rgba(245,158,11,0.25)',
                  display: 'flex', alignItems: 'center', gap: 10,
                }}>
                  <span style={{ fontSize: 15, lineHeight: 1 }}>⚠️</span>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#92400E' }}>
                      {summary.skippedEmployees.length} employee{summary.skippedEmployees.length !== 1 ? 's' : ''} skipped
                    </div>
                    <div style={{ fontSize: 12, color: '#78350F', marginTop: 2 }}>
                      Records were not imported. Fix the issues below and re-upload.
                    </div>
                  </div>
                </div>

                {/* Skipped table */}
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: 'rgba(245,158,11,0.08)' }}>
                        {['Employee (Excel)', 'Code', 'Days Skipped', 'Reason'].map(h => (
                          <th key={h} style={{
                            padding: '8px 14px', textAlign: h === 'Days Skipped' ? 'center' : 'left',
                            fontSize: 11, fontWeight: 600, color: '#92400E',
                            textTransform: 'uppercase', letterSpacing: '0.05em',
                            borderBottom: '1px solid rgba(245,158,11,0.2)',
                          }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {summary.skippedEmployees.map((s, i) => (
                        <tr key={i} style={{ borderBottom: i < summary.skippedEmployees.length - 1 ? '1px solid rgba(245,158,11,0.15)' : 'none' }}>
                          <td style={{ padding: '9px 14px', color: '#78350F', fontWeight: 500 }}>
                            {s.excel_name || '—'}
                          </td>
                          <td style={{ padding: '9px 14px', color: '#92400E', fontFamily: 'monospace', fontSize: 12 }}>
                            {s.excel_code}
                          </td>
                          <td style={{ padding: '9px 14px', textAlign: 'center', color: '#92400E', fontWeight: 600 }}>
                            {s.days_skipped}
                          </td>
                          <td style={{ padding: '9px 14px', color: '#78350F', fontSize: 12 }}>
                            {s.reason}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* CTA if any unmapped codes */}
                {summary.unmappedCount > 0 && (
                  <div style={{ padding: '10px 16px 14px' }}>
                    <Link
                      href="/attendance/employees"
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 6,
                        padding: '7px 16px', borderRadius: 7,
                        fontSize: 12.5, fontWeight: 600,
                        background: '#F59E0B', color: '#fff',
                        textDecoration: 'none',
                      }}
                    >
                      Set Fingerprint Codes in Employee Master →
                    </Link>
                  </div>
                )}
              </div>
            )}

            {/* ── Row-level punch errors (only if present and not already in skipped table) ── */}
            {summary.errors.length > 0 && (
              <div style={{
                background: colors.base, border: `1px solid ${colors.border}`,
                borderRadius: 10, padding: '14px 16px',
              }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: colors.tertiary, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
                  Row-level errors ({summary.errors.length})
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {summary.errors.map((e, i) => (
                    <div key={i} style={{
                      fontSize: 12, color: '#DC2626',
                      padding: '5px 10px', borderRadius: 5,
                      background: 'rgba(239,68,68,0.06)',
                      fontFamily: 'monospace',
                    }}>
                      {e}
                    </div>
                  ))}
                </div>
              </div>
            )}

          </div>
        )}

      </div>
    </AttendanceLayout>
  )
}
