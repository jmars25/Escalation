// Pointy-top hex geometry using axial coordinates (q, r).
// Reference: https://www.redblobgames.com/grids/hexagons/

import type { Hex, HexKey } from './types'

export const HEX_SIZE = 34 // pixel radius (center to corner)

export function key(h: Hex): HexKey {
  return `${h.q},${h.r}`
}

export function fromKey(k: HexKey): Hex {
  const [q, r] = k.split(',').map(Number)
  return { q, r }
}

export function hexEquals(a: Hex, b: Hex): boolean {
  return a.q === b.q && a.r === b.r
}

/** The six axial neighbor directions. */
const DIRECTIONS: Hex[] = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
]

export function neighbors(h: Hex): Hex[] {
  return DIRECTIONS.map((d) => ({ q: h.q + d.q, r: h.r + d.r }))
}

/** Hex distance in axial coords. */
export function distance(a: Hex, b: Hex): number {
  return (
    (Math.abs(a.q - b.q) +
      Math.abs(a.q + a.r - b.q - b.r) +
      Math.abs(a.r - b.r)) /
    2
  )
}

/** Center pixel position for a hex (before any board offset). */
export function hexToPixel(h: Hex): { x: number; y: number } {
  const x = HEX_SIZE * Math.sqrt(3) * (h.q + h.r / 2)
  const y = HEX_SIZE * (3 / 2) * h.r
  return { x, y }
}

/** Pixel position of corner k (0..5) of a hex centered at (cx, cy). */
export function hexCorner(cx: number, cy: number, k: number): { x: number; y: number } {
  const angle = (Math.PI / 180) * (60 * k - 30)
  return { x: cx + HEX_SIZE * Math.cos(angle), y: cy + HEX_SIZE * Math.sin(angle) }
}

/** SVG points string for a pointy-top hex centered at (cx, cy). */
export function hexCorners(cx: number, cy: number): string {
  const pts: string[] = []
  for (let k = 0; k < 6; k++) {
    const c = hexCorner(cx, cy, k)
    pts.push(`${c.x},${c.y}`)
  }
  return pts.join(' ')
}

/**
 * Neighbor direction across edge e (the edge between corner e and corner e+1).
 * Lets us tell which neighbor sits across each of a hex's six edges, so we can
 * draw a border segment only where territory ownership changes.
 */
export const EDGE_DIRS: Hex[] = [
  { q: 1, r: 0 },   // E   (corners 0–1)
  { q: 0, r: 1 },   // SE  (corners 1–2)
  { q: -1, r: 1 },  // SW  (corners 2–3)
  { q: -1, r: 0 },  // W   (corners 3–4)
  { q: 0, r: -1 },  // NW  (corners 4–5)
  { q: 1, r: -1 },  // NE  (corners 5–0)
]

/** Generate a roughly hexagonal map of the given radius (in hexes). */
export function generateHexMap(radius: number): Hex[] {
  const hexes: Hex[] = []
  for (let q = -radius; q <= radius; q++) {
    const r1 = Math.max(-radius, -q - radius)
    const r2 = Math.min(radius, -q + radius)
    for (let r = r1; r <= r2; r++) {
      hexes.push({ q, r })
    }
  }
  return hexes
}
