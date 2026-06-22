import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { AidPackageType, GameState, Hex, ProcurementBurden, ProcurementPolicy, ProcurementProjectType } from '../game/types'
import { buildInitialState } from '../game/scenario'
import {
  airBaseTargets, airStrike, canClaim, canStrike, claimHex, currentFactionId, dispatch, endFactionTurn,
  embargoOwner, forceStrike, forcesAt, isEmbargoed, legalMoves, moveForce, respondCeasefire, sendAidPackage,
  sendDiplomaticMessage, setProcurementBurden, setProcurementPolicy, startProcurement, strikeTargets, toggleEmbargo,
  type Action, type StrikeIntensity, type StrikeKind,
} from '../game/engine'
import { hexEquals, key } from '../game/hexUtils'
import { sfx } from '../audio/sfx'

type Mode = 'move' | 'strike' | 'airstrike'

/** A resolved strike, for the projectile animation. `key` retriggers it. */
export interface StrikeFx { from: Hex; to: Hex; key: number; kind: StrikeKind }
export interface AttackFx { from: Hex; to: Hex; key: number; forceId: string; won: boolean; quiet?: boolean }

interface GameStore {
  game: GameState
  introPending: boolean
  selectedForceId: string | null
  /** A selected air base (to launch air strikes from). */
  selectedInstallId: string | null
  mode: Mode
  strikeIntensity: StrikeIntensity
  moveTargets: Hex[]
  strikeTargets: Hex[]
  lastStrike: StrikeFx | null
  lastAttack: AttackFx | null
  /** Tile the user is inspecting (hover/click) — shows what's on it. */
  inspectHex: Hex | null
  /** Staged trade changes for the acting nation: targetId → desired embargoed state.
   *  Applied only when the player ends the turn. */
  pendingTrade: Record<string, boolean>

  current: () => string
  beginGame: () => void
  selectForce: (forceId: string | null) => void
  selectInstall: (installId: string | null) => void
  clickHex: (h: Hex) => void
  setInspect: (h: Hex | null) => void
  claim: () => void
  toggleTrade: (targetId: string) => void
  setProcurementPolicy: (policy: ProcurementPolicy) => void
  setProcurementBurden: (burden: ProcurementBurden) => void
  startProcurement: (type: ProcurementProjectType) => void
  sendAidPackage: (targetId: string, type: AidPackageType) => void
  sendDiplomaticMessage: (targetId: string, message: string) => void
  mediatePeace: (sideAId: string, sideBId: string, message: string) => Promise<void>
  requestCeasefire: (targetId: string, message: string) => Promise<void>
  respondCeasefire: (requestId: string, accepted: boolean, message: string) => void
  enterStrike: (intensity: StrikeIntensity) => void
  enterAirStrike: (intensity: StrikeIntensity) => void
  cancelAction: () => void
  endTurn: () => void
  reset: () => void
  aiPending: boolean
  runAiTurn: () => Promise<void>
}

function selectFx(game: GameState, forceId: string | null) {
  if (!forceId) return { selectedForceId: null, selectedInstallId: null, mode: 'move' as Mode, moveTargets: [], strikeTargets: [] }
  const force = game.forces.find((f) => f.id === forceId)
  if (!force || force.owner !== currentFactionId(game)) return null
  return { selectedForceId: forceId, selectedInstallId: null, mode: 'move' as Mode, moveTargets: legalMoves(game, force), strikeTargets: [] }
}

function buildOpeningState(): { game: GameState; lastAttack: AttackFx | null } {
  const game = buildInitialState()
  const dmz = Object.values(game.tiles).find((t) => t.dmz)?.hex
  const army = dmz
    ? game.forces.find((f) => f.owner === 'kazrek' && f.type === 'army_group' && f.health > 0)
    : undefined
  if (!dmz || !army) return { game, lastAttack: null }
  const from = army.hex
  const result = moveForce(game, army.id, dmz)
  const moved = result.forces.find((f) => f.id === army.id)
  return {
    game: result,
    lastAttack: moved ? { from, to: dmz, key: Date.now(), forceId: army.id, won: hexEquals(moved.hex, dmz) } : null,
  }
}

