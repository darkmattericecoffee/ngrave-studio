import {
  prepareSvgDocument,
  createArtObject,
  composeArtObjectsSvg,
  getDerivedOperationsForArtObjects,
  engraveTypeToFillMode,
  type ArtObject,
  type Settings,
  type EngraveType as BridgeEngraveType,
} from "@svg2gcode/bridge"

import type {
  ArtboardState,
  CanvasNode,
  GroupNode,
  MachiningSettings,
} from "../types/editor"
import { resolveNodeCncMetadata } from "./cncMetadata"
import { buildCenterlineExportNodes, subtreeHasActiveCenterline } from "./centerline"
import { getSubtreeIds, isGroupNode } from "./editorTree"
import { getNodeSize } from "./nodeDimensions"
import { exportToSVG } from "./svgExport"
import { buildBridgeSettings, resolveEffectiveMaxStepdown } from "./bridgeSettingsAdapter"

/**
 * Convert the editor's canvas state into bridge ArtObjects for GCode generation.
 *
 * For each root-level group with an `originalSvg`:
 * 1. Parse the original SVG through the WASM bridge (prepareSvgDocument)
 * 2. Create an ArtObject with auto-assigned element assignments
 * 3. Override element assignments based on the editor's CNC metadata
 *
 * For root nodes without `originalSvg` (manually created shapes), we export
 * them to SVG first, then run the same pipeline.
 */
export async function editorStateToArtObjects(
  nodesById: Record<string, CanvasNode>,
  rootIds: string[],
  artboard: ArtboardState,
  machiningSettings: MachiningSettings,
  baseSettings: Settings,
): Promise<ArtObject[]> {
  const settings = buildBridgeSettings(baseSettings, artboard, machiningSettings)
  const artObjects: ArtObject[] = []

  for (const rootId of rootIds) {
    const rootNode = nodesById[rootId]
    if (!rootNode || !rootNode.visible) continue

    const exportInfo = getSvgTextForNode(rootNode, rootId, nodesById, artboard, machiningSettings)
    if (!exportInfo) continue

    const preparedSvg = await prepareSvgDocument(exportInfo.svgText)

    const defaultEngraveType = resolveDefaultEngraveType(rootNode)
    const nodeSize = getNodeSize(rootNode, nodesById)
    const usesGeneratedCenterlineSvg = exportInfo.usesGeneratedCenterlineSvg

    // Expand grid nodes into N×M individual art objects
    const grid = rootNode.gridMetadata
    const rows = grid ? Math.max(1, grid.rows) : 1
    const cols = grid ? Math.max(1, grid.cols) : 1
    const rowGap = grid ? grid.rowGap : 0
    const colGap = grid ? grid.colGap : 0

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cellId = rows === 1 && cols === 1 ? rootId : `${rootId}-grid-${r}-${c}`
        const artObject = createArtObject({
          artObjectId: cellId,
          name: rows === 1 && cols === 1 ? rootNode.name : `${rootNode.name} [${r + 1},${c + 1}]`,
          preparedSvg,
          settings,
          defaultEngraveType,
          existingArtObjects: artObjects,
        })

        artObject.widthMm = nodeSize.width
        artObject.heightMm = nodeSize.height
        artObject.placementX = rootNode.x + c * (nodeSize.width + colGap)
        const cellCanvasY = rootNode.y + r * (nodeSize.height + rowGap)
        artObject.placementY = artboard.height - cellCanvasY - nodeSize.height

        // For generator nodes and synthesized shapes (no originalSvg), getSvgTextForNode
        // calls exportToSVG with an artboard-sized viewport (e.g. viewBox="0 0 600 500").
        // parseSvgDocumentMetrics then sets svgMetrics.width=600 instead of the shape's
        // actual coordinate width (~100mm), causing composeArtObjectsSvg to compute
        // scaleX = widthMm / 600 ≈ 0.17 — squashing the shape and corrupting its position.
        // Fix: override svgMetrics so that width/height match the actual path coordinate
        // extents (= baseWidth/baseHeight, which equal the mm dimensions since generator
        // path coordinates are in mm and scaleX is always 1 after parametric resize).
        const hasOriginalSvg = isGroupNode(rootNode) && Boolean((rootNode as GroupNode).originalSvg) && !usesGeneratedCenterlineSvg
        if ((usesGeneratedCenterlineSvg || !hasOriginalSvg) && nodeSize.baseWidth > 0 && nodeSize.baseHeight > 0) {
          artObject.svgMetrics = {
            x: 0,
            y: 0,
            width: nodeSize.baseWidth,
            height: nodeSize.baseHeight,
            widthMm: nodeSize.width,
            heightMm: nodeSize.height,
            aspectRatio: nodeSize.width / nodeSize.height,
          }
        }

        applyEditorCncMetadata(
          artObject,
          exportInfo.metadataRootNode,
          exportInfo.metadataNodesById,
          machiningSettings,
        )
        artObjects.push(artObject)
      }
    }
  }

  return artObjects
}

