/**
 * Merged sweep volume meshes - shows the swept tool volumes as blue extruded geometry.
 * Ported from PoC's createMergedSweepMeshes.
 */

import * as THREE from 'three'
import type { ToolpathGroup } from '../../types/preview'
import type { RouterBitShape } from '../../types/editor'
import { getExtrudeFn } from './bitProfiles'

export function createMergedSweepMeshes(
  toolpaths: ToolpathGroup[],
  toolShapeOverride?: RouterBitShape,
  color = 0x4aa8ff,
): THREE.Group {
  const group = new THREE.Group()

  for (const tp of toolpaths) {
    const shapes = tp.slotShapes || []
    if (shapes.length === 0) continue
    const depth = Math.abs(tp.depth) || 0.01
    const extrude = getExtrudeFn(toolShapeOverride ?? tp.toolShape)
    for (const shape of shapes) {
      group.add(extrude(shape, depth, tp.radius, color, false))
    }
  }

  return group
}
