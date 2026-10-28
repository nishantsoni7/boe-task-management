'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Camera, CheckCircle2, MapPin, Search } from 'lucide-react'
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
  AT_SITE_METRES, MAX_PHOTOS_PER_VISIT, PHOTO_KINDS, PRE_VISIT_STATUSES, VISIT_KINDS, VISIT_OUTCOMES, VISIT_PURPOSES,
  labelOf, type PhotoKind, type VisitKind,
} from '@/lib/vendors/constants'
import { shrinkPhoto, uploadVendorPhoto } from '@/lib/vendors/photos'
import {
  EMPTY_VENDOR, EMPTY_VISIT, isLiveSiteVisit, validateVendor, validateVisit, vendorPayload,
  type FieldErrors, type VendorField, type VisitDraft, type VisitField,
} from '@/lib/vendors/validation'
import { Chips, Field } from './VendorBits'
import VendorFields from './VendorFields'
import s from './vendors.module.css'

// Log a meeting with a vendor. One screen, top to bottom:
//   what happened   we went to their factory (the proof event) / they came to ours
//   which vendor    an existing one, or a new one
//   the details     purpose, person met, what was discussed, outcome
//   photographs     required for a live visit to their factory, optional otherwise
//   location        captured automatically, for a live visit to their factory only
// A visit that already happened (before this system existed) can be typed in without proof while the owner's
// catch-up window is open; it is always shown as "Added later".
// Saving uploads the photographs, creates the vendor if it is new, completes the profile if a site visit is
// registering a vendor we only knew by name, then records the meeting. Each step carries its own idempotency key,
// so a dropped signal and a second tap on Save never makes a second vendor or a second visit.

type Photo = { key: string; kind: PhotoKind; blob: Blob; preview: string }
type Where =
  | { state: 'asking' }
  | { state: 'ok'; latitude: number; longitude: number; accuracy: number }
  | { state: 'unavailable'; reason: string }

type Picked = { id: string; name: string; siteVisitCount: number }

const DRAFT_KEY = 'vendors:visit-draft:v2'
type Draft = {
  v: 2; kind: VisitKind; later: boolean; mode: 'existing' | 'new'; picked: Picked | null
  vendor: VendorInput; visit: VisitDraft
}

