import { useEffect, useMemo, useState } from 'react'
import { useGameStore } from '../store/useGameStore'
import {
  EDGE_DIRS, HEX_SIZE, hexCorner, hexCorners, hexEquals, hexToPixel, key,
} from '../game/hexUtils'
import { sfx } from '../audio/sfx'
import type { Force, Installation, Tile } from '../game/types'

const INSTALL_GLYPH: Record<Installation['type'], string> = {
  city: '◉', army_base: '▥', air_base: '✈', naval_base: '⚓', radar: '◎',
}
const FORCE_GLYPH: Record<Force['type'], string> = {
  army_group: '▲', marine: '⛊', naval_group: '⛴', missile_battery: '✸',
}

const TERRAIN_FILL: Record<Tile['terrain'], string> = {
  plains: '#3d4a36', mountain: '#54504a', sea: 'url(#water)', island: 'url(#water)',
}

export function HexMap() {
  const game = useGameStore((s) => s.game)
  const selectedForceId = useGameStore((s) => s.selectedForceId)
  const moveTargets = useGameStore((s) => s.moveTargets)
  const strikeTgts = useGameStore((s) => s.strikeTargets)
  const clickHex = useGameStore((s) => s.clickHex)
  const setInspect = useGameStore((s) => s.setInspect)
  const lastStrike = useGameStore((s) => s.lastStrike)
  const lastAttack = useGameStore((s) => s.lastAttack)
  const selectedInstallId = useGameStore((s) => s.selectedInstallId)
  const selectInstall = useGameStore((s) => s.selectInstall)
  const currentId = game.order[game.turnIndex]
  const [trottingForceId, setTrottingForceId] = useState<string | null>(null)
  const trottingForce = trottingForceId ? game.forces.find((f) => f.id === trottingForceId) : undefined

  const { offset, width, height, tiles } = useMemo(() => {
    const tiles = Object.values(game.tiles)
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const t of tiles) {
      const { x, y } = hexToPixel(t.hex)
      minX = Math.min(minX, x); maxX = Math.max(maxX, x)
      minY = Math.min(minY, y); maxY = Math.max(maxY, y)
    }
    const pad = HEX_SIZE * 1.6
    return {
      tiles,
      offset: { x: -minX + pad, y: -minY + pad },
      width: maxX - minX + pad * 2,
      height: maxY - minY + pad * 2,
    }
  }, [game.tiles])

  const center = (t: { hex: Tile['hex'] }) => {
    const p = hexToPixel(t.hex)
    return { cx: p.x + offset.x, cy: p.y + offset.y }
  }
  const isMoveTarget = (t: Tile) => moveTargets.some((h) => hexEquals(h, t.hex))

  const borders = useMemo(() => {
    const segs: { x1: number; y1: number; x2: number; y2: number; color: string }[] = []
    const inset = 0.08
    for (const t of tiles) {
      if (!t.owner) continue
      const { cx, cy } = center(t)
      const color = game.factions[t.owner].color
      for (let e = 0; e < 6; e++) {
        const d = EDGE_DIRS[e]
        const nb = game.tiles[key({ q: t.hex.q + d.q, r: t.hex.r + d.r })]
        if (nb && nb.owner === t.owner) continue
        const a = hexCorner(cx, cy, e)
        const b = hexCorner(cx, cy, (e + 1) % 6)
        segs.push({
          x1: a.x + (cx - a.x) * inset, y1: a.y + (cy - a.y) * inset,
          x2: b.x + (cx - b.x) * inset, y2: b.y + (cy - b.y) * inset, color,
        })
      }
    }
    return segs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tiles, game.factions, game.tiles, offset])

  // Forces grouped by hex (unlimited stacking).
  const forcesByHex = useMemo(() => {
    const m = new Map<string, Force[]>()
    for (const f of game.forces) {
      const k = key(f.hex)
      ;(m.get(k) ?? m.set(k, []).get(k)!).push(f)
    }
    return m
  }, [game.forces])

  // Tiles that carry a base, so forces there drop to the lower part of the hex.
  const installHexes = useMemo(
    () => new Set(game.installations.map((i) => key(i.hex))),
    [game.installations],
  )

  return (
    <svg className="hexmap" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet">
      <defs>
        <pattern id="water" width="22" height="16" patternUnits="userSpaceOnUse">
          <rect width="22" height="16" fill="#15405f" />
          <path d="M0 6 q 5.5 -4 11 0 t 11 0" stroke="#2f7bb0" strokeWidth="1.3" fill="none" opacity="0.55" />
          <path d="M0 13 q 5.5 -4 11 0 t 11 0" stroke="#22618f" strokeWidth="1.1" fill="none" opacity="0.45" />
        </pattern>
        <filter id="glow" x="-150%" y="-150%" width="400%" height="400%">
          <feGaussianBlur stdDeviation="2.6" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>

      {/* Terrain + ownership tint + contested hatch */}
      {tiles.map((t) => {
        const { cx, cy } = center(t)
        const pts = hexCorners(cx, cy)
        return (
          <g key={key(t.hex)} onClick={() => clickHex(t.hex)} onMouseEnter={() => setInspect(t.hex)} className="tile-g">
            <polygon points={pts} fill={TERRAIN_FILL[t.terrain]} stroke="rgba(255,255,255,0.05)" strokeWidth={0.6} className="tile" />
            {t.terrain === 'island' && <ellipse cx={cx} cy={cy} rx={9} ry={6} fill="#8a7355" opacity={0.85} pointerEvents="none" />}
            {t.owner && <polygon points={pts} fill={game.factions[t.owner].color} fillOpacity={0.16} pointerEvents="none" />}
          </g>
        )
      })}

      {/* Legal move highlights (green) */}
      {tiles.filter(isMoveTarget).map((t) => {
        const { cx, cy } = center(t)
        return <polygon key={'mv' + key(t.hex)} points={hexCorners(cx, cy)} fill="#22c55e" fillOpacity={0.28} stroke="#22c55e" strokeWidth={2.5} pointerEvents="none" />
      })}

      {/* Strike target highlights (red) */}
      {tiles.filter((t) => strikeTgts.some((h) => hexEquals(h, t.hex))).map((t) => {
        const { cx, cy } = center(t)
        return <polygon key={'st' + key(t.hex)} points={hexCorners(cx, cy)} fill="#ef4444" fillOpacity={0.32} stroke="#ef4444" strokeWidth={2.5} className="strike-target" onClick={() => clickHex(t.hex)} />
      })}

      {/* National borders */}
      {borders.map((s, i) => (
        <line key={'b' + i} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke={s.color} strokeWidth={3.2} strokeLinecap="round" pointerEvents="none" />
      ))}

      {/* Disputed hexes: alternating-claimant outline + flag */}
      {tiles.filter((t) => t.disputedBy?.length).map((t) => {
        const { cx, cy } = center(t)
        const claimants = t.disputedBy!
        return (
          <g key={'disp' + key(t.hex)} pointerEvents="none">
            {Array.from({ length: 6 }).map((_, e) => {
              const a = hexCorner(cx, cy, e)
              const b = hexCorner(cx, cy, (e + 1) % 6)
              const color = game.factions[claimants[e % claimants.length]].color
              return <line key={e} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={color} strokeWidth={3.5} strokeLinecap="round" />
            })}
            <text x={cx} y={cy + 2} textAnchor="middle" fontSize="15">⚑</text>
            {t.dmz && (
              <text x={cx} y={cy + 15} textAnchor="middle" fontSize="7.5" fontWeight={700} fill="#f8fafc" stroke="#0b0f17" strokeWidth={2} paintOrder="stroke" style={{ letterSpacing: '0.5px' }}>DMZ</text>
            )}
          </g>
        )
      })}

      {/* Installations: cities as a small building skyline, bases as a badge */}
      {game.installations.map((inst) => {
        const { cx, cy } = center(inst)
        const f = game.factions[inst.owner]
        if (inst.type === 'city') {
          const win = '#0b0f17'
          return (
            <g key={inst.id} pointerEvents="none">
              <title>{f.name} — city ({inst.integrity ?? 100}%)</title>
              <rect x={cx - 6} y={cy - 8} width={5} height={11} rx={0.5} fill={f.color} stroke={win} strokeWidth={0.8} />
              <rect x={cx - 0.5} y={cy - 12} width={6} height={15} rx={0.5} fill={f.color} stroke={win} strokeWidth={0.8} />
              <rect x={cx - 4.4} y={cy - 6} width={1.4} height={1.4} fill={win} />
              <rect x={cx - 4.4} y={cy - 3} width={1.4} height={1.4} fill={win} />
              <rect x={cx + 1} y={cy - 9} width={1.4} height={1.4} fill={win} />
              <rect x={cx + 1} y={cy - 6} width={1.4} height={1.4} fill={win} />
              <rect x={cx + 3.2} y={cy - 9} width={1.4} height={1.4} fill={win} />
              <rect x={cx + 3.2} y={cy - 6} width={1.4} height={1.4} fill={win} />
            </g>
          )
        }
        // Air bases are clickable (current faction) to launch air strikes.
        const isAir = inst.type === 'air_base'
        const selectable = isAir && inst.owner === currentId
        const selectedBase = isAir && inst.id === selectedInstallId
        return (
          <g
            key={inst.id}
            pointerEvents={selectable ? 'auto' : 'none'}
            style={selectable ? { cursor: 'pointer' } : undefined}
            onClick={selectable ? () => selectInstall(inst.id) : undefined}
          >
            <title>{f.name} — {inst.type.replace('_', ' ')} (integrity {inst.integrity}%{inst.maxCharges != null ? `, ${inst.charges}/${inst.maxCharges} sorties` : ''})</title>
            <rect x={cx - 7} y={cy - 13} width={14} height={14} rx={3} fill="#0b0f17"
              stroke={selectedBase ? '#ffffff' : f.color} strokeWidth={selectedBase ? 2.4 : 1.3} opacity={0.95} />
            <text x={cx} y={cy - 3} textAnchor="middle" fontSize="9" fill={f.color} fontWeight="bold">{INSTALL_GLYPH[inst.type]}</text>
          </g>
        )
      })}

      {/* Capitals: compact 3-letter code in a pill (full name on hover) */}
      {Object.values(game.factions).map((f) => {
        const { cx, cy } = center({ hex: f.capital })
        const abbr = f.name.slice(0, 3).toUpperCase()
        const w = abbr.length * 6 + 8
        return (
          <g key={'cap' + f.id} pointerEvents="none">
            <title>{f.name}</title>
            <rect x={cx - w / 2} y={cy - 27} width={w} height={12} rx={6} fill="#0b0f17" opacity={0.85} stroke={f.color} strokeWidth={1} />
            <text x={cx} y={cy - 18} textAnchor="middle" fontSize="8.5" fontWeight={700} fill={f.color} style={{ letterSpacing: '0.5px' }}>{abbr}</text>
          </g>
        )
      })}

      {/* Forces: small stackable tokens; drop lower when the tile has a base */}
      {[...forcesByHex.entries()].map(([k, stack]) => {
        const { cx, cy } = center({ hex: stack[0].hex })
        const rowY = cy + (installHexes.has(k) ? 13 : 2)
        const shown = stack.slice(0, 3)
        const startX = cx - ((shown.length - 1) * 9) / 2
        return (
          <g key={'fz' + k} onClick={() => clickHex(stack[0].hex)} className="force">
            {shown.map((force, i) => {
              if (force.id === trottingForceId) return null
              const f = game.factions[force.owner]
              const x = startX + i * 9
              const selected = force.id === selectedForceId
              const isCurrent = force.owner === currentId
              return (
                <g key={force.id} opacity={isCurrent ? 1 : 0.7}>
                  <title>{f.name} — {force.type.replace('_', ' ')} ({force.health}/{force.maxHealth} HP, str {force.strength}{force.maxCharges != null ? `, ${force.charges}/${force.maxCharges} ⚡` : ''})</title>
                  <circle cx={x} cy={rowY} r={selected ? 8 : 6.5} fill={f.color}
                    stroke={selected ? '#ffffff' : '#0b0f17'} strokeWidth={selected ? 2.2 : 1.3} />
                  <text x={x} y={rowY + 3} textAnchor="middle" fontSize="8" fill="#0b0f17" fontWeight="bold" pointerEvents="none">
                    {FORCE_GLYPH[force.type]}
                  </text>
                </g>
              )
            })}
            {stack.length > 3 && (
              <text x={startX + 3 * 9} y={rowY + 3} fontSize="8" fill="#e2e8f0" fontWeight="bold">+{stack.length - 3}</text>
            )}
          </g>
        )
      })}

      {/* Strike animation: a glowing dot flies to the target, then a boom flash */}
      {lastStrike && (
        lastStrike.kind === 'air'
          ? (
            <AirStrikeAnim
              key={lastStrike.key}
              from={center({ hex: lastStrike.from })}
              to={center({ hex: lastStrike.to })}
            />
          )
          : (
            <StrikeAnim
              key={lastStrike.key}
              from={center({ hex: lastStrike.from })}
              to={center({ hex: lastStrike.to })}
            />
          )
      )}

      {/* Army attack animation: muzzle flashes and tracer streaks into the target. */}
      {lastAttack && (
        <AttackAnim
          key={lastAttack.key}
          from={center({ hex: lastAttack.from })}
          to={center({ hex: lastAttack.to })}
          force={lastAttack.won ? trottingForce : undefined}
          color={trottingForce ? game.factions[trottingForce.owner].color : undefined}
          selected={lastAttack.forceId === selectedForceId}
          quiet={lastAttack.quiet}
          onTrotStart={lastAttack.won ? () => setTrottingForceId(lastAttack.forceId) : undefined}
          onTrotEnd={lastAttack.won ? () => setTrottingForceId((id) => id === lastAttack.forceId ? null : id) : undefined}
        />
      )}
    </svg>
  )
}

