import { useRef, useState, useCallback, useEffect } from 'react'
import type { ChangeEvent, DragEvent } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'

import { Button, ButtonGroup, Dropdown, Input, Label, ProgressBar, Tabs } from '@heroui/react'
import { Canvas } from './Canvas'
import { LayerTree } from './components/LayerTree'
import { LibraryPanel } from './components/library/LibraryPanel'
import { StudioInspector } from './components/StudioInspector'
import { TopBar } from './components/TopBar'
import { PreviewCanvas } from './components/preview/PreviewCanvas'
import { PlaybackTimeline } from './components/preview/PlaybackTimeline'
import { GcodeViewer } from './components/preview/GcodeViewer'
import { useGcodeGeneration } from './hooks/useGcodeGeneration'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { AppIcon, Icons } from './lib/icons'
import { importSvgToScene } from './lib/svgImport'
import { exportProjectSVG, exportToSVG } from './lib/svgExport'
import { buildCenterlineExportNodes, subtreeHasActiveCenterline } from './lib/centerline'
import { DEFAULT_MATERIAL, MATERIAL_PRESETS } from './lib/materialPresets'
import type { MaterialPreset } from './lib/materialPresets'
import { getAutoImportPlacement } from './lib/importPlacement'
import { loadStudioPreferences, saveStudioPreferences } from './lib/studioPreferences'
import { useEditorStore } from './store'
import { insertTabs } from './lib/gcodeTabInsertion'
import type { ViewMode } from './types/preview'
import type { CanvasNode } from './types/editor'

type InspectorTab = 'design' | 'material'

