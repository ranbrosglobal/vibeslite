/**
 * Field autonomy — one live 3D view of the whole loop.
 *
 *   baseline   the drone's first geo-mapped survey: a tiled relief of the field,
 *              kept as the permanent reference for every later reading
 *   sensing    depth cameras on poles and the drones' own passes, streaming
 *   compare    live readings against the baseline; the zones that drifted are
 *              marked on the ground and handed to the robots
 *   dispatch   ground robots drive to those coordinates and treat them
 *
 * Everything is primitives: the field is one InstancedMesh, the aircraft and
 * rovers are built from boxes/cylinders/tori, spray and dust are particle
 * systems, and the data links are dashed curves that animate toward the AWS
 * ingest node.
 *
 *   drag / wheel  orbit + zoom
 *   click         focus a drone, a robot or a field camera
 *   pip           the focused agent's own camera, rendered in the inset
 */
import { useEffect, useRef } from 'react'
import * as THREE from 'three'

const FIELD = { w: 96, d: 64, cols: 34, rows: 22 }

/** Picture-in-picture feed, in CSS pixels (bottom-right of the stage). */
export const PIP = { w: 252, h: 152, m: 18 }

/** Baseline scan: eleven weak zones from the first survey of this field. */
const PATCHES = [
  { x: -26, z: -14, r: 13, s: 0.42 },
  { x: -8, z: 10, r: 10, s: 0.34 },
  { x: 9, z: -18, r: 11, s: 0.38 },
  { x: 24, z: 8, r: 9, s: 0.31 },
  { x: -34, z: 12, r: 8, s: 0.28 },
  { x: 2, z: 22, r: 7, s: 0.24 },
  { x: 33, z: -6, r: 8, s: 0.3 },
  { x: -16, z: 24, r: 6, s: 0.22 },
  { x: 17, z: 24, r: 7, s: 0.26 },
  { x: -40, z: -18, r: 7, s: 0.25 },
  { x: 38, z: 20, r: 6, s: 0.2 },
]

/** Zones the live sensors have flagged as drifting from the baseline. */
const DRIFT = [0, 3, 6]

const RAMP = ['#8f3a22', '#b57a1f', '#6f8f2a', '#3f8a46', '#2f7d4a'].map((hex) => new THREE.Color(hex))

function healthAt(x, z) {
  let health = 0.66 + 0.15 * Math.sin(x * 0.11) * Math.cos(z * 0.09) + 0.07 * Math.sin((x + z) * 0.07)
  for (const patch of PATCHES) {
    const distance = Math.hypot(x - patch.x, z - patch.z)
    if (distance < patch.r) health -= patch.s * (1 - distance / patch.r) ** 1.3
  }
  return Math.min(1, Math.max(0.06, health))
}

function healthColor(health) {
  const t = Math.min(0.999, Math.max(0, health)) * (RAMP.length - 1)
  const index = Math.floor(t)
  return RAMP[index].clone().lerp(RAMP[Math.min(index + 1, RAMP.length - 1)], t - index)
}

function flightPoint(time, index) {
  const lanes = 5
  const cycle = 26 + index * 5
  const progress = ((time / cycle) + index * 0.29) % 1
  const laneFloat = progress * lanes
  const lane = Math.min(lanes - 1, Math.floor(laneFloat))
  const along = laneFloat - lane
  const forward = lane % 2 === 0
  const span = FIELD.w - 18
  const x = forward ? -(span / 2) + along * span : span / 2 - along * span
  const z = -FIELD.d / 2 + 9 + lane * ((FIELD.d - 18) / (lanes - 1)) + (index - 1) * 1.6
  return { x, z }
}

