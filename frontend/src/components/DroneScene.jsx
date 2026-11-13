/**
 * Drone operations — a real-time 3D view of the spray mission.
 *
 * Everything is drawn with three.js from primitives: the field relief is one
 * InstancedMesh whose tiles are coloured by a deterministic health field (so
 * the weak patches on screen match the ones the dashboard reports), the three
 * quadcopters are built from boxes/cylinders/tori, and the spray is a particle
 * system tied to the aircraft nozzles.
 *
 * Interactions
 *   drag        orbit the field
 *   wheel       zoom
 *   click       select a drone or the field camera
 *   pip         a second camera renders the selected drone's point of view
 */
import { useEffect, useRef } from 'react'
import * as THREE from 'three'

const FIELD = { w: 96, d: 64, cols: 34, rows: 22 }

/** Picture-in-picture feed, in CSS pixels (bottom-right of the stage). */
export const PIP = { w: 252, h: 152, m: 18 }

// Eleven weak zones — the same count the crop page reports for this field.
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
  const blend = t - index
  return RAMP[index].clone().lerp(RAMP[Math.min(index + 1, RAMP.length - 1)], blend)
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
  return { x, z, forward }
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

  const arms = [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ]
  const rotors = []
  for (const [sx, sz] of arms) {
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

  // spray tank + boom
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

function makeSpray() {
  const count = 300
  const positions = new Float32Array(count * 3)
  for (let i = 0; i < count; i += 1) {
    positions[i * 3] = (Math.random() - 0.5) * 4.4
    positions[i * 3 + 1] = -Math.random() * 7
    positions[i * 3 + 2] = (Math.random() - 0.5) * 3.4
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  const material = new THREE.PointsMaterial({
    color: 0xd7f79a,
    size: 0.13,
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
      const height = 0.3 + health * 3.1
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

  // field boundary + survey corners
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

function makeGroundCamera() {
  const group = new THREE.Group()
  const metal = new THREE.MeshStandardMaterial({ color: 0x1b2620, roughness: 0.5, metalness: 0.5 })
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.22, 7, 10), metal)
  pole.position.y = 3.5
  pole.castShadow = true
  group.add(pole)

  const head = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.55, 0.7), metal)
  head.position.set(0.35, 7.1, 0)
  head.castShadow = true
  group.add(head)

  const lens = new THREE.Mesh(
    new THREE.CylinderGeometry(0.16, 0.16, 0.12, 14),
    new THREE.MeshStandardMaterial({ color: 0x0a120e, roughness: 0.2, metalness: 0.8, emissive: 0xc8f24e, emissiveIntensity: 0.5 }),
  )
  lens.rotation.z = Math.PI / 2
  lens.position.set(0.82, 7.1, 0)
  group.add(lens)

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(1.1, 1.24, 40),
    new THREE.MeshBasicMaterial({ color: 0xc8f24e, transparent: true, opacity: 0.5, side: THREE.DoubleSide }),
  )
  ring.rotation.x = -Math.PI / 2
  ring.position.set(0.35, 0.1, 0)
  group.add(ring)
  group.userData.ring = ring

  group.position.set(-FIELD.w / 2 - 5, 0, 6)
  return group
}

export default function DroneScene({ selected = 0, spraying = true, mode = 'drone', speed = 1, onPick }) {
  const hostRef = useRef(null)
  const live = useRef({ selected, spraying, mode, speed, onPick })
  live.current = { selected, spraying, mode, speed, onPick }

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
    renderer.toneMappingExposure = 1.32
    if ('outputColorSpace' in renderer) renderer.outputColorSpace = THREE.SRGBColorSpace
    host.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x081711)
    scene.fog = new THREE.FogExp2(0x081711, 0.006)

    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 600)
    const pipCamera = new THREE.PerspectiveCamera(62, PIP.w / PIP.h, 0.2, 400)

    scene.add(new THREE.HemisphereLight(0xd8f7ac, 0x0a1c14, 1.4))
    const sun = new THREE.DirectionalLight(0xfff3d6, 2.5)
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

    // plinth: the field reads as a survey model on a dark table, not an endless plane
    const plinth = new THREE.Mesh(
      new THREE.BoxGeometry(FIELD.w + 5, 2.4, FIELD.d + 5),
      new THREE.MeshStandardMaterial({ color: 0x0c1c14, roughness: 0.85, metalness: 0.1 }),
    )
    plinth.position.y = -1.25
    plinth.receiveShadow = true
    scene.add(plinth)

    const field = makeField()
    scene.add(field)

    const sensor = makeGroundCamera()
    scene.add(sensor)

    const droneTints = [0xc8f24e, 0x7fe3b0, 0xf2d24e]
    const drones = droneTints.map((tint, index) => {
      const group = makeDrone(tint, index === 0 ? 1.95 : 1.8)
      group.userData.index = index
      scene.add(group)
      const spray = makeSpray()
      scene.add(spray)
      return { group, spray }
    })

    // selection halo under the chosen aircraft
    const halo = new THREE.Mesh(
      new THREE.RingGeometry(2.4, 2.62, 44),
      new THREE.MeshBasicMaterial({ color: 0xc8f24e, transparent: true, opacity: 0.75, side: THREE.DoubleSide }),
    )
    halo.rotation.x = -Math.PI / 2
    scene.add(halo)

    // camera orbit state
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
      const targets = drones.map((drone) => drone.group).concat(sensor)
      const hit = raycaster.intersectObjects(targets, true)[0]
      if (!hit) return
      let node = hit.object
      while (node && node.userData.index === undefined && node !== sensor) node = node.parent
      if (node?.userData.index !== undefined) live.current.onPick?.(node.userData.index)
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

    const tmpColor = new THREE.Color()

    function frame() {
      raf = requestAnimationFrame(frame)
      if (!visible) return
      const delta = Math.min(0.05, clock.getDelta())
      elapsed += delta * live.current.speed

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
      })

      const chosen = drones[live.current.selected] || drones[0]
      halo.position.set(chosen.group.position.x, 0.22, chosen.group.position.z)
      halo.rotation.z += delta * 0.6
      const pulse = 1 + Math.sin(elapsed * 2.2) * 0.06
      halo.scale.setScalar(pulse)

      sensor.userData.ring.rotation.z += delta * 0.5
      sensor.userData.ring.material.opacity = 0.35 + Math.sin(elapsed * 2.4) * 0.18

      renderer.setScissorTest(false)
      renderer.setViewport(0, 0, width, height)
      renderer.render(scene, camera)

      if (live.current.mode === 'drone') {
        const heading = chosen.group.rotation.y
        pipCamera.position.set(
          chosen.group.position.x + Math.sin(heading) * 3.4,
          chosen.group.position.y - 0.9,
          chosen.group.position.z + Math.cos(heading) * 3.4,
        )
        const lookX = chosen.group.position.x + Math.sin(heading) * 26
        const lookZ = chosen.group.position.z + Math.cos(heading) * 26
        pipCamera.lookAt(lookX, -2.9, lookZ)
        const x = Math.max(0, width - PIP.w - PIP.m)
        renderer.setViewport(x, PIP.m, PIP.w, PIP.h)
        renderer.setScissor(x, PIP.m, PIP.w, PIP.h)
        renderer.setScissorTest(true)
        renderer.render(scene, pipCamera)
        renderer.setScissorTest(false)
      }

      tmpColor.setHSL(0.27, 0.7, 0.55)
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

  return <div ref={hostRef} className="flight-canvas" role="img" aria-label="Three-dimensional view of three spray drones working the field" />
}
