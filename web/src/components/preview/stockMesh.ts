/**
 * Layered stock visualization with boolean subtraction.
 * Uses grid tiling to keep per-tile polygon complexity low enough for earcut.
 */

import * as THREE from 'three'
import type { ToolpathGroup, StockBounds } from '../../types/preview'
import type { RouterBitShape } from '../../types/editor'
import { unionShapes, subtractShapes, createRectangleShape, insetShapes } from './clipperSweep'

export function extrudeSlotShape(
  shape: THREE.Shape,
  depth: number,
  color: number,
  depthWrite = true,
): THREE.Mesh {
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: false,
    curveSegments: 28,
  })
  geometry.translate(0, 0, -depth)

  const material = new THREE.MeshPhongMaterial({
    color,
    transparent: true,
    opacity: 0.68,
    shininess: 70,
    side: THREE.DoubleSide,
    depthWrite,
  })

  return new THREE.Mesh(geometry, material)
}

/** Number of tiles per axis for grid-based stock subtraction */
const TILE_COUNT = 6

const V_HALF_ANGLE_RAD = Math.PI / 4 // 90° V-bit → 45° half-angle

interface ProfileSubLayer {
  shapes: THREE.Shape[]
  thickness: number
  zBottom: number
}

/**
 * Generate profile-aware sub-layers for the bottom of a cut.
 * For Flat bits, returns a single layer (no change).
 * For Ball/V bits, splits the profile zone into stepped inset layers.
 */
function computeProfileSubLayers(
  clearedShapes: THREE.Shape[],
  toolShape: RouterBitShape,
  toolRadius: number,
  depth: number,
  layerTop: number,
  layerBottom: number,
): ProfileSubLayer[] {
  if (toolShape === 'Flat' || clearedShapes.length === 0) {
    return [{ shapes: clearedShapes, thickness: layerBottom - layerTop, zBottom: layerBottom }]
  }

  if (toolShape === 'Ball') {
    const effectiveRadius = Math.min(toolRadius, depth)
    const hemiTop = depth - effectiveRadius // Z where hemisphere zone starts

    // If this layer is entirely above the hemisphere zone, full subtraction
    if (layerBottom <= hemiTop + 0.001) {
      return [{ shapes: clearedShapes, thickness: layerBottom - layerTop, zBottom: layerBottom }]
    }

    // Determine the overlap of this layer with the hemisphere zone
    const profileStart = Math.max(layerTop, hemiTop)
    const subLayers: ProfileSubLayer[] = []

    // Flat wall portion above hemisphere (if any)
    if (profileStart > layerTop + 0.001) {
      subLayers.push({ shapes: clearedShapes, thickness: profileStart - layerTop, zBottom: profileStart })
    }

    // Hemisphere sub-layers
    const hemiPortionTop = profileStart - hemiTop
    const hemiPortionBottom = layerBottom - hemiTop
    const hemiLayerCount = 8
    for (let i = 0; i < hemiLayerCount; i++) {
      const subTop = hemiPortionTop + (hemiPortionBottom - hemiPortionTop) * (i / hemiLayerCount)
      const subBottom = hemiPortionTop + (hemiPortionBottom - hemiPortionTop) * ((i + 1) / hemiLayerCount)
      const subThickness = subBottom - subTop
      if (subThickness < 0.001) continue

      // d = distance from top of hemisphere zone to the bottom of this sub-layer
      const d = subBottom
      const insetAmount = effectiveRadius - Math.sqrt(Math.max(0, effectiveRadius * effectiveRadius - d * d))

      let layerShapes: THREE.Shape[]
      if (insetAmount < 0.01) {
        layerShapes = clearedShapes
      } else {
        layerShapes = insetShapes(clearedShapes, insetAmount)
      }
      if (layerShapes.length === 0) break

      subLayers.push({ shapes: layerShapes, thickness: subThickness, zBottom: hemiTop + subBottom })
    }

    return subLayers.length > 0 ? subLayers : [{ shapes: clearedShapes, thickness: layerBottom - layerTop, zBottom: layerBottom }]
  }

  if (toolShape === 'V') {
    const tanHalf = Math.tan(V_HALF_ANGLE_RAD)
    const subLayers: ProfileSubLayer[] = []
    const subLayerCount = 8
    const layerThickness = layerBottom - layerTop

    for (let i = 0; i < subLayerCount; i++) {
      const subTop = layerTop + layerThickness * (i / subLayerCount)
      const subBottom = layerTop + layerThickness * ((i + 1) / subLayerCount)
      const subThickness = subBottom - subTop
      if (subThickness < 0.001) continue

      // Inset based on absolute depth from surface at the top of this sub-layer
      const insetAmount = subTop / tanHalf
      let layerShapes: THREE.Shape[]
      if (insetAmount < 0.01) {
        layerShapes = clearedShapes
      } else {
        layerShapes = insetShapes(clearedShapes, insetAmount)
      }
      if (layerShapes.length === 0) break

      subLayers.push({ shapes: layerShapes, thickness: subThickness, zBottom: subBottom })
    }

    return subLayers.length > 0 ? subLayers : [{ shapes: clearedShapes, thickness: layerBottom - layerTop, zBottom: layerBottom }]
  }

  return [{ shapes: clearedShapes, thickness: layerBottom - layerTop, zBottom: layerBottom }]
}