function makeDrone(tint, scale = 1) {
  const group = new THREE.Group()
  const glow = new THREE.PointLight(tint, 9, 18, 2)
  glow.position.set(0, -0.9, 0)
  group.add(glow)

  const shell = new THREE.MeshStandardMaterial({ color: 0x26332c, roughness: 0.38, metalness: 0.6 })
  const panel = new THREE.MeshStandardMaterial({ color: 0x33443b, roughness: 0.55, metalness: 0.35 })
  const accent = new THREE.MeshStandardMaterial({ color: tint, roughness: 0.3, metalness: 0.15, emissive: tint, emissiveIntensity: 0.7 })
  const rotorMat = new THREE.MeshStandardMaterial({ color: 0x0d1512, roughness: 0.7, metalness: 0.2, transparent: true, opacity: 0.9 })

  const body = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.52, 1.5), shell)
  body.castShadow = true
  group.add(body)

  const canopy = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.26, 1.05), panel)
  canopy.position.y = 0.32
  canopy.castShadow = true
  group.add(canopy)

  const nose = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.2, 0.5), accent)
  nose.position.set(1.42, 0.02, 0)
  group.add(nose)

  const rotors = []
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 1.75, 8), panel)
    arm.rotation.z = Math.PI / 2
    arm.rotation.y = Math.atan2(sz, sx) * -1 + Math.PI / 2
    arm.position.set(sx * 0.72, 0.04, sz * 0.55)
    group.add(arm)

    const hub = new THREE.Group()
    hub.position.set(sx * 1.62, 0.16, sz * 1.18)

    const guard = new THREE.Mesh(new THREE.TorusGeometry(0.44, 0.035, 6, 22), panel)
    guard.rotation.x = Math.PI / 2
    hub.add(guard)

    const blades = new THREE.Group()
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.02, 0.1), rotorMat)
    blades.add(blade)
    const blade2 = blade.clone()
    blade2.rotation.y = Math.PI / 2
    blades.add(blade2)
    hub.add(blades)
    rotors.push(blades)

    const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.2, 10), shell)
    motor.position.y = 0.04
    hub.add(motor)

    const led = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 8), accent)
    led.position.set(sx * 0.16, 0.02, sz * 0.14)
    hub.add(led)

    group.add(hub)
  }

  const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.7, 14), panel)
  tank.position.set(-0.4, -0.5, 0)
  tank.castShadow = true
  group.add(tank)

  const boom = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 2.9), panel)
  boom.position.set(0.55, -0.42, 0)
  group.add(boom)

  const nozzleMat = new THREE.MeshStandardMaterial({ color: 0x0d1512, roughness: 0.5, metalness: 0.4 })
  for (const z of [-1.4, -0.7, 0, 0.7, 1.4]) {
    const nozzle = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.2, 8), nozzleMat)
    nozzle.position.set(0.55, -0.56, z)
    nozzle.rotation.x = Math.PI
    group.add(nozzle)
  }

  const cone = new THREE.Mesh(
    new THREE.ConeGeometry(2.35, 5.8, 22, 1, true),
    new THREE.MeshBasicMaterial({
      color: 0xd7f79a,
      transparent: true,
      opacity: 0.055,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  )
  cone.position.set(0.3, -3.3, 0)
  cone.rotation.x = Math.PI
  group.add(cone)

  group.scale.setScalar(scale)
  group.userData.rotors = rotors
  group.userData.cone = cone
  return group
}

/** Ground rover: chassis, four wheels, tank, spray boom and a mast camera. */
function makeRobot(tint) {
  const group = new THREE.Group()
  const shell = new THREE.MeshStandardMaterial({ color: 0x4d5d52, roughness: 0.45, metalness: 0.5 })
  const panel = new THREE.MeshStandardMaterial({ color: 0x3a4a41, roughness: 0.6, metalness: 0.3 })
  const rubber = new THREE.MeshStandardMaterial({ color: 0x111815, roughness: 0.95, metalness: 0.05 })
  const accent = new THREE.MeshStandardMaterial({ color: tint, roughness: 0.35, metalness: 0.1, emissive: tint, emissiveIntensity: 0.6 })

  const glow = new THREE.PointLight(tint, 5, 12, 2)
  glow.position.set(0, 0.6, 0)
  group.add(glow)

  const chassis = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.55, 2.9), shell)
  chassis.position.y = 0.75
  chassis.castShadow = true
  group.add(chassis)

  const deck = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.16, 2.2), panel)
  deck.position.y = 1.08
  group.add(deck)

  const wheels = []
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.48, 0.48, 0.36, 14), rubber)
    wheel.rotation.z = Math.PI / 2
    wheel.position.set(sx * 0.95, 0.48, sz * 0.95)
    wheel.castShadow = true
    group.add(wheel)
    wheels.push(wheel)
  }

  const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.52, 0.52, 1.5, 16), panel)
  tank.rotation.x = Math.PI / 2
  tank.position.set(0, 1.32, 0.3)
  tank.castShadow = true
  group.add(tank)

  const boom = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.09, 0.09), panel)
  boom.position.set(0, 1.2, -1.5)
  group.add(boom)

  const nozzleMat = new THREE.MeshStandardMaterial({ color: 0x0d1512, roughness: 0.5, metalness: 0.4 })
  for (const x of [-1.5, -0.75, 0, 0.75, 1.5]) {
    const nozzle = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.26, 8), nozzleMat)
    nozzle.position.set(x, 1.02, -1.5)
    nozzle.rotation.x = Math.PI
    group.add(nozzle)
  }

  // camera mast
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 1.5, 8), panel)
  mast.position.set(0.7, 1.85, 1.2)
  group.add(mast)
  const camBox = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.26, 0.34), shell)
  camBox.position.set(0.7, 2.6, 1.2)
  group.add(camBox)
  const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.08, 12), accent)
  lens.rotation.x = Math.PI / 2
  lens.position.set(0.7, 2.6, 1.4)
  group.add(lens)

  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 10), accent)
  beacon.position.set(-0.6, 1.16, 1.35)
  group.add(beacon)

  const cone = new THREE.Mesh(
    new THREE.ConeGeometry(1.9, 3.4, 18, 1, true),
    new THREE.MeshBasicMaterial({
      color: 0xd7f79a,
      transparent: true,
      opacity: 0.06,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  )
  cone.position.set(0, -0.9, -1.5)
  cone.rotation.x = Math.PI
  group.add(cone)

  // cab, glass, fenders, lidar and lights: the difference between a box and a machine
  const cab = new THREE.Mesh(new THREE.BoxGeometry(1.18, 0.78, 0.92), shell)
  cab.position.set(0, 1.6, 0.55)
  cab.castShadow = true
  group.add(cab)

  const glass = new THREE.Mesh(
    new THREE.BoxGeometry(1.02, 0.42, 0.06),
    new THREE.MeshStandardMaterial({ color: 0x14221c, roughness: 0.15, metalness: 0.6, transparent: true, opacity: 0.85 }),
  )
  glass.position.set(0, 1.72, 1.02)
  group.add(glass)

  const roof = new THREE.Mesh(new THREE.BoxGeometry(1.26, 0.09, 1.0), panel)
  roof.position.set(0, 2.04, 0.55)
  group.add(roof)

  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const fender = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.1, 1.16), panel)
    fender.position.set(sx * 0.95, 0.99, sz * 0.95)
    group.add(fender)
  }

  const lidar = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.15, 18), accent)
  lidar.position.set(-0.55, 2.86, 1.2)
  group.add(lidar)
  group.userData.lidar = lidar

  const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.95, 6), panel)
  antenna.position.set(-0.62, 2.55, 0.92)
  group.add(antenna)

  const lightBar = new THREE.Mesh(
    new THREE.BoxGeometry(1.12, 0.1, 0.08),
    new THREE.MeshStandardMaterial({ color: 0xfff2c8, emissive: 0xffe9a8, emissiveIntensity: 1.1, roughness: 0.4 }),
  )
  lightBar.position.set(0, 1.26, 1.46)
  group.add(lightBar)

  const hitch = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.12, 0.55), panel)
  hitch.position.set(0, 0.6, 1.66)
  group.add(hitch)

  group.scale.setScalar(1.78)
  group.userData.wheels = wheels
  group.userData.cone = cone
  group.userData.beacon = beacon
  return group
}

