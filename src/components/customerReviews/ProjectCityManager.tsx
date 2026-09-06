'use client'

import { useCallback, useEffect, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { Loader2, MapPin, RefreshCw } from 'lucide-react'
import { colors } from '@/lib/tokens'

type ProjectRow = {
  id: string
  label: string
  city: string | null
  archived_at: string | null
}

/**
 * Project metadata kept beside the existing Image Library rather than inside
 * its upload flow. One image group is one project, so the city belongs on the
 * group and automatically applies to every photograph inside it.
 */
export function ProjectCityManager({ supabase }: { supabase: SupabaseClient }) {
  const [projects, setProjects] = useState<ProjectRow[] | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [savingId, setSavingId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [savedId, setSavedId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError('')
    const { data, error: loadError } = await supabase
      .from('customer_review_image_groups')
      .select('id, label, city, archived_at')
      .order('created_at', { ascending: false })

    if (loadError) {
      setProjects([])
      setError('Project details could not be loaded. Refresh and try again.')
      return
    }

    const rows = (data ?? []) as ProjectRow[]
    setProjects(rows)
    setDrafts(Object.fromEntries(rows.map(row => [row.id, row.city ?? ''])))
  }, [supabase])

  useEffect(() => {
    void load()
  }, [load])

  const save = useCallback(async (project: ProjectRow) => {
    if (savingId) return
    const city = (drafts[project.id] ?? '').trim()
    if (city.length > 80) {
      setError('City must be 80 characters or fewer.')
      return
    }

    setSavingId(project.id)
    setSavedId(null)
    setError('')
    const { error: rpcError } = await supabase.rpc('set_customer_review_image_group_city', {
      p_group_id: project.id,
      p_city: city,
    })

    if (rpcError) {
      setError(rpcError.message.replace(/^[A-Z_]+:\s*/, '') || 'City could not be saved.')
      setSavingId(null)
      return
    }

    setProjects(current => (current ?? []).map(row =>
      row.id === project.id ? { ...row, city: city || null } : row,
    ))
    setSavedId(project.id)
    setSavingId(null)
  }, [drafts, savingId, supabase])

  return (
    <section style={{
      marginTop: '18px', padding: '16px', border: `1px solid ${colors.border}`,
      borderRadius: '10px', background: '#FFFFFF',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 360px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
            <MapPin size={15} strokeWidth={2.2} />
            <strong style={{ fontSize: '13px', color: colors.primary }}>Project details</strong>
          </div>
          <p style={{ margin: '5px 0 0', fontSize: '11.5px', color: colors.secondary, lineHeight: 1.55 }}>
            Add the city for each project. Every image in that project keeps the same project name and city reference.
          </p>
        </div>
        <button
          type="button"
          onClick={() => { void load() }}
          className="boe-btn boe-btn-ghost"
          style={{ minHeight: '36px', fontSize: '12px' }}
        >
          <RefreshCw size={13} /> Refresh projects
        </button>
      </div>

      {projects === null ? (
        <p style={{ margin: '14px 0 0', fontSize: '12px', color: colors.secondary }}>Loading projects…</p>
      ) : projects.length === 0 ? (
        <p style={{ margin: '14px 0 0', fontSize: '12px', color: colors.secondary }}>
          No project groups yet. Create one in the image library, then refresh this list.
        </p>
      ) : (
        <div style={{ display: 'grid', gap: '8px', marginTop: '14px' }}>
          {projects.map(project => {
            const current = drafts[project.id] ?? ''
            const unchanged = current.trim() === (project.city ?? '')
            const saving = savingId === project.id
            return (
              <div key={project.id} style={{
                display: 'grid', gridTemplateColumns: 'minmax(170px, 1fr) minmax(150px, 220px) auto',
                gap: '8px', alignItems: 'center', padding: '9px',
                border: `1px solid ${colors.borderSoft}`, borderRadius: '8px',
                opacity: project.archived_at ? 0.65 : 1,
              }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: '12px', fontWeight: 650, color: colors.primary, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {project.label}
                  </div>
                  {project.archived_at && (
                    <div style={{ marginTop: '2px', fontSize: '10.5px', color: colors.tertiary }}>Archived project</div>
                  )}
                </div>
                <input
                  className="boe-input"
                  value={current}
                  maxLength={80}
                  placeholder="City (optional)"
                  aria-label={`City for ${project.label}`}
                  disabled={saving}
                  onChange={event => {
                    setDrafts(values => ({ ...values, [project.id]: event.target.value }))
                    setSavedId(null)
                    setError('')
                  }}
                  style={{ minHeight: '38px' }}
                />
                <button
                  type="button"
                  className="boe-btn boe-btn-primary"
                  disabled={saving || unchanged}
                  onClick={() => { void save(project) }}
                  style={{ minHeight: '38px', minWidth: '74px', justifyContent: 'center', fontSize: '12px' }}
                >
                  {saving ? <Loader2 size={13} className="boe-spin" /> : savedId === project.id ? 'Saved' : 'Save'}
                </button>
              </div>
            )
          })}
        </div>
      )}

      {error && (
        <p role="alert" style={{ margin: '10px 0 0', fontSize: '12px', color: colors.red, lineHeight: 1.5 }}>
          {error}
        </p>
      )}
    </section>
  )
}
