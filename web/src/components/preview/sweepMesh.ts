/**
 * Merged sweep volume meshes - shows the swept tool volumes as blue extruded geometry.
 * Ported from PoC's createMergedSweepMeshes.
 */

import * as THREE from 'three'
import type { ToolpathGroup } from '../../types/preview'
import type { RouterBitShape } from '../../types/editor'
import { getExtrudeFn, createSweepMaterial } from './bitProfiles'

export function createMergedSweepMeshes(
  toolpaths: ToolpathGroup[],
  toolShapeOverride?: RouterBitShape,
  color = 0x4aa8ff,
): THREE.Group {
  const group = new THREE.Group()

  // One shared material for every swept slot in this rebuild. The material is
  // tagged on the group so clearGroup's dedup can dispose it exactly once.
  const material = createSweepMaterial(color, false)
  group.userData.sweepMaterial = material

  for (const tp of toolpaths) {
    const shapes = tp.slotShapes || []
    if (shapes.length === 0) continue
    const depth = Math.abs(tp.depth) || 0.01
    const extrude = getExtrudeFn(toolShapeOverride ?? tp.toolShape)
    for (const shape of shapes) {
      group.add(extrude(shape, depth, tp.radius, material))
    }
  }

  return group
}