export default function LogVisitScreen() {
  const { supabase, profile, isAdmin, pastEntriesOpen, pastEntriesUntil, loading, signOut } = useVendors()
  const params = useSearchParams()
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
  const [where, setWhere] = useState<Where>({ state: 'asking' })
  const [vendorErrors, setVendorErrors] = useState<FieldErrors<VendorField>>({})
  const [completionErrors, setCompletionErrors] = useState<FieldErrors<VendorField>>({})
  const [visitErrors, setVisitErrors] = useState<FieldErrors<VisitField>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [duplicate, setDuplicate] = useState<{ id: string; name: string } | null>(null)
  const [done, setDone] = useState<(LogVisitResult & { name: string }) | null>(null)

  // Idempotency keys live for the life of one entry (see the note at the top).
  const keys = useRef({ vendor: newSubmissionId(), visit: newSubmissionId(), completion: newSubmissionId() })
  const createdVendorId = useRef<string | null>(null)
  const uploadedPaths = useRef(new Map<string, string>())

  // A past entry is only possible while the owner's window is open.
  const effectiveLater = later && pastEntriesOpen
  const live = isLiveSiteVisit(kind, effectiveLater)

  // ── Where the phone says it is (a live visit to their factory only) ──
  const requestFix = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      queueMicrotask(() => setWhere({ state: 'unavailable', reason: 'This phone does not share its location.' }))
      return
    }
    navigator.geolocation.getCurrentPosition(
      pos => setWhere({
        state: 'ok', latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: Math.round(pos.coords.accuracy),
      }),
      err => setWhere({
        state: 'unavailable',
        reason: err.code === err.PERMISSION_DENIED
          ? 'Location is switched off for this site. Allow it in the browser settings.'
          : 'The phone could not find its location.',
      }),
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 },
    )
  }, [])
  const locate = () => { setWhere({ state: 'asking' }); requestFix() }
  useEffect(() => { if (live) requestFix() }, [live, requestFix])

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
    queryFn: () => fetchVendorPage(supabase, { q: search.trim(), limit: 8 }),
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
      company_name: chosenVendor.company_name, contact_name: chosenVendor.contact_name ?? '',
      contact_designation: chosenVendor.contact_designation ?? '', phone: chosenVendor.phone ?? '',
      alt_phone: chosenVendor.alt_phone ?? '', email: chosenVendor.email ?? '', address: chosenVendor.address ?? '',
      city: chosenVendor.city ?? '', state: chosenVendor.state ?? '', pincode: chosenVendor.pincode ?? '',
      capabilities: chosenVendor.capabilities, categories: chosenVendor.categories, materials: chosenVendor.materials ?? '',
      headcount: chosenVendor.headcount === null ? '' : String(chosenVendor.headcount),
      monthly_capacity: chosenVendor.monthly_capacity ?? '', referred_by: chosenVendor.referred_by ?? '', notes: chosenVendor.notes ?? '',
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
          if (d && d.v === 2 && (d.visit?.discussion || d.vendor?.company_name || d.picked)) {
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
      else window.localStorage.setItem(DRAFT_KEY, JSON.stringify({ v: 2, kind, later, mode, picked, vendor, visit } satisfies Draft))
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
  const photoNeeded = live

  const checks = [
    { label: 'Vendor', ok: isNewVendor ? !!(vendor.company_name.trim() && (newVendorRelaxed || (vendor.phone.trim() && vendor.address.trim() && vendor.contact_name.trim() && vendor.capabilities.length))) : !!picked },
    ...(registering ? [{ label: 'Vendor details', ok: Object.keys(validateVendor(completion, false)).length === 0 }] : []),
    { label: 'Visit details', ok: !!(visit.purpose && visit.person_met.trim() && visit.discussion.trim().length >= 3 && visit.outcome && (!effectiveLater || visit.visited_on)) },
    ...(photoNeeded ? [{ label: 'Photos', ok: photos.length > 0 && (!needsFactoryPhoto || photos.some(p => p.kind === 'factory')) }] : []),
  ]
  const doneCount = checks.filter(c => c.ok).length

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

      setBusy('Recording the visit…')
      const input: VisitInput = {
        ...visit,
        kind,
        entered_later: effectiveLater,
        visited_on: effectiveLater ? visit.visited_on : '',
        person_met: visit.person_met.trim(),
        person_met_designation: visit.person_met_designation.trim(),
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
          <div className={s.card}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <CheckCircle2 size={26} color="#1D6B34" aria-hidden="true" />
              <h2 className={s.cardTitle}>
                {done.kind === 'vendor_at_our_factory' ? `Your meeting with ${done.name} is recorded` : `Your visit to ${done.name} is recorded`}
              </h2>
            </div>
            {done.entered_later
              ? <div className={`${s.banner} ${s.bannerWarn}`}>Recorded as “Added later”: it shows no photographs or location, and does not count as a proven visit.</div>
              : done.kind === 'vendor_at_our_factory'
                ? <div className={`${s.banner} ${s.bannerWarn}`}>Nobody has visited their factory yet. A site visit registers {done.name} properly — it now appears on the “awaiting site visit” list.</div>
                : done.location_source === 'gps'
                  ? <div className={`${s.banner} ${near || done.distance_m == null ? s.bannerOk : s.bannerWarn}`}>
                      {done.distance_m == null
                        ? 'Location recorded.'
                        : near
                          ? 'Location recorded — you were at the vendor.'
                          : `Location recorded — ${(done.distance_m / 1000).toFixed(1)} km from the vendor's address.`}
                    </div>
                  : <div className={`${s.banner} ${s.bannerWarn}`}>No location was recorded for this visit.</div>}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <Link className={s.primary} href={`/vendors/${done.vendor_id}`}>See the vendor</Link>
              <button className={s.secondary} type="button" onClick={() => window.location.assign('/vendors/visit')}>
                Log another
              </button>
            </div>
          </div>
        </div>
      </VendorsLayout>
    )
  }

  const photoCount = (k: PhotoKind) => photos.filter(p => p.kind === k).length
  const slotKinds: PhotoKind[] = ['factory', 'person', 'product']
  const today = istToday()

  return (
    <VendorsLayout profile={profile} isAdmin={isAdmin} onSignOut={signOut} title="Log a Visit" subtitle="Record who you met, where, and what you saw">
      <div className={s.wrap}>
        {restored && (
          <div className={`${s.banner} ${s.bannerOk}`} role="status">
            Your unfinished entry was restored. Photographs need to be added again.
            <button type="button" className={s.linkBtn} onClick={() => {
              try { window.localStorage.removeItem(DRAFT_KEY) } catch { /* nothing to clear */ }
              window.location.assign('/vendors/visit')
            }}>Start fresh</button>
          </div>
        )}

        {/* 0. What happened */}
        <section className={s.card} aria-labelledby="h-kind">
          <h2 id="h-kind" className={s.cardTitle}>What happened?</h2>
          <div className={s.kindTabs} role="radiogroup" aria-label="What happened">
            {VISIT_KINDS.map(o => (
              <button key={o.value} type="button" role="radio" aria-checked={kind === o.value}
                      className={`${s.kindTab}${kind === o.value ? ` ${s.kindTabOn}` : ''}`} onClick={() => setKind(o.value)}>
                <span className={s.kindTitle}>{o.label}</span>
                <span className={s.kindHint}>{o.value === 'site_visit' ? 'Photos and location required' : 'No photos or location needed'}</span>
              </button>
            ))}
          </div>
          {kind === 'vendor_at_our_factory' && (
            <div className={s.hint}>A vendor who comes to us is recorded here. They are registered only when someone from our team visits their factory.</div>
          )}

          {pastEntriesOpen ? (
            <div className={later ? s.laterBox : undefined}>
              <label className={s.switchRow}>
                <input type="checkbox" checked={later} onChange={e => setLater(e.target.checked)} />
                This already happened (I am entering it now)
              </label>
              {later && (
                <>
                  <div className={s.hint}>
                    It will be saved as “Added later”: no photographs or location are needed, and it does not count as a proven visit.
                    {pastEntriesUntil ? ` Past entries can be added until ${new Date(`${pastEntriesUntil}T00:00:00+05:30`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' })}.` : ''}
                  </div>
                  <Field label="Day it happened" required error={visitErrors.visited_on} htmlFor="x-on">
                    <input id="x-on" type="date" className={`${s.input}${visitErrors.visited_on ? ` ${s.invalid}` : ''}`}
                           min={istAddDays(today, -120)} max={today} value={visit.visited_on}
                           onChange={e => setVisit(d => ({ ...d, visited_on: e.target.value }))} />
                  </Field>
                </>
              )}
            </div>
          ) : null}
        </section>

        {/* 1. Which vendor */}
        <section className={s.card} aria-labelledby="h-vendor">
          <h2 id="h-vendor" className={s.cardTitle}>Which vendor?</h2>
          <div className={s.chips}>
            <button type="button" className={`${s.chip}${mode === 'existing' ? ` ${s.chipOn}` : ''}`} onClick={() => setMode('existing')}>
              A vendor already in the list
            </button>
            <button type="button" className={`${s.chip}${mode === 'new' ? ` ${s.chipOn}` : ''}`}
                    onClick={() => { setMode('new'); setPicked(null) }}>
              A new vendor
            </button>
          </div>

          {mode === 'existing' && picked && (
            <div className={s.chosen}>
              <div>
                <div className={s.rowName}>{picked.name}</div>
                <div className={s.muted}>
                  {chosenVendor ? labelOf([{ value: 'potential', label: 'Potential' }, { value: 'contacted', label: 'Contacted' }, { value: 'prospect', label: 'Registered' }], PRE_VISIT_STATUSES.some(p => p === chosenVendor.status) ? chosenVendor.status : 'prospect') : ''}
                  {chosen.data ? ` · ${chosen.data.visits.length} earlier meeting${chosen.data.visits.length === 1 ? '' : 's'}` : ''}
                </div>
              </div>
              {!presetId && <button type="button" className={s.secondary} onClick={() => { setPicked(null); setCompletionLoadedFor(null) }}>Change</button>}
            </div>
          )}
          {mode === 'existing' && !picked && (
            <div className={s.vendorPick}>
              <div className={s.searchWrap}>
                <Search size={16} className={s.searchIcon} aria-hidden="true" />
                <input className={`${s.input} ${s.searchInput}`} value={search} onChange={e => setSearch(e.target.value)}
                       placeholder="Search by company, person, phone or city" aria-label="Search vendors" autoComplete="off" />
              </div>
              {results.isFetching && <div className={s.muted}>Searching…</div>}
              {results.data?.rows.map(r => (
                <button key={r.id} type="button" className={s.pickItem}
                        onClick={() => {
                          setPicked({ id: r.id, name: r.company_name, siteVisitCount: r.site_visit_count })
                          setVisit(v => ({ ...v, person_met: v.person_met || (r.contact_name ?? '') }))
                        }}>
                  <span className={s.rowName}>{r.company_name}</span>
                  <span className={s.rowMeta}>{[r.contact_name, r.city].filter(Boolean).join(' · ') || 'No contact details yet'}</span>
                </button>
              ))}
              {results.data && results.data.rows.length === 0 && (
                <div className={s.muted}>No vendor found. Check the spelling, or choose “A new vendor”.</div>
              )}
            </div>
          )}

          {isNewVendor && (
            <>
              {duplicate && (
                <div className={`${s.banner} ${s.bannerWarn}`} role="alert">
                  This vendor is already in the list: <strong>{duplicate.name}</strong>. Log the meeting against that vendor instead.
                  <div style={{ marginTop: 8 }}>
                    <button type="button" className={s.secondary} onClick={() => {
                      setPicked({ id: duplicate.id, name: duplicate.name, siteVisitCount: 0 })
                      setMode('existing'); setDuplicate(null)
                    }}>Use {duplicate.name}</button>
                  </div>
                </div>
              )}
              {newVendorRelaxed && <div className={s.hint}>Only the company name is needed for now; the rest can be filled in when their factory is visited.</div>}
              <VendorFields relaxed={newVendorRelaxed} value={vendor} errors={vendorErrors}
                            onChange={patch => setVendor(v => ({ ...v, ...patch }))} />
            </>
          )}
        </section>

        {/* 1b. Registering a vendor we only knew by name */}
        {registering && (
          <section className={s.card} aria-labelledby="h-complete">
            <h2 id="h-complete" className={s.cardTitle}>Complete the vendor’s details</h2>
            <div className={s.hint}>This visit registers the vendor, so its profile needs to be complete. Fill in what you saw.</div>
            <VendorFields value={completion} errors={completionErrors} onChange={patch => setCompletion(v => ({ ...v, ...patch }))} />
          </section>
        )}

        {/* 2. The meeting */}
        <section className={s.card} aria-labelledby="h-visit">
          <h2 id="h-visit" className={s.cardTitle}>The meeting</h2>
          <Field label="Purpose" required error={visitErrors.purpose}>
            <Chips label="Purpose" options={VISIT_PURPOSES} value={visit.purpose} onChange={v => setVisit(d => ({ ...d, purpose: v as string }))} />
          </Field>
          <div className={s.grid2}>
            <Field label="Person you met" required error={visitErrors.person_met} htmlFor="x-person">
              <input id="x-person" className={`${s.input}${visitErrors.person_met ? ` ${s.invalid}` : ''}`} value={visit.person_met}
                     maxLength={120} onChange={e => setVisit(d => ({ ...d, person_met: e.target.value }))} />
            </Field>
            <Field label="Their designation" htmlFor="x-desig">
              <input id="x-desig" className={s.input} value={visit.person_met_designation} maxLength={80}
                     onChange={e => setVisit(d => ({ ...d, person_met_designation: e.target.value }))} />
            </Field>
          </div>
          <Field label="What was discussed / what you saw" required error={visitErrors.discussion} htmlFor="x-disc"
                 hint="Products they make, quality, capacity, rates, timelines, anything useful later">
            <textarea id="x-disc" className={`${s.textarea}${visitErrors.discussion ? ` ${s.invalid}` : ''}`} value={visit.discussion}
                      maxLength={2000} onChange={e => setVisit(d => ({ ...d, discussion: e.target.value }))} />
          </Field>
          <Field label="Outcome" required error={visitErrors.outcome}>
            <Chips label="Outcome" options={VISIT_OUTCOMES} value={visit.outcome} onChange={v => setVisit(d => ({ ...d, outcome: v as string }))} />
          </Field>
          {visit.outcome !== 'not_suitable' && visit.outcome !== 'approved_to_start' && (
            <Field label="Next follow-up date" required={visit.outcome === 'follow_up_needed'} error={visitErrors.next_follow_up_on} htmlFor="x-next">
              <input id="x-next" type="date" className={`${s.input}${visitErrors.next_follow_up_on ? ` ${s.invalid}` : ''}`}
                     min={today} value={visit.next_follow_up_on} onChange={e => setVisit(d => ({ ...d, next_follow_up_on: e.target.value }))} />
            </Field>
          )}
        </section>

        {/* 3. Photographs */}
        <section className={s.card} aria-labelledby="h-photos">
          <h2 id="h-photos" className={s.cardTitle}>Photographs{photoNeeded ? '' : ' (optional)'}</h2>
          <div className={s.muted}>
            {photoNeeded
              ? (needsFactoryPhoto ? 'This is the first visit to their factory: a photograph of the factory is required. ' : 'At least one photograph is required. ') + 'Take them now, at the vendor.'
              : effectiveLater ? 'Photographs are not needed for a visit that already happened, but add any you have.'
                : 'Photographs are not needed for a meeting at our factory, but add one if it helps (samples they brought, for example).'}
          </div>
          {visitErrors.photos && <div className={s.err} role="alert">{visitErrors.photos}</div>}
          <div className={s.photoSlots}>
            {slotKinds.map(pk => (
              <div key={pk} className={s.photoSlot}>
                <div className={s.photoSlotHead}>
                  <strong>{labelOf(PHOTO_KINDS, pk)}{pk === 'factory' && photoNeeded && needsFactoryPhoto && <span className={s.req}>*</span>}</strong>
                  <label className={s.secondary} style={{ cursor: 'pointer' }}>
                    <Camera size={16} aria-hidden="true" /> {photoNeeded ? 'Take photo' : 'Add photo'}
                    <input className={s.hiddenFile} type="file" accept="image/*" {...(photoNeeded ? { capture: 'environment' as const } : {})} multiple
                           onChange={e => { void addPhotos(pk, e.target.files); e.target.value = '' }} />
                  </label>
                </div>
                {photoCount(pk) > 0 && (
                  <div className={s.thumbs}>
                    {photos.filter(p => p.kind === pk).map(p => (
                      <div key={p.key} className={s.thumb}>
                        {/* eslint-disable-next-line @next/next/no-img-element -- a local blob preview */}
                        <img src={p.preview} alt={`${labelOf(PHOTO_KINDS, pk)} photograph`} />
                        <button type="button" className={s.thumbX} aria-label="Remove this photograph" onClick={() => setPhotos(list => list.filter(x => x.key !== p.key))}>×</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* 4. Location (a live visit to their factory only) */}
        {live && (
          <section className={s.card} aria-labelledby="h-where">
            <h2 id="h-where" className={s.cardTitle}>Location</h2>
            {where.state === 'asking' && <div className={s.muted}><MapPin size={14} aria-hidden="true" /> Finding your location…</div>}
            {where.state === 'ok' && (
              <div className={`${s.banner} ${s.bannerOk}`}>
                <MapPin size={14} aria-hidden="true" /> Location captured (accurate to about {where.accuracy} m). It is saved with the visit.
              </div>
            )}
            {where.state === 'unavailable' && (
              <div className={`${s.banner} ${s.bannerWarn}`}>
                {where.reason} The visit can still be saved, but it will be marked “no location”.
                <div style={{ marginTop: 8 }}><button type="button" className={s.secondary} onClick={locate}>Try again</button></div>
              </div>
            )}
          </section>
        )}

        {problem && <div className={`${s.banner} ${s.bannerErr}`} role="alert">{problem}</div>}
        <div className={s.submitBar}>
          <ul className={s.checklist} aria-label="What is left to fill in">
            {checks.map(c => (
              <li key={c.label} className={c.ok ? s.checkOk : s.checkTodo}>
                <span aria-hidden="true">{c.ok ? '✓' : '○'}</span> {c.label}
              </li>
            ))}
            {live && (
              <li className={where.state === 'ok' ? s.checkOk : s.checkWarn}>
                <span aria-hidden="true">{where.state === 'ok' ? '✓' : '!'}</span> Location
              </li>
            )}
          </ul>
          <button type="button" className={s.primary} disabled={!!busy} onClick={() => void save()}>
            {busy ?? (doneCount === checks.length ? 'Save' : `Save (${doneCount} of ${checks.length} ready)`)}
          </button>
        </div>
      </div>
    </VendorsLayout>
  )
}