export const useGameStore = create<GameStore>()(persist((set, get) => ({
  game: buildInitialState(),
  introPending: true,
  selectedForceId: null,
  selectedInstallId: null,
  mode: 'move',
  strikeIntensity: 'limited',
  moveTargets: [],
  strikeTargets: [],
  lastStrike: null,
  lastAttack: null,
  inspectHex: null,
  pendingTrade: {},

  current: () => currentFactionId(get().game),

  beginGame: () => {
    if (!get().introPending) return
    const next = buildOpeningState()
    set({
      game: next.game,
      introPending: false,
      selectedForceId: null,
      selectedInstallId: null,
      mode: 'move',
      moveTargets: [],
      strikeTargets: [],
      lastStrike: null,
      lastAttack: next.lastAttack ? { ...next.lastAttack, key: Date.now(), quiet: true } : null,
      pendingTrade: {},
    })
  },

  setInspect: (h) => set({ inspectHex: h }),

  selectForce: (forceId) => {
    const fx = selectFx(get().game, forceId)
    if (fx === null) return
    if (forceId) sfx.select()
    set(fx)
  },

  selectInstall: (installId) => {
    const { game } = get()
    const inst = game.installations.find((i) => i.id === installId)
    if (!inst || inst.type !== 'air_base' || inst.owner !== currentFactionId(game)) return
    sfx.select()
    set({ selectedInstallId: installId, selectedForceId: null, mode: 'move', moveTargets: [], strikeTargets: [], inspectHex: inst.hex })
  },

  clickHex: (h) => {
    const { game, selectedForceId, mode, strikeIntensity, moveTargets, strikeTargets: tgts } = get()
    if (game.regimeFallen || get().aiPending) return

    // Strike modes: click a target to resolve, anything else cancels.
    if (mode === 'strike' || mode === 'airstrike') {
      const { selectedInstallId } = get()
      if (tgts.some((t) => hexEquals(t, h))) {
        const base = game.installations.find((i) => i.id === selectedInstallId)
        const from = mode === 'airstrike'
          ? (base ? base.hex : h)
          : game.forces.find((f) => f.id === selectedForceId)!.hex
        const kind: StrikeKind = mode === 'airstrike'
          ? 'air'
          : game.forces.find((f) => f.id === selectedForceId)?.type === 'naval_group' ? 'naval' : 'missile'
        const result = mode === 'airstrike'
          ? airStrike(game, selectedInstallId!, h, strikeIntensity)
          : forceStrike(game, selectedForceId!, h, strikeIntensity)
        if (result === game) { set({ mode: 'move', strikeTargets: [] }); return } // strike was invalid
        const force = result.forces.find((f) => f.id === selectedForceId)
        set({
          game: result, mode: 'move', strikeTargets: [],
          moveTargets: force ? legalMoves(result, force) : [],
          selectedForceId: force ? selectedForceId : null,
          lastStrike: { from, to: h, key: Date.now(), kind },
        })
        return
      }
      set({ mode: 'move', strikeTargets: [] })
      return
    }

    // Move mode: move the selected force first, so friendly stacks don't steal the click.
    if (selectedForceId && moveTargets.some((t) => hexEquals(t, h))) {
      const myAlign = game.factions[currentFactionId(game)].alignment
      const force = game.forces.find((f) => f.id === selectedForceId)
      const tile = game.tiles[key(h)]
      const targetHasEnemy = forcesAt(game, h).some((f) => game.factions[f.owner].alignment !== myAlign)
      const armyAttack = !!force && force.type === 'army_group' && (
        targetHasEnemy || tile?.owner !== force.owner || !!tile?.disputedBy || !!tile?.dmz
      )
      const from = force?.hex ?? h
      const result = moveForce(game, selectedForceId, h)
      if (!armyAttack) sfx.move()
      const moved = result.forces.find((f) => f.id === selectedForceId)
      const won = !!moved && hexEquals(moved.hex, h)
      set({
        game: result,
        selectedForceId: moved ? selectedForceId : null,
        moveTargets: moved ? legalMoves(result, moved) : [],
        lastAttack: armyAttack && result !== game ? { from, to: h, key: Date.now(), forceId: selectedForceId, won } : get().lastAttack,
      })
      return
    }
    const mine = forcesAt(game, h).filter((f) => f.owner === currentFactionId(game))
    if (mine.length) {
      const idx = mine.findIndex((f) => f.id === selectedForceId)
      get().selectForce(mine[(idx + 1) % mine.length].id)
      return
    }
    // Clicked empty/enemy ground — inspect what's on it.
    set({ selectedForceId: null, selectedInstallId: null, mode: 'move', moveTargets: [], strikeTargets: [], inspectHex: h })
  },

  claim: () => {
    const { game, selectedForceId } = get()
    const force = game.forces.find((f) => f.id === selectedForceId)
    if (!force || !canClaim(game, force)) return
    const result = claimHex(game, force.id)
    sfx.confirm()
    const moved = result.forces.find((f) => f.id === force.id)
    set({ game: result, moveTargets: moved ? legalMoves(result, moved) : [], mode: 'move', strikeTargets: [] })
  },

  // Stage (don't apply) a trade change. It commits when the player ends the turn.
  toggleTrade: (targetId) => {
    const { game, pendingTrade } = get()
    if (game.regimeFallen) return
    const actual = isEmbargoed(game, currentFactionId(game), targetId)
    if (actual && embargoOwner(game, currentFactionId(game), targetId) !== currentFactionId(game)) return
    const desired = targetId in pendingTrade ? pendingTrade[targetId] : actual
    const newDesired = !desired
    const next = { ...pendingTrade }
    if (newDesired === actual) delete next[targetId] // back to current state = no pending
    else next[targetId] = newDesired
    sfx.confirm()
    set({ pendingTrade: next })
  },

  setProcurementPolicy: (policy) => {
    const { game } = get()
    if (game.regimeFallen) return
    const result = setProcurementPolicy(game, currentFactionId(game), policy)
    if (result !== game) sfx.confirm()
    set({ game: result })
  },

  setProcurementBurden: (burden) => {
    const { game } = get()
    if (game.regimeFallen) return
    const result = setProcurementBurden(game, currentFactionId(game), burden)
    if (result !== game) sfx.confirm()
    set({ game: result })
  },

  startProcurement: (type) => {
    const { game } = get()
    if (game.regimeFallen) return
    const result = startProcurement(game, currentFactionId(game), type)
    if (result !== game) sfx.confirm()
    set({ game: result })
  },

  sendAidPackage: (targetId, type) => {
    const { game } = get()
    if (game.regimeFallen) return
    const result = sendAidPackage(game, currentFactionId(game), targetId, type)
    if (result !== game) sfx.confirm()
    set({ game: result })
  },

  sendDiplomaticMessage: (targetId, message) => {
    const { game } = get()
    if (game.regimeFallen || get().aiPending) return
    const result = sendDiplomaticMessage(game, currentFactionId(game), targetId, message)
    if (result !== game) sfx.confirm()
    set({ game: result })
  },

  mediatePeace: async (sideAId, sideBId, message) => {
    const { game } = get()
    if (game.regimeFallen || get().aiPending) return
    set({ aiPending: true, selectedForceId: null, selectedInstallId: null, mode: 'move', moveTargets: [], strikeTargets: [] })
    try {
      const res = await fetch('http://localhost:3001/api/mediation-response', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: game, mediatorId: currentFactionId(game), sideAId, sideBId, message }),
      })
      if (!res.ok) throw new Error(await res.text())
      const { finalState } = await res.json() as { finalState: typeof game }
      sfx.confirm()
      set({ game: finalState, pendingTrade: {} })
    } catch (err) {
      console.error('[mediatePeace]', err)
    } finally {
      set({ aiPending: false })
    }
  },

  requestCeasefire: async (targetId, message) => {
    const { game } = get()
    if (game.regimeFallen || get().aiPending) return
    set({ aiPending: true, selectedForceId: null, selectedInstallId: null, mode: 'move', moveTargets: [], strikeTargets: [] })
    try {
      const res = await fetch('http://localhost:3001/api/ceasefire-response', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: game, fromId: currentFactionId(game), toId: targetId, message }),
      })
      if (!res.ok) throw new Error(await res.text())
      const { finalState } = await res.json() as { finalState: typeof game; response: 'accepted' | 'rejected'; message: string }
      sfx.confirm()
      set({ game: finalState, pendingTrade: {} })
    } catch (err) {
      console.error('[requestCeasefire]', err)
    } finally {
      set({ aiPending: false })
    }
  },

  respondCeasefire: (requestId, accepted, message) => {
    const { game } = get()
    if (game.regimeFallen || get().aiPending) return
    const result = respondCeasefire(game, currentFactionId(game), requestId, accepted ? 'accepted' : 'rejected', message)
    if (result !== game) sfx.confirm()
    set({ game: result })
  },

  enterStrike: (intensity) => {
    const { game, selectedForceId } = get()
    const force = game.forces.find((f) => f.id === selectedForceId)
    if (!force || !canStrike(force)) return
    sfx.select()
    set({ mode: 'strike', strikeIntensity: intensity, strikeTargets: strikeTargets(game, force), moveTargets: [] })
  },

  enterAirStrike: (intensity) => {
    const { game, selectedInstallId } = get()
    const base = game.installations.find((i) => i.id === selectedInstallId)
    if (!base || (base.charges ?? 0) < (intensity === 'full' ? 2 : 1)) return
    const targets = airBaseTargets(game, base.id)
    if (!targets.length) return
    sfx.select()
    set({ mode: 'airstrike', strikeIntensity: intensity, strikeTargets: targets, moveTargets: [] })
  },

  cancelAction: () => set({ mode: 'move', strikeTargets: [] }),

  endTurn: () => {
    const { game, pendingTrade } = get()
    if (game.regimeFallen) return
    // Commit staged trade changes for the acting nation, then advance.
    const cur = currentFactionId(game)
    let g = game
    for (const [target, desired] of Object.entries(pendingTrade)) {
      if (desired !== isEmbargoed(g, cur, target)) g = toggleEmbargo(g, cur, target)
    }
    const next = endFactionTurn(g)
    sfx.endTurn()
    set({ game: next, selectedForceId: null, selectedInstallId: null, mode: 'move', moveTargets: [], strikeTargets: [], pendingTrade: {} })
  },

  reset: () => set({ game: buildInitialState(), introPending: true, selectedForceId: null, selectedInstallId: null, mode: 'move', moveTargets: [], strikeTargets: [], lastStrike: null, lastAttack: null, pendingTrade: {} }),

  aiPending: false,

  runAiTurn: async () => {
    const { game } = get()
    if (get().aiPending) return
    set({ aiPending: true, selectedForceId: null, selectedInstallId: null, mode: 'move', moveTargets: [], strikeTargets: [] })
    try {
      const res = await fetch('http://localhost:3001/api/agent-turn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: game, factionId: currentFactionId(game) }),
      })
      if (!res.ok) throw new Error(await res.text())
      const { actions, finalState } = await res.json() as { actions: Action[]; finalState: typeof game; log: string[]; pressStatement?: string }

      // Replay actions to collect all animation events in order.
      type AnimEvent = { type: 'attack'; fx: AttackFx } | { type: 'strike'; fx: StrikeFx }
      const events: AnimEvent[] = []
      let replay = game

      for (const action of actions) {
        if (action.type === 'move_force') {
          const force = replay.forces.find((f) => f.id === action.forceId)
          if (force) {
            const myAlign = replay.factions[force.owner].alignment
            const tile = replay.tiles[key(action.to)]
            const isAttack =
              forcesAt(replay, action.to).some((f) => replay.factions[f.owner].alignment !== myAlign) ||
              tile?.owner !== force.owner || !!tile?.disputedBy || !!tile?.dmz
            if (isAttack) {
              const from = force.hex
              replay = dispatch(replay, action)
              const moved = replay.forces.find((f) => f.id === action.forceId)
              events.push({ type: 'attack', fx: { from, to: action.to, key: Date.now(), forceId: action.forceId, won: !!moved && hexEquals(moved.hex, action.to) } })
              continue
            }
          }
        } else if (action.type === 'force_strike' || action.type === 'air_strike') {
          const from = action.type === 'force_strike'
            ? (replay.forces.find((f) => f.id === action.forceId)?.hex ?? action.target)
            : (replay.installations.find((i) => i.id === action.baseId)?.hex ?? action.target)
          const kind: StrikeKind = action.type === 'air_strike' ? 'air'
            : replay.forces.find((f) => f.id === action.forceId)?.type === 'naval_group' ? 'naval' : 'missile'
          events.push({ type: 'strike', fx: { from, to: action.target, key: Date.now(), kind } })
        }
        replay = dispatch(replay, action)
      }

      // Apply final state, then play animations sequentially.
      sfx.endTurn()
      set({ game: finalState, pendingTrade: {} })

      const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
      for (const ev of events) {
        if (ev.type === 'attack') {
          set({ lastAttack: { ...ev.fx, key: Date.now() } })
          await sleep(960)
        } else {
          set({ lastStrike: { ...ev.fx, key: Date.now() } })
          await sleep(ev.fx.kind === 'air' ? 860 : 780)
        }
      }
    } catch (err) {
      console.error('[runAiTurn]', err)
    } finally {
      set({ aiPending: false })
    }
  },
}), {
  name: 'escalation-save',
  partialize: (s) => ({ game: s.game, pendingTrade: s.pendingTrade, introPending: s.introPending }),
}))

// Dev aid: inspect/poke game state from the console (and from preview tooling).
if (import.meta.env.DEV) {
  ;(window as unknown as { useGameStore: typeof useGameStore }).useGameStore = useGameStore
}

export { key }