/**
 * A reusable stock material. The underlying MeshPhongMaterial is created once
 * per preview session so Three.js compiles its shader program exactly once.
 * The depth-darkening uniform is held in a stable object so it can be updated
 * between rebuilds without triggering a recompile.
 */
export interface StockMaterialHandle {
  material: THREE.MeshPhongMaterial
  uniforms: { uMaxDepth: { value: number } }
  setTexture: (texture?: THREE.Texture) => void
  dispose: () => void
}

export function createStockMaterialHandle(): StockMaterialHandle {
  const uniforms = { uMaxDepth: { value: 0.01 } }

  const material = new THREE.MeshPhongMaterial({
    color: 0xcdbb8f,
    transparent: true,
    opacity: 0.82,
    shininess: 28,
    side: THREE.DoubleSide,
  })

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uMaxDepth = uniforms.uMaxDepth

    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `#include <common>
varying float vWorldZ;`,
    )
    shader.vertexShader = shader.vertexShader.replace(
      '#include <fog_vertex>',
      `#include <fog_vertex>
vWorldZ = (modelMatrix * vec4(position, 1.0)).z;`,
    )

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>
varying float vWorldZ;
uniform float uMaxDepth;`,
    )
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <dithering_fragment>',
      `#include <dithering_fragment>
