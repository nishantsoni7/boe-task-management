<#
  Safely remove a git worktree.

  WHY THIS EXISTS: a worktree whose node_modules is a junction to another
  checkout's node_modules is DANGEROUS to remove with `git worktree remove` (with
  or without --force): git follows the junction and empties the TARGET, i.e. the
  main repository's node_modules. This script refuses to continue until the link
  is gone, and refuses a dirty worktree.

  Usage:  powershell -File scripts/remove-worktree.ps1 <path-to-worktree>

  Prefer giving each worktree its own `npm ci` and never creating the junction.
#>
param([Parameter(Mandatory = $true)][string]$Path)

$ErrorActionPreference = 'Stop'
$wt = (Resolve-Path -LiteralPath $Path).Path

if (-not (Test-Path -LiteralPath (Join-Path $wt '.git'))) { throw "$wt is not a git worktree." }

$dirty = git -C $wt status --porcelain
if ($dirty) { throw "$wt has uncommitted changes:`n$dirty`nReview and protect them first." }

$nm = Join-Path $wt 'node_modules'
if (Test-Path -LiteralPath $nm) {
  $item = Get-Item -LiteralPath $nm -Force
  if ($item.LinkType) {
    # Deletes the LINK only. [IO.Directory]::Delete on a junction never recurses.
    [System.IO.Directory]::Delete($nm, $false)
    if (Test-Path -LiteralPath $nm) { throw "Could not remove the node_modules link at $nm. Stopping before anything is deleted." }
    Write-Host "Removed node_modules link."
  } else {
    Write-Host "node_modules is a real folder; git will delete it with the worktree."
  }
}

git worktree remove $wt
Write-Host "Removed $wt"
