// Deleting one old Task-style quotation request from the Dashboard card (administrator only; owner, 20 Nov 2026). It goes through the route the
// Super Admin page already uses (/api/admin-delete-tasks), which checks on the server that the caller is an administrator, then deletes the task
// and its activity log. A quotation that was made from the request is NOT deleted (quotations.request_task_id only becomes empty).
// Returns null when it is gone, or one plain sentence for the dialog.

export async function deleteRequestTask(taskId: string, token: string | undefined, send: typeof fetch = fetch): Promise<string | null> {
  if (!token) return 'You are signed out. Sign in again, then try once more.'
  let res: Response
  try {
    res = await send('/api/admin-delete-tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ taskIds: [taskId] }),
    })
  } catch {
    return 'No connection. The request was not deleted; try again.'
  }
  if (res.ok) return null
  if (res.status === 401 || res.status === 403) return 'Only an administrator can delete a request.'
  const body = await res.json().catch(() => null) as { error?: string } | null
  return `The request was not deleted${body?.error ? `: ${body.error}` : '.'}`
}
