import { useEffect } from 'react'

import { isTypingTarget } from '../lib/domEvents'
import { useEditorStore } from '../store'

export function useKeyboardShortcuts() {
  const deleteSelected = useEditorStore((state) => state.deleteSelected)
  const copySelected = useEditorStore((state) => state.copySelected)
  const pasteClipboard = useEditorStore((state) => state.pasteClipboard)
  const selectAll = useEditorStore((state) => state.selectAll)
  const clearSelection = useEditorStore((state) => state.clearSelection)
  const undo = useEditorStore((state) => state.undo)
  const redo = useEditorStore((state) => state.redo)
  const pendingImport = useEditorStore((state) => state.ui.pendingImport)
  const clearPendingImport = useEditorStore((state) => state.clearPendingImport)
  const eyedropperMode = useEditorStore((state) => state.eyedropperMode)
  const setEyedropperMode = useEditorStore((state) => state.setEyedropperMode)
  const setDirectSelectionModifierActive = useEditorStore(
    (state) => state.setDirectSelectionModifierActive,
  )
  const setImportStatus = useEditorStore((state) => state.setImportStatus)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Meta' || event.key === 'Control') {
        setDirectSelectionModifierActive(true)
      }

      if (isTypingTarget(event.target)) {
        return
      }

      const isMod = event.metaKey || event.ctrlKey

      if (isMod) {
        switch (event.key.toLowerCase()) {
          case 'a':
            event.preventDefault()
            selectAll()
            return
          case 'c':
            event.preventDefault()
            copySelected()
            return
          case 'v':
            event.preventDefault()
            pasteClipboard()
            return
          case 'd':
            event.preventDefault()
            clearSelection()
            return
          case 'x':
            event.preventDefault()
            copySelected()
            deleteSelected()
            return
          case 'z':
            event.preventDefault()
            if (event.shiftKey) {
              redo()
            } else {
              undo()
            }
            return
          case 'i':
            event.preventDefault()
            if (event.shiftKey) {
              setEyedropperMode(eyedropperMode === 'depth-only' ? 'off' : 'depth-only')
            } else {
              setEyedropperMode(eyedropperMode === 'full' ? 'off' : 'full')
            }
            return
        }
      }

      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        deleteSelected()
      }

      if (event.key === 'Escape') {
        if (pendingImport) {
          event.preventDefault()
          clearPendingImport()
          setImportStatus({
            tone: 'info',
            message: `Cancelled placing "${pendingImport.name}".`,
          })
        } else if (eyedropperMode !== 'off') {
          event.preventDefault()
          setEyedropperMode('off')
        } else {
          clearSelection()
        }
      }
    }

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Meta' || event.key === 'Control') {
        setDirectSelectionModifierActive(false)
      }
    }

    const resetDirectSelectionModifier = () => {
      setDirectSelectionModifierActive(false)
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', resetDirectSelectionModifier)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', resetDirectSelectionModifier)
    }
  }, [
    clearPendingImport,
    clearSelection,
    copySelected,
    deleteSelected,
    eyedropperMode,
    pasteClipboard,
    pendingImport,
    redo,
    selectAll,
    setDirectSelectionModifierActive,
    setEyedropperMode,
    setImportStatus,
    undo,
  ])
}
