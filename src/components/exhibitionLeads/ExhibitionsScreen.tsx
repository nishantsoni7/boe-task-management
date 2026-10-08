'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { ExhibitionLeadsLayout } from '@/components/layout/ExhibitionLeadsLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { ReviewSheet } from '@/components/customerReviews/ReviewSheet'
import { useExhibitionLeads } from '@/hooks/useExhibitionLeads'
import {
  EXHIBITION_LEADS_KEY, createExhibition, fetchExhibitionsAdmin, updateExhibition,
  type AdminExhibition,
} from '@/lib/exhibitionLeads/api'
import { exhibitionDates } from '@/lib/exhibitionLeads/format'
import { MAX_CITY, MAX_NAME } from '@/lib/exhibitionLeads/validation'
import { validateExhibitionForm, type ExhibitionFormValues } from '@/lib/exhibitionLeads/exhibitions'
import s from './leads.module.css'

const Req = () => <span className={s.req} aria-hidden="true">*</span>

function StateBadge({ open }: { open: boolean }) {
  return <span className={`${s.badge} ${open ? s.badgeOk : s.badgeMuted}`}>{open ? 'Open' : 'Closed'}</span>
}

export default function ExhibitionsScreen() {
  const router = useRouter()
  const { supabase, profile, isAdmin, loading, signOut } = useExhibitionLeads()
  const qc = useQueryClient()
  const [editing, setEditing] = useState<AdminExhibition | 'new' | null>(null)

  // Managing exhibitions is the Admin's. Anyone else lands on their own leads.
  useEffect(() => {
    if (!loading && !isAdmin) router.replace('/exhibition-leads/my')
  }, [loading, isAdmin, router])

  const list = useQuery({
    queryKey: [...EXHIBITION_LEADS_KEY, 'exhibitions-admin'],
    queryFn: () => fetchExhibitionsAdmin(supabase),
    enabled: !loading && isAdmin,
  })

  if (loading || !isAdmin) return <LoadingScreen />
  const rows = list.data ?? []

  return (
    <ExhibitionLeadsLayout
      profile={profile} isAdmin={isAdmin} onSignOut={signOut}
      title="Exhibitions"
      subtitle="Add an exhibition, then capture and review its leads"
      actions={<button className={`${s.btn} ${s.btnRed}`} onClick={() => setEditing('new')}><Plus size={16} aria-hidden="true" /> Add exhibition</button>}
    >
      <div className={s.wrapWide}>
        <div className={s.noticeActions} style={{ marginTop: 0 }}>
          <Link className={s.btn} href="/admin/control-center/permissions/modules?module=exhibition_leads">
            Who can use Exhibition Leads? Manage access
          </Link>
        </div>
        <div className={s.scopeLine}>
          Leads are kept per exhibition. A <strong>closed</strong> exhibition takes no new leads, but its leads, ranking and
          export stay available. Nothing is ever deleted from here.
        </div>

        {list.isLoading && <div className={s.cards}><div className={s.skeleton} /><div className={s.skeleton} /></div>}
        {list.error && !list.data && (
          <div className={`${s.notice} ${s.noticeErr}`} role="alert">
            {(list.error as Error).message}
            <div className={s.noticeActions}><button className={s.btn} onClick={() => list.refetch()}>Try again</button></div>
          </div>
        )}
        {list.data && rows.length === 0 && (
          <div className={s.empty}>
            No exhibition has been added yet.
            <div style={{ marginTop: 10 }}><button className={`${s.btn} ${s.btnRed}`} onClick={() => setEditing('new')}>Add the first exhibition</button></div>
          </div>
        )}

        {rows.length > 0 && (
          <>
            <div className={s.cards}>
              {rows.map(x => (
                <article key={x.id} className={`${s.card}${x.is_active ? '' : ` ${s.cardArchived}`}`}>
                  <div className={s.cardTop}>
                    <div>
                      <div className={s.cardName}>{x.name}</div>
                      <div className={s.cardSub}>{[x.city, exhibitionDates(x)].filter(Boolean).join(' · ')}</div>
                    </div>
                    <StateBadge open={x.is_active} />
                  </div>
                  <div className={s.cardLine}>{x.leads} active lead{x.leads === 1 ? '' : 's'}{x.archived ? ` · ${x.archived} archived` : ''}</div>
                  <div className={s.cardActions}>
                    <Link className={s.btn} href={`/exhibition-leads/all?ex=${x.id}&when=all`}>Leads</Link>
                    <Link className={s.btn} href={`/exhibition-leads/ranking?ex=${x.id}`}>Ranking</Link>
                    <button className={`${s.btn} ${s.btnDark}`} onClick={() => setEditing(x)}>Edit</button>
                  </div>
                </article>
              ))}
            </div>

            <div className={s.tableWrap}>
              <table className={s.table}>
                <thead>
                  <tr><th>Exhibition</th><th>City</th><th>Dates</th><th>State</th><th>Leads</th><th>Actions</th></tr>
                </thead>
                <tbody>
                  {rows.map(x => (
                    <tr key={x.id} className={x.is_active ? undefined : s.rowArchived}>
                      <td><strong>{x.name}</strong></td>
                      <td>{x.city ?? ''}</td>
                      <td className={s.nowrap}>{exhibitionDates(x)}</td>
                      <td><StateBadge open={x.is_active} /></td>
                      <td>{x.leads}{x.archived ? <div className={s.cardSub}>{x.archived} archived</div> : null}</td>
                      <td>
                        <div className={s.tableActions}>
                          <Link className={`${s.btn} ${s.btnSm}`} href={`/exhibition-leads/all?ex=${x.id}&when=all`}>Leads</Link>
                          <Link className={`${s.btn} ${s.btnSm}`} href={`/exhibition-leads/ranking?ex=${x.id}`}>Ranking</Link>
                          <button className={`${s.btn} ${s.btnSm} ${s.btnDark}`} onClick={() => setEditing(x)}>Edit</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {editing && (
        <ExhibitionSheet
          key={editing === 'new' ? 'new' : editing.id}
          existing={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSave={async values => {
            if (editing === 'new') await createExhibition(supabase, values)
            else await updateExhibition(supabase, editing.id, values)
            await qc.invalidateQueries({ queryKey: EXHIBITION_LEADS_KEY })
            setEditing(null)
          }}
        />
      )}
    </ExhibitionLeadsLayout>
  )
}

function ExhibitionSheet({
  existing, onClose, onSave,
}: {
  existing: AdminExhibition | null
  onClose: () => void
  onSave: (v: ExhibitionFormValues) => Promise<void>
}) {
  const [v, setV] = useState<ExhibitionFormValues>({
    name: existing?.name ?? '', city: existing?.city ?? '',
    startsOn: existing?.starts_on ?? '', endsOn: existing?.ends_on ?? '',
    isActive: existing?.is_active ?? true,
  })
  const [showErrors, setShowErrors] = useState(false)
  const errors = showErrors ? validateExhibitionForm(v) : {}
  const save = useMutation({
    mutationFn: async () => {
      setShowErrors(true)
      if (Object.keys(validateExhibitionForm(v)).length) throw new Error('Fix the highlighted fields.')
      await onSave(v)
    },
  })
  const set = <K extends keyof ExhibitionFormValues>(k: K, val: ExhibitionFormValues[K]) => setV(p => ({ ...p, [k]: val }))
  const err = (k: keyof typeof errors) => errors[k] && <div className={s.err} role="alert">{errors[k]}</div>

  return (
    <ReviewSheet
      title={existing ? 'Edit exhibition' : 'Add exhibition'}
      subtitle={existing ? existing.name : 'It appears on the Add Lead form as soon as it is saved'}
      onClose={onClose}
      dismissOnBackdrop={false}
      maxWidth="520px"
      footer={
        <>
          <button type="button" className={s.btn} onClick={onClose}>Cancel</button>
          <button type="submit" form="exhibition-form" className={`${s.btn} ${s.btnRed}`} style={{ flex: 1 }} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : existing ? 'Save changes' : 'Add exhibition'}
          </button>
        </>
      }
    >
      <form id="exhibition-form" className={s.filterSheetBody} noValidate onSubmit={e => { e.preventDefault(); save.mutate() }}>
        <div className={s.field}>
          <label className={s.label} htmlFor="ex-name">Exhibition name<Req /></label>
          <input id="ex-name" className={`${s.input}${errors.name ? ` ${s.invalid}` : ''}`} value={v.name} maxLength={MAX_NAME + 20}
            autoComplete="off" autoCapitalize="words" placeholder="Example: Acetech Bangalore 2026" onChange={e => set('name', e.target.value)} />
          {err('name')}
        </div>
        <div className={s.field}>
          <label className={s.label} htmlFor="ex-city">City</label>
          <input id="ex-city" className={`${s.input}${errors.city ? ` ${s.invalid}` : ''}`} value={v.city} maxLength={MAX_CITY + 20}
            autoComplete="off" autoCapitalize="words" placeholder="Type the city" onChange={e => set('city', e.target.value)} />
          {err('city')}
        </div>
        <div className={s.grid2}>
          <div className={s.field}>
            <label className={s.label} htmlFor="ex-start">First day<Req /></label>
            <input id="ex-start" type="date" className={`${s.input}${errors.startsOn ? ` ${s.invalid}` : ''}`} value={v.startsOn} onChange={e => set('startsOn', e.target.value)} />
            {err('startsOn')}
          </div>
          <div className={s.field}>
            <label className={s.label} htmlFor="ex-end">Last day<Req /></label>
            <input id="ex-end" type="date" className={`${s.input}${errors.endsOn ? ` ${s.invalid}` : ''}`} value={v.endsOn} min={v.startsOn || undefined} onChange={e => set('endsOn', e.target.value)} />
            {err('endsOn')}
          </div>
        </div>
        <div className={s.hint}>Days are counted in India time. An exhibition can run for up to 31 days; the ranking shows one column per day.</div>
        {existing && (
          <label className={s.checkRow}>
            <input type="checkbox" checked={v.isActive} onChange={e => set('isActive', e.target.checked)} />
            <span>Open for new leads</span>
          </label>
        )}
        {existing && !v.isActive && (
          <div className={s.hint}>Closed: salespeople can no longer add leads to it, but its leads, ranking and export stay available.</div>
        )}
        {save.error && <div className={`${s.notice} ${s.noticeErr}`} role="alert">{(save.error as Error).message}</div>}
      </form>
    </ReviewSheet>
  )
}
