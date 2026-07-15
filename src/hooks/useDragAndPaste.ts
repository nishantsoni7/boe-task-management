'use client'

import { useState } from 'react'

// Extracted from the task update/comment composer (src/app/tasks/[id]/page.tsx) so every
// task-creation form can offer the same drag-and-drop / clipboard-paste attachment behavior.
// `onFiles` receives the raw incoming files — the caller runs its own validation (e.g. via
// filterAcceptedFiles/prepareFiles) so all entry points share one validation path.
export function useDragAndPaste(onFiles: (files: File[]) => void) {
  const [dropActive, setDropActive] = useState(false)

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }

  const onDragEnter = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer.types.includes('Files')) setDropActive(true)
  }

  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.currentTarget.contains(e.relatedTarget as Node)) return
    setDropActive(false)
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDropActive(false)
    onFiles(Array.from(e.dataTransfer.files ?? []))
  }

  const onPaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items
    const pastedFiles: File[] = []
    if (items) {
      for (let i = 0; i < items.length; i++) {
        if (items[i].kind === 'file') {
          const file = items[i].getAsFile()
          if (file) pastedFiles.push(file)
        }
      }
    }
    if (pastedFiles.length === 0) return
    e.preventDefault() // don't let the browser also paste a filename/placeholder as text
    onFiles(pastedFiles)
  }

  return { dropActive, onDragOver, onDragEnter, onDragLeave, onDrop, onPaste }
}
