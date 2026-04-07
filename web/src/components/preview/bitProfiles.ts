/**
 * Modular bit profile extrusion strategies.
 *
 * Each bit type defines how to turn a 2D swept footprint (THREE.Shape)
 * into 3D cut geometry. Adding a new bit type = one function + one case.
 */

import * as THREE from 'three'
import type { RouterBitShape } from '../../types/editor'
import { insetShapes } from './clipperSweep'

export type ExtrudeFn = (
  shape: THREE.Shape,
  depth: number,
  radius: number,
  color: number,
  depthWrite: boolean,
) => THREE.Object3D

function makeMaterial(color: number, depthWrite: boolean): THREE.MeshPhongMaterial {
  return new THREE.MeshPhongMaterial({
    color,
    transparent: true,
    opacity: 0.68,
    shininess: 70,
    side: THREE.DoubleSide,
    depthWrite,
  })
}

/**
 * Flat bit: single straight extrusion (original behavior).
 */
function extrudeFlat(
  shape: THREE.Shape,
  depth: number,
  _radius: number,
  color: number,
  depthWrite: boolean,
): THREE.Mesh {
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: false,
    curveSegments: 28,
  })
  geometry.translate(0, 0, -depth)
  return new THREE.Mesh(geometry, makeMaterial(color, depthWrite))
}

/**
 * Ball bit: flat walls above + hemisphere bottom using negative bevel.
 *
 * THREE.js ExtrudeGeometry bevel with negative bevelSize creates a
 * quarter-circle inward profile — exactly a hemisphere cross-section.
 */
function extrudeBall(
  shape: THREE.Shape,
  depth: number,
  radius: number,
  color: number,
  depthWrite: boolean,
): THREE.Object3D {
  const effectiveRadius = Math.min(radius, depth)
  const wallHeight = depth - effectiveRadius

  const group = new THREE.Group()
  const material = makeMaterial(color, depthWrite)

  // Upper flat walls (only when cut is deeper than the hemisphere)
  if (wallHeight > 0.001) {
    const wallGeo = new THREE.ExtrudeGeometry(shape, {
      depth: wallHeight,
      bevelEnabled: false,
      curveSegments: 28,
    })
    wallGeo.translate(0, 0, -wallHeight)
    group.add(new THREE.Mesh(wallGeo, material))
  }

  // Bottom hemisphere via negative bevel
  const hemiGeo = new THREE.ExtrudeGeometry(shape, {
    depth: 0.001,
    bevelEnabled: true,
    bevelThickness: effectiveRadius,
    bevelSize: -effectiveRadius,
    bevelSegments: 6,
    curveSegments: 28,
  })
  // Position so the top of the hemisphere meets the bottom of the walls
  // ExtrudeGeometry with bevel extends from -bevelThickness to depth+bevelThickness
  // We want the top (z = bevelThickness) to align with z = -wallHeight
  hemiGeo.translate(0, 0, -wallHeight - effectiveRadius)
  group.add(new THREE.Mesh(hemiGeo, material))

  return group
}

/**
 * V-groove bit: stepped taper using Clipper polygon inset.
 *
 * Creates 3 layers that approximate the V cross-section:
 * full width at surface → inset at mid-depth → heavily inset at full depth.
 * Default V-angle: 90 degrees (halfAngle = 45°, tan = 1).
 */
const V_HALF_ANGLE_RAD = Math.PI / 4 // 90° V-bit → 45° half-angle

function extrudeVGroove(
  shape: THREE.Shape,
  depth: number,
  _radius: number,
  color: number,
  depthWrite: boolean,
): THREE.Object3D {
  const tanHalf = Math.tan(V_HALF_ANGLE_RAD)
  const layerCount = 3
  const layerThickness = depth / layerCount

  const group = new THREE.Group()
  const material = makeMaterial(color, depthWrite)

  for (let i = 0; i < layerCount; i++) {
    const layerBottom = (i + 1) * layerThickness
    const insetAmount = layerBottom / tanHalf

    let layerShapes: THREE.Shape[]
    if (insetAmount < 0.01) {
      layerShapes = [shape]
    } else {
      layerShapes = insetShapes([shape], insetAmount)
    }

    if (layerShapes.length === 0) break // fully collapsed

    for (const s of layerShapes) {
      const geo = new THREE.ExtrudeGeometry(s, {
        depth: layerThickness,
        bevelEnabled: false,
        curveSegments: 28,
      })
      geo.translate(0, 0, -layerBottom)
      group.add(new THREE.Mesh(geo, material))
    }
  }

  // If all layers collapsed, fall back to a thin surface extrusion
  if (group.children.length === 0) {
    return extrudeFlat(shape, Math.min(depth, 0.1), _radius, color, depthWrite)
  }

  return group
}

/**
 * Factory: returns the extrude function for a given bit shape.
 */
export function getExtrudeFn(bitShape: RouterBitShape): ExtrudeFn {
  switch (bitShape) {
    case 'Ball':
      return extrudeBall
    case 'V':
      return extrudeVGroove
    case 'Flat':
    default:
      return extrudeFlat
  }
}
