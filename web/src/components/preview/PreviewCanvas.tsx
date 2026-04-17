import { useRef, useEffect, useState } from 'react'
import * as THREE from 'three'
import { sampleProgramAtDistance } from '@svg2gcode/bridge/viewer'

import { useEditorStore } from '../../store'
import { MATERIAL_PRESETS } from '../../lib/materialPresets'
import { useThreeScene } from './useThreeScene'
import { clearGroup, createLighting, createGrid, createToolMarker, createActivePathLine } from './sceneHelpers'
import { createStockMeshLayers, createStockMaterialHandle, type StockMaterialHandle } from './stockMesh'
import { createMergedSweepMeshes } from './sweepMesh'
import { buildToolpathLines, updateDrawRange, type ToolpathLineData } from './toolpathLines'
import { buildCutOrderLabels, disposeCutOrderLabels } from './cutOrderLabels'
import type { ToolMarker } from './sceneHelpers'

export function PreviewCanvas() {
  const containerRef = useRef<HTMLDivElement>(null)

  const cameraType = useEditorStore((s) => s.preview.cameraType)
  const parsedProgram = useEditorStore((s) => s.preview.parsedProgram)
  const toolpaths = useEditorStore((s) => s.preview.toolpaths)
  const stockBounds = useEditorStore((s) => s.preview.stockBounds)
  const previewSnapshot = useEditorStore((s) => s.preview.previewSnapshot)
  const showStock = useEditorStore((s) => s.preview.showStock)
  const showRapidMoves = useEditorStore((s) => s.preview.showRapidMoves)
  const showSvgOverlay = useEditorStore((s) => s.preview.showSvgOverlay)
  const showCutOrder = useEditorStore((s) => s.preview.showCutOrder)
  const setPlaybackDistance = useEditorStore((s) => s.setPlaybackDistance)
  const materialPreset = useEditorStore((s) => s.preview.materialPreset)
  const previewToolShape = useEditorStore((s) => s.preview.toolShape)

  const isPlaying = useEditorStore((s) => s.preview.isPlaying)
  const playbackDistance = useEditorStore((s) => s.preview.playbackDistance)

  const [stockTexture, setStockTexture] = useState<THREE.Texture | null>(null)

  useEffect(() => {
    const presetDef = MATERIAL_PRESETS.find((p) => p.id === materialPreset)
    if (!presetDef) return
    const loader = new THREE.TextureLoader()
    loader.load(presetDef.textureSrc, (tex) => {
      setStockTexture((prev) => {
        prev?.dispose()
        return tex
      })
    })
  }, [materialPreset])

  // Dispose the final texture when the component itself unmounts — otherwise
  // the texture survives as long as the WebGL context does.
  useEffect(() => {
    return () => {
      setStockTexture((prev) => {
        prev?.dispose()
        return null
      })
    }
  }, [])

  const { sceneRef, requestRender } = useThreeScene(containerRef, cameraType)

  // Refs for mutable scene objects
  const toolMarkerRef = useRef<ToolMarker | null>(null)
  const activePathLineRef = useRef<THREE.Line | null>(null)
  const toolpathLineDataRef = useRef<ToolpathLineData | null>(null)

  // Shared stock material. We recreate the handle whenever the texture
  // changes so USE_MAP is baked into the initial shader compile — assigning
  // `.map` + `needsUpdate` after construction was unreliable and caused the
  // wood texture to not show. The previous handle is disposed on swap.
  const stockMaterialRef = useRef<StockMaterialHandle | null>(null)
  if (stockMaterialRef.current == null) {
    stockMaterialRef.current = createStockMaterialHandle()
  }
  useEffect(() => {
    stockMaterialRef.current?.dispose()
    stockMaterialRef.current = createStockMaterialHandle(stockTexture ?? undefined)
    requestRender()
  }, [stockTexture, requestRender])
  useEffect(() => {
    return () => {
      stockMaterialRef.current?.dispose()
      stockMaterialRef.current = null
    }
  }, [])

  // Set up lighting and grid on first mount or when material size changes
  useEffect(() => {
    const state = sceneRef.current
    if (!state || !previewSnapshot) return

    clearGroup(state.lightGroup)
    clearGroup(state.gridGroup)

    state.lightGroup.add(createLighting())

    const grid = createGrid(previewSnapshot.material_width, previewSnapshot.material_height)
    state.gridGroup.add(grid)

    // Position camera to look at the material center
    const cx = previewSnapshot.material_width / 2
    const cy = previewSnapshot.material_height / 2
    const maxDim = Math.max(previewSnapshot.material_width, previewSnapshot.material_height)
    state.controls.target.set(cx, cy, -previewSnapshot.material_thickness / 2)
    state.perspectiveCamera.position.set(cx + maxDim * 0.3, cy - maxDim * 0.6, maxDim * 0.5)
    state.orthographicCamera.position.set(cx + maxDim * 0.3, cy - maxDim * 0.6, maxDim * 0.5)
    state.controls.update()

    requestRender()
  }, [sceneRef, previewSnapshot, requestRender])

  // Build tool marker
  useEffect(() => {
    const state = sceneRef.current
    if (!state || !previewSnapshot) return

    clearGroup(state.toolMarkerGroup)

    const marker = createToolMarker(
      previewSnapshot.tool_diameter / 2,
      previewToolShape ?? 'Flat',
    )
    state.toolMarkerGroup.add(marker.group)
    toolMarkerRef.current = marker

    const activeLine = createActivePathLine()
    state.toolMarkerGroup.add(activeLine)
    activePathLineRef.current = activeLine

    requestRender()
  }, [sceneRef, previewSnapshot, previewToolShape, requestRender])

  // Build stock/sweep meshes when toolpaths change
  useEffect(() => {
    const state = sceneRef.current
    if (!state || !toolpaths || !stockBounds || !previewSnapshot) return

    clearGroup(state.stockGroup)
    clearGroup(state.sweepGroup)

    const stockMesh = createStockMeshLayers(
      stockBounds,
      toolpaths,
      previewSnapshot.material_thickness,
      previewToolShape ?? 'Flat',
      previewSnapshot.tool_diameter / 2,
      stockMaterialRef.current ?? undefined,
    )
    state.stockGroup.add(stockMesh)

    const sweepMesh = createMergedSweepMeshes(toolpaths, previewToolShape ?? undefined)
    state.sweepGroup.add(sweepMesh)

    requestRender()
  }, [sceneRef, toolpaths, stockBounds, previewSnapshot, previewToolShape, stockTexture, requestRender])

  // Auto-fit camera to toolpath bounding box when GCode is generated
  useEffect(() => {
    const state = sceneRef.current
    if (!state || !toolpaths || toolpaths.length === 0 || !previewSnapshot) return

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const tp of toolpaths) {
      for (const pt of tp.pathPoints) {
        if (pt.x < minX) minX = pt.x
        if (pt.x > maxX) maxX = pt.x
        if (pt.y < minY) minY = pt.y
        if (pt.y > maxY) maxY = pt.y
      }
    }
    if (!isFinite(minX)) return

    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    const fitDim = Math.max(maxX - minX, maxY - minY, 10) * 1.4

    state.controls.target.set(cx, cy, -previewSnapshot.material_thickness / 2)
    state.perspectiveCamera.position.set(cx + fitDim * 0.3, cy - fitDim * 0.6, fitDim * 0.5)
    state.orthographicCamera.position.set(cx + fitDim * 0.3, cy - fitDim * 0.6, fitDim * 0.5)

    // Adjust orthographic zoom to fit the toolpath area
    const container = containerRef.current
    if (container) {
      const aspect = container.clientWidth / container.clientHeight
      const frustumSize = 400
      const zoomX = (frustumSize * aspect) / fitDim
      const zoomY = frustumSize / fitDim
      state.orthographicCamera.zoom = Math.min(zoomX, zoomY)
      state.orthographicCamera.updateProjectionMatrix()
    }

    state.controls.update()
    requestRender()
  }, [sceneRef, toolpaths, previewSnapshot, containerRef, requestRender])

  // Toggle stock/sweep visibility
  useEffect(() => {
    const state = sceneRef.current
    if (!state) return
    state.stockGroup.visible = showStock
    state.sweepGroup.visible = !showStock
    requestRender()
  }, [sceneRef, showStock, requestRender])

  // Build toolpath line geometries
  useEffect(() => {
    const state = sceneRef.current
    if (!state || !parsedProgram) return

    clearGroup(state.toolpathGroup)

    const lineData = buildToolpathLines(parsedProgram.segments, showRapidMoves || showCutOrder)
    state.toolpathGroup.add(lineData.mesh)
    toolpathLineDataRef.current = lineData

    requestRender()
  }, [sceneRef, parsedProgram, showRapidMoves, showCutOrder, requestRender])

  // SVG overlay visibility
  useEffect(() => {
    const state = sceneRef.current
    if (!state) return
    state.overlayGroup.visible = showSvgOverlay
    requestRender()
  }, [sceneRef, showSvgOverlay, requestRender])

  // Cut-order badges. Rebuilt whenever the toolpaths change or the toggle
  // turns on; torn down (with texture disposal) when the toggle turns off.
  useEffect(() => {
    const state = sceneRef.current
    if (!state) return

    disposeCutOrderLabels(state.cutOrderGroup)

    if (showCutOrder && toolpaths && toolpaths.length > 0) {
      const { group } = buildCutOrderLabels(toolpaths, parsedProgram?.segments)
      for (const child of [...group.children]) {
        state.cutOrderGroup.add(child)
      }
    }

    requestRender()
    return () => {
      disposeCutOrderLabels(state.cutOrderGroup)
    }
  }, [sceneRef, toolpaths, parsedProgram, showCutOrder, requestRender])

  // Click-to-seek on cut-order badges. Raycast from the pointer into the
  // cutOrderGroup; on a hit, jump playback to that cut's start distance.
  useEffect(() => {
    const state = sceneRef.current
    if (!state || !showCutOrder) return

    const canvas = state.renderer.domElement
    const raycaster = new THREE.Raycaster()
    const pointer = new THREE.Vector2()

    const handleClick = (event: PointerEvent) => {
      if (state.cutOrderGroup.children.length === 0) return
      const rect = canvas.getBoundingClientRect()
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(pointer, state.activeCamera)
      const hits = raycaster.intersectObjects(state.cutOrderGroup.children, false)
      if (hits.length === 0) return
      const sprite = hits[0].object
      const seek = sprite.userData?.seekDistance
      if (typeof seek === 'number') {
        event.stopPropagation()
        setPlaybackDistance(seek)
      }
    }

    canvas.addEventListener('pointerdown', handleClick)
    return () => {
      canvas.removeEventListener('pointerdown', handleClick)
    }
  }, [sceneRef, showCutOrder, setPlaybackDistance])

  // Sync tool marker + draw range whenever playback distance changes.
  // This covers scrubbing (user drags the slider) without needing a rAF loop.
  useEffect(() => {
    const state = sceneRef.current
    if (!state) return

    if (parsedProgram && toolMarkerRef.current) {
      const sample = sampleProgramAtDistance(parsedProgram, playbackDistance)
      const marker = toolMarkerRef.current
      if (sample.segment) {
        marker.group.visible = true
        marker.group.position.set(sample.position.x, sample.position.y, sample.position.z)
      } else {
        marker.group.visible = false
      }
    }

    if (toolpathLineDataRef.current) {
      updateDrawRange(toolpathLineDataRef.current, playbackDistance)
    }

    requestRender()
  }, [sceneRef, parsedProgram, playbackDistance, requestRender])

  // Playback advancement loop. Only runs while actually playing. On unmount
  // or when playback stops, the cleanup cancels the latest frame id (tracked
  // per-frame, unlike the previous version which only tracked the first id).
  useEffect(() => {
    if (!isPlaying) return

    let rafId = 0
    let cancelled = false
    let lastTime = 0
    let accumulator = 0

    const animate = (time: number) => {
      if (cancelled) return

      const { preview } = useEditorStore.getState()
      if (!preview.parsedProgram || preview.parsedProgram.totalDistance <= 0) {
        return
      }

      const delta = lastTime === 0 ? 0 : (time - lastTime) / 1000
      accumulator += delta * preview.playbackRate
      lastTime = time

      if (accumulator >= 0.1) {
        let nextDistance = preview.playbackDistance + accumulator
        accumulator = 0

        if (nextDistance >= preview.parsedProgram.totalDistance) {
          if (preview.loopPlayback) {
            nextDistance = nextDistance % preview.parsedProgram.totalDistance
          } else {
            nextDistance = preview.parsedProgram.totalDistance
            useEditorStore.getState().setIsPlaying(false)
          }
        }

        useEditorStore.getState().setPlaybackDistance(nextDistance)
      }

      rafId = requestAnimationFrame(animate)
    }

    rafId = requestAnimationFrame(animate)
    return () => {
      cancelled = true
      cancelAnimationFrame(rafId)
    }
  }, [isPlaying])

  return <div ref={containerRef} className="h-full w-full" />
}
