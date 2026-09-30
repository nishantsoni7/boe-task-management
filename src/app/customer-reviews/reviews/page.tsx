import { redirect } from 'next/navigation'

// RETIRED FRONTEND PAGE. The generated-review workflow (prepare → allocate →
// assign → book → share) is deactivated for every role; the module is custom
// reviews only. Nothing behind it is deleted — the tables, records, storage,
// routes and the screen components all remain — this page simply no longer
// opens, so a saved link or bookmark lands on the Reviews landing page.
export default function RetiredPage() {
  redirect('/customer-reviews')
}