/** Pole-mounted depth camera with a visible field of view. */
function makeFieldCamera(position, lookAt) {
  const group = new THREE.Group()
  const metal = new THREE.MeshStandardMaterial({ color: 0x1f2b24, roughness: 0.5, metalness: 0.5 })
  const lensMat = new THREE.MeshStandardMaterial({ color: 0x0a120e, roughness: 0.2, metalness: 0.8, emissive: 0x9fe0ff, emissiveIntensity: 0.6 })

  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.2, 8, 10), metal)
  pole.position.y = 4
  pole.castShadow = true
  group.add(pole)

  const head = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.5, 0.62), metal)
  head.position.y = 8.1
  group.add(head)

  const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.1, 14), lensMat)
  lens.rotation.x = Math.PI / 2
  lens.position.set(0, 8.1, 0.36)
  group.add(lens)

  // field of view: a faint volume plus its wireframe so it reads as a sensor
  const fovGeometry = new THREE.ConeGeometry(9, 26, 22, 1, true)
  fovGeometry.translate(0, 13, 0)
  fovGeometry.rotateX(Math.PI / 2)
  const fov = new THREE.Mesh(
    fovGeometry,
    new THREE.MeshBasicMaterial({
      color: 0x9fe0ff,
      transparent: true,
      opacity: 0.03,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  )
  fov.position.set(0, 8.1, 0)
  fov.lookAt(lookAt.x, 2, lookAt.z)
  group.add(fov)

  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(fovGeometry, 24),
    new THREE.LineBasicMaterial({ color: 0x9fe0ff, transparent: true, opacity: 0.22, depthWrite: false }),
  )
  edges.position.set(0, 8.1, 0)
  edges.lookAt(lookAt.x, 2, lookAt.z)
  group.add(edges)

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(1.5, 1.66, 40),
    new THREE.MeshBasicMaterial({ color: 0x9fe0ff, transparent: true, opacity: 0.4, side: THREE.DoubleSide }),
  )
  ring.rotation.x = -Math.PI / 2
  ring.position.y = 0.08
  group.add(ring)
  group.userData.ring = ring

  group.position.copy(position)
  return group
}

