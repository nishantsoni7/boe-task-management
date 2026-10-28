'use client'

import { CAPABILITIES, PRODUCT_FOCUS, TEAM_SIZES } from '@/lib/vendors/constants'
import type { VendorInput } from '@/lib/vendors/api'
import type { FieldErrors, VendorField } from '@/lib/vendors/validation'
import { Chips, Field } from './VendorBits'
import ScanVendorButton from './ScanVendorButton'
import s from './vendors.module.css'

// The vendor profile, kept to what the owner asked for: who they are, where they are, what they make, what they
// can do, how big they are, and a note.
//   Registered vendor (a site visit): company name, contact person, mobile, address and capability are required.
//   Potential / contacted vendor (`relaxed`): only the company name is; everything else can wait.

type Props = {
  value: VendorInput
  errors: FieldErrors<VendorField>
  onChange: (patch: Partial<VendorInput>) => void
  relaxed?: boolean
  /** Areas already in use: offered as suggestions, so "Basni" is spelled one way everywhere. */
  areas?: readonly string[]
}

export default function VendorFields({ value, errors, onChange, relaxed = false, areas = [] }: Props) {
  const need = !relaxed
  const cls = (k: VendorField) => `${s.input}${errors[k] ? ` ${s.invalid}` : ''}`
  return (
    <>
      <Field label="Company name" required error={errors.company_name} htmlFor="v-company">
        <input id="v-company" className={cls('company_name')} value={value.company_name} maxLength={160}
               autoComplete="off" onChange={e => onChange({ company_name: e.target.value })} />
      </Field>
      <Field label="Contact person" required={need} error={errors.contact_name} htmlFor="v-contact">
        <input id="v-contact" className={cls('contact_name')} value={value.contact_name} maxLength={120}
               autoComplete="off" onChange={e => onChange({ contact_name: e.target.value })} />
      </Field>
      <Field label="Mobile" required={need} error={errors.phone} htmlFor="v-phone">
        <input id="v-phone" className={cls('phone')} value={value.phone} inputMode="tel" autoComplete="off"
               placeholder="98765 43210" onChange={e => onChange({ phone: e.target.value })} />
      </Field>
      <Field label="Area" htmlFor="v-area" hint={areas.length === 0 ? 'The locality, for example Basni or Boranada' : undefined}>
        <input id="v-area" className={s.input} value={value.area} maxLength={80} list="v-area-list" autoComplete="off"
               placeholder="Basni" onChange={e => onChange({ area: e.target.value })} />
        <datalist id="v-area-list">{areas.map(a => <option key={a} value={a} />)}</datalist>
      </Field>
      <Field label="Address" required={need} error={errors.address} htmlFor="v-address">
        <textarea id="v-address" rows={2} className={`${s.textarea}${errors.address ? ` ${s.invalid}` : ''}`} value={value.address}
                  maxLength={500} onChange={e => onChange({ address: e.target.value })} />
        <ScanVendorButton value={value} onChange={onChange} />
      </Field>
      <Field label="Products">
        <Chips label="Products" options={PRODUCT_FOCUS} value={value.product_focus} clearable
               onChange={v => onChange({ product_focus: v as string })} />
      </Field>
      <Field label="Capability" required={need} error={errors.capabilities}>
        <Chips multiple label="Capability" options={CAPABILITIES} value={value.capabilities}
               onChange={v => onChange({ capabilities: v as string[] })} />
      </Field>
      <Field label="Team size">
        <Chips label="Team size" options={TEAM_SIZES} value={value.team_size} clearable
               onChange={v => onChange({ team_size: v as string })} />
      </Field>
      <Field label="Notes" htmlFor="v-notes">
        <textarea id="v-notes" rows={3} className={s.textarea} value={value.notes} maxLength={2000}
                  onChange={e => onChange({ notes: e.target.value })} />
      </Field>
    </>
  )
}
