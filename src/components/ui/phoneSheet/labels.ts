/** The sheet's result button: "Show 1 task" / "Show 12 tasks". */
export function showResultsLabel(count: number, noun: readonly [string, string]): string {
  return `Show ${count} ${count === 1 ? noun[0] : noun[1]}`
}