function makeSpray(count, spread, fall, size) {
  const positions = new Float32Array(count * 3)
  for (let i = 0; i < count; i += 1) {
    positions[i * 3] = (Math.random() - 0.5) * spread
    positions[i * 3 + 1] = -Math.random() * fall
    positions[i * 3 + 2] = (Math.random() - 0.5) * spread * 0.8
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  const material = new THREE.PointsMaterial({
    color: 0xd7f79a,
    size,
    transparent: true,
    opacity: 0.75,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  })
  const points = new THREE.Points(geometry, material)
  points.frustumCulled = false
  return points
}

/** A wheat stalk drawn once and instanced a few thousand times. */
function makeWheatTexture() {
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, size, size)

  for (let i = 0; i < 22; i += 1) {
    const x = 8 + Math.random() * 240
    const base = 252
    const height = 120 + Math.random() * 118
    const sway = (Math.random() - 0.5) * 22

    ctx.strokeStyle = 'rgba(255, 246, 214, 1)'
    ctx.lineWidth = 4 + Math.random() * 2.6
    ctx.beginPath()
    ctx.moveTo(x, base)
    ctx.quadraticCurveTo(x + sway * 0.4, base - height * 0.62, x + sway, base - height)
    ctx.stroke()

    ctx.fillStyle = 'rgba(255, 238, 186, 0.98)'
    ctx.save()
    ctx.translate(x + sway, base - height - 5)
    ctx.rotate(Math.atan2(sway, height))
    ctx.beginPath()
    ctx.ellipse(0, 0, 4.6, 13, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()

    ctx.strokeStyle = 'rgba(255, 238, 186, 0.7)'
    ctx.lineWidth = 2
    for (let awn = -2; awn <= 2; awn += 1) {
      ctx.beginPath()
      ctx.moveTo(x + sway, base - height - 8)
      ctx.lineTo(x + sway + awn * 6, base - height - 30)
      ctx.stroke()
    }
  }

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  return texture
}

/** Tilled soil: dark earth, furrows and grit. */
function makeSoilTexture() {
  const size = 512
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#3a2d20'
  ctx.fillRect(0, 0, size, size)
  for (let i = 0; i < 9000; i += 1) {
    const tone = Math.random() * 90
    ctx.fillStyle = `rgba(${120 + tone},${96 + tone * 0.82},${66 + tone * 0.6},0.30)`
    ctx.fillRect(Math.random() * size, Math.random() * size, 2, 2)
  }
  ctx.strokeStyle = 'rgba(24, 18, 12, 0.55)'
  ctx.lineWidth = 3
  for (let y = 8; y < size; y += 18) {
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(size, y)
    ctx.stroke()
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.repeat.set(4, 3)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  return texture
}

/** Standing wheat, drilled in rows, coloured by the same health field. */
function makeCropField() {
  const group = new THREE.Group()

  const rows = 54
  const perRow = 104
  const geometry = new THREE.PlaneGeometry(0.95, 1.5)
  geometry.translate(0, 0.75, 0)
  const material = new THREE.MeshStandardMaterial({
    map: makeWheatTexture(),
    alphaTest: 0.12,
    side: THREE.DoubleSide,
    roughness: 0.92,
    metalness: 0,
    color: 0xffffff,
  })
  const mesh = new THREE.InstancedMesh(geometry, material, rows * perRow)
  mesh.receiveShadow = true

  const wheat = new THREE.Color('#efd18a')
  const matrix = new THREE.Matrix4()
  const quat = new THREE.Quaternion()
  const axis = new THREE.Vector3(0, 1, 0)
  const scale = new THREE.Vector3()
  const position = new THREE.Vector3()
  const color = new THREE.Color()
  const rowGap = FIELD.d / rows
  const colGap = FIELD.w / perRow
  let index = 0

  for (let row = 0; row < rows; row += 1) {
    const z = -FIELD.d / 2 + (row + 0.5) * rowGap
    const tramline = row % 9 === 0
    for (let col = 0; col < perRow; col += 1) {
      const x = -FIELD.w / 2 + (col + 0.5) * colGap
      const health = healthAt(x, z)
      position.set(x + (Math.random() - 0.5) * 0.2, 0, z + (Math.random() - 0.5) * 0.16)
      quat.setFromAxisAngle(axis, Math.random() * Math.PI)
      scale.set(0.95 + Math.random() * 0.35, (tramline ? 0.4 : 0.78) + health * 0.85 + Math.random() * 0.18, 1)
      matrix.compose(position, quat, scale)
      mesh.setMatrixAt(index, matrix)
      color.copy(healthColor(health)).lerp(wheat, 0.68).multiplyScalar(1.35)
      mesh.setColorAt(index, color)
      index += 1
    }
  }
  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  group.add(mesh)

  const border = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-FIELD.w / 2, 0.12, -FIELD.d / 2),
      new THREE.Vector3(FIELD.w / 2, 0.12, -FIELD.d / 2),
      new THREE.Vector3(FIELD.w / 2, 0.12, FIELD.d / 2),
      new THREE.Vector3(-FIELD.w / 2, 0.12, FIELD.d / 2),
    ]),
    new THREE.LineBasicMaterial({ color: 0x86c65a, transparent: true, opacity: 0.55 }),
  )
  group.add(border)

  return group
}

