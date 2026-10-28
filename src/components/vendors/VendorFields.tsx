'use client'

import { useState } from 'react'
import { Plus } from 'lucide-react'
import { CAPABILITIES, CATEGORIES } from '@/lib/vendors/constants'
import type { VendorInput } from '@/lib/vendors/api'
import type { FieldErrors, VendorField } from '@/lib/vendors/validation'
import { Chips, Field } from './VendorBits'
import s from './vendors.module.css'

// The vendor profile, kept to what the owner actually asked for. Like a Notion page, only the properties that
// matter are on screen; the optional ones appear when you add them ("+ Products", "+ People" …) or when they
// already hold a value.
//   Registered vendor (a site visit): company, contact, mobile, city, address and what they do are always shown.
//   Potential / contacted vendor (`relaxed`): company, who recommended them, contact, mobile and city are shown;
//   address and what they do can wait.

type Props = {
  value: VendorInput
  errors: FieldErrors<VendorField>
  onChange: (patch: Partial<VendorInput>) => void
  relaxed?: boolean
}

type Optional = 'referred_by' | 'address' | 'capabilities' | 'categories' | 'headcount' | 'notes'

const LABELS: Record<Optional, string> = {
  referred_by: 'Recommended by', address: 'Address', capabilities: 'What they do',
  categories: 'Products', headcount: 'People', notes: 'Notes',
}

export default function VendorFields({ value, errors, onChange, relaxed = false }: Props) {
  const need = !relaxed
  const cls = (k: VendorField) => `${s.input}${errors[k] ? ` ${s.invalid}` : ''}`

  // Which optional properties are on the page: the ones already filled, plus the ones the person adds.
  const [added, setAdded] = useState<ReadonlySet<Optional>>(new Set())
  const filled: Record<Optional, boolean> = {
    referred_by: value.referred_by.trim() !== '', address: value.address.trim() !== '', capabilities: value.capabilities.length > 0,
    categories: value.categories.length > 0, headcount: value.headcount.trim() !== '', notes: value.notes.trim() !== '',
  }
  // A property with an error must be visible, or the person would be told about something they cannot see.
  const errored: Partial<Record<Optional, boolean>> = {
    address: !!errors.address, capabilities: !!errors.capabilities, headcount: !!errors.headcount,
  }
  const always: ReadonlySet<Optional> = relaxed ? new Set<Optional>(['referred_by']) : new Set<Optional>(['address', 'capabilities'])
  const shown = (k: Optional) => always.has(k) || added.has(k) || filled[k] || !!errored[k]
  const add = (k: Optional) => setAdded(prev => new Set(prev).add(k))
  const hidden = (Object.keys(LABELS) as Optional[]).filter(k => !shown(k))

  const optionalField: Record<Optional, React.ReactNode> = {
    referred_by: (
      <Field label="Recommended by" htmlFor="v-ref" hint="Who gave us this reference">
        <input id="v-ref" className={s.input} value={value.referred_by} maxLength={200} autoFocus={added.has('referred_by')}
               onChange={e => onChange({ referred_by: e.target.value })} />
      </Field>
    ),
    address: (
      <Field label="Address" required={need} error={errors.address} htmlFor="v-address" hint="Exact location of the factory">
        <textarea id="v-address" rows={2} className={`${s.textarea}${errors.address ? ` ${s.invalid}` : ''}`} value={value.address}
                  maxLength={500} autoFocus={added.has('address')} onChange={e => onChange({ address: e.target.value })} />
      </Field>
    ),
    capabilities: (
      <Field label="What they do" required={need} error={errors.capabilities}>
        <Chips multiple label="What they do" options={CAPABILITIES} value={value.capabilities}
               onChange={v => onChange({ capabilities: v as string[] })} />
      </Field>
    ),
    categories: (
      <Field label="Products">
        <Chips multiple label="Products" options={CATEGORIES} value={value.categories}
               onChange={v => onChange({ categories: v as string[] })} />
      </Field>
    ),
    headcount: (
      <Field label="People" error={errors.headcount} htmlFor="v-head" hint="How many work at the unit">
        <input id="v-head" className={cls('headcount')} value={value.headcount} inputMode="numeric" maxLength={4}
               style={{ maxWidth: 120 }} autoFocus={added.has('headcount')} onChange={e => onChange({ headcount: e.target.value })} />
      </Field>
    ),
    notes: (
      <Field label="Notes" htmlFor="v-notes">
        <textarea id="v-notes" rows={3} className={s.textarea} value={value.notes} maxLength={2000}
                  autoFocus={added.has('notes')} onChange={e => onChange({ notes: e.target.value })} />
      </Field>
    ),
  }
  const order: Optional[] = ['referred_by', 'address', 'capabilities', 'categories', 'headcount', 'notes']

  return (
    <div className={s.formStack}>
      <Field label="Company" required error={errors.company_name} htmlFor="v-company">
        <input id="v-company" className={cls('company_name')} value={value.company_name} maxLength={160}
               autoComplete="off" onChange={e => onChange({ company_name: e.target.value })} />
      </Field>
      {relaxed && optionalField.referred_by}
      <Field label="Contact person" required={need} error={errors.contact_name} htmlFor="v-contact">
        <input id="v-contact" className={cls('contact_name')} value={value.contact_name} maxLength={120}
               autoComplete="off" onChange={e => onChange({ contact_name: e.target.value })} />
      </Field>
      <Field label="Mobile" required={need} error={errors.phone} htmlFor="v-phone">
        <input id="v-phone" className={cls('phone')} value={value.phone} inputMode="tel" autoComplete="off"
               placeholder="98765 43210" onChange={e => onChange({ phone: e.target.value })} />
      </Field>
      <Field label="City" required={need} error={errors.city} htmlFor="v-city">
        <input id="v-city" className={cls('city')} value={value.city} maxLength={80}
               onChange={e => onChange({ city: e.target.value })} />
      </Field>

      {order.filter(k => !(relaxed && k === 'referred_by') && shown(k)).map(k => (
        <div key={k} className={s.fade}>{optionalField[k]}</div>
      ))}

      {hidden.length > 0 && (
        <div className={s.addProps} role="group" aria-label="Add details">
          {hidden.map(k => (
            <button key={k} type="button" className={s.addProp} onClick={() => add(k)}>
              <Plus size={13} aria-hidden="true" /> {LABELS[k]}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
