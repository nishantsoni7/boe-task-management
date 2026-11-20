// Quotation requests moved into the Quotations module (owner, 20 Nov 2026). Old links, bookmarks and notices land there.
import { redirect } from 'next/navigation'

export default function Page() {
  redirect('/quotations?new=1')
}