function makeField() {
  const group = new THREE.Group()
  const cols = FIELD.cols
  const rows = FIELD.rows
  const cellW = FIELD.w / cols
  const cellD = FIELD.d / rows
  const geometry = new THREE.BoxGeometry(cellW * 0.94, 1, cellD * 0.94)
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.86, metalness: 0.05 })
  const mesh = new THREE.InstancedMesh(geometry, material, cols * rows)
  mesh.castShadow = true
  mesh.receiveShadow = true

  const matrix = new THREE.Matrix4()
  const color = new THREE.Color()
  let index = 0
  for (let cx = 0; cx < cols; cx += 1) {
    for (let cz = 0; cz < rows; cz += 1) {
      const x = -FIELD.w / 2 + (cx + 0.5) * cellW
      const z = -FIELD.d / 2 + (cz + 0.5) * cellD
      const health = healthAt(x, z)
      const height = 0.24 + health * 0.95
      matrix.makeScale(1, height, 1)
      matrix.setPosition(x, height / 2, z)
      mesh.setMatrixAt(index, matrix)
      color.copy(healthColor(health)).multiplyScalar(1.18)
      mesh.setColorAt(index, color)
      index += 1
    }
  }
  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  group.add(mesh)

  const border = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-FIELD.w / 2, 0.12, -FIELD.d / 2),
      new THREE.Vector3(FIELD.w / 2, 0.12, -FIELD.d / 2),
      new THREE.Vector3(FIELD.w / 2, 0.12, FIELD.d / 2),
      new THREE.Vector3(-FIELD.w / 2, 0.12, FIELD.d / 2),
    ]),
    new THREE.LineBasicMaterial({ color: 0x86c65a, transparent: true, opacity: 0.55 }),
  )
  group.add(border)

  return group
}

function dashedLink(color, opacity = 0.5) {
  const geometry = new THREE.BufferGeometry()
  const material = new THREE.LineDashedMaterial({
    color,
    dashSize: 1.4,
    gapSize: 1.3,
    transparent: true,
    opacity,
    depthWrite: false,
  })
  const line = new THREE.Line(geometry, material)
  line.frustumCulled = false
  return line
}

