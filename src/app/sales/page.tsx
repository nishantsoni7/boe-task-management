import { redirect } from 'next/navigation'

// The Lead Master is the first thing Sales holds. A refused person never gets here: layout.tsx guards the module.
export default function SalesPage() {
  redirect('/sales/lead-master')
}
