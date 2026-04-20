import type { Settings } from "@svg2gcode/bridge"
import type { ArtboardState, MachiningSettings } from "../types/editor"

function roundStepdown(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

export function resolveEffectiveMaxStepdown(
  machining: Pick<MachiningSettings, "passCount" | "maxStepdown">,
  deepestTargetDepth: number,
): number | null {
  if (machining.maxStepdown != null) {
    return machining.maxStepdown > 0 ? machining.maxStepdown : null
  }

  if (!Number.isFinite(deepestTargetDepth) || deepestTargetDepth <= 0) {
    return null
  }

  const passCount = Math.max(1, Math.round(machining.passCount || 1))
  return roundStepdown(deepestTargetDepth / passCount)
}

/**
 * Merge editor state onto a bridge Settings object.
 * Starts from the provided base (typically from loadDefaultSettings()),
 * then overlays values from the editor's artboard and machining settings.
 * Null values in machining settings are left as the base default.
 */
export function buildBridgeSettings(
  base: Settings,
  artboard: ArtboardState,
  machining: MachiningSettings,
): Settings {
  return {
    ...base,
    conversion: {
      ...base.conversion,
      // 0.01 mm curve tolerance — fine enough that offset polylines from
      // i_overlay are nearly smooth on letter glyph pockets, which lets the
      // tangent-continuous arc refitter collapse them into clean G2/G3
      // segments. Lines falling back for cornered regions stay at this
      // resolution and look visually smooth on any viewer.
      tolerance: 0.01,
      optimize_path_order: machining.optimizePathOrder,
      anchor: machining.pathAnchor,
      cluster_detour_radius:
        machining.clusterDetourRadius != null && machining.clusterDetourRadius > 0
          ? machining.clusterDetourRadius
          : null,
    },
    engraving: {
      ...base.engraving,
      material_width: artboard.width,
      material_height: artboard.height,
      material_thickness: artboard.thickness,
      tool_diameter: machining.toolDiameter,
      tool_shape: machining.toolShape,
      target_depth: machining.defaultDepthMm,
      // Overlay optional fields only when set
      ...(machining.stepover != null && { stepover: machining.stepover }),
      max_fill_passes: machining.maxFillPasses,
      ...(machining.cutFeedrate != null && { cut_feedrate: machining.cutFeedrate }),
      ...(machining.shallowCutFeedrate != null && { shallow_cut_feedrate: machining.shallowCutFeedrate }),
      ...(machining.plungeFeedrate != null && { plunge_feedrate: machining.plungeFeedrate }),
      ...(machining.machineWidth != null && { machine_width: machining.machineWidth }),
      ...(machining.machineHeight != null && { machine_height: machining.machineHeight }),
      // Art objects handle their own placement, so zero these out
      placement_x: 0,
      placement_y: 0,
    },
    machine: {
      ...base.machine,
      supported_functionality: {
        ...base.machine.supported_functionality,
        circular_interpolation: machining.circularInterpolation,
      },
      ...(machining.travelZ != null && { travel_z: machining.travelZ }),
      ...(machining.cutZ != null && { cut_z: machining.cutZ }),
    },
    // Tab settings — scaffolded for future bridge/WASM consumption
    ...(machining.tabsEnabled && {
      tabs: {
        enabled: true,
        width: machining.tabWidth,
        height: machining.tabHeight,
        spacing: machining.tabSpacing,
      },
    }),
  }
}
