'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, MapPin, MessageCircle, Pencil, Phone, Plus } from 'lucide-react'
import { VendorsLayout } from '@/components/layout/VendorsLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { useVendors } from '@/hooks/useVendors'
import { formatPhone, telHref, whatsappHref } from '@/lib/exhibitionLeads/phone'
import {
  VENDORS_KEY, archiveVendor, fetchVendor, restoreVendor, setVendorStatus,
} from '@/lib/vendors/api'
import {
  AT_SITE_METRES, CAPABILITIES, PHOTO_KINDS, PRODUCT_FOCUS, PRE_VISIT_STATUSES, VENDOR_STATUSES, VISIT_KINDS, VISIT_OUTCOMES,
  labelOf, labelsOf, type Visit, type VisitPhoto,
} from '@/lib/vendors/constants'
import { signedVendorPhotoUrl } from '@/lib/vendors/photos'
import { StatusBadge, daysAgoText, formatDay, formatWhen, mapsHref } from './VendorBits'
import s from './vendors.module.css'

// One vendor: who they are and how to reach them at the top (call, WhatsApp, map, log a visit — one tap each),
// then three tabs: every Visit (newest first), the Profile, and all Photographs from every visit in one place.

type Tab = 'visits' | 'profile' | 'photos'

export default function VendorDetailScreen() {
  const { id } = useParams<{ id: string }>()
  const qc = useQueryClient()
  const { supabase, profile, isAdmin, loading, signOut } = useVendors()
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<Tab>('visits')
  const [now] = useState(() => Date.now())

  const { data, isLoading, error } = useQuery({
    queryKey: [VENDORS_KEY, 'detail', id],
    queryFn: () => fetchVendor(supabase, id),
    enabled: !!profile,
  })

  if (loading || !profile || (isLoading && !data)) return <DetailSkeleton profile={profile} isAdmin={isAdmin} onSignOut={signOut} />

  async function run(action: () => Promise<unknown>) {
    setBusy(true)
    setProblem(null)
    try {
      await action()
      await qc.invalidateQueries({ queryKey: [VENDORS_KEY] })
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  const v = data?.vendor
  const visits = data?.visits ?? []
  const allPhotos = visits.flatMap(x => x.photos)
  const last = visits[0]
  const daysSince = last ? Math.max(0, Math.floor((now - new Date(last.visited_at).getTime()) / 86_400_000)) : null

  return (
    <VendorsLayout profile={profile} isAdmin={isAdmin} onSignOut={signOut} title={v?.company_name ?? 'Vendor'}
                   subtitle={v?.contact_name ?? undefined}
                   actions={v && !v.archived ? (
                     <>
                       <Link className={`${s.secondary} ${s.hideOnPhone}`} href="/vendors"><ArrowLeft size={15} aria-hidden="true" /> All vendors</Link>
                       <Link className={`${s.secondary} ${s.hideOnPhone}`} href={`/vendors/${v.id}/edit`}><Pencil size={15} aria-hidden="true" /> Edit</Link>
                       <Link className={`${s.primary} ${s.hideOnPhone}`} href={`/vendors/visit?vendor=${v.id}`}><Plus size={15} aria-hidden="true" /> Log a Visit</Link>
                     </>
                   ) : undefined}>
      <div className={s.wrapWide}>
        <Link href="/vendors" className={`${s.backLink} ${s.showOnPhone}`}><ArrowLeft size={16} aria-hidden="true" /> All vendors</Link>
        {error && <div className={`${s.banner} ${s.bannerErr}`} role="alert">This vendor is not available to you.</div>}
        {problem && <div className={`${s.banner} ${s.bannerErr}`} role="alert">{problem}</div>}
        {v && (
          <>
            {v.archived && (
              <div className={`${s.banner} ${s.bannerWarn}`}>
                Archived{v.archive_reason ? `: ${v.archive_reason}` : ''}.
                {isAdmin && <> <button type="button" className={s.secondary} disabled={busy} onClick={() => void run(() => restoreVendor(supabase, v.id))}>Restore</button></>}
              </div>
            )}

            {/* Hero */}
            <section className={s.hero} aria-label="Vendor summary">
              <div className={s.heroTop}>
                <div className={s.heroId}>
                  <span className={`${s.avatar} ${s.avatarLg}`} aria-hidden="true">{(v.company_name.trim()[0] ?? '?').toUpperCase()}</span>
                  <div className={s.rowMain}>
                    <div className={s.heroName}>{v.company_name}</div>
                    <div className={s.rowMeta}>{v.contact_name ?? 'No contact person yet'}</div>
                  </div>
                </div>
                {(isAdmin || PRE_VISIT_STATUSES.some(p => p === v.status)) && !v.archived ? (
                  <select className={`${s.select} ${s.statusSelect}`} value={v.status} disabled={busy} aria-label="Vendor status"
                          onChange={e => void run(() => setVendorStatus(supabase, v.id, e.target.value))}>
                    {VENDOR_STATUSES.filter(o => isAdmin || PRE_VISIT_STATUSES.some(p => p === o.value)).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                ) : <StatusBadge status={v.status} />}
              </div>

              <div className={s.actionRow}>
                {v.phone && <a className={s.actionBtn} href={telHref(v.phone)}><Phone size={18} aria-hidden="true" /><span>Call</span></a>}
                {v.phone && <a className={s.actionBtn} href={whatsappHref(v.phone)} target="_blank" rel="noopener noreferrer"><MessageCircle size={18} aria-hidden="true" /><span>WhatsApp</span></a>}
                {v.latitude !== null && v.longitude !== null
                  ? <a className={s.actionBtn} href={mapsHref(v.latitude, v.longitude)} target="_blank" rel="noopener noreferrer"><MapPin size={18} aria-hidden="true" /><span>Map</span></a>
                  : v.address && <a className={s.actionBtn} href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(v.address)}`} target="_blank" rel="noopener noreferrer"><MapPin size={18} aria-hidden="true" /><span>Map</span></a>}
                {!v.archived && <Link className={`${s.actionBtn} ${s.actionPrimary}`} href={`/vendors/visit?vendor=${v.id}`}><Plus size={18} aria-hidden="true" /><span>Log visit</span></Link>}
              </div>

              <div className={s.stageTrack} aria-label="Stage">
                {(['potential', 'contacted', 'registered'] as const).map((st, i) => {
                  const idx = PRE_VISIT_STATUSES.some(p => p === v.status) ? PRE_VISIT_STATUSES.findIndex(p => p === v.status) : 2
                  return (
                    <span key={st} className={`${s.stageStep} ${i < idx ? s.stageDone : ''} ${i === idx ? s.stageNow : ''}`}>
                      {st === 'potential' ? 'Potential' : st === 'contacted' ? 'Contacted' : 'Registered (site visited)'}
                    </span>
                  )
                })}
              </div>

              <div className={s.statStrip}>
                <div className={s.stat}><div className={s.statValue}>{visits.length}</div><div className={s.statLabel}>Meetings</div></div>
                <div className={s.stat}><div className={s.statValue}>{daysSince === null ? '—' : daysSince === 0 ? 'Today' : `${daysSince}d`}</div><div className={s.statLabel}>Since last visit</div></div>
                <div className={s.stat}><div className={s.statValue}>{v.team_size ?? '—'}</div><div className={s.statLabel}>Team size</div></div>
                <div className={s.stat}><div className={s.statValue}>{allPhotos.length}</div><div className={s.statLabel}>Photos</div></div>
              </div>
            </section>

            {!v.archived && v.awaiting_site_visit && (
              <div className={`${s.banner} ${s.bannerWarn}`}>
                This vendor has met us at our factory but nobody has visited theirs yet. A site visit registers them properly.
                <div style={{ marginTop: 8 }}>
                  <Link className={s.primary} href={`/vendors/visit?vendor=${v.id}&kind=site_visit`}><Plus size={16} aria-hidden="true" /> Log the site visit</Link>
                </div>
              </div>
            )}
            {!v.archived && !v.awaiting_site_visit && PRE_VISIT_STATUSES.some(p => p === v.status) && visits.length === 0 && (
              <div className={`${s.banner} ${s.bannerWarn}`}>
                Nobody has met or visited this vendor yet.
                <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button type="button" className={s.secondary} disabled={busy}
                          onClick={() => void run(() => setVendorStatus(supabase, v.id, v.status === 'potential' ? 'contacted' : 'potential'))}>
                    {v.status === 'potential' ? 'Mark as contacted' : 'Mark as not contacted'}
                  </button>
                </div>
              </div>
            )}

            <div className={s.tabs} role="tablist" aria-label="Vendor sections">
              {([['visits', `Visits (${visits.length})`], ['profile', 'Profile'], ['photos', `Photos (${allPhotos.length})`]] as const).map(([k, label]) => (
                <button key={k} type="button" role="tab" aria-selected={tab === k} className={`${s.tab}${tab === k ? ` ${s.tabOn}` : ''}`} onClick={() => setTab(k)}>
                  {label}
                </button>
              ))}
            </div>

            {tab === 'visits' && (
              <section aria-label="Visits">
                {visits.length === 0 && (
                  <div className={s.emptyState}>
                    <div className={s.emptyTitle}>No visit recorded yet</div>
                    <div className={s.muted}>Every visit you log appears here with its photographs and location.</div>
                    {!v.archived && <Link className={s.primary} href={`/vendors/visit?vendor=${v.id}`}><Plus size={16} aria-hidden="true" /> Log the first visit</Link>}
                  </div>
                )}
                <div className={s.timeline}>
                  {visits.map(x => <VisitCard key={x.id} visit={x} />)}
                </div>
              </section>
            )}

            {tab === 'profile' && (
              <section className={s.card} aria-label="Profile">
                <dl className={s.facts}>
                  <Fact label="Contact person">{v.contact_name ?? 'Not known yet'}</Fact>
                  <Fact label="Mobile">
                    {v.phone ? <a href={telHref(v.phone)}>{formatPhone(v.phone)}</a> : 'Not known yet'}
                  </Fact>
                  <Fact label="Address">{v.address ?? 'Not known yet'}</Fact>
                  <Fact label="Can do">{v.capabilities.length > 0 ? labelsOf(CAPABILITIES, v.capabilities) : 'Not known yet'}</Fact>
                  {v.product_focus && <Fact label="Products">{labelOf(PRODUCT_FOCUS, v.product_focus)}</Fact>}
                  {v.team_size && <Fact label="Team size">{v.team_size}</Fact>}
                  {v.notes && <Fact label="Notes">{v.notes}</Fact>}
                  <Fact label="Added">{formatDay(v.created_at)}{v.created_by_name ? ` by ${v.created_by_name}` : ''}</Fact>
                  <Fact label="Last visit">{last ? `${daysAgoText(daysSince)} · ${formatWhen(last.visited_at)}` : 'Never visited'}</Fact>
                </dl>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  {!v.archived && <Link className={s.secondary} href={`/vendors/${v.id}/edit`}><Pencil size={15} aria-hidden="true" /> Edit profile</Link>}
                  {isAdmin && !v.archived && (
                    <button type="button" className={s.danger} disabled={busy} onClick={() => {
                      const reason = window.prompt('Why is this vendor being archived?')
                      if (reason && reason.trim().length >= 3) void run(() => archiveVendor(supabase, v.id, reason.trim()))
                    }}>Archive vendor</button>
                  )}
                </div>
              </section>
            )}

            {tab === 'photos' && (
              <section className={s.card} aria-label="Photographs">
                {allPhotos.length === 0 ? <div className={s.muted}>No photographs yet.</div> : <PhotoGrid photos={allPhotos} />}
              </section>
            )}
          </>
        )}
      </div>
    </VendorsLayout>
  )
}

function DetailSkeleton({ profile, isAdmin, onSignOut }: { profile: ReturnType<typeof useVendors>['profile']; isAdmin: boolean; onSignOut: () => void }) {
  if (!profile) return <LoadingScreen />
  return (
    <VendorsLayout profile={profile} isAdmin={isAdmin} onSignOut={onSignOut} title="Vendor">
      <div className={s.wrapWide} aria-hidden="true">
        <div className={s.hero}>
          <div className={s.skel} style={{ width: '60%', height: 24 }} />
          <div className={s.skel} style={{ width: '35%', height: 14 }} />
          <div className={s.skel} style={{ width: '100%', height: 48 }} />
        </div>
      </div>
    </VendorsLayout>
  )
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className={s.fact}><dt>{label}</dt><dd>{children}</dd></div>
}

function VisitCard({ visit: x }: { visit: Visit }) {
  const near = x.distance_m !== null && x.distance_m <= AT_SITE_METRES
  return (
    <article className={s.visit}>
      <div className={s.visitHead}>
        <span className={s.visitWhen}>{x.entered_later ? formatDay(x.visited_at) : formatWhen(x.visited_at)}</span>
        <span className={s.muted}>
          {x.entered_later ? `added on ${formatDay(x.recorded_at)} by ` : 'by '}{x.visited_by_name ?? 'unknown'}
        </span>
      </div>
      <div className={s.rowBadges}>
        <span className={`${s.badge} ${x.kind === 'site_visit' ? s.badgeDark : s.badgeSoft}`}>{labelOf(VISIT_KINDS, x.kind)}</span>
        <span className={s.badge}>{labelOf(VISIT_OUTCOMES, x.outcome)}</span>
        {x.entered_later
          ? <span className={`${s.badge} ${s.badgeWarn}`}>Added later · no proof</span>
          : x.location_source === 'not_applicable'
            ? null
            : x.location_source === 'unavailable'
              ? <span className={`${s.badge} ${s.badgeWarn}`}>No location recorded</span>
              : x.distance_m === null
                ? <span className={s.badge}>Location recorded</span>
                : near
                  ? <span className={`${s.badge} ${s.badgeGood}`}>At the vendor ({x.distance_m} m)</span>
                  : <span className={`${s.badge} ${s.badgeBad}`}>{(x.distance_m / 1000).toFixed(1)} km from the vendor</span>}
        {x.latitude !== null && x.longitude !== null && (
          <a className={s.badge} href={mapsHref(x.latitude, x.longitude)} target="_blank" rel="noopener noreferrer">View where</a>
        )}
      </div>
      <div className={s.rowMeta}>
        <strong>Met:</strong> {x.person_met}
      </div>
      <div style={{ whiteSpace: 'pre-wrap', fontSize: 14, color: '#303536', overflowWrap: 'anywhere' }}>{x.discussion}</div>
      {x.next_follow_up_on && <div className={s.rowMeta}><strong>Next follow-up:</strong> {formatDay(x.next_follow_up_on)}</div>}
      {x.photos.length > 0 && <PhotoGrid photos={x.photos} />}
    </article>
  )
}

function PhotoGrid({ photos }: { photos: VisitPhoto[] }) {
  const { supabase } = useVendors()
  const [urls, setUrls] = useState<Record<string, string | null>>({})
  const [open, setOpen] = useState<number | null>(null)

  useEffect(() => {
    let active = true
    ;(async () => {
      const entries = await Promise.all(photos.map(async p => [p.path, await signedVendorPhotoUrl(supabase, p.path)] as const))
      if (active) setUrls(Object.fromEntries(entries))
    })()
    return () => { active = false }
  }, [photos, supabase])

  // Left / Right / Escape in the enlarged view.
  useEffect(() => {
    if (open === null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(null)
      if (e.key === 'ArrowRight') setOpen(i => (i === null ? i : Math.min(photos.length - 1, i + 1)))
      if (e.key === 'ArrowLeft') setOpen(i => (i === null ? i : Math.max(0, i - 1)))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, photos.length])

  const current = open === null ? null : photos[open]
  const currentUrl = current ? urls[current.path] : null

  return (
    <>
      <div className={s.photos}>
        {photos.map((p, i) => (
          <button key={p.path} type="button" className={s.photoBtn} onClick={() => setOpen(i)}
                  aria-label={`Open ${labelOf(PHOTO_KINDS, p.kind)} photograph`}>
            {urls[p.path] ? (
              // eslint-disable-next-line @next/next/no-img-element -- a short-lived signed link
              <img src={urls[p.path] as string} alt={`${labelOf(PHOTO_KINDS, p.kind)} photograph`} loading="lazy" />
            ) : <span className={`${s.skel} ${s.photoFill}`} />}
            <span className={s.photoKind}>{labelOf(PHOTO_KINDS, p.kind)}</span>
          </button>
        ))}
      </div>
      {current && (
        <div className={s.lightbox} role="dialog" aria-modal="true" aria-label="Photograph" onClick={() => setOpen(null)}>
          {currentUrl && (
            // eslint-disable-next-line @next/next/no-img-element -- a short-lived signed link
            <img src={currentUrl} alt={`${labelOf(PHOTO_KINDS, current.kind)} photograph, enlarged`} />
          )}
          <div className={s.lightboxBar} onClick={e => e.stopPropagation()}>
            <button type="button" className={s.secondary} disabled={open === 0} onClick={() => setOpen(i => Math.max(0, (i ?? 0) - 1))}>Previous</button>
            <span>{(open ?? 0) + 1} / {photos.length} · {labelOf(PHOTO_KINDS, current.kind)}</span>
            <button type="button" className={s.secondary} disabled={open === photos.length - 1} onClick={() => setOpen(i => Math.min(photos.length - 1, (i ?? 0) + 1))}>Next</button>
            <button type="button" className={s.primary} onClick={() => setOpen(null)}>Close</button>
          </div>
        </div>
      )}
    </>
  )
}
