import type { ArtboardState, MachiningSettings } from '../types/editor'
import type { CameraType } from '../types/preview'
import { DEFAULT_MATERIAL, MATERIAL_PRESETS, type MaterialPreset } from './materialPresets'

const STORAGE_KEY = 'engrav-studio-preferences-v1'

type DownloadFormat = 'nc' | 'gcode'

interface PreviewPreferences {
  cameraType?: CameraType
  showStock?: boolean
  showSvgOverlay?: boolean
  showRapidMoves?: boolean
  showJobOrder?: boolean
  playbackRate?: number
  loopPlayback?: boolean
}

export interface StudioPreferences {
  version: 1
  artboard?: Partial<ArtboardState>
  machiningSettings?: Partial<MachiningSettings>
  materialPreset?: MaterialPreset
  downloadFormat?: DownloadFormat
  preview?: PreviewPreferences
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

function isMaterialPreset(value: unknown): value is MaterialPreset {
  return typeof value === 'string' && MATERIAL_PRESETS.some((preset) => preset.id === value)
}

function isDownloadFormat(value: unknown): value is DownloadFormat {
  return value === 'nc' || value === 'gcode'
}

function isCameraType(value: unknown): value is CameraType {
  return value === 'perspective' || value === 'orthographic'
}

function isPathAnchor(value: unknown): value is MachiningSettings['pathAnchor'] {
  return value === 'TopLeft'
    || value === 'TopCenter'
    || value === 'TopRight'
    || value === 'MiddleLeft'
    || value === 'Center'
    || value === 'MiddleRight'
    || value === 'BottomLeft'
    || value === 'BottomCenter'
    || value === 'BottomRight'
}

function optionalNumber(value: unknown): number | null | undefined {
  if (value === null) return null
  return isNumber(value) ? value : undefined
}

function sanitizeArtboard(value: unknown): Partial<ArtboardState> | undefined {
  if (!isObject(value)) return undefined
  const next: Partial<ArtboardState> = {}
  if (isNumber(value.width) && value.width >= 1) next.width = value.width
  if (isNumber(value.height) && value.height >= 1) next.height = value.height
  if (isNumber(value.thickness) && value.thickness >= 0) next.thickness = value.thickness
  if (isNumber(value.x)) next.x = value.x
  if (isNumber(value.y)) next.y = value.y
  return Object.keys(next).length > 0 ? next : undefined
}

function sanitizeMachiningSettings(value: unknown): Partial<MachiningSettings> | undefined {
  if (!isObject(value)) return undefined
  const next: Partial<MachiningSettings> = {}

  if (isNumber(value.toolDiameter) && value.toolDiameter > 0) next.toolDiameter = value.toolDiameter
  if (value.toolShape === 'Flat' || value.toolShape === 'Ball' || value.toolShape === 'V') next.toolShape = value.toolShape
  if (isNumber(value.defaultDepthMm) && value.defaultDepthMm > 0) next.defaultDepthMm = value.defaultDepthMm
  if (isNumber(value.passCount) && value.passCount >= 1) next.passCount = Math.round(value.passCount)

  const maxStepdown = optionalNumber(value.maxStepdown)
  if (maxStepdown !== undefined) next.maxStepdown = maxStepdown
  const stepover = optionalNumber(value.stepover)
  if (stepover !== undefined) next.stepover = stepover
  const maxFillPasses = optionalNumber(value.maxFillPasses)
  if (maxFillPasses !== undefined) next.maxFillPasses = maxFillPasses
  const cutFeedrate = optionalNumber(value.cutFeedrate)
  if (cutFeedrate !== undefined) next.cutFeedrate = cutFeedrate
  const shallowCutFeedrate = optionalNumber(value.shallowCutFeedrate)
  if (shallowCutFeedrate !== undefined) next.shallowCutFeedrate = shallowCutFeedrate
  const plungeFeedrate = optionalNumber(value.plungeFeedrate)
  if (plungeFeedrate !== undefined) next.plungeFeedrate = plungeFeedrate
  const travelZ = optionalNumber(value.travelZ)
  if (travelZ !== undefined) next.travelZ = travelZ
  const cutZ = optionalNumber(value.cutZ)
  if (cutZ !== undefined) next.cutZ = cutZ
  const machineWidth = optionalNumber(value.machineWidth)
  if (machineWidth !== undefined) next.machineWidth = machineWidth
  const machineHeight = optionalNumber(value.machineHeight)
  if (machineHeight !== undefined) next.machineHeight = machineHeight

  if (isBoolean(value.tabsEnabled)) next.tabsEnabled = value.tabsEnabled
  if (isNumber(value.tabWidth) && value.tabWidth > 0) next.tabWidth = value.tabWidth
  if (isNumber(value.tabHeight) && value.tabHeight > 0) next.tabHeight = value.tabHeight
  if (isNumber(value.tabSpacing) && value.tabSpacing > 0) next.tabSpacing = value.tabSpacing
  if (isBoolean(value.optimizePathOrder)) next.optimizePathOrder = value.optimizePathOrder
  if (isPathAnchor(value.pathAnchor)) next.pathAnchor = value.pathAnchor
  if (value.cutOrderStrategy === 'auto' || value.cutOrderStrategy === 'manual') {
    next.cutOrderStrategy = value.cutOrderStrategy
  } else if (
    value.cutOrderStrategy === 'svg' ||
    value.cutOrderStrategy === 'ltr' ||
    value.cutOrderStrategy === 'btt'
  ) {
    // Legacy strategies folded into the magic planner — old projects open as auto.
    next.cutOrderStrategy = 'auto'
  }
  if (Array.isArray(value.manualCutOrder) && value.manualCutOrder.every((id) => typeof id === 'string')) {
    next.manualCutOrder = value.manualCutOrder
  }

  return Object.keys(next).length > 0 ? next : undefined
}

function sanitizePreview(value: unknown): PreviewPreferences | undefined {
  if (!isObject(value)) return undefined
  const next: PreviewPreferences = {}
  if (isCameraType(value.cameraType)) next.cameraType = value.cameraType
  if (isBoolean(value.showStock)) next.showStock = value.showStock
  if (isBoolean(value.showSvgOverlay)) next.showSvgOverlay = value.showSvgOverlay
  if (isBoolean(value.showRapidMoves)) next.showRapidMoves = value.showRapidMoves
  if (isBoolean(value.showJobOrder)) next.showJobOrder = value.showJobOrder
  if (isNumber(value.playbackRate) && value.playbackRate > 0) next.playbackRate = value.playbackRate
  if (isBoolean(value.loopPlayback)) next.loopPlayback = value.loopPlayback
  return Object.keys(next).length > 0 ? next : undefined
}

export function loadStudioPreferences(): StudioPreferences | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!isObject(parsed)) return null

    const next: StudioPreferences = { version: 1 }
    const artboard = sanitizeArtboard(parsed.artboard)
    if (artboard) next.artboard = artboard
    const machiningSettings = sanitizeMachiningSettings(parsed.machiningSettings)
    if (machiningSettings) next.machiningSettings = machiningSettings
    next.materialPreset = isMaterialPreset(parsed.materialPreset) ? parsed.materialPreset : DEFAULT_MATERIAL
    if (isDownloadFormat(parsed.downloadFormat)) next.downloadFormat = parsed.downloadFormat
    const preview = sanitizePreview(parsed.preview)
    if (preview) next.preview = preview
    return next
  } catch {
    return null
  }
}

export function saveStudioPreferences(preferences: StudioPreferences) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences))
  } catch {
    // Best-effort user preferences; storage can be unavailable in private contexts.
  }
}