export default function DroneScene({ focus = { kind: 'drone', index: 0 }, spraying = true, mode = 'drone', speed = 1, onFocus }) {
  const hostRef = useRef(null)
  const live = useRef({ focus, spraying, mode, speed, onFocus })
  live.current = { focus, spraying, mode, speed, onFocus }

  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined

    let renderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' })
    } catch {
      host.dataset.webgl = 'failed'
      return undefined
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.42
    if ('outputColorSpace' in renderer) renderer.outputColorSpace = THREE.SRGBColorSpace
    host.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x081711)
    scene.fog = new THREE.FogExp2(0x081711, 0.006)

    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 600)
    const pipCamera = new THREE.PerspectiveCamera(62, PIP.w / PIP.h, 0.2, 400)

    scene.add(new THREE.HemisphereLight(0xd8f7ac, 0x0a1c14, 1.4))
    const sun = new THREE.DirectionalLight(0xfff3d6, 3.0)
    sun.position.set(38, 62, 26)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    sun.shadow.camera.left = -70
    sun.shadow.camera.right = 70
    sun.shadow.camera.top = 60
    sun.shadow.camera.bottom = -60
    sun.shadow.camera.far = 200
    sun.shadow.bias = -0.0008
    scene.add(sun)

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(280, 200),
      new THREE.MeshStandardMaterial({ color: 0x0a1a12, roughness: 1, metalness: 0 }),
    )
    ground.rotation.x = -Math.PI / 2
    ground.position.y = -0.02
    ground.receiveShadow = true
    scene.add(ground)

    const plinth = new THREE.Mesh(
      new THREE.BoxGeometry(FIELD.w + 5, 2.4, FIELD.d + 5),
      new THREE.MeshStandardMaterial({ color: 0x0c1c14, roughness: 0.85, metalness: 0.1 }),
    )
    plinth.position.y = -1.25
    plinth.receiveShadow = true
    scene.add(plinth)

    scene.add(makeField())
    scene.add(makeCropField())

    // ── AWS ingest node, floating above the baseline ────────────────────────
    const hub = new THREE.Group()
    hub.position.set(0, 27, 0)
    const hubShell = new THREE.Mesh(
      new THREE.OctahedronGeometry(4.3, 0),
      new THREE.MeshBasicMaterial({ color: 0xc8f24e, wireframe: true, transparent: true, opacity: 0.75 }),
    )
    hub.add(hubShell)
    const hubCore = new THREE.Mesh(
      new THREE.IcosahedronGeometry(2.1, 1),
      new THREE.MeshStandardMaterial({ color: 0xa9e02a, emissive: 0xb8ec3c, emissiveIntensity: 1.1, roughness: 0.35 }),
    )
    hub.add(hubCore)
    const hubRing = new THREE.Mesh(
      new THREE.TorusGeometry(7.2, 0.06, 8, 60),
      new THREE.MeshBasicMaterial({ color: 0xc8f24e, transparent: true, opacity: 0.4 }),
    )
    hubRing.rotation.x = Math.PI / 2.3
    hub.add(hubRing)
    hub.add(new THREE.PointLight(0xc8f24e, 140, 80, 2))
    scene.add(hub)

    // ── field cameras ───────────────────────────────────────────────────────
    const cameraSpots = [
      [new THREE.Vector3(-FIELD.w / 2 - 5, 0, -FIELD.d / 2 - 4), new THREE.Vector3(-6, 2, -6)],
      [new THREE.Vector3(FIELD.w / 2 + 5, 0, -FIELD.d / 2 - 4), new THREE.Vector3(6, 2, -6)],
      [new THREE.Vector3(FIELD.w / 2 + 6, 0, FIELD.d / 2 + 5), new THREE.Vector3(4, 2, 4)],
      [new THREE.Vector3(-FIELD.w / 2 - 6, 0, FIELD.d / 2 + 5), new THREE.Vector3(-4, 2, 4)],
    ]
    const cameras = cameraSpots.map(([position, look], index) => {
      const group = makeFieldCamera(position, look)
      group.userData.focus = { kind: 'camera', index }
      scene.add(group)
      return group
    })

    // ── drones ──────────────────────────────────────────────────────────────
    const droneTints = [0xc8f24e, 0x7fe3b0, 0xf2d24e]
    const drones = droneTints.map((tint, index) => {
      const group = makeDrone(tint, index === 0 ? 1.95 : 1.8)
      group.userData.focus = { kind: 'drone', index }
      scene.add(group)
      const spray = makeSpray(300, 4.4, 7, 0.13)
      scene.add(spray)
      return { group, spray }
    })

    // ── ground robots heading for the drifted zones ──────────────────────────
    const robotTints = [0xffd166, 0x8ee6c8, 0xc8f24e]
    const robots = robotTints.map((tint, index) => {
      const group = makeRobot(tint)
      group.userData.focus = { kind: 'robot', index }
      const start = PATCHES[DRIFT[index] % PATCHES.length]
      group.position.set(-FIELD.w / 2 + 10 + index * 6, 0, FIELD.d / 2 - 12)
      group.rotation.y = Math.PI
      scene.add(group)
      const spray = makeSpray(120, 2.6, 1.6, 0.1)
      scene.add(spray)
      return { group, spray, target: 0, phase: 'drive', timer: 0, from: null }
    })

    // eroded zones handed to the robots: rings + vertical beacons
    const driftMarks = DRIFT.map((patchIndex) => {
      const patch = PATCHES[patchIndex]
      const group = new THREE.Group()
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(patch.r * 0.86, patch.r * 0.98, 56),
        new THREE.MeshBasicMaterial({
          color: 0xffb347,
          transparent: true,
          opacity: 0.72,
          side: THREE.DoubleSide,
          depthTest: false,
        }),
      )
      ring.rotation.x = -Math.PI / 2
      ring.position.y = 0.6
      ring.renderOrder = 3
      group.add(ring)
      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(0.08, 0.08, 16, 6),
        new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.18 }),
      )
      beam.position.y = 8
      group.add(beam)
      group.position.set(patch.x, 0, patch.z)
      scene.add(group)
      return { group, ring, patch }
    })

    // ── data links: cameras and drones up to AWS, AWS back down to robots ────
    const upLinks = cameras.map(() => {
      const line = dashedLink(0x9fe0ff, 0.5)
      scene.add(line)
      return line
    })
    const droneLinks = drones.map(() => {
      const line = dashedLink(0x9fe0ff, 0.4)
      scene.add(line)
      return line
    })
    const downLinks = robots.map(() => {
      const line = dashedLink(0xc8f24e, 0.75)
      scene.add(line)
      return line
    })

    const halo = new THREE.Mesh(
      new THREE.RingGeometry(2.4, 2.62, 44),
      new THREE.MeshBasicMaterial({ color: 0xc8f24e, transparent: true, opacity: 0.75, side: THREE.DoubleSide }),
    )
    halo.rotation.x = -Math.PI / 2
    scene.add(halo)

    const orbit = { theta: -0.58, phi: 0.86, radius: 132 }
    const target = new THREE.Vector3(0, 1, 0)
    const pointer = { dragging: false, x: 0, y: 0, moved: 0 }

    function placeCamera() {
      const { theta, phi, radius } = orbit
      camera.position.set(
        target.x + radius * Math.sin(phi) * Math.sin(theta),
        target.y + radius * Math.cos(phi),
        target.z + radius * Math.sin(phi) * Math.cos(theta),
      )
      camera.lookAt(target)
    }
    placeCamera()

    const raycaster = new THREE.Raycaster()
    const pointerNdc = new THREE.Vector2()

    function onPointerDown(event) {
      pointer.dragging = true
      pointer.moved = 0
      pointer.x = event.clientX
      pointer.y = event.clientY
      host.setPointerCapture?.(event.pointerId)
    }

    function onPointerMove(event) {
      if (!pointer.dragging) return
      const dx = event.clientX - pointer.x
      const dy = event.clientY - pointer.y
      pointer.x = event.clientX
      pointer.y = event.clientY
      pointer.moved += Math.abs(dx) + Math.abs(dy)
      orbit.theta -= dx * 0.005
      orbit.phi = Math.min(1.42, Math.max(0.32, orbit.phi - dy * 0.004))
      placeCamera()
    }

    function onPointerUp(event) {
      if (!pointer.dragging) return
      pointer.dragging = false
      host.releasePointerCapture?.(event.pointerId)
      if (pointer.moved > 6) return
      const rect = host.getBoundingClientRect()
      pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
      pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(pointerNdc, camera)
      const roots = drones.map((drone) => drone.group).concat(robots.map((robot) => robot.group)).concat(cameras)
      const hit = raycaster.intersectObjects(roots, true)[0]
      if (!hit) return
      let node = hit.object
      while (node && !node.userData.focus) node = node.parent
      if (node?.userData.focus) live.current.onFocus?.(node.userData.focus)
    }

    function onWheel(event) {
      event.preventDefault()
      orbit.radius = Math.min(150, Math.max(34, orbit.radius + event.deltaY * 0.05))
      placeCamera()
    }

    renderer.domElement.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    renderer.domElement.addEventListener('wheel', onWheel, { passive: false })

    let width = 1
    let height = 1
    const resize = () => {
      const rect = host.getBoundingClientRect()
      width = Math.max(1, rect.width)
      height = Math.max(1, rect.height)
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
      renderer.domElement.style.width = '100%'
      renderer.domElement.style.height = '100%'
    }
    const observer = new ResizeObserver(resize)
    observer.observe(host)
    resize()

    const clock = new THREE.Clock()
    let elapsed = 0
    let raf = 0
    let visible = true
    const onVisibility = () => {
      visible = !document.hidden
    }
    document.addEventListener('visibilitychange', onVisibility)

    const curvePoint = new THREE.Vector3()
    const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3())
    const robotTarget = new THREE.Vector3()

    function setLink(line, from, to, lift = 14) {
      curve.v0.copy(from)
      curve.v2.copy(to)
      curve.v1.set((from.x + to.x) / 2, Math.max(from.y, to.y) + lift, (from.z + to.z) / 2)
      const points = curve.getPoints(26)
      line.geometry.setFromPoints(points)
      line.computeLineDistances()
    }

    function frame() {
      raf = requestAnimationFrame(frame)
      if (!visible) return
      const delta = Math.min(0.05, clock.getDelta())
      elapsed += delta * live.current.speed

      hub.rotation.y += delta * 0.25
      hubRing.rotation.z += delta * 0.4
      hubCore.scale.setScalar(1 + Math.sin(elapsed * 1.8) * 0.05)

      drones.forEach((drone, index) => {
        const point = flightPoint(elapsed, index)
        const ahead = flightPoint(elapsed + 0.35, index)
        const bob = Math.sin(elapsed * 1.7 + index * 1.9) * 0.18
        const altitude = 7.2 + index * 1.15 + bob
        drone.group.position.set(point.x, altitude, point.z)
        drone.group.rotation.y = Math.atan2(ahead.x - point.x, ahead.z - point.z)
        drone.group.rotation.z = Math.sin(elapsed * 1.2 + index) * 0.03

        drone.group.userData.rotors.forEach((rotor) => {
          rotor.rotation.y += delta * 46
        })

        const sprayOn = live.current.spraying
        drone.spray.visible = sprayOn
        drone.group.userData.cone.visible = sprayOn
        drone.spray.position.set(point.x, altitude - 0.7, point.z)
        drone.spray.rotation.y = drone.group.rotation.y
        if (sprayOn) {
          const attr = drone.spray.geometry.getAttribute('position')
          const array = attr.array
          for (let i = 0; i < array.length; i += 3) {
            array[i + 1] -= delta * 7.5
            if (array[i + 1] < -Math.max(1, altitude - 0.4)) {
              array[i] = (Math.random() - 0.5) * 4.6
              array[i + 1] = -0.4
              array[i + 2] = (Math.random() - 0.5) * 3.6
            }
          }
          attr.needsUpdate = true
        }

        setLink(droneLinks[index], drone.group.position, hub.position, 6)
      })

      // ── robots: drive to the drifted zone, treat it, move on ───────────────
      robots.forEach((robot, index) => {
        const targetPatch = PATCHES[DRIFT[(robot.target + index) % DRIFT.length] % PATCHES.length]
        robotTarget.set(targetPatch.x, 0, targetPatch.z)
        const dx = robotTarget.x - robot.group.position.x
        const dz = robotTarget.z - robot.group.position.z
        const distance = Math.hypot(dx, dz)

        if (robot.phase === 'drive') {
          const step = Math.min(distance, delta * 6.2)
          if (distance > 0.001) {
            robot.group.position.x += (dx / distance) * step
            robot.group.position.z += (dz / distance) * step
          }
          robot.group.rotation.y = Math.atan2(dx, dz)
          if (distance < 1.6) {
            robot.phase = 'treat'
            robot.timer = 0
          }
        } else {
          robot.timer += delta
          if (robot.timer > 7) {
            robot.phase = 'drive'
            robot.target += 1
          }
        }

        robot.group.userData.wheels.forEach((wheel) => {
          wheel.rotation.x += delta * (robot.phase === 'drive' ? 6 : 0)
        })
        if (robot.group.userData.lidar) robot.group.userData.lidar.rotation.y += delta * 5.5

        const treating = robot.phase === 'treat'
        robot.spray.visible = treating
        robot.group.userData.cone.visible = treating
        robot.spray.position.set(robot.group.position.x, 1.05, robot.group.position.z)
        robot.spray.rotation.y = robot.group.rotation.y
        robot.group.userData.beacon.material.emissiveIntensity = treating ? 1.4 + Math.sin(elapsed * 8) * 0.6 : 0.5
        if (treating) {
          const attr = robot.spray.geometry.getAttribute('position')
          const array = attr.array
          for (let i = 0; i < array.length; i += 3) {
            array[i + 1] -= delta * 3.4
            if (array[i + 1] < -0.75) {
              array[i] = (Math.random() - 0.5) * 2.8
              array[i + 1] = -0.2
              array[i + 2] = (Math.random() - 0.5) * 2.2
            }
          }
          attr.needsUpdate = true
        }

        setLink(downLinks[index], hub.position, robot.group.position, 10)
      })

      cameras.forEach((cam, index) => {
        cam.userData.ring.scale.setScalar(1 + Math.sin(elapsed * 2 + index) * 0.08)
        cam.userData.ring.material.opacity = 0.28 + Math.sin(elapsed * 2.2 + index) * 0.12
        const top = new THREE.Vector3(cam.position.x, 8.1, cam.position.z)
        setLink(upLinks[index], top, hub.position, 8)
      })

      driftMarks.forEach((mark, index) => {
        mark.ring.material.opacity = 0.35 + Math.sin(elapsed * 2.4 + index) * 0.18
        mark.ring.scale.setScalar(1 + Math.sin(elapsed * 1.6 + index) * 0.04)
      })

      upLinks.concat(droneLinks, downLinks).forEach((line) => {
        line.material.dashOffset = -elapsed * 0.6
      })

      const focused = live.current.focus || { kind: 'drone', index: 0 }
      const focusGroup =
        focused.kind === 'robot'
          ? robots[focused.index]?.group
          : focused.kind === 'camera'
            ? cameras[focused.index]
            : drones[focused.index]?.group
      if (focusGroup) {
        halo.position.set(focusGroup.position.x, 0.22, focusGroup.position.z)
        halo.rotation.z += delta * 0.6
        halo.scale.setScalar(1 + Math.sin(elapsed * 2.2) * 0.06)
      }
      halo.visible = Boolean(focusGroup)

      renderer.setScissorTest(false)
      renderer.setViewport(0, 0, width, height)
      renderer.render(scene, camera)

      if (live.current.mode === 'drone' && focusGroup) {
        if (focused.kind === 'drone') {
          const heading = focusGroup.rotation.y
          pipCamera.position.set(
            focusGroup.position.x + Math.sin(heading) * 3.4,
            focusGroup.position.y - 0.9,
            focusGroup.position.z + Math.cos(heading) * 3.4,
          )
          pipCamera.lookAt(
            focusGroup.position.x + Math.sin(heading) * 26,
            -2.9,
            focusGroup.position.z + Math.cos(heading) * 26,
          )
        } else if (focused.kind === 'robot') {
          const heading = focusGroup.rotation.y
          pipCamera.position.set(
            focusGroup.position.x + Math.sin(heading) * 2.4,
            3.1,
            focusGroup.position.z + Math.cos(heading) * 2.4,
          )
          pipCamera.lookAt(
            focusGroup.position.x + Math.sin(heading) * 16,
            1.1,
            focusGroup.position.z + Math.cos(heading) * 16,
          )
        } else {
          const look = cameraSpots[focused.index]?.[1] || new THREE.Vector3()
          pipCamera.position.set(focusGroup.position.x, 8.1, focusGroup.position.z)
          pipCamera.lookAt(look.x, 2.5, look.z)
        }

        const x = Math.max(0, width - PIP.w - PIP.m)
        renderer.setViewport(x, PIP.m, PIP.w, PIP.h)
        renderer.setScissor(x, PIP.m, PIP.w, PIP.h)
        renderer.setScissorTest(true)
        renderer.render(scene, pipCamera)
        renderer.setScissorTest(false)
      }
    }

    frame()

    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      renderer.domElement.removeEventListener('pointerdown', onPointerDown)
      renderer.domElement.removeEventListener('wheel', onWheel)
      scene.traverse((object) => {
        if (object.geometry) object.geometry.dispose()
        if (object.material) {
          const materials = Array.isArray(object.material) ? object.material : [object.material]
          materials.forEach((material) => material.dispose())
        }
      })
      renderer.dispose()
      if (renderer.domElement.parentNode === host) host.removeChild(renderer.domElement)
    }
  }, [])

  return <div ref={hostRef} className="flight-canvas" role="img" aria-label="Three-dimensional view of the field with survey drones, ground robots and depth cameras" />
}