/**
 * Full GCode generation pipeline: editor state → ArtObjects → composed SVG → operations.
 * Returns the inputs needed for `generateEngravingJob`.
 */
export async function prepareGenerationInputs(
  nodesById: Record<string, CanvasNode>,
  rootIds: string[],
  artboard: ArtboardState,
  machiningSettings: MachiningSettings,
  baseSettings: Settings,
) {
  const settings = buildBridgeSettings(baseSettings, artboard, machiningSettings)
  const artObjects = await editorStateToArtObjects(
    nodesById,
    rootIds,
    artboard,
    machiningSettings,
    baseSettings,
  )

  if (artObjects.length === 0) {
    throw new Error("No visible objects on the artboard to generate GCode from.")
  }

  const composedSvg = composeArtObjectsSvg(artObjects, settings)
  const operations = getDerivedOperationsForArtObjects(artObjects)
  const deepestTargetDepth = operations.reduce(
    (max, operation) => Math.max(max, operation.target_depth_mm),
    0,
  )
  const effectiveMaxStepdown = resolveEffectiveMaxStepdown(
    machiningSettings,
    deepestTargetDepth,
  )

  if (effectiveMaxStepdown != null) {
    settings.engraving.max_stepdown = effectiveMaxStepdown
  }

  return { normalized_svg: composedSvg, settings, operations }
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

interface SvgTextForNode {
  svgText: string
  metadataRootNode: CanvasNode
  metadataNodesById: Record<string, CanvasNode>
  usesGeneratedCenterlineSvg: boolean
}

function getSvgTextForNode(
  node: CanvasNode,
  nodeId: string,
  nodesById: Record<string, CanvasNode>,
  artboard: ArtboardState,
  machiningSettings: MachiningSettings,
): SvgTextForNode | null {
  if (subtreeHasActiveCenterline(node, nodesById)) {
    const exportNodes = buildCenterlineExportNodes(nodeId, nodesById, {
      toolDiameter: machiningSettings.toolDiameter,
    })
    const exportRoot = exportNodes.nodesById[nodeId]
    if (exportRoot) {
      exportNodes.nodesById[nodeId] = { ...exportRoot, x: 0, y: 0 } as CanvasNode
    }

    return {
      svgText: exportToSVG(exportNodes.nodesById, [nodeId], {
        ...artboard,
        x: 0,
        y: 0,
      }),
      metadataRootNode: exportNodes.nodesById[nodeId] ?? exportNodes.rootNode,
      metadataNodesById: exportNodes.nodesById,
      usesGeneratedCenterlineSvg: true,
    }
  }

  // Prefer the stored original SVG from import (but not for generator groups —
  // those need per-child export so each shape becomes a separate operation)
  if (isGroupNode(node) && node.originalSvg && !(node as GroupNode).generatorMetadata) {
    return {
      svgText: node.originalSvg,
      metadataRootNode: node,
      metadataNodesById: nodesById,
      usesGeneratedCenterlineSvg: false,
    }
  }

  // Fallback: export this single node as SVG
  // Create a minimal nodesById with just this subtree
  const subtreeIds = getSubtreeIds(nodeId, nodesById)
  const subtreeNodes: Record<string, CanvasNode> = {}
  for (const id of subtreeIds) {
    const subtreeNode = nodesById[id]
    if (subtreeNode) {
      subtreeNodes[id] = id === nodeId
        ? { ...subtreeNode, x: 0, y: 0 }
        : subtreeNode
    }
  }

  const metadataRootNode = subtreeNodes[nodeId]
  if (!metadataRootNode) return null

  return {
    svgText: exportToSVG(subtreeNodes, [nodeId], {
      ...artboard,
      x: 0,
      y: 0,
    }),
    metadataRootNode,
    metadataNodesById: subtreeNodes,
    usesGeneratedCenterlineSvg: false,
  }
}

function resolveDefaultEngraveType(node: CanvasNode): BridgeEngraveType {
  const engraveType = node.cncMetadata?.engraveType
  if (engraveType === "pocket" || engraveType === "outline") {
    return engraveType
  }
  if (engraveType === "contour") {
    return "outline"
  }
  // 'plunge' maps to pocket — tiny circles will produce a plunge-like operation
  if (engraveType === "plunge") {
    return "pocket"
  }
  return "pocket"
}

/**
 * Walk the editor's node subtree and apply CNC metadata (cutDepth, engraveType)
 * onto the ArtObject's element assignments.
 *
 * Since the editor's node IDs and the bridge's element IDs (from data-s2g-id)
 * are independent, we match by traversal order: leaf elements in both trees
 * come from the same SVG and appear in the same document order.
 */
function applyEditorCncMetadata(
  artObject: ArtObject,
  rootNode: CanvasNode,
  nodesById: Record<string, CanvasNode>,
  machiningSettings: MachiningSettings,
) {
  // Collect leaf nodes with CNC metadata in document order
  const leafMetadata = collectLeafCncMetadata(rootNode, nodesById)

  // The bridge's selectable element IDs are in document order too
  const compositeIds = Object.keys(artObject.elementAssignments)

  // If we have metadata from the editor, apply it positionally
  // If the editor has metadata on the root group, apply it as default to all elements
  const rootDepth = rootNode.cncMetadata?.cutDepth ?? machiningSettings.defaultDepthMm
  const rootEngraveType = resolveDefaultEngraveType(rootNode)
  const rootFillMode = engraveTypeToFillMode(rootEngraveType)

  for (let i = 0; i < compositeIds.length; i++) {
    const compositeId = compositeIds[i]!
    const assignment = artObject.elementAssignments[compositeId]
    if (!assignment) continue

    // Check if there's a positional match from editor leaf metadata
    const leafMeta = leafMetadata[i]
    if (leafMeta) {
      assignment.targetDepthMm = leafMeta.cutDepth ?? rootDepth
      assignment.engraveType = leafMeta.engraveType ?? rootEngraveType
      assignment.fillMode = engraveTypeToFillMode(assignment.engraveType) ?? rootFillMode
    } else {
      // Fall back to root defaults
      assignment.targetDepthMm = rootDepth
      assignment.engraveType = rootEngraveType
      assignment.fillMode = rootFillMode
    }
  }
}

interface LeafMeta {
  cutDepth: number | undefined
  engraveType: BridgeEngraveType | null
}

function collectLeafCncMetadata(
  node: CanvasNode,
  nodesById: Record<string, CanvasNode>,
): LeafMeta[] {
  if (isGroupNode(node)) {
    const result: LeafMeta[] = []
    for (const childId of (node as GroupNode).childIds) {
      const child = nodesById[childId]
      if (child && child.visible) {
        result.push(...collectLeafCncMetadata(child, nodesById))
      }
    }
    return result
  }

  // Leaf node — resolve engrave type to bridge format
  const metadata = resolveNodeCncMetadata(node, nodesById)
  const editorType = metadata.engraveType
  let bridgeType: BridgeEngraveType | null = null
  if (editorType === "contour" || editorType === "outline") {
    bridgeType = "outline"
  } else if (editorType === "pocket" || editorType === "plunge") {
    bridgeType = "pocket"
  }

  return [{
    cutDepth: metadata.cutDepth,
    engraveType: bridgeType,
  }]
}