type Pt = { cx: number; cy: number }

/** rAF-driven projectile + boom. Mounted fresh per strike (keyed), so it replays. */
function StrikeAnim({ from, to }: { from: Pt; to: Pt }) {
  const [st, setSt] = useState({ phase: 'fly' as 'fly' | 'boom', x: from.cx, y: from.cy, r: 0, o: 0 })
  useEffect(() => {
    const FLY = 360, BOOM = 320
    const start = performance.now()
    let raf = 0, boomed = false
    const tick = (now: number) => {
      const e = now - start
      if (e < FLY) {
        const t = e / FLY
        setSt({ phase: 'fly', x: from.cx + (to.cx - from.cx) * t, y: from.cy + (to.cy - from.cy) * t, r: 0, o: 0 })
        raf = requestAnimationFrame(tick)
      } else if (e < FLY + BOOM) {
        if (!boomed) { boomed = true; sfx.boom() }
        const t = (e - FLY) / BOOM
        setSt({ phase: 'boom', x: to.cx, y: to.cy, r: 3 + 20 * t, o: 0.95 * (1 - t) })
        raf = requestAnimationFrame(tick)
      } else {
        setSt((s) => ({ ...s, o: 0 }))
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [from.cx, from.cy, to.cx, to.cy])

  return (
    <g pointerEvents="none">
      {st.phase === 'fly'
        ? <circle cx={st.x} cy={st.y} r={5} fill="#fde047" filter="url(#glow)" />
        : <circle cx={st.x} cy={st.y} r={st.r} fill="#fff3c4" opacity={st.o} filter="url(#glow)" />}
    </g>
  )
}

function AirStrikeAnim({ from, to }: { from: Pt; to: Pt }) {
  const [t, setT] = useState(0)
  useEffect(() => {
    const DUR = 760
    const start = performance.now()
    let raf = 0, hit = false
    const tick = (now: number) => {
      const n = Math.min(1, (now - start) / DUR)
      setT(n)
      if (!hit && n >= 0.58) {
        hit = true
        sfx.boom()
      }
      if (n < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const dx = to.cx - from.cx
  const dy = to.cy - from.cy
  const len = Math.max(1, Math.hypot(dx, dy))
  const ux = dx / len
  const uy = dy / len
  const nx = -uy
  const ny = ux
  const approach = -24
  const exit = 34
  const px = from.cx + ux * approach + dx * t + ux * exit * t
  const py = from.cy + uy * approach + dy * t + uy * exit * t
  const angle = Math.atan2(dy, dx) * 180 / Math.PI
  const hit = Math.min(1, Math.max(0, (t - 0.55) / 0.28))
  const planeOpacity = t < 0.96 ? 1 : Math.max(0, 1 - (t - 0.96) / 0.04)

  return (
    <g pointerEvents="none">
      <line
        x1={from.cx - ux * 12}
        y1={from.cy - uy * 12}
        x2={px - ux * 12}
        y2={py - uy * 12}
        stroke="#bae6fd"
        strokeWidth={1.7}
        strokeDasharray="5 7"
        opacity={0.5 * planeOpacity}
      />
      <g transform={`translate(${px} ${py}) rotate(${angle})`} opacity={planeOpacity} filter="url(#glow)">
        <path d="M13 0 L-9 -5 L-5 0 L-9 5 Z" fill="#dbeafe" stroke="#0b0f17" strokeWidth={0.9} />
        <path d="M-2 0 L-13 -9 L-9 0 L-13 9 Z" fill="#93c5fd" stroke="#0b0f17" strokeWidth={0.8} />
        <line x1={-8} y1={0} x2={-15} y2={0} stroke="#fef3c7" strokeWidth={2} strokeLinecap="round" />
      </g>
      {hit > 0 && (
        <g opacity={1 - hit}>
          <circle cx={to.cx} cy={to.cy} r={5 + hit * 24} fill="#f8fafc" opacity={0.45} filter="url(#glow)" />
          <circle cx={to.cx + nx * 8} cy={to.cy + ny * 8} r={4 + hit * 12} fill="#38bdf8" opacity={0.32} filter="url(#glow)" />
          <circle cx={to.cx - nx * 7} cy={to.cy - ny * 7} r={3 + hit * 10} fill="#facc15" opacity={0.35} filter="url(#glow)" />
        </g>
      )}
    </g>
  )
}

function AttackAnim({
  from,
  to,
  force,
  color,
  selected,
  quiet,
  onTrotStart,
  onTrotEnd,
}: {
  from: Pt
  to: Pt
  force?: Force
  color?: string
  selected: boolean
  quiet?: boolean
  onTrotStart?: () => void
  onTrotEnd?: () => void
}) {
  const [t, setT] = useState(0)
  useEffect(() => {
    if (!quiet) sfx.machineGun()
    onTrotStart?.()
    const DUR = quiet ? 650 : 860
    const start = performance.now()
    let raf = 0
    const tick = (now: number) => {
      const n = Math.min(1, (now - start) / DUR)
      setT(n)
      if (n < 1) raf = requestAnimationFrame(tick)
      else onTrotEnd?.()
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
    // AttackAnim is keyed by attack id, so mount == one animation playback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const dx = to.cx - from.cx
  const dy = to.cy - from.cy
  const len = Math.max(1, Math.hypot(dx, dy))
  const nx = -dy / len
  const ny = dx / len
  const gun = Math.min(1, t / 0.5)
  const opacity = Math.max(0, 1 - gun)
  const bursts = [0.1, 0.24, 0.38, 0.52, 0.66]
  const trot = quiet ? t : Math.min(1, Math.max(0, (t - 0.42) / 0.5))
  const bob = Math.sin(trot * Math.PI * 7) * 3.5 * (1 - trot * 0.25)
  const tx = from.cx + dx * trot
  const ty = from.cy + dy * trot + bob

  return (
    <g pointerEvents="none">
      {!quiet && bursts.map((start, i) => {
        const p = Math.min(1, Math.max(0, (gun - start) / 0.22))
        if (p <= 0 || p >= 1) return null
        const jitter = (i - 2) * 2.2
        const x1 = from.cx + dx * p + nx * jitter
        const y1 = from.cy + dy * p + ny * jitter
        const x2 = from.cx + dx * Math.min(1, p + 0.16) + nx * jitter
        const y2 = from.cy + dy * Math.min(1, p + 0.16) + ny * jitter
        return (
          <line
            key={i}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            stroke={i % 2 ? '#fb923c' : '#fde047'}
            opacity={opacity}
            strokeWidth={2.6}
            strokeLinecap="round"
            filter="url(#glow)"
          />
        )
      })}
      {!quiet && <circle cx={from.cx} cy={from.cy} r={5 + 7 * Math.sin(gun * Math.PI * 9) ** 2} fill="#fde047" opacity={0.75 * opacity} filter="url(#glow)" />}
      {!quiet && <circle cx={to.cx} cy={to.cy} r={6 + 18 * gun} fill="#fb923c" opacity={0.45 * opacity} filter="url(#glow)" />}
      {force && color && (
        <g opacity={trot < 1 ? 1 : Math.max(0, 1 - (t - 0.92) / 0.08)}>
          <circle cx={tx} cy={ty} r={selected ? 8 : 6.5} fill={color}
            stroke={selected ? '#ffffff' : '#0b0f17'} strokeWidth={selected ? 2.2 : 1.3} />
          <text x={tx} y={ty + 3} textAnchor="middle" fontSize="8" fill="#0b0f17" fontWeight="bold" pointerEvents="none">
            {FORCE_GLYPH[force.type]}
          </text>
        </g>
      )}
    </g>
  )
}
