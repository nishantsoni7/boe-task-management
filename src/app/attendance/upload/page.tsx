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

type ImportSummary = {
  total: number
  imported: number
  updated: number
  skipped: number
  unmappedCodes: string[]
  errors: string[]
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

        {/* ── Import summary ── */}
        {summary && (
          <div style={{
            marginTop: 16,
            background: colors.base, border: `1px solid ${colors.border}`,
            borderRadius: 10, overflow: 'hidden',
          }}>
            {/* Summary counts */}
            <div style={{ padding: '16px 20px', borderBottom: `1px solid ${colors.border}` }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: colors.primary, marginBottom: 12 }}>
                Import Complete
              </div>
              <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
                {[
                  { label: 'Total rows',   value: summary.total,    color: colors.primary },
                  { label: 'Imported',     value: summary.imported,  color: '#3B82F6'      },
                  { label: 'Updated',      value: summary.updated,   color: '#10B981'      },
                  { label: 'Skipped',      value: summary.skipped,   color: '#F59E0B'      },
                ].map(s => (
                  <div key={s.label} style={{ textAlign: 'center', minWidth: 64 }}>
                    <div style={{ fontSize: 22, fontWeight: 700, color: s.color, fontVariantNumeric: 'tabular-nums' }}>{s.value}</div>
                    <div style={{ fontSize: 11, color: colors.tertiary, marginTop: 3 }}>{s.label}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Unmapped codes */}
            {summary.unmappedCodes?.length > 0 && (
              <div style={{ padding: '14px 20px', borderBottom: `1px solid ${colors.border}` }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: colors.tertiary, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
                  Unmapped fingerprint codes ({summary.unmappedCodes.length})
                </div>
                <div style={{ fontSize: 12, color: '#F59E0B', lineHeight: 1.7 }}>
                  {summary.unmappedCodes.join(', ')} — add these codes in Employee Master → Fingerprint Code field.
                </div>
              </div>
            )}

            {/* Error details */}
            {summary.errors.length > 0 && (
              <div style={{ padding: '14px 20px' }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: colors.tertiary, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
                  Skipped rows ({summary.errors.length})
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {summary.errors.map((e, i) => (
                    <div key={i} style={{
                      fontSize: 12, color: '#DC2626',
                      padding: '5px 10px', borderRadius: 5,
                      background: 'rgba(239,68,68,0.06)',
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
