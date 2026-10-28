'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Camera, CheckCircle2, MapPin, Plus, Search } from 'lucide-react'
import { VendorsLayout } from '@/components/layout/VendorsLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { useVendors } from '@/hooks/useVendors'
import { istToday, istAddDays } from '@/lib/istDate'
import { newSubmissionId } from '@/lib/exhibitionLeads/draft'
import {
  VENDORS_KEY, fetchVendor, fetchVendorPage, logVisit, saveVendor,
  type LogVisitResult, type VendorInput, type VisitInput,
} from '@/lib/vendors/api'
import {
  AT_SITE_METRES, MAX_PHOTOS_PER_VISIT, PRE_VISIT_STATUSES, VISIT_KINDS, VISIT_OUTCOMES,
  type PhotoKind, type VisitKind,
} from '@/lib/vendors/constants'
import { shrinkPhoto, uploadVendorPhoto } from '@/lib/vendors/photos'
import { useDeviceLocation } from '@/lib/vendors/useDeviceLocation'
import { useVendorAreas } from '@/lib/vendors/useVendorAreas'
import {
  EMPTY_VENDOR, EMPTY_VISIT, isLiveSiteVisit, validateVendor, validateVisit, vendorPayload,
  type FieldErrors, type VendorField, type VisitDraft, type VisitField,
} from '@/lib/vendors/validation'
import { Field, Segmented } from './VendorBits'
import VendorFields from './VendorFields'
import s from './vendors.module.css'

// Log a meeting with a vendor — one flat page, top to bottom:
//   what happened     we went to their factory (the proof event) / they came to ours
//   vendor            an existing one, or a new one
//   the meeting       who, what was said, the outcome
//   photographs       required for a live visit to their factory, optional otherwise
//   location          captured automatically, for a live visit to their factory only
// A visit that already happened (before this system existed) can be typed in without proof while the owner's
// catch-up window is open; it is always shown as "Added later".
// Saving uploads the photographs, creates the vendor if it is new, completes the profile if a site visit is
// registering a vendor we only knew by name, then records the meeting. Each step carries its own idempotency key,
// so a dropped signal and a second tap on Save never makes a second vendor or a second visit.

type Photo = { key: string; kind: PhotoKind; blob: Blob; preview: string }
type Picked = { id: string; name: string; siteVisitCount: number }

const OUTCOME_SHORT: Record<string, string> = {
  interested: 'Interested', follow_up_needed: 'Follow up', sample_requested: 'Sample', approved_to_start: 'Approved', not_suitable: 'Not suitable',
}
const OUTCOME_DOT: Record<string, string> = {
  interested: s.dotInterested, follow_up_needed: s.dotFollow, sample_requested: s.dotSample, approved_to_start: s.dotApproved, not_suitable: s.dotNo,
}
const TILE_TAG: Record<string, string> = { factory: 'Factory', person: 'Other', other: '' }

const DRAFT_KEY = 'vendors:visit-draft:v3'
type Draft = {
  v: 3; kind: VisitKind; later: boolean; mode: 'existing' | 'new'; picked: Picked | null
  vendor: VendorInput; visit: VisitDraft
}

