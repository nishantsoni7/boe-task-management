import { redirect } from 'next/navigation'

// My day is where a salesperson starts. A refused person never gets here: layout.tsx guards the module.
export default function SalesPage() {
  redirect('/sales/my-day')
}
