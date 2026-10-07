import { redirect } from 'next/navigation'

// The module's front door is the entry form: the thing someone standing at a
// stand needs is one tap from the launcher and one tap from here.
export default function ExhibitionLeadsIndex() {
  redirect('/exhibition-leads/add')
}