export default function LogVisitScreen() {
  const { supabase, profile, isAdmin, pastEntriesOpen, pastEntriesUntil, loading, signOut } = useVendors()
  const params = useSearchParams()
  const areas = useVendorAreas(supabase, !!profile)
  const qc = useQueryClient()
  const presetId = params.get('vendor')

  const [kind, setKind] = useState<VisitKind>(params.get('kind') === 'vendor_at_our_factory' ? 'vendor_at_our_factory' : 'site_visit')
  const [later, setLater] = useState(false)
  const [mode, setMode] = useState<'existing' | 'new'>('existing')
  const [picked, setPicked] = useState<Picked | null>(null)
  const [search, setSearch] = useState('')
  const [vendor, setVendor] = useState<VendorInput>(EMPTY_VENDOR)
  const [completion, setCompletion] = useState<VendorInput>(EMPTY_VENDOR)
  const [completionLoadedFor, setCompletionLoadedFor] = useState<string | null>(null)
  const [visit, setVisit] = useState<VisitDraft>(EMPTY_VISIT)
  const [photos, setPhotos] = useState<Photo[]>([])
  const [vendorErrors, setVendorErrors] = useState<FieldErrors<VendorField>>({})
  const [completionErrors, setCompletionErrors] = useState<FieldErrors<VendorField>>({})
  const [visitErrors, setVisitErrors] = useState<FieldErrors<VisitField>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [duplicate, setDuplicate] = useState<{ id: string; name: string } | null>(null)
  const [done, setDone] = useState<(LogVisitResult & { name: string }) | null>(null)
  const [dragOn, setDragOn] = useState(false)
  const [draftSaved, setDraftSaved] = useState(false)

  // Idempotency keys live for the life of one entry (see the note at the top).
  const keys = useRef({ vendor: newSubmissionId(), visit: newSubmissionId(), completion: newSubmissionId() })
  const createdVendorId = useRef<string | null>(null)
  const uploadedPaths = useRef(new Map<string, string>())

  // A past entry is only possible while the owner's window is open.
  const effectiveLater = later && pastEntriesOpen
  const live = isLiveSiteVisit(kind, effectiveLater)

  // ── Where the phone says it is (a live visit to their factory only) ──
  const { where, retry: locate } = useDeviceLocation(live)

  // ── A vendor named in the link (Log a visit from a vendor page) ───
  const preset = useQuery({
    queryKey: [VENDORS_KEY, 'detail', presetId],
    queryFn: () => fetchVendor(supabase, presetId as string),
    enabled: !!presetId && !!profile,
  })
  // Applied once, while rendering, the moment the vendor arrives (no effect, so no extra render pass).
  const [presetApplied, setPresetApplied] = useState(false)
  if (preset.data && !presetApplied) {
    setPresetApplied(true)
    setPicked({
      id: preset.data.vendor.id, name: preset.data.vendor.company_name,
      siteVisitCount: preset.data.visits.filter(x => x.kind === 'site_visit').length,
    })
    setVisit(v => ({ ...v, person_met: v.person_met || (preset.data.vendor.contact_name ?? '') }))
  }

  const results = useQuery({
    queryKey: [VENDORS_KEY, 'pick', search.trim()],
    queryFn: () => fetchVendorPage(supabase, { q: search.trim(), limit: 6 }),
    enabled: mode === 'existing' && !picked && search.trim().length >= 2 && !!profile,
  })

  // The chosen vendor's full record: tells us its stage, whether its profile is complete, and its earlier visits.
  const chosen = useQuery({
    queryKey: [VENDORS_KEY, 'detail', picked?.id],
    queryFn: () => fetchVendor(supabase, picked?.id as string),
    enabled: !!picked && !!profile,
  })
  const chosenVendor = chosen.data?.vendor
  const registering = kind === 'site_visit' && !!chosenVendor
    && PRE_VISIT_STATUSES.some(p => p === chosenVendor.status) && !chosenVendor.profile_complete
  // Prefill the "complete the profile" form once per vendor, while rendering.
  if (chosenVendor && completionLoadedFor !== chosenVendor.id) {
    setCompletionLoadedFor(chosenVendor.id)
    setCompletion({
      company_name: chosenVendor.company_name, contact_name: chosenVendor.contact_name ?? '', phone: chosenVendor.phone ?? '',
      address: chosenVendor.address ?? '', capabilities: chosenVendor.capabilities,
      product_focus: chosenVendor.product_focus ?? '', team_size: chosenVendor.team_size ?? '', area: chosenVendor.area ?? '', notes: chosenVendor.notes ?? '',
    })
  }

  // Free the object URLs when the photographs go.
  const previews = useRef<string[]>([])
  useEffect(() => () => { previews.current.forEach(URL.revokeObjectURL) }, [])

  // A half-written entry survives a dropped signal, a locked phone or an accidental swipe away: the typed
  // fields are kept on this device and offered back. (Photographs are not kept — they are retaken or re-added.)
  const [restored, setRestored] = useState(false)
  const draftReady = useRef(false)
  useEffect(() => {
    // Read after mount (storage does not exist on the server); applied from a microtask, not the effect body.
    queueMicrotask(() => {
      try {
        const raw = window.localStorage.getItem(DRAFT_KEY)
        if (raw && !presetId) {
          const d = JSON.parse(raw) as Draft
          if (d && d.v === 3 && (d.visit?.discussion || d.vendor?.company_name || d.picked)) {
            setKind(d.kind); setLater(d.later); setMode(d.mode); setPicked(d.picked)
            setVendor({ ...EMPTY_VENDOR, ...d.vendor }); setVisit({ ...EMPTY_VISIT, ...d.visit })
            setRestored(true)
          }
        }
      } catch { /* no storage, or an old draft — start clean */ }
      draftReady.current = true
    })
  }, [presetId])
  useEffect(() => {
    if (!draftReady.current || done) return
    try {
      const empty = !visit.discussion && !visit.person_met && !vendor.company_name && !picked
      if (empty) window.localStorage.removeItem(DRAFT_KEY)
      else {
        window.localStorage.setItem(DRAFT_KEY, JSON.stringify({ v: 3, kind, later, mode, picked, vendor, visit } satisfies Draft))
        queueMicrotask(() => setDraftSaved(true))
      }
    } catch { /* storage unavailable — the form still works */ }
  }, [kind, later, mode, picked, vendor, visit, done])

  if (loading || !profile) return <LoadingScreen />

  const isNewVendor = mode === 'new'
  // A vendor met at our factory may stay a name; one that is visited is registered, so it needs everything.
  const newVendorRelaxed = kind === 'vendor_at_our_factory'
  const liveSiteVisits = chosen.data
    ? chosen.data.visits.filter(x => x.kind === 'site_visit' && !x.entered_later).length
    : (picked?.siteVisitCount ?? 0)
  const needsFactoryPhoto = isNewVendor || liveSiteVisits === 0
  const hasFactory = photos.some(p => p.kind === 'factory')

  // What is still missing: the first item is shown beside the Save button.
  const missing: string[] = []
  if (isNewVendor) {
    if (Object.keys(validateVendor(vendor, newVendorRelaxed)).length > 0) missing.push('Fill in the vendor’s details')
  } else if (!picked) missing.push('Choose the vendor')
  if (registering && Object.keys(validateVendor(completion, false)).length > 0) missing.push('Complete the vendor’s details')
  if (!visit.person_met.trim()) missing.push('Who did you meet?')
  if (visit.discussion.trim().length < 3) missing.push('Add a note about the meeting')
  if (!visit.outcome) missing.push('Choose the outcome')
  if (effectiveLater && !visit.visited_on) missing.push('Choose the day it happened')
  if (live && photos.length === 0) missing.push(needsFactoryPhoto ? 'Take a photo of the factory' : 'Take a photo')
  else if (live && needsFactoryPhoto && !photos.some(p => p.kind === 'factory')) missing.push('Take a photo of the factory')

  async function addPhotos(photoKind: PhotoKind, files: FileList | null) {
    if (!files || files.length === 0) return
    setProblem(null)
    for (const file of Array.from(files)) {
      if (photos.length >= MAX_PHOTOS_PER_VISIT) { setProblem(`At most ${MAX_PHOTOS_PER_VISIT} photographs per visit.`); break }
      try {
        const blob = await shrinkPhoto(file)
        const preview = URL.createObjectURL(blob)
        previews.current.push(preview)
        setPhotos(p => [...p, { key: newSubmissionId(), kind: photoKind, blob, preview }])
      } catch (e) {
        setProblem(e instanceof Error ? e.message : 'This photo could not be used.')
      }
    }
  }

  async function save() {
    if (busy || !profile) return
    setProblem(null)
    setDuplicate(null)
    const vErr = isNewVendor ? validateVendor(vendor, newVendorRelaxed) : {}
    const cErr = registering ? validateVendor(completion, false) : {}
    const xErr = validateVisit(visit, {
      kind, enteredLater: effectiveLater, photoKinds: photos.map(p => p.kind), needsFactoryPhoto, today: istToday(),
    })
    setVendorErrors(vErr)
    setCompletionErrors(cErr)
    setVisitErrors(xErr)
    if (!isNewVendor && !picked) { setProblem('Choose the vendor, or add a new one.'); return }
    if (Object.keys(vErr).length > 0 || Object.keys(cErr).length > 0 || Object.keys(xErr).length > 0) {
      setProblem('Some details need attention — they are marked in red.')
      return
    }

    try {
      let vendorId = picked?.id ?? createdVendorId.current
      let name = picked?.name ?? vendor.company_name.trim()
      if (isNewVendor && !vendorId) {
        setBusy('Saving the vendor…')
        const payload = { ...vendorPayload(vendor), status: newVendorRelaxed ? ('contacted' as const) : ('prospect' as const) }
        if (live && where.state === 'ok' && where.accuracy <= 200) {
          payload.latitude = where.latitude
          payload.longitude = where.longitude
        }
        const res = await saveVendor(supabase, keys.current.vendor, null, payload)
        if (res.status === 'duplicate') {
          setDuplicate({ id: res.id, name: res.company_name })
          setBusy(null)
          return
        }
        vendorId = res.id
        name = res.company_name
        createdVendorId.current = res.id
      }
      if (!vendorId) throw new Error('No vendor')

      // A site visit registers a vendor we only knew by name: complete the profile first.
      if (registering) {
        setBusy('Completing the vendor’s details…')
        await saveVendor(supabase, keys.current.completion, vendorId, vendorPayload(completion))
      }

      // Upload what has not gone up yet; a retry never uploads a photograph twice.
      const uploaded: { path: string; kind: PhotoKind }[] = []
      let n = 0
      for (const p of photos) {
        n += 1
        let path = uploadedPaths.current.get(p.key)
        if (!path) {
          setBusy(`Uploading photo ${n} of ${photos.length}…`)
          path = await uploadVendorPhoto(supabase, profile.id, p.blob)
          uploadedPaths.current.set(p.key, path)
        }
        uploaded.push({ path, kind: p.kind })
      }

      setBusy('Saving…')
      const input: VisitInput = {
        ...visit,
        kind,
        entered_later: effectiveLater,
        visited_on: effectiveLater ? visit.visited_on : '',
        person_met: visit.person_met.trim(),
        discussion: visit.discussion.trim(),
        photos: uploaded,
        latitude: live && where.state === 'ok' ? where.latitude : null,
        longitude: live && where.state === 'ok' ? where.longitude : null,
        accuracy_m: live && where.state === 'ok' ? where.accuracy : null,
      }
      const res = await logVisit(supabase, keys.current.visit, vendorId, input)
      await qc.invalidateQueries({ queryKey: [VENDORS_KEY] })
      try { window.localStorage.removeItem(DRAFT_KEY) } catch { /* nothing to clear */ }
      setDone({ ...res, name })
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'Something went wrong. Nothing was confirmed saved — try again.')
    } finally {
      setBusy(null)
    }
  }

  // ── Saved ─────────────────────────────────────────────────────────
  if (done) {
    const near = done.distance_m !== null && done.distance_m !== undefined && done.distance_m <= AT_SITE_METRES
    return (
      <VendorsLayout profile={profile} isAdmin={isAdmin} onSignOut={signOut} title="Saved">
        <div className={s.wrap}>
          <div className={s.section}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <CheckCircle2 size={20} color="#2A6B3D" aria-hidden="true" />
              <h2 className={s.cardTitle}>
                {done.kind === 'vendor_at_our_factory' ? `Meeting with ${done.name} recorded` : `Visit to ${done.name} recorded`}
              </h2>
            </div>
            {done.entered_later
              ? <div className={`${s.banner} ${s.bannerWarn}`}>Saved as “Added later”: no photographs or location, so it does not count as a proven visit.</div>
              : done.kind === 'vendor_at_our_factory'
                ? <div className={`${s.banner} ${s.bannerWarn}`}>Nobody has visited their factory yet. A site visit registers {done.name} properly; it now shows on the “awaiting a site visit” list.</div>
                : done.location_source === 'gps'
                  ? <div className={`${s.banner} ${near || done.distance_m == null ? s.bannerOk : s.bannerWarn}`}>
                      {done.distance_m == null
                        ? 'Location recorded.'
                        : near
                          ? 'Location recorded — you were at the vendor.'
                          : `Location recorded — ${(done.distance_m / 1000).toFixed(1)} km from the vendor's address.`}
                    </div>
                  : <div className={`${s.banner} ${s.bannerWarn}`}>No location was recorded for this visit.</div>}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Link className={s.primary} href={`/vendors/${done.vendor_id}`}>See the vendor</Link>
              <button className={s.secondary} type="button" onClick={() => window.location.assign('/vendors/visit')}>Log another</button>
            </div>
          </div>
        </div>
      </VendorsLayout>
    )
  }

  const today = istToday()
  return (
    <VendorsLayout profile={profile} isAdmin={isAdmin} onSignOut={signOut} title="Log Visit">
      <div className={s.wrap} onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void save() } }}>
        {restored && (
          <div className={`${s.banner} ${s.bannerOk}`} role="status">
            Your unfinished entry was restored (photographs need adding again).{' '}
            <button type="button" className={s.linkBtn} onClick={() => {
              try { window.localStorage.removeItem(DRAFT_KEY) } catch { /* nothing to clear */ }
              window.location.assign('/vendors/visit')
            }}>Start fresh</button>
          </div>
        )}

        <div className={s.formStack}>
          <Field label="Type" hint={kind === 'site_visit'
            ? 'Photographs and your location are saved with a visit to their factory.'
            : 'A vendor who comes to us needs no photographs. They are registered when someone from our team visits their factory.'}>
            <Segmented label="What happened" value={kind} onChange={v => v && setKind(v as VisitKind)}
                       options={VISIT_KINDS} />
          </Field>

          {pastEntriesOpen && (
            <Field label="When" hint={later
              ? `Saved as “Added later”: no photographs or location needed, and it does not count as a proven visit.${pastEntriesUntil ? ` Open until ${new Date(`${pastEntriesUntil}T00:00:00+05:30`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' })}.` : ''}`
              : undefined}>
              <Segmented label="When it happened" value={later ? 'earlier' : 'now'} onChange={v => v && setLater(v === 'earlier')}
                         options={[{ value: 'now', label: 'Just now' }, { value: 'earlier', label: 'Already happened' }]} />
            </Field>
          )}
          {pastEntriesOpen && later && (
            <Field label="Day" required error={visitErrors.visited_on} htmlFor="x-on">
              <input id="x-on" type="date" className={`${s.input}${visitErrors.visited_on ? ` ${s.invalid}` : ''}`}
                     min={istAddDays(today, -120)} max={today} value={visit.visited_on} style={{ maxWidth: 200 }}
                     onChange={e => setVisit(d => ({ ...d, visited_on: e.target.value }))} />
            </Field>
          )}

          <hr className={s.rule} />

          <Field label="Vendor" required={mode === 'existing' && !picked}>
            {mode === 'existing' && picked ? (
              <div className={s.chosen}>
                <div>
                  <div className={s.rowName}>{picked.name}</div>
                  {chosen.data && <div className={s.muted}>{chosen.data.visits.length} earlier meeting{chosen.data.visits.length === 1 ? '' : 's'}</div>}
                </div>
                {!presetId && <button type="button" className={s.linkBtn} onClick={() => { setPicked(null); setCompletionLoadedFor(null) }}>Change</button>}
              </div>
            ) : mode === 'existing' ? (
              <div className={s.vendorPick}>
                <div className={s.searchWrap}>
                  <Search size={16} className={s.searchIcon} aria-hidden="true" />
                  <input className={`${s.input} ${s.searchInput}`} value={search} onChange={e => setSearch(e.target.value)}
                         placeholder="Search by company, person or phone" aria-label="Search vendors" autoComplete="off" />
                </div>
                {results.data?.rows.map(r => (
                  <button key={r.id} type="button" className={s.pickItem}
                          onClick={() => {
                            setPicked({ id: r.id, name: r.company_name, siteVisitCount: r.site_visit_count })
                            setVisit(v => ({ ...v, person_met: v.person_met || (r.contact_name ?? '') }))
                            setTimeout(() => document.getElementById('x-disc')?.focus(), 50)
                          }}>
                    <span className={s.rowName}>{r.company_name}</span>
                    <span className={s.rowMeta}>{r.contact_name || 'No contact details yet'}</span>
                  </button>
                ))}
                {results.data && results.data.rows.length === 0 && <div className={s.muted} style={{ padding: '8px 0' }}>No vendor found.</div>}
                {results.isFetching && <div className={s.muted} style={{ padding: '8px 0' }}>Searching…</div>}
                <div><button type="button" className={s.linkBtn} onClick={() => { setMode('new'); setPicked(null) }}>+ New vendor</button></div>
              </div>
            ) : (
              <div>
                <button type="button" className={s.linkBtn} onClick={() => setMode('existing')}>← Pick an existing vendor</button>
              </div>
            )}
          </Field>

          {isNewVendor && (
            <>
              {duplicate && (
                <div className={`${s.banner} ${s.bannerWarn}`} role="alert">
                  <strong>{duplicate.name}</strong> is already in the list.{' '}
                  <button type="button" className={s.linkBtn} onClick={() => {
                    setPicked({ id: duplicate.id, name: duplicate.name, siteVisitCount: 0 })
                    setMode('existing'); setDuplicate(null)
                  }}>Use it</button>
                </div>
              )}
              <VendorFields relaxed={newVendorRelaxed} areas={areas} value={vendor} errors={vendorErrors}
                            onChange={patch => setVendor(v => ({ ...v, ...patch }))} />
            </>
          )}

          {registering && (
            <>
              <hr className={s.rule} />
              <div className={s.hint}>This visit registers the vendor, so its details need to be complete.</div>
              <VendorFields areas={areas} value={completion} errors={completionErrors} onChange={patch => setCompletion(v => ({ ...v, ...patch }))} />
            </>
          )}

          <hr className={s.rule} />

          <Field label="Person met" required error={visitErrors.person_met} htmlFor="x-person">
            <input id="x-person" className={`${s.input}${visitErrors.person_met ? ` ${s.invalid}` : ''}`} value={visit.person_met}
                   maxLength={120} autoComplete="off" onChange={e => setVisit(d => ({ ...d, person_met: e.target.value }))} />
          </Field>
          <Field label="Notes" required error={visitErrors.discussion} htmlFor="x-disc" hint="What they make, quality, capacity, rates, timelines">
            <textarea id="x-disc" rows={4} className={`${s.textarea}${visitErrors.discussion ? ` ${s.invalid}` : ''}`} value={visit.discussion}
                      maxLength={2000} onChange={e => setVisit(d => ({ ...d, discussion: e.target.value }))} />
          </Field>
          <Field label="Outcome" required error={visitErrors.outcome}>
            <div className={s.outcomeGrid} role="radiogroup" aria-label="Outcome">
              {VISIT_OUTCOMES.map(o => (
                <button key={o.value} type="button" role="radio" aria-checked={visit.outcome === o.value}
                        className={`${s.outcome}${visit.outcome === o.value ? ` ${s.outcomeOn}` : ''}`}
                        onClick={() => setVisit(d => ({ ...d, outcome: o.value }))}>
                  <span className={`${s.outcomeDot} ${OUTCOME_DOT[o.value] ?? ''}`} aria-hidden="true" />
                  {OUTCOME_SHORT[o.value] ?? o.label}
                </button>
              ))}
            </div>
          </Field>
          {visit.outcome !== 'not_suitable' && visit.outcome !== 'approved_to_start' && (
            <Field label="Follow up on" required={visit.outcome === 'follow_up_needed'} error={visitErrors.next_follow_up_on} htmlFor="x-next">
              <input id="x-next" type="date" className={`${s.input}${visitErrors.next_follow_up_on ? ` ${s.invalid}` : ''}`}
                     min={today} value={visit.next_follow_up_on} style={{ maxWidth: 200 }}
                     onChange={e => setVisit(d => ({ ...d, next_follow_up_on: e.target.value }))} />
            </Field>
          )}

          <hr className={s.rule} />

          <Field label="Photos" required={live} error={visitErrors.photos}
                 hint={live ? 'Take photos now, at the vendor. On a computer you can also drop files here.' : 'Optional.'}>
            <div className={s.fieldBody}>
              {live && (
                <div className={`${s.photoStatus}${hasFactory ? ` ${s.photoStatusOk}` : ''}`}>
                  {hasFactory ? <CheckCircle2 size={14} aria-hidden="true" /> : <Camera size={14} aria-hidden="true" />}
                  {hasFactory ? 'Factory photo added' : needsFactoryPhoto ? 'A photo of the factory is required' : 'Add photos of the visit'}
                </div>
              )}
              <div className={`${s.tiles} ${s.tilesDrop}${dragOn ? ` ${s.tilesDropOn}` : ''}`}
                   onDragOver={e => { e.preventDefault(); setDragOn(true) }} onDragLeave={() => setDragOn(false)}
                   onDrop={e => {
                     e.preventDefault(); setDragOn(false)
                     void addPhotos(live ? (needsFactoryPhoto && !hasFactory ? 'factory' : 'person') : 'other', e.dataTransfer.files)
                   }}>
                {photos.map(p => (
                  <div key={p.key} className={s.tile}>
                    {/* eslint-disable-next-line @next/next/no-img-element -- a local blob preview */}
                    <img src={p.preview} alt="Photograph to upload" />
                    {TILE_TAG[p.kind] && <span className={s.tileTag}>{TILE_TAG[p.kind]}</span>}
                    <button type="button" className={s.tileX} aria-label="Remove this photograph" onClick={() => setPhotos(list => list.filter(x => x.key !== p.key))}>×</button>
                  </div>
                ))}
                {live ? (
                  <>
                    <label className={`${s.tileAdd}${needsFactoryPhoto && !hasFactory ? ` ${s.tileRequired}` : ''}`}>
                      <Camera size={18} aria-hidden="true" /> Factory photo
                      <input className={s.hiddenFile} type="file" accept="image/*" capture="environment" multiple
                             onChange={e => { void addPhotos('factory', e.target.files); e.target.value = '' }} />
                    </label>
                    <label className={s.tileAdd}>
                      <Plus size={18} aria-hidden="true" /> Other photo
                      <input className={s.hiddenFile} type="file" accept="image/*" capture="environment" multiple
                             onChange={e => { void addPhotos('person', e.target.files); e.target.value = '' }} />
                    </label>
                  </>
                ) : (
                  <label className={s.tileAdd}>
                    <Plus size={18} aria-hidden="true" /> Add photo
                    <input className={s.hiddenFile} type="file" accept="image/*" multiple
                           onChange={e => { void addPhotos('other', e.target.files); e.target.value = '' }} />
                  </label>
                )}
              </div>
            </div>
          </Field>

          {live && (
            <Field label="Location">
              <div className={s.locationLine}>
                <MapPin size={14} aria-hidden="true" />
                {where.state === 'asking' && <span>Finding your location…</span>}
                {where.state === 'ok' && <span>Location captured (about {where.accuracy} m). Saved with the visit.</span>}
                {where.state === 'unavailable' && (
                  <span className={s.locationWarn}>{where.reason} The visit will be marked “no location”.{' '}
                    <button type="button" className={s.linkBtn} onClick={locate}>Try again</button></span>
                )}
              </div>
            </Field>
          )}
        </div>

        {problem && <div className={`${s.banner} ${s.bannerErr}`} role="alert">{problem}</div>}
        <div className={s.submitBar}>
          <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
            <span className={`${s.submitHint}${missing.length === 0 ? ` ${s.submitHintOk}` : ''}`}>
              {missing.length === 0 ? 'Ready to save' : missing[0]}
            </span>
            {draftSaved && <span className={s.draftNote}><span className={s.draftDot} aria-hidden="true" />Draft saved on this device</span>}
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className={`${s.kbdHint} ${s.hideOnPhone}`}><kbd className={s.kbdKey}>Ctrl</kbd> + <kbd className={s.kbdKey}>Enter</kbd></span>
            <button type="button" className={s.primary} disabled={!!busy} onClick={() => void save()}>{busy ?? 'Save'}</button>
          </span>
        </div>
      </div>
    </VendorsLayout>
  )
}
