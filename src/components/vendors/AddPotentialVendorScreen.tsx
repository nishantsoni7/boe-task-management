'use client'

import { useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { MapPin } from 'lucide-react'
import { VendorsLayout } from '@/components/layout/VendorsLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { useVendors } from '@/hooks/useVendors'
import { newSubmissionId } from '@/lib/exhibitionLeads/draft'
import { VENDORS_KEY, saveVendor } from '@/lib/vendors/api'
import { useDeviceLocation } from '@/lib/vendors/useDeviceLocation'
import { EMPTY_VENDOR, validateVendor, vendorPayload } from '@/lib/vendors/validation'
import { Field, Segmented } from './VendorBits'
import VendorFields from './VendorFields'
import s from './vendors.module.css'

// A vendor we have heard about, or spoken to, but not visited. Only the company name is needed; the rest can be
// filled in when someone visits their factory. The phone's location is found automatically: if the person is at
// the factory right now, one tick saves it as the factory's location (a visit later pins it too).

type Stage = 'potential' | 'contacted'

export default function AddPotentialVendorScreen() {
  const { supabase, profile, isAdmin, loading, signOut } = useVendors()
  const router = useRouter()
  const qc = useQueryClient()
  const [form, setForm] = useState(EMPTY_VENDOR)
  const [stage, setStage] = useState<Stage>('potential')
  const [atFactory, setAtFactory] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [errors, setErrors] = useState<ReturnType<typeof validateVendor>>({})
  const [duplicate, setDuplicate] = useState<{ id: string; name: string } | null>(null)
  const key = useRef(newSubmissionId())
  const { where, retry } = useDeviceLocation(true)

  if (loading || !profile) return <LoadingScreen />

  async function save() {
    if (busy) return
    const e = validateVendor(form, true)
    setErrors(e)
    setDuplicate(null)
    if (Object.keys(e).length > 0) { setProblem('Some details need attention.'); return }
    setBusy(true)
    setProblem(null)
    try {
      const payload = { ...vendorPayload(form), status: stage }
      if (atFactory && where.state === 'ok' && where.accuracy <= 200) {
        payload.latitude = where.latitude
        payload.longitude = where.longitude
      }
      const res = await saveVendor(supabase, key.current, null, payload)
      if (res.status === 'duplicate') {
        setDuplicate({ id: res.id, name: res.company_name })
        setBusy(false)
        return
      }
      await qc.invalidateQueries({ queryKey: [VENDORS_KEY] })
      router.push(`/vendors/${res.id}`)
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'Could not save. Nothing was confirmed saved — try again.')
      setBusy(false)
    }
  }

  return (
    <VendorsLayout profile={profile} isAdmin={isAdmin} onSignOut={signOut} title="Add Vendor">
      <div className={s.wrap}>
        <div className={s.formStack}>
          <Field label="Status">
            <Segmented label="Where are we with them" value={stage} onChange={v => v && setStage(v as Stage)} options={[
              { value: 'potential', label: 'Not contacted yet' },
              { value: 'contacted', label: 'Already spoken to' },
            ]} />
          </Field>

          <VendorFields relaxed value={form} errors={errors} onChange={patch => setForm(f => ({ ...f, ...patch }))} />

          <Field label="Location">
            <div className={s.locationBox}>
              <div className={s.locationLine}>
                <MapPin size={14} aria-hidden="true" />
                {where.state === 'asking' && <span>Finding your location…</span>}
                {where.state === 'ok' && <span>Location found (about {where.accuracy} m)</span>}
                {where.state === 'unavailable' && (
                  <span className={s.locationWarn}>{where.reason} <button type="button" className={s.linkBtn} onClick={retry}>Try again</button></span>
                )}
              </div>
              {where.state === 'ok' && (
                <label className={s.switchRow}>
                  <input type="checkbox" checked={atFactory} onChange={e => setAtFactory(e.target.checked)} />
                  I am at the vendor’s factory now — save this as its location
                </label>
              )}
            </div>
          </Field>
        </div>

        {duplicate && (
          <div className={`${s.banner} ${s.bannerWarn}`} role="alert">
            <strong>{duplicate.name}</strong> is already in the list. <Link className={s.linkBtn} href={`/vendors/${duplicate.id}`}>Open it</Link>
          </div>
        )}
        {problem && <div className={`${s.banner} ${s.bannerErr}`} role="alert">{problem}</div>}
        <div className={`${s.submitBar} ${s.submitBarEnd}`}>
          <Link className={s.secondary} href="/vendors">Cancel</Link>
          <button type="button" className={s.primary} disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Add vendor'}</button>
        </div>
      </div>
    </VendorsLayout>
  )
}
