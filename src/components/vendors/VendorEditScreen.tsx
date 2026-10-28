'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { VendorsLayout } from '@/components/layout/VendorsLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { useVendors } from '@/hooks/useVendors'
import { VENDORS_KEY, fetchVendor, saveVendor, type VendorInput } from '@/lib/vendors/api'
import { newSubmissionId } from '@/lib/exhibitionLeads/draft'
import { EMPTY_VENDOR, validateVendor, vendorPayload, type FieldErrors, type VendorField } from '@/lib/vendors/validation'
import VendorFields from './VendorFields'
import s from './vendors.module.css'

// Edit a vendor's profile. The visits are a record and are never edited.

export default function VendorEditScreen() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const qc = useQueryClient()
  const { supabase, profile, isAdmin, loading, signOut } = useVendors()
  const [value, setValue] = useState<VendorInput>(EMPTY_VENDOR)
  const [loaded, setLoaded] = useState(false)
  const [errors, setErrors] = useState<FieldErrors<VendorField>>({})
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const detail = useQuery({
    queryKey: [VENDORS_KEY, 'detail', id],
    queryFn: () => fetchVendor(supabase, id),
    enabled: !!profile,
  })

  // Filled once, while rendering, when the vendor arrives (so the form never shows empty then jumps).
  const v = detail.data?.vendor
  if (v && !loaded) {
    setLoaded(true)
    setValue({
      company_name: v.company_name, contact_name: v.contact_name, contact_designation: v.contact_designation ?? '',
      phone: v.phone, alt_phone: v.alt_phone ?? '', email: v.email ?? '', address: v.address, city: v.city,
      state: v.state ?? '', pincode: v.pincode ?? '', capabilities: v.capabilities, categories: v.categories,
      materials: v.materials ?? '', headcount: v.headcount === null ? '' : String(v.headcount),
      monthly_capacity: v.monthly_capacity ?? '', notes: v.notes ?? '',
    })
  }

  if (loading || !profile || detail.isLoading) return <LoadingScreen />

  async function save() {
    const e = validateVendor(value)
    setErrors(e)
    if (Object.keys(e).length > 0) { setProblem('Some details need attention — they are marked in red.'); return }
    setBusy(true)
    setProblem(null)
    try {
      await saveVendor(supabase, newSubmissionId(), id, vendorPayload(value))
      await qc.invalidateQueries({ queryKey: [VENDORS_KEY] })
      router.push(`/vendors/${id}`)
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'Could not save. Try again.')
      setBusy(false)
    }
  }

  return (
    <VendorsLayout profile={profile} isAdmin={isAdmin} onSignOut={signOut} title="Edit Vendor" subtitle={detail.data?.vendor.company_name}>
      <div className={s.wrap}>
        {detail.error && <div className={`${s.banner} ${s.bannerErr}`} role="alert">This vendor is not available.</div>}
        {detail.data && (
          <div className={s.card}>
            <VendorFields value={value} errors={errors} onChange={patch => setValue(v => ({ ...v, ...patch }))} />
            {problem && <div className={`${s.banner} ${s.bannerErr}`} role="alert">{problem}</div>}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button type="button" className={s.primary} disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save changes'}</button>
              <Link className={s.secondary} href={`/vendors/${id}`}>Cancel</Link>
            </div>
          </div>
        )}
      </div>
    </VendorsLayout>
  )
}
