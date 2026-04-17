/**
 * Scene helpers: GPU cleanup, grid, axes, tool marker, lighting.
 * Ported from PoC's clearGroup, disposeMaterial, and scene setup code.
 */

import * as THREE from 'three'
import type { RouterBitShape } from '../../types/editor'

export function disposeMaterial(material: THREE.Material | THREE.Material[]): void {
  if (Array.isArray(material)) {
    for (const entry of material) {
      entry.dispose()
    }
    return
  }
  material.dispose()
}

export function clearGroup(group: THREE.Group): void {
  const disposedMaterials = new Set<THREE.Material>()
  for (const child of [...group.children]) {
    group.remove(child)
    child.traverse((node) => {
      const meshNode = node as THREE.Mesh
      if (meshNode.geometry) {
        meshNode.geometry.dispose()
      }
      if (meshNode.material && !disposedMaterials.has(meshNode.material as THREE.Material)) {
        disposedMaterials.add(meshNode.material as THREE.Material)
        disposeMaterial(meshNode.material as THREE.Material | THREE.Material[])
      }
    })
  }
}

export function createLighting(): THREE.Group {
  const group = new THREE.Group()
  group.add(new THREE.AmbientLight(0xffffff, 0.35))

  const keyLight = new THREE.DirectionalLight(0xffffff, 1.1)
  keyLight.position.set(8, -6, 12)
  group.add(keyLight)

  const fillLight = new THREE.DirectionalLight(0x88aaff, 0.45)
  fillLight.position.set(-10, 8, 7)
  group.add(fillLight)

  return group
}

export function createGrid(materialWidth: number, materialHeight: number): THREE.Group {
  const group = new THREE.Group()

  const gridSize = Math.max(materialWidth, materialHeight) * 1.5
  const divisions = Math.round(gridSize / 10)
  const grid = new THREE.GridHelper(gridSize, divisions, 0x666666, 0x383838)
  grid.rotation.x = Math.PI / 2
  // Lift the grid slightly above the stock surface (Z=0) so it doesn't
  // z-fight with the material top face from certain camera angles.
  grid.position.set(materialWidth / 2, materialHeight / 2, 0.5)
  // GridHelper ships with two LineBasicMaterials (center + grid). Make both
  // transparent so the grid reads as a faint overlay, not a solid pattern.
  // Keep depthWrite on so the grid occludes correctly against the stock —
  // without it, transparent-sorted stock tiles in front of the grid will
  // draw on top and hide half of it depending on camera angle.
  const gridMaterials = Array.isArray(grid.material) ? grid.material : [grid.material]
  for (const mat of gridMaterials) {
    const lineMat = mat as THREE.LineBasicMaterial
    lineMat.transparent = true
    lineMat.opacity = 0.28
  }
  // Draw the grid after the transparent stock so it always sits on top of
  // the material surface regardless of the transparent sort order.
  grid.renderOrder = 2
  group.add(grid)

  const axes = new THREE.AxesHelper(Math.min(materialWidth, materialHeight) * 0.15)
  group.add(axes)

  return group
}

export interface ToolMarker {
  group: THREE.Group
  body: THREE.Object3D
  circle: THREE.Mesh
  line: THREE.Line
}

function createToolMaterial(): THREE.MeshPhongMaterial {
  return new THREE.MeshPhongMaterial({
    color: 0xffd166,
    emissive: 0x5a4311,
    transparent: true,
    opacity: 0.84,
    shininess: 90,
  })
}

function createLathedToolProfile(
  toolRadius: number,
  toolShape: RouterBitShape,
): THREE.Object3D {
  const fluteLength = Math.max(toolRadius * 5, 10)
  const shaftRadius = Math.max(toolRadius * 0.42, 0.35)
  const points: THREE.Vector2[] = [new THREE.Vector2(0, 0)]

  if (toolShape === 'Ball') {
    const arcSegments = 10
    for (let i = 1; i <= arcSegments; i++) {
      const t = i / arcSegments
      const angle = (Math.PI / 2) * t
      points.push(
        new THREE.Vector2(
          Math.sin(angle) * toolRadius,
          toolRadius - Math.cos(angle) * toolRadius,
        ),
      )
    }
  } else if (toolShape === 'V') {
    const tipHeight = Math.max(toolRadius, 1)
    points.push(new THREE.Vector2(toolRadius, tipHeight))
  } else {
    points.push(new THREE.Vector2(toolRadius, 0))
  }

  points.push(new THREE.Vector2(toolRadius, fluteLength))
  points.push(new THREE.Vector2(shaftRadius, fluteLength + toolRadius * 1.8))
  points.push(new THREE.Vector2(shaftRadius, fluteLength + toolRadius * 4))
  points.push(new THREE.Vector2(0, fluteLength + toolRadius * 4))

  const geometry = new THREE.LatheGeometry(points, 32)
  geometry.rotateX(Math.PI / 2)
  geometry.computeVertexNormals()

  return new THREE.Mesh(geometry, createToolMaterial())
}

export function createToolMarker(
  toolRadius: number,
  toolShape: RouterBitShape = 'Flat',
): ToolMarker {
  const group = new THREE.Group()
  group.visible = false

  const body = createLathedToolProfile(toolRadius, toolShape)
  group.add(body)

  const circleGeo = new THREE.CircleGeometry(1, 32)
  const circleMat = new THREE.MeshBasicMaterial({
    color: 0xffd166,
    transparent: true,
    opacity: 0.52,
    side: THREE.DoubleSide,
  })
  const circle = new THREE.Mesh(circleGeo, circleMat)
  circle.scale.set(toolRadius, toolRadius, 1)
  circle.position.z = 0.03
  group.add(circle)

  const lineGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0.03),
    new THREE.Vector3(0, 0, 5),
  ])
  const lineMat = new THREE.LineBasicMaterial({
    color: 0xffd166,
    transparent: true,
    opacity: 0.6,
  })
  const line = new THREE.Line(lineGeo, lineMat)
  group.add(line)

  return { group, body, circle, line }
}

export function createActivePathLine(): THREE.Line {
  const line = new THREE.Line(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({
      color: 0xffd166,
      transparent: true,
      opacity: 1,
    }),
  )
  line.visible = false
  return line
}