function App() {
  const artboard = useEditorStore((state) => state.artboard)
  const nodesById = useEditorStore((state) => state.nodesById)
  const rootIds = useEditorStore((state) => state.rootIds)
  const stagePendingImport = useEditorStore((state) => state.stagePendingImport)
  const placePendingImport = useEditorStore((state) => state.placePendingImport)
  const setImportStatus = useEditorStore((state) => state.setImportStatus)
  const machiningSettings = useEditorStore((state) => state.machiningSettings)
  const setMachiningSettings = useEditorStore((state) => state.setMachiningSettings)
  const setArtboardSize = useEditorStore((state) => state.setArtboardSize)
  const leftPanelTab = useEditorStore((state) => state.leftPanelTab)
  const setLeftPanelTab = useEditorStore((state) => state.setLeftPanelTab)
  const viewMode = useEditorStore((state) => state.preview.viewMode)
  const previewCameraType = useEditorStore((state) => state.preview.cameraType)
  const previewShowStock = useEditorStore((state) => state.preview.showStock)
  const previewShowSvgOverlay = useEditorStore((state) => state.preview.showSvgOverlay)
  const previewShowRapidMoves = useEditorStore((state) => state.preview.showRapidMoves)
  const previewPlaybackRate = useEditorStore((state) => state.preview.playbackRate)
  const previewLoopPlayback = useEditorStore((state) => state.preview.loopPlayback)
  const setViewMode = useEditorStore((state) => state.setViewMode)
  const initPreview = useEditorStore((state) => state.initPreview)
  const initProgress = useEditorStore((state) => state.preview.initProgress)

  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('design')
  const [projectName, setProjectName] = useState('Untitled project')
  const [materialPreset, setMaterialPreset] = useState<MaterialPreset>(DEFAULT_MATERIAL)
  const [isDragOver, setIsDragOver] = useState(false)
  const [isInitializingPreview, setIsInitializingPreview] = useState(false)
  const [downloadFormat, setDownloadFormat] = useState<'nc' | 'gcode'>('nc')
  const preferencesLoadedRef = useRef(false)
  const skipInitialPreferencesSaveRef = useRef(true)

  const isCanvasEmpty = rootIds.length === 0

  const gcode = useGcodeGeneration()

  useKeyboardShortcuts()

  useEffect(() => {
    const preferences = loadStudioPreferences()
    if (preferences?.artboard) {
      useEditorStore.setState((state) => ({
        artboard: { ...state.artboard, ...preferences.artboard },
      }))
    }
    if (preferences?.machiningSettings) {
      useEditorStore.setState((state) => ({
        machiningSettings: { ...state.machiningSettings, ...preferences.machiningSettings },
      }))
    }
    if (preferences?.materialPreset) {
      setMaterialPreset(preferences.materialPreset)
      useEditorStore.getState().setMaterialPreset(preferences.materialPreset)
    }
    if (preferences?.downloadFormat) {
      setDownloadFormat(preferences.downloadFormat)
    }
    if (preferences?.preview) {
      useEditorStore.setState((state) => ({
        preview: { ...state.preview, ...preferences.preview },
      }))
    }
    preferencesLoadedRef.current = true
  }, [])

  useEffect(() => {
    if (!preferencesLoadedRef.current) return
    if (skipInitialPreferencesSaveRef.current) {
      skipInitialPreferencesSaveRef.current = false
      return
    }

    const timeoutId = window.setTimeout(() => {
      saveStudioPreferences({
        version: 1,
        artboard,
        machiningSettings,
        materialPreset,
        downloadFormat,
        preview: {
          cameraType: previewCameraType,
          showStock: previewShowStock,
          showSvgOverlay: previewShowSvgOverlay,
          showRapidMoves: previewShowRapidMoves,
          playbackRate: previewPlaybackRate,
          loopPlayback: previewLoopPlayback,
        },
      })
    }, 150)

    return () => window.clearTimeout(timeoutId)
  }, [
    artboard,
    machiningSettings,
    materialPreset,
    downloadFormat,
    previewCameraType,
    previewShowStock,
    previewShowSvgOverlay,
    previewShowRapidMoves,
    previewPlaybackRate,
    previewLoopPlayback,
  ])

  const handleProjectExport = () => {
    const svgString = exportProjectSVG(
      nodesById,
      rootIds,
      artboard,
      machiningSettings,
      materialPreset,
      projectName,
    )
    const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${projectName || 'project'}.svg`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const handleCenterlineExport = () => {
    // Build a node tree where each shape with an active centerline is
    // replaced by a path containing only its centerline geometry, then
    // serialize to a minimal SVG ready for pasting into an LLM.
    console.log('[centerline-export] start', { rootIds, nodeCount: Object.keys(nodesById).length })
    try {
      let mergedNodes: Record<string, CanvasNode> = {}
      const exportedRoots: string[] = []
      for (const rootId of rootIds) {
        const root = nodesById[rootId]
        if (!root || !root.visible) {
          console.log('[centerline-export] skip root (missing/invisible)', rootId)
          continue
        }
        const hasCenter = subtreeHasActiveCenterline(root, nodesById)
        console.log('[centerline-export] root', rootId, 'hasActiveCenterline:', hasCenter)
        if (!hasCenter) continue
        const { nodesById: perRoot } = buildCenterlineExportNodes(rootId, nodesById, {
          toolDiameter: machiningSettings.toolDiameter,
        })
        mergedNodes = { ...mergedNodes, ...perRoot }
        exportedRoots.push(rootId)
      }
      console.log('[centerline-export] exportedRoots:', exportedRoots.length)
      if (exportedRoots.length === 0) {
        setImportStatus({
          tone: 'error',
          message: 'Enable centerline on at least one shape before exporting.',
        })
        return
      }
      const svgString = exportToSVG(mergedNodes, exportedRoots, artboard)
      const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${projectName || 'project'}-centerlines.svg`
      anchor.click()
      URL.revokeObjectURL(url)
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Centerline export failed unexpectedly.'
      setImportStatus({ tone: 'error', message })
    }
  }

  const processSvgFile = async (file: File, autoPlace = false) => {
    try {
      const svgText = await file.text()
      const pendingScene = importSvgToScene({
        artboardWidth: artboard.width,
        artboardHeight: artboard.height,
        fileName: file.name,
        svgText,
      })

      // Restore project metadata if this is an Engrav project file
      const meta = pendingScene.projectMetadata
      if (meta) {
        if (meta.projectName) setProjectName(meta.projectName)
        if (meta.artboard) setArtboardSize(meta.artboard)
        if (meta.machiningSettings) setMachiningSettings(meta.machiningSettings)
        if (meta.materialPreset) handleMaterialChange(meta.materialPreset as MaterialPreset)
      } else {
        // Use the SVG filename (without extension) as the project name
        const baseName = file.name.replace(/\.[^.]+$/, '')
        if (baseName) setProjectName(baseName)
      }

      if (autoPlace) {
        stagePendingImport(pendingScene)
        placePendingImport(
          getAutoImportPlacement({
            artboard,
            nodesById,
            rootIds,
            width: pendingScene.width,
            height: pendingScene.height,
          }),
        )
      } else {
        stagePendingImport(pendingScene)
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'The SVG import failed unexpectedly.'
      setImportStatus({ tone: 'error', message })
    }
  }

  const handleSvgImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const [file] = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (!file) return
    await processSvgFile(file, false)
  }

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    if (Array.from(e.dataTransfer.types).includes('Files')) {
      setIsDragOver(true)
    }
  }

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragOver(false)
    }
  }

  const handleDrop = async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragOver(false)
    const file = Array.from(e.dataTransfer.files).find(
      (f) => f.type === 'image/svg+xml' || f.name.toLowerCase().endsWith('.svg'),
    )
    if (!file) return
    await processSvgFile(file, true)
  }

  const handleGenerateGcode = async () => {
    await gcode.generate()
  }

  const handleDownloadGcode = (format: 'nc' | 'gcode' = downloadFormat) => {
    const state = useEditorStore.getState()
    const { machiningSettings, artboard: ab } = state
    // Prefer preview gcodeText (already has tabs). Fall back to raw gcode with
    // tab insertion applied on the fly so tabs are never silently omitted.
    let text = state.preview.gcodeText ?? gcode.result?.gcode
    if (text && !state.preview.gcodeText && machiningSettings.tabsEnabled) {
      text = insertTabs(text, {
        materialThickness: ab.thickness,
        tabWidth: machiningSettings.tabWidth,
        tabHeight: machiningSettings.tabHeight,
        tabSpacing: machiningSettings.tabSpacing,
      })
    }
    if (text) {
      const diameter = machiningSettings.toolDiameter
      const diameterStr = Number.isInteger(diameter) ? `${diameter}` : diameter.toFixed(2).replace(/\.?0+$/, '')
      const header = `; tool_diameter = ${diameterStr} mm\n`
      gcode.downloadGcode(header + text, `${projectName || 'output'}.${format}`)
    }
  }

  const handleMaterialChange = (preset: MaterialPreset) => {
    setMaterialPreset(preset)
    useEditorStore.getState().setMaterialPreset(preset)

    const presetDef = MATERIAL_PRESETS.find((entry) => entry.id === preset)
    if (presetDef) {
      setMachiningSettings({ defaultDepthMm: presetDef.defaultDepthMm })
    }
  }

  const handleViewModeChange = useCallback((mode: ViewMode) => {
    if (mode === 'preview3d' && gcode.result) {
      setIsInitializingPreview(true)
      // Defer so the loading UI can paint, then run async with progress
      setTimeout(async () => {
        await initPreview(gcode.result!)
        // Wait two animation frames so PreviewCanvas has a chance to mount
        // and render its first frame while the modal still shows 100%.
        // Without this the bar visibly snaps back to 0% for ~1 frame before
        // the scene is ready.
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        )
        setIsInitializingPreview(false)
        // Clear the progress value now that the modal is gone so the next
        // invocation starts fresh.
        useEditorStore.setState((state) => ({
          preview: { ...state.preview, initProgress: null },
        }))
      }, 0)
    } else {
      setViewMode(mode)
    }
  }, [gcode.result, initPreview, setViewMode])

  const isPreview3d = viewMode === 'preview3d'
  const isPreview2d = viewMode === 'preview2d'
  const showLibraryEmptyState = !isPreview3d && !isPreview2d && isCanvasEmpty && leftPanelTab === 'library'
  const showSvgImportEmptyState = !isPreview3d && !isPreview2d && isCanvasEmpty && leftPanelTab !== 'library'

  return (
    <div
      className="flex h-screen flex-col bg-background text-foreground"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept=".svg,image/svg+xml"
        className="hidden"
        onChange={handleSvgImport}
      />

      <Group orientation="horizontal" className="flex-1">
        {/* Left sidebar */}
        <Panel defaultSize="20%" minSize="14%" maxSize="30%">
          <div className="flex h-full flex-col overflow-hidden border-r border-border bg-background">
            {isPreview3d ? (
              <GcodeViewer />
            ) : (
              <>
                <div className="shrink-0 border-b border-border px-4 py-4">
                  <div className="text-xl font-bold text-foreground">Engrav Studio</div>

                  <Input
                    aria-label="Project name"
                    className="mt-4 w-full max-w-none"
                    value={projectName}
                    onChange={(e) => setProjectName(e.target.value)}
                  />

                  <div className="mt-4">
                    <Tabs
                      className="w-full"
                      selectedKey={leftPanelTab}
                      onSelectionChange={(key) => setLeftPanelTab(String(key) as 'layers' | 'library')}
                    >
                      <Tabs.ListContainer className="w-full">
                        <Tabs.List aria-label="Left sidebar tabs" className="grid w-full grid-cols-2">
                          <Tabs.Tab id="layers" className="cursor-pointer">
                            Layers
                            <Tabs.Indicator />
                          </Tabs.Tab>
                          <Tabs.Tab id="library" className="cursor-pointer">
                            Library
                            <Tabs.Indicator />
                          </Tabs.Tab>
                        </Tabs.List>
                      </Tabs.ListContainer>
                    </Tabs>
                  </div>

                  {leftPanelTab === 'layers' ? (
                    <ButtonGroup className="mt-4 w-full" variant="secondary">
                      <Button
                        className="flex-1 cursor-pointer justify-start text-xs font-normal text-foreground"
                        onPress={() => fileInputRef.current?.click()}
                      >
                        <AppIcon icon={Icons.fileUpload} className="h-4 w-4 text-foreground" />
                        Import SVG
                      </Button>
                      <Dropdown>
                        <Button
                          isIconOnly
                          aria-label="More options"
                          className="cursor-pointer bg-[var(--surface)] text-foreground hover:bg-[var(--surface-secondary)]"
                        >
                          <ButtonGroup.Separator />
                          <AppIcon icon={Icons.fileArrowDown} className="h-4 w-4 text-foreground" />
                        </Button>
                        <Dropdown.Popover placement="bottom end">
                          <Dropdown.Menu onAction={(key) => {
                            console.log('[export-menu] onAction', key)
                            if (key === 'export-project') handleProjectExport()
                            else if (key === 'export-centerlines') handleCenterlineExport()
                          }}>
                            <Dropdown.Item id="export-project">
                              <AppIcon icon={Icons.fileArrowDown} className="mr-1.5 inline h-4 w-4 text-foreground" />
                              Export Project
                            </Dropdown.Item>
                            <Dropdown.Item id="export-centerlines">
                              <AppIcon icon={Icons.fileArrowDown} className="mr-1.5 inline h-4 w-4 text-foreground" />
                              Export Centerlines SVG
                            </Dropdown.Item>
                          </Dropdown.Menu>
                        </Dropdown.Popover>
                      </Dropdown>
                    </ButtonGroup>
                  ) : null}
                </div>
                {/* Panel body */}
                <div className="min-h-0 flex-1 overflow-hidden">
                  {leftPanelTab === 'layers' ? (
                    <LayerTree />
                  ) : (
                    <LibraryPanel />
                  )}
                </div>
              </>
            )}
          </div>
        </Panel>

        <Separator className="w-px bg-border transition-colors hover:bg-primary/30" />

        {/* Center: Canvas or 3D Preview */}
        <Panel defaultSize="56%" minSize="36%">
          <div className="relative flex h-full flex-col overflow-hidden bg-background">
            <TopBar
              viewMode={viewMode}
              onViewModeChange={handleViewModeChange}
              onGenerateGcode={handleGenerateGcode}
              onDownloadGcode={handleDownloadGcode}
              downloadFormat={downloadFormat}
              onDownloadFormatChange={setDownloadFormat}
              isGenerating={gcode.isGenerating}
              progress={gcode.progress}
              hasGcodeResult={!!gcode.result}
              gcodeResult={gcode.result}
              gcodeError={gcode.error}
              onDismissGcode={gcode.reset}
            />
            <div className="min-h-0 flex-1 relative">
              {isInitializingPreview ? (
                <div className="flex h-full items-center justify-center bg-[#232323]">
                  <div className="flex w-72 flex-col gap-3">
                    <ProgressBar value={initProgress ?? 0} maxValue={100} aria-label="Creating 3D CNC preview" className="w-full">
                      <div className="mb-2 flex items-center justify-between">
                        <Label className="text-sm font-medium text-white">Creating 3D CNC preview</Label>
                        <span className="text-xs text-white/60">{initProgress ?? 0}%</span>
                      </div>
                      <ProgressBar.Track className="h-2 overflow-hidden rounded-full bg-white/10">
                        <ProgressBar.Fill className="rounded-full bg-emerald-500" />
                      </ProgressBar.Track>
                    </ProgressBar>
                  </div>
                </div>
              ) : isPreview3d ? (
                <PreviewCanvas />
              ) : (
                <Canvas
                  allowStageSelection={inspectorTab === 'material'}
                  materialPreset={materialPreset}
                  forceEngravePreview={isPreview2d}
                />
              )}

              {/* Empty-state drop zone */}
              {showSvgImportEmptyState && (
                <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
                  <div
                    className={`pointer-events-auto relative flex min-w-[500px] max-w-[80%] flex-col items-center gap-4 rounded-2xl border-2 border-dashed px-12 py-10 text-center backdrop-blur-md transition-all duration-220 ease-out ${
                      isDragOver
                        ? 'translate-y-0 scale-[1.015] border-white/80 bg-black/78 shadow-[0_18px_36px_rgba(0,0,0,0.36)]'
                        : 'translate-y-0 scale-100 border-white/65 bg-black/72 shadow-[0_10px_26px_rgba(0,0,0,0.3)]'
                    }`}
                    onClick={() => fileInputRef.current?.click()}
                    style={{ cursor: 'pointer' }}
                  >
                    <div className={`pointer-events-none absolute inset-[6px] rounded-[14px] border border-white/25 transition-opacity duration-200 ${isDragOver ? 'opacity-100' : 'opacity-75'}`} />
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width={isDragOver ? 38 : 40}
                      height={isDragOver ? 38 : 40}
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className={`relative transition-colors duration-200 ${isDragOver ? 'text-primary' : 'text-muted-foreground'}`}
                    >
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="17 8 12 3 7 8" />
                      <line x1="12" y1="3" x2="12" y2="15" />
                    </svg>
                    <div className="relative">
                      <p className="text-base font-semibold text-foreground">
                        {isDragOver ? 'Drop to import SVG' : 'Import or drag an SVG to begin'}
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {isDragOver ? 'Release to import this file' : 'Drop a file anywhere, or click to browse'}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {showLibraryEmptyState && (
                <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
                  <div className="relative flex min-w-[500px] max-w-[80%] flex-col items-center gap-4 rounded-2xl border border-white/15 bg-black/72 px-12 py-10 text-center shadow-[0_10px_26px_rgba(0,0,0,0.3)] backdrop-blur-md">
                    <div className="pointer-events-none absolute inset-[6px] rounded-[14px] border border-white/10" />
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="40"
                      height="40"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="relative text-muted-foreground"
                    >
                      <rect x="3" y="4" width="7" height="7" rx="1.5" />
                      <rect x="14" y="4" width="7" height="7" rx="1.5" />
                      <rect x="8.5" y="13" width="7" height="7" rx="1.5" />
                    </svg>
                    <div className="relative">
                      <p className="text-base font-semibold text-foreground">
                        Choose a generated shape from the library
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Place it on the artboard to start building your layout.
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Playback timeline at bottom in 3D preview mode */}
            {isPreview3d && <PlaybackTimeline />}
          </div>
        </Panel>

        <Separator className="w-px bg-border transition-colors hover:bg-primary/30" />

        {/* Right: Studio inspector */}
        <Panel defaultSize="24%" minSize="18%" maxSize="34%">
          <div className="h-full overflow-hidden border-l border-border bg-background">
            <StudioInspector
              activeTab={inspectorTab}
              onTabChange={setInspectorTab}
              materialPreset={materialPreset}
              onMaterialChange={handleMaterialChange}
            />
          </div>
        </Panel>
      </Group>
    </div>
  )
}

export default App
