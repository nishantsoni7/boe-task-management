'use client'

import { useEffect, useState, useMemo, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { AttendancePayrollLayout } from '@/components/layout/AttendancePayrollLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import Link from 'next/link'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { Notice, ui } from '@/components/attendancePayroll/ui'
import styles from './upload.module.css'

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

/** A value and its label on one line; a run of these replaces tiles. */
function Stat({ label, value, color }: { label: string; value: number | string; color?: string }) {
  return (
    <div className={styles.stat}>
      <span className={styles.statValue} style={color ? { color } : undefined}>{value}</span>
      <span>{label}</span>
    </div>
  )
}

/** A titled white surface. `warning` tints the head amber for things that need attention. */
function Section({ title, warning, children }: { title: React.ReactNode; warning?: boolean; children: React.ReactNode }) {
  return (
    <section className={ui.surface} style={warning ? { borderColor: 'rgba(232,160,48,0.45)' } : undefined}>
      <div
        className={ui.surfaceHead}
        style={warning ? { background: 'rgba(232,160,48,0.08)' } : undefined}
      >
        <h2 className={ui.surfaceTitle} style={warning ? { color: '#92400E' } : undefined}>{title}</h2>
      </div>
      {children}
    </section>
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

const STEP_LABELS = ['Choose file', 'Check results', 'Confirm import', 'Outcome']

function Steps({ current }: { current: number }) {
  return (
    <ol className={styles.steps} aria-label="Import steps">
      {STEP_LABELS.map((label, i) => {
        const n = i + 1
        const cls = n < current ? styles.stepDone : n === current ? styles.stepCurrent : ''
        return (
          <li key={label} className={`${styles.step} ${cls}`} aria-current={n === current ? 'step' : undefined}>
            <span className={styles.stepNum} aria-hidden>{n < current ? '✓' : n}</span>
            {label}
          </li>
        )
      })}
    </ol>
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
  const step = result ? 4 : preview ? 2 : 1
  const btn = `boe-btn boe-btn-ghost ${ui.btnSm}`

  return (
    <AttendancePayrollLayout
      profile={profile}
      title="Upload"
      subtitle="Import a fingerprint machine export, check it, then confirm"
      onSignOut={handleSignOut}
    >
      <div className={ui.stack}>
        <Steps current={step} />

        {!canImport && (
          <div className={styles.narrow}>
            <Notice kind="error">Only admin and manager users can import attendance records.</Notice>
          </div>
        )}

        {/* ── Step 1: choose file (hidden after preview/result) ── */}
        {!preview && !result && (
          <section className={`${ui.surface} ${styles.narrow}`}>
            <div className={ui.surfaceHead}>
              <div>
                <h2 className={ui.surfaceTitle}>Fingerprint machine import</h2>
                <p className={ui.surfaceSub}>
                  Upload the monthly attendance report exported from the machine (.xls or .xlsx).
                  Employees are matched by <strong>fingerprint employee code</strong> (e.g. 0014, 0017).
                </p>
              </div>
            </div>
            <div className={`${ui.surfaceBody} ${ui.stack}`}>
              <ul className={styles.expected}>
                <li>Format: XLS/XLSX monthly attendance export</li>
                <li>Employee codes must be mapped in Employee directory</li>
                <li>Days with no punch (--:--) are automatically skipped</li>
              </ul>

              <div className={ui.field}>
                <label className={ui.label} htmlFor="upload-file">Select file</label>
                <input
                  id="upload-file"
                  ref={fileRef}
                  type="file"
                  accept=".xls,.xlsx,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  onChange={handleFileChange}
                  disabled={!canImport}
                  className={ui.input}
                />
                {file && (
                  <div className={styles.fileMeta}>{file.name} · {(file.size / 1024).toFixed(1)} KB</div>
                )}
              </div>

              <div>
                <button
                  type="button"
                  className={`boe-btn boe-btn-primary ${ui.btn}`}
                  onClick={() => handlePreview()}
                  disabled={!file || previewing || !canImport}
                >
                  {previewing ? 'Analysing…' : 'Preview Import'}
                </button>
              </div>
            </div>
          </section>
        )}

        {/* ── Page-level error ── */}
        {pageError && (
          <div className={styles.narrow}>
            <Notice
              kind="error"
              action={<button type="button" className={btn} onClick={() => setPageError(null)}>Dismiss</button>}
            >
              <strong>Error:</strong> {pageError}
            </Notice>
          </div>
        )}

        {/* ════════════════════════════════════════════════════════════════
            STEP 2–3: CHECK RESULTS, THEN CONFIRM
        ════════════════════════════════════════════════════════════════ */}
        {preview && (
          <>
            {/* ── Status banner ── */}
            {preview.allUnchanged ? (
              <Notice kind="error">This attendance data already appears to be imported. No changes found.</Notice>
            ) : preview.modifiedCount > 0 && preview.newCount === 0 ? (
              <Notice kind="info">{preview.modifiedCount} record{preview.modifiedCount !== 1 ? 's' : ''} have different timings and will be corrected. Review the changes below before confirming.</Notice>
            ) : preview.modifiedCount > 0 ? (
              <Notice kind="info">{preview.newCount} new record{preview.newCount !== 1 ? 's' : ''} will be added and {preview.modifiedCount} existing record{preview.modifiedCount !== 1 ? 's' : ''} will be corrected.</Notice>
            ) : null}

            {/* Payroll lock / generated warnings — shown whenever this import would write to a locked/generated period */}
            {preview.payrollStatus === 'locked' && (
              <Notice kind="error"><strong>Payroll is locked for this month.</strong> Attendance cannot be imported or corrected.</Notice>
            )}
            {preview.payrollStatus === 'generated' && (
              <Notice kind="warning"><strong>Payroll has already been generated for this month.</strong> Applying corrections may require payroll regeneration.</Notice>
            )}

            <div className={styles.narrow}>
              <Section title="File summary">
                <div className={ui.surfaceBody}>
                  <dl className={ui.facts}>
                    <dt>File name</dt><dd>{preview.fileName}</dd>
                    <dt>Device format</dt><dd>{preview.deviceFormat}</dd>
                    <dt>Month detected</dt><dd>{preview.month > 0 ? MONTH_NAMES[preview.month - 1] : '—'}</dd>
                    <dt>Year detected</dt><dd>{preview.year > 0 ? String(preview.year) : '—'}</dd>
                    <dt>Total rows found</dt><dd>{String(preview.totalRows)}</dd>
                  </dl>
                </div>
              </Section>
            </div>

            <div className={styles.narrow}>
              <Section title="Employee matching" warning={preview.unmatchedCount > 0}>
                <div className={`${ui.surfaceBody} ${ui.stack}`}>
                  <div className={styles.stats}>
                    <Stat label="Employees detected" value={preview.detectedEmployees} />
                    <Stat label="Matched" value={preview.matchedCount} color="#047857" />
                    <Stat label="Unmatched" value={preview.unmatchedCount} color={preview.unmatchedCount > 0 ? '#B45309' : '#6B7384'} />
                  </div>

                  {/* Codes an admin named an employee for. Shown as the server
                      resolved them, so what is confirmed here is what will run. */}
                  {preview.manualMappings.length > 0 && (
                    <div>
                      <h3 className={styles.sectionLabel}>Manually matched — these will be imported</h3>
                      <div className={ui.stack} style={{ gap: 6 }}>
                        {preview.manualMappings.map(m => (
                          <div key={m.excel_code} className={`${styles.mapRow} ${styles.mapRowGood}`}>
                            <span className={styles.mono}>{m.excel_code}</span>
                            <span>{m.excel_name || 'unnamed in file'}</span>
                            <span>{m.days} day{m.days !== 1 ? 's' : ''}</span>
                            <span aria-hidden>→</span>
                            <strong>{m.employee_name}</strong>
                            <button
                              type="button"
                              className={`${btn} ${styles.mapEnd}`}
                              onClick={() => handleRemoveMapping(m.excel_code)}
                              disabled={previewing || confirming}
                            >
                              Remove
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {preview.unmatchedEntries.length > 0 && (
                    <div>
                      <h3 className={styles.sectionLabel}>Unmatched employees — skipped unless you choose who they are</h3>

                      <div className={ui.stack} style={{ gap: 8 }}>
                        {preview.unmatchedEntries.map(u => {
                          const open      = pickerFor === u.excel_code
                          const confirmed = pendingChoice?.entry.excel_code === u.excel_code
                          const matches   = open && !confirmed
                            ? searchEmployees(employees, pickerQuery).slice(0, 40)
                            : []
                          return (
                            <div key={u.excel_code} className={`${styles.mapRow} ${styles.mapRowWarn}`}>
                              <div className={styles.mapLine}>
                                <span className={styles.mono}>{u.excel_code}</span>
                                <span className={ui.strong}>{u.excel_name || 'unnamed in file'}</span>
                                <span className={ui.muted}>{u.days} day{u.days !== 1 ? 's' : ''}</span>
                                {!open && (
                                  <button
                                    type="button"
                                    className={`boe-btn boe-btn-primary ${ui.btnSm} ${styles.mapEnd}`}
                                    onClick={() => { setPickerFor(u.excel_code); setPickerQuery(''); setPendingChoice(null); loadEmployees() }}
                                    disabled={previewing || confirming}
                                  >
                                    Choose employee
                                  </button>
                                )}
                              </div>

                              {/* Confirmation gate — naming the employee and
                                  agreeing to import as them are two steps. */}
                              {confirmed && pendingChoice && (
                                <div className={styles.confirmBox}>
                                  <div>
                                    Import {u.days} day{u.days !== 1 ? 's' : ''} recorded under code{' '}
                                    <strong className={styles.mono}>{u.excel_code}</strong>
                                    {u.excel_name ? ` ("${u.excel_name}")` : ''} as{' '}
                                    <strong>{pendingChoice.employee.full_name ?? 'this employee'}</strong>?
                                  </div>
                                  <div className={ui.sub} style={{ marginTop: 4 }}>
                                    These punches will be written to that employee&apos;s attendance and counted in their payroll.
                                  </div>
                                  <div className={styles.actions} style={{ marginTop: 10 }}>
                                    <button
                                      type="button"
                                      className={`boe-btn boe-btn-primary ${ui.btnSm}`}
                                      onClick={handleConfirmChoice}
                                      disabled={previewing}
                                    >
                                      {previewing ? 'Applying…' : 'Yes, import as this employee'}
                                    </button>
                                    <button
                                      type="button"
                                      className={btn}
                                      onClick={() => setPendingChoice(null)}
                                      disabled={previewing}
                                    >
                                      Back
                                    </button>
                                  </div>
                                </div>
                              )}

                              {/* Searchable selector */}
                              {open && !confirmed && (
                                <div style={{ marginTop: 10 }}>
                                  <label className={ui.srOnly} htmlFor={`pick-${u.excel_code}`}>Search employees</label>
                                  <input
                                    id={`pick-${u.excel_code}`}
                                    autoFocus
                                    className={ui.input}
                                    value={pickerQuery}
                                    onChange={e => setPickerQuery(e.target.value)}
                                    placeholder="Search by name or employee code…"
                                  />
                                  {loadingEmployees && (
                                    <div className={ui.sub} style={{ padding: '8px 2px' }}>Loading employees…</div>
                                  )}
                                  {employeesError && (
                                    <div role="alert" style={{ fontSize: 12.5, color: '#B91C1C', padding: '8px 2px' }}>{employeesError}</div>
                                  )}
                                  {!loadingEmployees && !employeesError && (
                                    <div className={styles.picker}>
                                      {matches.length === 0 ? (
                                        <div className={ui.sub} style={{ padding: '10px 12px' }}>
                                          No employee matches that search.
                                        </div>
                                      ) : matches.map(emp => (
                                        <button
                                          type="button"
                                          key={emp.id}
                                          className={styles.pickerItem}
                                          onClick={() => setPendingChoice({ entry: u, employee: emp })}
                                        >
                                          <span className={ui.strong}>{emp.full_name ?? 'Unnamed'}</span>
                                          {emp.employee_code && (
                                            <span className={`${ui.muted} ${styles.mono}`} style={{ fontSize: 12, marginLeft: 8 }}>
                                              {emp.employee_code}
                                            </span>
                                          )}
                                        </button>
                                      ))}
                                    </div>
                                  )}
                                  <button
                                    type="button"
                                    className={btn}
                                    style={{ marginTop: 8 }}
                                    onClick={() => { setPickerFor(null); setPickerQuery('') }}
                                  >
                                    Cancel
                                  </button>
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>

                      <div style={{ paddingTop: 12 }}>
                        <Link href="/attendance/employees" className={btn}>
                          Fix Fingerprint Codes in Employee directory →
                        </Link>
                      </div>
                    </div>
                  )}
                </div>
              </Section>
            </div>

            <div className={styles.narrow}>
              <Section title="Import safety" warning={preview.allUnchanged}>
                <div className={`${ui.surfaceBody} ${ui.stack}`} style={{ gap: 10 }}>
                  <div className={styles.stats}>
                    <Stat label="New records" value={preview.newCount} color={preview.newCount > 0 ? '#1D4ED8' : '#6B7384'} />
                    <Stat label="Modified records" value={preview.modifiedCount} color={preview.modifiedCount > 0 ? '#6D28D9' : '#6B7384'} />
                    <Stat label="Unchanged" value={preview.unchangedCount} color={preview.unchangedCount > 0 ? '#047857' : '#6B7384'} />
                  </div>
                  {preview.allUnchanged && (
                    <div style={{ fontSize: 13, color: '#B91C1C', fontWeight: 500 }}>
                      This attendance data already appears to be imported. No changes found.
                    </div>
                  )}
                </div>
              </Section>
            </div>

            {/* Modified records detail */}
            {preview.modifiedRecords.length > 0 && (
              <Section title="Modified records — timings will be corrected">
                <div className={ui.desktopOnly}>
                  <div className={ui.tableWrap}>
                    <table className={ui.table}>
                      <thead>
                        <tr>
                          {['Employee', 'Date', 'Old Check-in', 'New Check-in', 'Old Check-out', 'New Check-out'].map(h => (
                            <th key={h} scope="col">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {preview.modifiedRecords.map((r, i) => (
                          <tr key={i}>
                            <td className={ui.strong}>{r.employeeName}</td>
                            <td className={`${ui.nowrap} ${styles.mono}`}>{r.date}</td>
                            <td className={`${styles.oldVal} ${styles.mono}`}>{r.oldCheckIn}</td>
                            <td className={`${styles.newVal} ${styles.mono}`}>{r.newCheckIn}</td>
                            <td className={`${styles.oldVal} ${styles.mono}`}>{r.oldCheckOut}</td>
                            <td className={`${styles.newVal} ${styles.mono}`}>{r.newCheckOut}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
                <ul className={ui.cards} style={{ padding: 12 }}>
                  {preview.modifiedRecords.map((r, i) => (
                    <li key={i} className={`${ui.surface} ${ui.card}`}>
                      <div className={ui.strong}>{r.employeeName}</div>
                      <div className={ui.sub}>{r.date}</div>
                      <div style={{ fontSize: 13 }}>
                        <div>Check-in: <span className={styles.oldVal}>{r.oldCheckIn}</span> → <span className={styles.newVal}>{r.newCheckIn}</span></div>
                        <div>Check-out: <span className={styles.oldVal}>{r.oldCheckOut}</span> → <span className={styles.newVal}>{r.newCheckOut}</span></div>
                      </div>
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {/* Confirm import */}
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
              return (
                <div className={styles.narrow}>
                  <Section title="Confirm import">
                    <div className={`${ui.surfaceBody} ${styles.actions}`}>
                      <button
                        type="button"
                        className={`boe-btn boe-btn-primary ${ui.btn}`}
                        onClick={handleConfirmImport}
                        disabled={isDisabled}
                      >
                        {buttonLabel}
                      </button>
                      <button
                        type="button"
                        className={`boe-btn boe-btn-ghost ${ui.btn}`}
                        onClick={handleCancel}
                        disabled={confirming}
                      >
                        Cancel
                      </button>
                    </div>
                  </Section>
                </div>
              )
            })()}
          </>
        )}

        {/* ════════════════════════════════════════════════════════════════
            STEP 4: IMPORT OUTCOME
        ════════════════════════════════════════════════════════════════ */}
        {result && (
          <>
            <div className={styles.narrow}>
              <Notice kind="success">
                <strong>Import complete</strong>
                {result.month > 0 && <> — {MONTH_NAMES[result.month - 1]} {result.year}</>}
                <div className={styles.stats} style={{ marginTop: 8 }}>
                  <Stat label="Records inserted" value={result.imported} />
                  <Stat label="Records corrected" value={result.updated} />
                  <Stat label="Unchanged" value={result.unchanged ?? 0} />
                  <Stat label="Records skipped" value={result.skipped} color={result.skipped > 0 ? '#B45309' : undefined} />
                </div>
              </Notice>
            </div>

            {/* Imported employees */}
            {result.importedEmployees.length > 0 && (
              <Section title={`Imported (${result.importedEmployees.length} employee${result.importedEmployees.length !== 1 ? 's' : ''})`}>
                <div className={ui.desktopOnly}>
                  <div className={ui.tableWrap}>
                    <table className={ui.table}>
                      <thead>
                        <tr>
                          <th scope="col">Employee</th>
                          <th scope="col">HR Code</th>
                          <th scope="col" className={ui.num}>Inserted</th>
                          <th scope="col" className={ui.num}>Corrected</th>
                          <th scope="col" className={ui.num}>Unchanged</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.importedEmployees.map((emp, i) => (
                          <tr key={i}>
                            <td className={ui.strong}>{emp.name}</td>
                            <td className={`${ui.muted} ${styles.mono}`}>{emp.employee_code ?? '—'}</td>
                            <td className={ui.num}>{emp.inserted}</td>
                            <td className={ui.num}>{emp.updated}</td>
                            <td className={ui.num}>{emp.unchanged ?? 0}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
                <ul className={ui.cards} style={{ padding: 12 }}>
                  {result.importedEmployees.map((emp, i) => (
                    <li key={i} className={`${ui.surface} ${ui.card}`}>
                      <div className={ui.strong}>{emp.name}</div>
                      {emp.employee_code && <div className={ui.sub}>{emp.employee_code}</div>}
                      <div style={{ fontSize: 13, color: '#4A5261' }}>
                        {emp.inserted} inserted · {emp.updated} corrected · {emp.unchanged ?? 0} unchanged
                      </div>
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {/* Manually matched codes — the one fact about this import that
                cannot be recovered from the file afterwards. */}
            {(result.manualMappings ?? []).length > 0 && (
              <div className={styles.narrow}>
                <Section title="Manually matched codes">
                  <div className={`${ui.surfaceBody} ${ui.stack}`} style={{ gap: 6 }}>
                    {(result.manualMappings ?? []).map(m => (
                      <div key={m.excel_code} style={{ fontSize: 13, color: '#4A5261' }}>
                        <span className={styles.mono}>{m.excel_code}</span>
                        {' '}
                        {m.excel_name ? `("${m.excel_name}") ` : ''}
                        imported as <strong style={{ color: '#111318' }}>{m.employee_name}</strong>
                      </div>
                    ))}
                  </div>
                </Section>
              </div>
            )}

            {/* Skipped employees */}
            {result.skippedEmployees.length > 0 && (
              <Section
                warning
                title={`${result.skippedEmployees.length} employee${result.skippedEmployees.length !== 1 ? 's' : ''} skipped`}
              >
                <div className={ui.desktopOnly}>
                  <div className={ui.tableWrap}>
                    <table className={ui.table}>
                      <thead>
                        <tr>
                          <th scope="col">Employee (File)</th>
                          <th scope="col">Code</th>
                          <th scope="col">Days Skipped</th>
                          <th scope="col">Reason</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.skippedEmployees.map((s, i) => (
                          <tr key={i}>
                            <td className={ui.strong}>{s.excel_name || '—'}</td>
                            <td className={styles.mono}>{s.excel_code}</td>
                            <td>{s.days_skipped}</td>
                            <td>{s.reason}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
                <ul className={ui.cards} style={{ padding: 12 }}>
                  {result.skippedEmployees.map((s, i) => (
                    <li key={i} className={`${ui.surface} ${ui.card}`}>
                      <div className={ui.strong}>{s.excel_name || '—'}</div>
                      <div className={ui.sub}><span className={styles.mono}>{s.excel_code}</span> · {s.days_skipped} day{s.days_skipped !== 1 ? 's' : ''} skipped</div>
                      <div style={{ fontSize: 13 }}>{s.reason}</div>
                    </li>
                  ))}
                </ul>
                {result.skippedEmployees.some(s => s.reason.includes('Fingerprint')) && (
                  <div style={{ padding: '4px 18px 16px' }}>
                    <Link href="/attendance/employees" className={btn}>
                      Set Fingerprint Codes in Employee directory →
                    </Link>
                  </div>
                )}
              </Section>
            )}

            {/* Row-level punch errors */}
            {result.errors.length > 0 && (
              <Section title={`Row-level errors (${result.errors.length})`}>
                <div className={ui.surfaceBody}>
                  <ul className={styles.errList}>
                    {result.errors.map((e, i) => (
                      <li key={i} className={styles.errItem}>{e}</li>
                    ))}
                  </ul>
                </div>
              </Section>
            )}

            {/* Import another */}
            <div>
              <button
                type="button"
                className={`boe-btn boe-btn-primary ${ui.btn}`}
                onClick={() => { setResult(null); setPageError(null) }}
              >
                Import Another File
              </button>
            </div>
          </>
        )}

      </div>
    </AttendancePayrollLayout>
  )
}