if (vWorldZ < -0.05) {
  float t = clamp(-vWorldZ / max(uMaxDepth, 0.001), 0.0, 1.0);
  gl_FragColor.rgb *= (1.0 - sqrt(t) * 0.6);
}`,
    )
  }

  return {
    material,
    uniforms,
    setTexture: (texture?: THREE.Texture) => {
      if (texture) {
        texture.wrapS = THREE.RepeatWrapping
        texture.wrapT = THREE.RepeatWrapping
        texture.repeat.set(1 / 400, 1 / 400)
      }
      material.map = texture ?? null
      material.color.setHex(texture ? 0xffffff : 0xcdbb8f)
      material.needsUpdate = true
    },
    dispose: () => {
      material.dispose()
    },
  }
}

export function createStockMeshLayers(
  bounds: StockBounds,
  toolpaths: ToolpathGroup[],
  materialThickness: number,
  toolShape: RouterBitShape = 'Flat',
  toolRadius = 1.5,
  stockHandle?: StockMaterialHandle,
  fallbackDepth = 0.01,
): THREE.Group {
  const uniqueDepths =
    toolpaths.length > 0
      ? [...new Set(toolpaths.map((tp) => tp.depth))].sort((a, b) => a - b)
      : [fallbackDepth]

  const group = new THREE.Group()

  // If no handle provided, create a one-shot material owned by the returned group.
  // clearGroup() will dispose it along with the geometries.
  const ownedHandle = stockHandle ?? createStockMaterialHandle()
  const stockMaterial = ownedHandle.material
  if (!stockHandle) {
    group.userData.ownedStockMaterial = stockMaterial
  }

  const totalDepth = Math.max(materialThickness, uniqueDepths[uniqueDepths.length - 1] || 0) || fallbackDepth
  ownedHandle.uniforms.uMaxDepth.value = totalDepth
  const deepestCut = uniqueDepths[uniqueDepths.length - 1] || 0

  const tileW = (bounds.maxX - bounds.minX) / TILE_COUNT
  const tileH = (bounds.maxY - bounds.minY) / TILE_COUNT

  let previousDepth = 0

  for (const depth of uniqueDepths) {
    const layerThickness = depth - previousDepth
    const activeToolpaths = toolpaths.filter(
      (tp) => tp.depth >= depth && (tp.slotShapes || []).length > 0,
    )

    if (layerThickness <= 0) {
      previousDepth = depth
      continue
    }

    const allClearedShapes = activeToolpaths.flatMap((tp) => tp.slotShapes || [])
    if (allClearedShapes.length === 0) {
      // No cuts at this depth — full stock layer
      const fullShape = createRectangleShape(bounds)
      const geo = new THREE.ExtrudeGeometry(fullShape, {
        depth: layerThickness,
        bevelEnabled: false,
        curveSegments: 4,
      })
      geo.translate(0, 0, -depth)
      group.add(new THREE.Mesh(geo, stockMaterial))
      previousDepth = depth
      continue
    }

    // Merge all cleared shapes once (Clipper handles this well)
    const mergedClearedShapes = unionShapes(allClearedShapes, 48)

    // Separate toolpaths passing through vs terminating at this depth
    const passingThrough = activeToolpaths.filter((tp) => tp.depth > depth)
    const terminatingHere = activeToolpaths.filter((tp) => Math.abs(tp.depth - depth) < 0.001)

    const passingShapes = passingThrough.flatMap((tp) => tp.slotShapes || [])
    const terminatingShapes = terminatingHere.flatMap((tp) => tp.slotShapes || [])
    const mergedPassingShapes = passingShapes.length > 0 ? unionShapes(passingShapes, 48) : []
    const mergedTerminatingShapes = terminatingShapes.length > 0 ? unionShapes(terminatingShapes, 48) : []

    // For non-Flat tools with terminating toolpaths, use profile sub-layers
    if (toolShape !== 'Flat' && mergedTerminatingShapes.length > 0) {
      const subLayers = computeProfileSubLayers(
        mergedTerminatingShapes, toolShape, toolRadius,
        depth, previousDepth, depth,
      )

      for (const subLayer of subLayers) {
        // Union passing-through shapes (full width) with this sub-layer's (possibly inset) shapes
        const combinedClearance = mergedPassingShapes.length > 0
          ? unionShapes([...mergedPassingShapes, ...subLayer.shapes], 48)
          : subLayer.shapes

        for (let row = 0; row < TILE_COUNT; row++) {
          for (let col = 0; col < TILE_COUNT; col++) {
            const tileBounds = {
              minX: bounds.minX + col * tileW,
              minY: bounds.minY + row * tileH,
              maxX: bounds.minX + (col + 1) * tileW,
              maxY: bounds.minY + (row + 1) * tileH,
            }

            const tileShapes = subtractShapes(
              [createRectangleShape(tileBounds)],
              combinedClearance,
              48,
            )

            for (const shape of tileShapes) {
              const geo = new THREE.ExtrudeGeometry(shape, {
                depth: subLayer.thickness,
                bevelEnabled: false,
                curveSegments: 12,
              })
              geo.translate(0, 0, -subLayer.zBottom)
              group.add(new THREE.Mesh(geo, stockMaterial))
            }
          }
        }
      }
    } else {
      // Flat tool or no terminating toolpaths — original behavior
      for (let row = 0; row < TILE_COUNT; row++) {
        for (let col = 0; col < TILE_COUNT; col++) {
          const tileBounds = {
            minX: bounds.minX + col * tileW,
            minY: bounds.minY + row * tileH,
            maxX: bounds.minX + (col + 1) * tileW,
            maxY: bounds.minY + (row + 1) * tileH,
          }

          const tileShapes = subtractShapes(
            [createRectangleShape(tileBounds)],
            mergedClearedShapes,
            48,
          )

          for (const shape of tileShapes) {
            const geo = new THREE.ExtrudeGeometry(shape, {
              depth: layerThickness,
              bevelEnabled: false,
              curveSegments: 12,
            })
            geo.translate(0, 0, -depth)
            group.add(new THREE.Mesh(geo, stockMaterial))
          }
        }
      }
    }

    previousDepth = depth
  }

  // Add solid material layer below the deepest cut down to material thickness
  if (totalDepth > deepestCut) {
    const belowGeometry = new THREE.ExtrudeGeometry(createRectangleShape(bounds), {
      depth: totalDepth - deepestCut,
      bevelEnabled: false,
      curveSegments: 4,
    })
    belowGeometry.translate(0, 0, -totalDepth)
    group.add(new THREE.Mesh(belowGeometry, stockMaterial))
  }

  // Bounding box outline
  const outlineGeometry = new THREE.EdgesGeometry(
    new THREE.BoxGeometry(
      bounds.maxX - bounds.minX,
      bounds.maxY - bounds.minY,
      totalDepth,
    ),
  )
  outlineGeometry.translate(
    (bounds.minX + bounds.maxX) / 2,
    (bounds.minY + bounds.maxY) / 2,
    -(totalDepth / 2),
  )
  const outline = new THREE.LineSegments(
    outlineGeometry,
    new THREE.LineBasicMaterial({ color: 0xf5deb3, transparent: true, opacity: 0.55 }),
  )
  group.add(outline)

  return group
}

export function computeStockBounds(toolpaths: ToolpathGroup[], padding = 1.8): StockBounds {
  const bounds: StockBounds = {
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
  }

  for (const toolpath of toolpaths) {
    for (const point of toolpath.pathPoints) {
      bounds.minX = Math.min(bounds.minX, point.x)
      bounds.minY = Math.min(bounds.minY, point.y)
      bounds.maxX = Math.max(bounds.maxX, point.x)
      bounds.maxY = Math.max(bounds.maxY, point.y)
    }
  }

  bounds.minX -= padding
  bounds.minY -= padding
  bounds.maxX += padding
  bounds.maxY += padding
  return bounds
}
