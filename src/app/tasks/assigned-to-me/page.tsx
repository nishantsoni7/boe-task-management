import { redirect } from 'next/navigation'

export default function AssignedToMeRedirect() {
  redirect('/tasks/assigned-by-me')
}
