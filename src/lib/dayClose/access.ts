// Who is OFFERED Team Today in the Task Management sidebar (Day Close, owner 2026-11-12). A display question
// only: /api/day-close/team decides for real (an administrator, or the Day Close reviewer).

export function offersTeamToday(role: string | null | undefined): boolean {
  return role === 'admin'
}
