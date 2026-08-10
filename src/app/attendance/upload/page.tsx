'use client'

import { useEffect, useState, useMemo, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { AttendancePayrollLayout } from '@/components/layout/AttendancePayrollLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import Link from 'next/link'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'

// ─── Types ────────────────────────────────────────────────────────────────────

type UnmatchedEntry = { excel_code: string; excel_name: string; days: number }

/** One code an admin named an employee for, as the server resolved it. */
type AppliedMapping = {
  excel_code:    string
  excel_name:    string
  user_id:       string
  employee_name: string
  days:          number
}

/** The choice sent back to both routes. */
type ManualMapping = { excel_code: string; user_id: string }

/** An employee the admin can pick, from /api/employee-list. */
type SelectableEmployee = {
  id:                        string
  full_name:                 string | null
  employee_code?:            string | null
  fingerprint_employee_code?: string | null
  is_active?:                boolean | null
}

type ModifiedRecord = {
  employeeName: string
  date:         string
  oldCheckIn:   string
  newCheckIn:   string
  oldCheckOut:  string
  newCheckOut:  string
}

type PreviewSummary = {
  fileName:          string
  deviceFormat:      string
  month:             number
  year:              number
  totalRows:         number
  detectedEmployees: number
  matchedCount:      number
  unmatchedCount:    number
  unmatchedEntries:  UnmatchedEntry[]
  manualMappings:    AppliedMapping[]
  newCount:          number
  unchangedCount:    number
  modifiedCount:     number
  modifiedRecords:   ModifiedRecord[]
  allUnchanged:      boolean
  payrollStatus:     string | null
}

type ImportedEmployee = {
  name:          string
  employee_code: string | null
  inserted:      number
  updated:       number
  unchanged:     number
}

type SkippedEmployee = {
  excel_code:   string
  excel_name:   string
  days_skipped: number
  reason:       string
}

type ImportResult = {
  month:     number
  year:      number
  total:     number
  imported:  number
  updated:   number
  unchanged: number
  skipped:   number
  importedEmployees: ImportedEmployee[]
  skippedEmployees:  SkippedEmployee[]
  manualMappings?:   AppliedMapping[]
  errors:    string[]
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
]

function StatBox({ label, value, color }: { label: string; value: number | string; color?: string }) {
  return (
    <div style={{ minWidth: 88 }}>
      <div style={{ fontSize: 24, fontWeight: 700, color: color ?? colors.primary, fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>
        {value}
      </div>
      <div style={{ fontSize: 11, color: colors.tertiary, marginTop: 5 }}>{label}</div>
    </div>
  )
}

function SectionCard({ children, warning }: { children: React.ReactNode; warning?: boolean }) {
  return (
    <div style={{
      background: warning ? 'rgba(245,158,11,0.05)' : colors.base,
      border: `1.5px solid ${warning ? 'rgba(245,158,11,0.5)' : colors.border}`,
      borderRadius: 10, overflow: 'hidden',
    }}>
      {children}
    </div>
  )
}

/**
 * The employees whose text matches `query`, best-effort and case-insensitive.
 *
 * Name, HR code and fingerprint code are all searched because an admin
 * reconciling a file knows the person by whichever of those the file gave them.
 * An empty query returns everyone, so opening the picker shows a list rather
 * than a blank box the admin has to guess at.
 */
function searchEmployees(employees: SelectableEmployee[], query: string): SelectableEmployee[] {
  const q = query.trim().toLowerCase()
  if (!q) return employees
  return employees.filter(e =>
    (e.full_name ?? '').toLowerCase().includes(q) ||
    (e.employee_code ?? '').toLowerCase().includes(q) ||
    (e.fingerprint_employee_code ?? '').toLowerCase().includes(q)
  )
}

function CardHeader({ children, warning }: { children: React.ReactNode; warning?: boolean }) {
  return (
    <div style={{
      padding: '12px 16px',
      borderBottom: `1px solid ${warning ? 'rgba(245,158,11,0.25)' : colors.border}`,
      fontSize: 11, fontWeight: 600,
      color: warning ? '#92400E' : colors.tertiary,
      textTransform: 'uppercase' as const, letterSpacing: '0.06em',
    }}>
      {children}
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AttendanceUploadPage() {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [token, setToken]     = useState('')

  const [file, setFile]         = useState<File | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [preview, setPreview]   = useState<PreviewSummary | null>(null)
  const [result, setResult]     = useState<ImportResult | null>(null)
  const [pageError, setPageError] = useState<string | null>(null)

  // ── Manual employee matching ──
  // The codes an admin has named an employee for. Held here, sent to BOTH the
  // preview and the import, and never applied client-side: the server resolves
  // them, so the numbers on screen are the numbers the import will produce.
  const [manualMappings, setManualMappings] = useState<ManualMapping[]>([])
  const [employees, setEmployees]           = useState<SelectableEmployee[]>([])
  const [employeesError, setEmployeesError] = useState<string | null>(null)
  const [loadingEmployees, setLoadingEmployees] = useState(false)
  /** Which unmatched code currently has its search box open. */
  const [pickerFor, setPickerFor] = useState<string | null>(null)
  const [pickerQuery, setPickerQuery] = useState('')
  /**
   * A chosen employee awaiting confirmation. Choosing is not assigning — this
   * writes attendance onto a named person, so the admin says who and then says
   * yes, rather than a stray click in a list doing both.
   */
  const [pendingChoice, setPendingChoice] =
    useState<{ entry: UnmatchedEntry; employee: SelectableEmployee } | null>(null)

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
        .select(USER_PROFILE_COLUMNS)
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

  const resetManualMatching = () => {
    setManualMappings([])
    setPickerFor(null)
    setPickerQuery('')
    setPendingChoice(null)
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null
    setFile(f)
    setPreview(null)
    setResult(null)
    setPageError(null)
    // A new file means new codes. Carrying the previous file's selections over
    // would offer to import this file's days under the last file's names.
    resetManualMatching()
  }

  /** The employee list for the picker, fetched once and only when it is needed. */
  const loadEmployees = async () => {
    if (employees.length > 0 || loadingEmployees) return
    setLoadingEmployees(true)
    setEmployeesError(null)
    try {
      const res  = await fetch('/api/employee-list', { headers: { 'Authorization': `Bearer ${token}` } })
      const json = await res.json()
      if (!res.ok) {
        setEmployeesError(json.error ?? 'Could not load the employee list')
      } else {
        const list = (json.employees ?? []) as SelectableEmployee[]
        setEmployees(
          list
            .filter(e => e.is_active !== false)
            .sort((a, b) => (a.full_name ?? '').localeCompare(b.full_name ?? ''))
        )
      }
    } catch {
      setEmployeesError('Network error while loading the employee list')
    }
    setLoadingEmployees(false)
  }

  // Phase 1: Preview
  //
  // `mappings` is passed explicitly rather than read from state because a
  // preview re-run immediately follows a selection, and React state is not yet
  // the new value at that point. Sending the list we just built is what keeps
  // the preview and the import describing the same mapping.
  const handlePreview = async (mappings: ManualMapping[] = manualMappings) => {
    if (!file) return
    setPreviewing(true)
    setResult(null)
    setPageError(null)

    const form = new FormData()
    form.append('file', file)
    if (mappings.length > 0) form.append('manualMappings', JSON.stringify(mappings))

    try {
      const res  = await fetch('/api/attendance/preview', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: form,
      })
      const json = await res.json()
      if (!res.ok) {
        setPageError(json.error ?? 'Preview failed')
      } else {
        setPreview(json.preview)
      }
    } catch {
      setPageError('Network error. Please try again.')
    }

    setPreviewing(false)
  }

  /** Confirmed choice → new mapping list → a fresh preview built from it. */
  const handleConfirmChoice = async () => {
    if (!pendingChoice) return
    const next: ManualMapping[] = [
      ...manualMappings.filter(m => m.excel_code !== pendingChoice.entry.excel_code),
      { excel_code: pendingChoice.entry.excel_code, user_id: pendingChoice.employee.id },
    ]
    setManualMappings(next)
    setPendingChoice(null)
    setPickerFor(null)
    setPickerQuery('')
    await handlePreview(next)
  }

  const handleRemoveMapping = async (excelCode: string) => {
    const next = manualMappings.filter(m => m.excel_code !== excelCode)
    setManualMappings(next)
    setPendingChoice(null)
    setPickerFor(null)
    setPickerQuery('')
    await handlePreview(next)
  }

  // Phase 2: Confirm Import
  const handleConfirmImport = async () => {
    if (!file || !preview) return
    setConfirming(true)
    setPageError(null)

    const form = new FormData()
    form.append('file', file)
    // The same selections the preview above was built from.
    if (manualMappings.length > 0) form.append('manualMappings', JSON.stringify(manualMappings))

    try {
      const res  = await fetch('/api/attendance/import', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: form,
      })
      const json = await res.json()
      if (!res.ok) {
        setPageError(json.error ?? 'Import failed')
      } else {
        setResult(json.summary)
        setPreview(null)
        setFile(null)
        resetManualMatching()
        if (fileRef.current) fileRef.current.value = ''
      }
    } catch {
      setPageError('Network error. Please try again.')
    }

    setConfirming(false)
  }

  const handleCancel = () => {
    setPreview(null)
    setResult(null)
    setPageError(null)
    setFile(null)
    resetManualMatching()
    if (fileRef.current) fileRef.current.value = ''
  }

  if (loading) return <LoadingScreen />

  const canImport = profile?.role === 'admin' || profile?.role === 'manager'

  const inputStyle: React.CSSProperties = {
    fontSize: 13, border: `1px solid ${colors.border}`, borderRadius: 7,
    background: colors.base, color: colors.primary, outline: 'none',
    padding: '8px 12px', width: '100%', boxSizing: 'border-box',
  }

  const btnBase: React.CSSProperties = {
    padding: '9px 22px', fontSize: 13, fontWeight: 600, borderRadius: 7,
    border: 'none', cursor: 'pointer',
  }

  return (
    <AttendancePayrollLayout
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

        {/* ── Upload card (hidden after preview/result) ── */}
        {!preview && !result && (
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
            </div>

            <div style={{
              background: colors.raised, border: `1px solid ${colors.border}`,
              borderRadius: 8, padding: '12px 14px', marginBottom: 20,
              fontFamily: 'monospace', fontSize: 11.5, color: colors.secondary, lineHeight: 1.7,
            }}>
              <div style={{ fontWeight: 700, marginBottom: 4, fontFamily: 'inherit', color: colors.tertiary, textTransform: 'uppercase', fontSize: 10, letterSpacing: '0.06em' }}>Expected file</div>
              Monthly performance report from fingerprint machine
              <div style={{ marginTop: 6, color: colors.tertiary, fontSize: 11 }}>
                • Format: XLS/XLSX monthly attendance export<br />
                • Employee codes must be mapped in Employee Master<br />
                • Days with no punch (--:--) are automatically skipped
              </div>
            </div>

            <div style={{ marginBottom: 20 }}>
              <label style={{ fontSize: 11, fontWeight: 600, color: colors.tertiary, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 6 }}>
                Select file
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

            <button
              onClick={() => handlePreview()}
              disabled={!file || previewing || !canImport}
              style={{
                ...btnBase,
                background: '#3B82F6', color: '#fff',
                opacity: !file || previewing || !canImport ? 0.5 : 1,
                cursor: !file || previewing || !canImport ? 'not-allowed' : 'pointer',
              }}
            >
              {previewing ? 'Analysing…' : 'Preview Import'}
            </button>
          </div>
        )}

        {/* ── Page-level error ── */}
        {pageError && (
          <div style={{
            marginTop: 16, padding: '12px 16px', borderRadius: 8,
            background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.2)',
            fontSize: 13, color: '#DC2626',
          }}>
            <strong>Error:</strong> {pageError}
            <button
              onClick={() => setPageError(null)}
              style={{ marginLeft: 12, fontSize: 12, color: '#DC2626', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
            >
              Dismiss
            </button>
          </div>
        )}

        {/* ════════════════════════════════════════════════════════════════
            PHASE 1: PREVIEW CARDS
        ════════════════════════════════════════════════════════════════ */}
        {preview && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

            {/* ── Status banner ── */}
            {preview.allUnchanged ? (
              <div style={{
                padding: '12px 16px', borderRadius: 8,
                background: 'rgba(239,68,68,0.07)',
                border: '1.5px solid rgba(239,68,68,0.3)',
                fontSize: 13, color: '#DC2626',
                display: 'flex', alignItems: 'flex-start', gap: 10,
              }}>
                <span style={{ fontSize: 16, lineHeight: 1, flexShrink: 0 }}>🚫</span>
                <span>This attendance data already appears to be imported. No changes found.</span>
              </div>
            ) : preview.modifiedCount > 0 && preview.newCount === 0 ? (
              <div style={{
                padding: '12px 16px', borderRadius: 8,
                background: 'rgba(139,92,246,0.07)',
                border: '1.5px solid rgba(139,92,246,0.4)',
                fontSize: 13, color: '#5B21B6',
                display: 'flex', alignItems: 'flex-start', gap: 10,
              }}>
                <span style={{ fontSize: 16, lineHeight: 1, flexShrink: 0 }}>✏️</span>
                <span>{preview.modifiedCount} record{preview.modifiedCount !== 1 ? 's' : ''} have different timings and will be corrected. Review the changes below before confirming.</span>
              </div>
            ) : preview.modifiedCount > 0 ? (
              <div style={{
                padding: '12px 16px', borderRadius: 8,
                background: 'rgba(139,92,246,0.07)',
                border: '1.5px solid rgba(139,92,246,0.4)',
                fontSize: 13, color: '#5B21B6',
                display: 'flex', alignItems: 'flex-start', gap: 10,
              }}>
                <span style={{ fontSize: 16, lineHeight: 1, flexShrink: 0 }}>✏️</span>
                <span>{preview.newCount} new record{preview.newCount !== 1 ? 's' : ''} will be added and {preview.modifiedCount} existing record{preview.modifiedCount !== 1 ? 's' : ''} will be corrected.</span>
              </div>
            ) : null}

            {/* Section 1: File Summary */}
            <SectionCard>
              <CardHeader>Section 1 — File Summary</CardHeader>
              <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                {[
                  { label: 'File name',       value: preview.fileName },
                  { label: 'Device format',   value: preview.deviceFormat },
                  { label: 'Month detected',  value: preview.month > 0 ? MONTH_NAMES[preview.month - 1] : '—' },
                  { label: 'Year detected',   value: preview.year > 0 ? String(preview.year) : '—' },
                  { label: 'Total rows found', value: String(preview.totalRows) },
                ].map(({ label, value }) => (
                  <div key={label} style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    <span style={{ fontSize: 12, color: colors.tertiary, minWidth: 140 }}>{label}</span>
                    <span style={{ fontSize: 13, color: colors.primary, fontWeight: 500 }}>{value}</span>
                  </div>
                ))}
              </div>
            </SectionCard>

            {/* Section 2: Employee Matching */}
            <SectionCard warning={preview.unmatchedCount > 0}>
              <CardHeader warning={preview.unmatchedCount > 0}>Section 2 — Employee Matching</CardHeader>
              <div style={{ padding: '16px 20px' }}>
                <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap', marginBottom: preview.unmatchedEntries.length > 0 ? 16 : 0 }}>
                  <StatBox label="Employees detected" value={preview.detectedEmployees} />
                  <StatBox label="Matched" value={preview.matchedCount} color="#10B981" />
                  <StatBox label="Unmatched" value={preview.unmatchedCount} color={preview.unmatchedCount > 0 ? '#F59E0B' : colors.tertiary} />
                </div>

                {/* Codes an admin named an employee for. Shown as the server
                    resolved them, so what is confirmed here is what will run. */}
                {preview.manualMappings.length > 0 && (
                  <div style={{ marginBottom: preview.unmatchedEntries.length > 0 ? 16 : 0 }}>
                    <div style={{ fontSize: 11, color: '#065F46', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
                      Manually matched — these will be imported
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {preview.manualMappings.map(m => (
                        <div key={m.excel_code} style={{
                          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                          padding: '9px 12px', borderRadius: 8,
                          background: 'rgba(16,185,129,0.07)',
                          border: '1px solid rgba(16,185,129,0.3)',
                          fontSize: 12.5, color: '#065F46',
                        }}>
                          <span style={{ fontFamily: 'monospace' }}>{m.excel_code}</span>
                          <span style={{ color: '#047857' }}>{m.excel_name || 'unnamed in file'}</span>
                          <span style={{ color: '#047857' }}>{m.days} day{m.days !== 1 ? 's' : ''}</span>
                          <span aria-hidden>→</span>
                          <strong style={{ fontWeight: 700 }}>{m.employee_name}</strong>
                          <button
                            onClick={() => handleRemoveMapping(m.excel_code)}
                            disabled={previewing || confirming}
                            style={{
                              marginLeft: 'auto', fontSize: 11.5, fontWeight: 600,
                              padding: '4px 10px', borderRadius: 6,
                              background: 'transparent', color: '#065F46',
                              border: '1px solid rgba(16,185,129,0.45)',
                              cursor: previewing || confirming ? 'not-allowed' : 'pointer',
                              opacity: previewing || confirming ? 0.5 : 1,
                            }}
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {preview.unmatchedEntries.length > 0 && (
                  <>
                    <div style={{ fontSize: 11, color: '#92400E', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
                      Unmatched employees — skipped unless you choose who they are
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {preview.unmatchedEntries.map(u => {
                        const open      = pickerFor === u.excel_code
                        const confirmed = pendingChoice?.entry.excel_code === u.excel_code
                        const matches   = open && !confirmed
                          ? searchEmployees(employees, pickerQuery).slice(0, 40)
                          : []
                        return (
                          <div key={u.excel_code} style={{
                            padding: '10px 12px', borderRadius: 8,
                            background: 'rgba(245,158,11,0.06)',
                            border: '1px solid rgba(245,158,11,0.28)',
                          }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 12.5, color: '#78350F' }}>
                              <span style={{ fontFamily: 'monospace', color: '#92400E' }}>{u.excel_code}</span>
                              <span style={{ fontWeight: 500 }}>{u.excel_name || 'unnamed in file'}</span>
                              <span style={{ color: '#92400E' }}>{u.days} day{u.days !== 1 ? 's' : ''}</span>
                              {!open && (
                                <button
                                  onClick={() => { setPickerFor(u.excel_code); setPickerQuery(''); setPendingChoice(null); loadEmployees() }}
                                  disabled={previewing || confirming}
                                  style={{
                                    marginLeft: 'auto', fontSize: 11.5, fontWeight: 600,
                                    padding: '5px 12px', borderRadius: 6,
                                    background: '#F59E0B', color: '#fff', border: 'none',
                                    cursor: previewing || confirming ? 'not-allowed' : 'pointer',
                                    opacity: previewing || confirming ? 0.5 : 1,
                                  }}
                                >
                                  Choose employee
                                </button>
                              )}
                            </div>

                            {/* Confirmation gate — naming the employee and
                                agreeing to import as them are two steps. */}
                            {confirmed && pendingChoice && (
                              <div style={{
                                marginTop: 10, padding: '10px 12px', borderRadius: 7,
                                background: colors.base, border: `1.5px solid ${colors.border}`,
                              }}>
                                <div style={{ fontSize: 12.5, color: colors.primary, lineHeight: 1.6 }}>
                                  Import {u.days} day{u.days !== 1 ? 's' : ''} recorded under code{' '}
                                  <strong style={{ fontFamily: 'monospace' }}>{u.excel_code}</strong>
                                  {u.excel_name ? ` ("${u.excel_name}")` : ''} as{' '}
                                  <strong>{pendingChoice.employee.full_name ?? 'this employee'}</strong>?
                                </div>
                                <div style={{ fontSize: 11.5, color: colors.tertiary, marginTop: 6 }}>
                                  These punches will be written to that employee&apos;s attendance and counted in their payroll.
                                </div>
                                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                                  <button
                                    onClick={handleConfirmChoice}
                                    disabled={previewing}
                                    style={{
                                      fontSize: 12, fontWeight: 600, padding: '6px 14px', borderRadius: 6,
                                      background: '#10B981', color: '#fff', border: 'none',
                                      cursor: previewing ? 'not-allowed' : 'pointer',
                                      opacity: previewing ? 0.5 : 1,
                                    }}
                                  >
                                    {previewing ? 'Applying…' : 'Yes, import as this employee'}
                                  </button>
                                  <button
                                    onClick={() => setPendingChoice(null)}
                                    disabled={previewing}
                                    style={{
                                      fontSize: 12, fontWeight: 600, padding: '6px 14px', borderRadius: 6,
                                      background: colors.raised, color: colors.secondary,
                                      border: `1px solid ${colors.border}`,
                                      cursor: previewing ? 'not-allowed' : 'pointer',
                                    }}
                                  >
                                    Back
                                  </button>
                                </div>
                              </div>
                            )}

                            {/* Searchable selector */}
                            {open && !confirmed && (
                              <div style={{ marginTop: 10 }}>
                                <input
                                  autoFocus
                                  value={pickerQuery}
                                  onChange={e => setPickerQuery(e.target.value)}
                                  placeholder="Search by name or employee code…"
                                  style={{ ...inputStyle, fontSize: 12.5 }}
                                />
                                {loadingEmployees && (
                                  <div style={{ fontSize: 12, color: colors.tertiary, padding: '8px 2px' }}>Loading employees…</div>
                                )}
                                {employeesError && (
                                  <div style={{ fontSize: 12, color: '#DC2626', padding: '8px 2px' }}>{employeesError}</div>
                                )}
                                {!loadingEmployees && !employeesError && (
                                  <div style={{
                                    marginTop: 6, maxHeight: 210, overflowY: 'auto',
                                    border: `1px solid ${colors.border}`, borderRadius: 7,
                                    background: colors.base,
                                  }}>
                                    {matches.length === 0 ? (
                                      <div style={{ fontSize: 12, color: colors.tertiary, padding: '10px 12px' }}>
                                        No employee matches that search.
                                      </div>
                                    ) : matches.map(emp => (
                                      <button
                                        key={emp.id}
                                        onClick={() => setPendingChoice({ entry: u, employee: emp })}
                                        style={{
                                          display: 'block', width: '100%', textAlign: 'left',
                                          padding: '8px 12px', fontSize: 12.5,
                                          background: 'transparent', border: 'none',
                                          borderBottom: `1px solid ${colors.border}`,
                                          color: colors.primary, cursor: 'pointer',
                                        }}
                                      >
                                        <span style={{ fontWeight: 500 }}>{emp.full_name ?? 'Unnamed'}</span>
                                        {emp.employee_code && (
                                          <span style={{ color: colors.tertiary, fontFamily: 'monospace', fontSize: 11, marginLeft: 8 }}>
                                            {emp.employee_code}
                                          </span>
                                        )}
                                      </button>
                                    ))}
                                  </div>
                                )}
                                <button
                                  onClick={() => { setPickerFor(null); setPickerQuery('') }}
                                  style={{
                                    marginTop: 8, fontSize: 11.5, fontWeight: 600,
                                    padding: '5px 12px', borderRadius: 6,
                                    background: colors.raised, color: colors.secondary,
                                    border: `1px solid ${colors.border}`, cursor: 'pointer',
                                  }}
                                >
                                  Cancel
                                </button>
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>

                    <div style={{ padding: '10px 0 0' }}>
                      <Link
                        href="/attendance/employees"
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: 6,
                          padding: '6px 14px', borderRadius: 7,
                          fontSize: 12, fontWeight: 600,
                          background: '#F59E0B', color: '#fff',
                          textDecoration: 'none',
                        }}
                      >
                        Fix Fingerprint Codes in Employee Master →
                      </Link>
                    </div>
                  </>
                )}
              </div>
            </SectionCard>

            {/* Section 3: Import Safety */}
            <SectionCard warning={preview.allUnchanged}>
              <CardHeader warning={preview.allUnchanged}>Section 3 — Import Safety</CardHeader>
              <div style={{ padding: '16px 20px', display: 'flex', gap: 32, flexWrap: 'wrap' }}>
                <StatBox label="New records"      value={preview.newCount}       color={preview.newCount > 0       ? '#3B82F6' : colors.tertiary} />
                <StatBox label="Modified records" value={preview.modifiedCount}  color={preview.modifiedCount > 0  ? '#8B5CF6' : colors.tertiary} />
                <StatBox label="Unchanged"        value={preview.unchangedCount} color={preview.unchangedCount > 0 ? '#10B981' : colors.tertiary} />
              </div>
              {preview.allUnchanged && (
                <div style={{ padding: '0 20px 16px', fontSize: 13, color: '#DC2626', fontWeight: 500 }}>
                  This attendance data already appears to be imported. No changes found.
                </div>
              )}
            </SectionCard>

            {/* Payroll lock / generated warnings — shown whenever this import would write to a locked/generated period */}
            {preview.payrollStatus === 'locked' && (
              <div style={{
                padding: '12px 16px', borderRadius: 8,
                background: 'rgba(239,68,68,0.07)',
                border: '1.5px solid rgba(239,68,68,0.35)',
                fontSize: 13, color: '#DC2626',
                display: 'flex', alignItems: 'flex-start', gap: 10,
              }}>
                <span style={{ fontSize: 16, lineHeight: 1, flexShrink: 0 }}>🔒</span>
                <span><strong>Payroll is locked for this month.</strong> Attendance cannot be imported or corrected.</span>
              </div>
            )}
            {preview.payrollStatus === 'generated' && (
              <div style={{
                padding: '12px 16px', borderRadius: 8,
                background: 'rgba(245,158,11,0.07)',
                border: '1.5px solid rgba(245,158,11,0.45)',
                fontSize: 13, color: '#92400E',
                display: 'flex', alignItems: 'flex-start', gap: 10,
              }}>
                <span style={{ fontSize: 16, lineHeight: 1, flexShrink: 0 }}>⚠️</span>
                <span><strong>Payroll has already been generated for this month.</strong> Applying corrections may require payroll regeneration.</span>
              </div>
            )}

            {/* Modified records detail */}
            {preview.modifiedRecords.length > 0 && (
              <SectionCard>
                <CardHeader>Modified Records — timings will be corrected</CardHeader>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr style={{ background: 'rgba(139,92,246,0.07)' }}>
                        {['Employee', 'Date', 'Old Check-in', 'New Check-in', 'Old Check-out', 'New Check-out'].map(h => (
                          <th key={h} style={{
                            padding: '7px 12px', textAlign: 'left',
                            fontSize: 10, fontWeight: 600, color: '#5B21B6',
                            textTransform: 'uppercase', letterSpacing: '0.05em',
                            borderBottom: '1px solid rgba(139,92,246,0.2)',
                          }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.modifiedRecords.map((r, i) => (
                        <tr key={i} style={{ borderBottom: i < preview.modifiedRecords.length - 1 ? '1px solid rgba(139,92,246,0.1)' : 'none' }}>
                          <td style={{ padding: '8px 12px', color: colors.primary, fontWeight: 500 }}>{r.employeeName}</td>
                          <td style={{ padding: '8px 12px', color: colors.secondary, fontFamily: 'monospace', fontSize: 11 }}>{r.date}</td>
                          <td style={{ padding: '8px 12px', color: '#9CA3AF', fontFamily: 'monospace' }}>{r.oldCheckIn}</td>
                          <td style={{ padding: '8px 12px', color: '#7C3AED', fontFamily: 'monospace', fontWeight: 600 }}>{r.newCheckIn}</td>
                          <td style={{ padding: '8px 12px', color: '#9CA3AF', fontFamily: 'monospace' }}>{r.oldCheckOut}</td>
                          <td style={{ padding: '8px 12px', color: '#7C3AED', fontFamily: 'monospace', fontWeight: 600 }}>{r.newCheckOut}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </SectionCard>
            )}

            {/* Section 4: Actions */}
            {(() => {
              const payrollLocked   = preview.payrollStatus === 'locked'
              const onlyCorrections = preview.newCount === 0 && preview.modifiedCount > 0
              const mixed           = preview.newCount > 0  && preview.modifiedCount > 0
              const isDisabled      = preview.allUnchanged || payrollLocked || confirming
              const buttonLabel     = confirming
                ? 'Importing…'
                : preview.allUnchanged
                  ? 'No Changes to Import'
                  : payrollLocked
                    ? 'Import Blocked (Payroll Locked)'
                    : onlyCorrections
                      ? 'Apply Corrections'
                      : mixed
                        ? 'Import New & Apply Corrections'
                        : `Confirm Import (${preview.newCount} new record${preview.newCount !== 1 ? 's' : ''})`
              const btnBg = isDisabled
                ? colors.raised
                : (onlyCorrections || mixed) ? '#7C3AED' : '#3B82F6'
              return (
                <div style={{
                  background: colors.base, border: `1px solid ${colors.border}`,
                  borderRadius: 10, padding: '16px 20px',
                }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: colors.tertiary, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 14 }}>
                    Section 4 — Actions
                  </div>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <button
                      onClick={handleConfirmImport}
                      disabled={isDisabled}
                      style={{
                        ...btnBase,
                        background: btnBg,
                        color: isDisabled ? colors.secondary : '#fff',
                        border: isDisabled ? `1px solid ${colors.border}` : 'none',
                        opacity: isDisabled ? 0.55 : 1,
                        cursor: isDisabled ? 'not-allowed' : 'pointer',
                      }}
                    >
                      {buttonLabel}
                    </button>
                    <button
                      onClick={handleCancel}
                      disabled={confirming}
                      style={{
                        ...btnBase,
                        background: colors.raised, color: colors.secondary,
                        border: `1px solid ${colors.border}`,
                        opacity: confirming ? 0.5 : 1,
                        cursor: confirming ? 'not-allowed' : 'pointer',
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )
            })()}

          </div>
        )}

        {/* ════════════════════════════════════════════════════════════════
            PHASE 2: IMPORT RESULT
        ════════════════════════════════════════════════════════════════ */}
        {result && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

            {/* Header */}
            <div style={{
              background: colors.base, border: `1px solid ${colors.border}`,
              borderRadius: 10, overflow: 'hidden',
            }}>
              <div style={{ padding: '14px 20px', borderBottom: `1px solid ${colors.border}` }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: colors.primary }}>
                  Import Complete
                  {result.month > 0 && (
                    <span style={{ fontWeight: 400, color: colors.secondary, marginLeft: 8 }}>
                      — {MONTH_NAMES[result.month - 1]} {result.year}
                    </span>
                  )}
                </div>
              </div>
              <div style={{ padding: '16px 20px', display: 'flex', gap: 32, flexWrap: 'wrap' }}>
                <StatBox label="Records Inserted"  value={result.imported}  color="#3B82F6" />
                <StatBox label="Records Corrected" value={result.updated}   color={result.updated   > 0 ? '#8B5CF6' : colors.tertiary} />
                <StatBox label="Unchanged"         value={result.unchanged ?? 0} color={colors.tertiary} />
                <StatBox label="Records Skipped"   value={result.skipped}   color={result.skipped   > 0 ? '#F59E0B' : colors.tertiary} />
              </div>
            </div>

            {/* Imported employees */}
            {result.importedEmployees.length > 0 && (
              <SectionCard>
                <CardHeader>Imported ({result.importedEmployees.length} employee{result.importedEmployees.length !== 1 ? 's' : ''})</CardHeader>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: colors.raised }}>
                        {['Employee', 'HR Code', 'Inserted', 'Corrected', 'Unchanged'].map(h => (
                          <th key={h} style={{
                            padding: '8px 14px', textAlign: ['Inserted','Corrected','Unchanged'].includes(h) ? 'center' : 'left',
                            fontSize: 11, fontWeight: 600, color: colors.tertiary,
                            textTransform: 'uppercase', letterSpacing: '0.05em',
                            borderBottom: `1px solid ${colors.border}`,
                          }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {result.importedEmployees.map((emp, i) => (
                        <tr key={i} style={{ borderBottom: i < result.importedEmployees.length - 1 ? `1px solid ${colors.border}` : 'none' }}>
                          <td style={{ padding: '9px 14px', color: colors.primary, fontWeight: 500 }}>{emp.name}</td>
                          <td style={{ padding: '9px 14px', color: colors.tertiary, fontFamily: 'monospace', fontSize: 12 }}>
                            {emp.employee_code ?? '—'}
                          </td>
                          <td style={{ padding: '9px 14px', textAlign: 'center', color: emp.inserted > 0 ? '#3B82F6' : colors.tertiary, fontWeight: emp.inserted > 0 ? 600 : 400 }}>
                            {emp.inserted}
                          </td>
                          <td style={{ padding: '9px 14px', textAlign: 'center', color: emp.updated > 0 ? '#8B5CF6' : colors.tertiary, fontWeight: emp.updated > 0 ? 600 : 400 }}>
                            {emp.updated}
                          </td>
                          <td style={{ padding: '9px 14px', textAlign: 'center', color: colors.tertiary }}>
                            {emp.unchanged ?? 0}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </SectionCard>
            )}

            {/* Manually matched codes — the one fact about this import that
                cannot be recovered from the file afterwards. */}
            {(result.manualMappings ?? []).length > 0 && (
              <SectionCard>
                <CardHeader>Manually matched codes</CardHeader>
                <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {(result.manualMappings ?? []).map(m => (
                    <div key={m.excel_code} style={{ fontSize: 12.5, color: colors.secondary }}>
                      <span style={{ fontFamily: 'monospace', color: colors.tertiary }}>{m.excel_code}</span>
                      {' '}
                      {m.excel_name ? `("${m.excel_name}") ` : ''}
                      imported as <strong style={{ color: colors.primary }}>{m.employee_name}</strong>
                    </div>
                  ))}
                </div>
              </SectionCard>
            )}

            {/* Skipped employees */}
            {result.skippedEmployees.length > 0 && (
              <SectionCard warning>
                <CardHeader warning>
                  {result.skippedEmployees.length} employee{result.skippedEmployees.length !== 1 ? 's' : ''} skipped
                </CardHeader>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: 'rgba(245,158,11,0.08)' }}>
                        {['Employee (File)', 'Code', 'Days Skipped', 'Reason'].map(h => (
                          <th key={h} style={{
                            padding: '8px 14px', textAlign: 'left',
                            fontSize: 11, fontWeight: 600, color: '#92400E',
                            textTransform: 'uppercase', letterSpacing: '0.05em',
                            borderBottom: '1px solid rgba(245,158,11,0.2)',
                          }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {result.skippedEmployees.map((s, i) => (
                        <tr key={i} style={{ borderBottom: i < result.skippedEmployees.length - 1 ? '1px solid rgba(245,158,11,0.15)' : 'none' }}>
                          <td style={{ padding: '9px 14px', color: '#78350F', fontWeight: 500 }}>{s.excel_name || '—'}</td>
                          <td style={{ padding: '9px 14px', color: '#92400E', fontFamily: 'monospace', fontSize: 12 }}>{s.excel_code}</td>
                          <td style={{ padding: '9px 14px', color: '#92400E' }}>{s.days_skipped}</td>
                          <td style={{ padding: '9px 14px', color: '#78350F', fontSize: 12 }}>{s.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {result.skippedEmployees.some(s => s.reason.includes('Fingerprint')) && (
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
              </SectionCard>
            )}

            {/* Row-level punch errors */}
            {result.errors.length > 0 && (
              <div style={{
                background: colors.base, border: `1px solid ${colors.border}`,
                borderRadius: 10, padding: '14px 16px',
              }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: colors.tertiary, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
                  Row-level errors ({result.errors.length})
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {result.errors.map((e, i) => (
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

            {/* Import another */}
            <div style={{ paddingTop: 4 }}>
              <button
                onClick={() => { setResult(null); setPageError(null) }}
                style={{ ...btnBase, background: colors.raised, color: colors.secondary, border: `1px solid ${colors.border}`, cursor: 'pointer' }}
              >
                Import Another File
              </button>
            </div>

          </div>
        )}

      </div>
    </AttendancePayrollLayout>
  )
}
