import { describe, it, expect } from 'vitest'
import { summarizeState, recentCoalitionPressureOnKazrek } from './summarize.ts'
import { key, neighbors } from '../src/game/hexUtils.ts'
import type { Faction, Force, GameEvent, GameState, Hex, Installation, Tile } from '../src/game/types.ts'

// --- Fixture builders: sensible defaults, override what each test cares about. ---

function faction(id: string, over: Partial<Faction> = {}): Faction {
  return {
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    type: 'ally',
    alignment: 'coalition',
    color: '#ffffff',
    capital: { q: 0, r: 0 },
    support: 50,
    market: 50,
    tradeWeight: 2,
    disposition: 0,
    procurement: { policy: 'civilian', burden: 'standard', aidBoost: 0, aidBoostTurns: 0 },
    doctrine: 'doctrine text',
    redLines: ['red line'],
    objectives: ['objective'],
    ...over,
  }
}

function force(owner: string, over: Partial<Force> = {}): Force {
  return {
    id: 'f1', owner, type: 'army_group',
    health: 40, maxHealth: 40, strength: 7,
    hex: { q: 0, r: 0 }, acted: false,
    ...over,
  }
}

function installation(owner: string, over: Partial<Installation> = {}): Installation {
  return { id: 'i1', owner, type: 'army_base', hex: { q: 0, r: 0 }, integrity: 100, ...over }
}

function tile(hex: Hex, over: Partial<Tile> = {}): Tile {
  return { hex, owner: null, contested: false, terrain: 'plains', ...over }
}

function tilesOf(...tiles: Tile[]): Record<string, Tile> {
  return Object.fromEntries(tiles.map((t) => [key(t.hex), t]))
}

function state(over: Partial<GameState> = {}): GameState {
  return {
    turn: 1, order: [], turnIndex: 0,
    factions: {}, tiles: {}, installations: [], forces: [],
    deathToll: 0, factionDeaths: {},
    embargoes: [], embargoedBy: {},
    ceasefires: [], ceasefireRequests: [], diplomaticMessages: [],
    log: [],
    ...over,
  }
}

describe('summarizeState — header', () => {
  it('reports name, round, support, economy, and death tolls', () => {
    const s = state({
      turn: 4,
      factions: { aurelia: faction('aurelia', { support: 72, market: 88 }) },
      deathToll: 1200,
      factionDeaths: { aurelia: 300 },
    })
    const out = summarizeState(s, 'aurelia')

    expect(out).toContain('SITUATION — Aurelia — Round 4')
    expect(out).toContain('Support 72/100  |  Economy 88/100')
    expect(out).toContain('Global death toll 1200  |  Aurelia deaths 300')
  })

  it('defaults missing death counters to zero', () => {
    const s = state({ factions: { aurelia: faction('aurelia') } })
    expect(summarizeState(s, 'aurelia')).toContain('Global death toll 0  |  Aurelia deaths 0')
  })
})

describe('summarizeState — active forces and installations', () => {
  it('lists own forces with charges and the acted flag', () => {
    const s = state({
      factions: { aurelia: faction('aurelia') },
      forces: [
        force('aurelia', { type: 'army_group', hex: { q: 1, r: 2 } }),
        force('aurelia', { id: 'f2', type: 'missile_battery', strength: 4, charges: 1, maxCharges: 2, acted: true, hex: { q: 3, r: 0 } }),
      ],
    })
    const out = summarizeState(s, 'aurelia')

    expect(out).toContain('YOUR FORCES:')
    expect(out).toContain('Army Group  hp 40/40  str 7')
    expect(out).toContain('Missile Battery  hp 40/40  str 4  1/2⚡ [acted this turn]')
    expect(out).toContain('at (1,2)')
  })

  it('shows "(none)" when the faction has no forces or installations', () => {
    const s = state({ factions: { aurelia: faction('aurelia') } })
    const out = summarizeState(s, 'aurelia')
    expect(out).toContain('YOUR FORCES:\n  (none)')
    expect(out).toContain('YOUR INSTALLATIONS:\n  (none)')
  })

  it('lists installations with integrity damage when below 80', () => {
    const s = state({
      factions: { aurelia: faction('aurelia') },
      installations: [
        installation('aurelia', { type: 'air_base', hex: { q: 2, r: 2 }, charges: 1, maxCharges: 2 }),
        installation('aurelia', { id: 'i2', type: 'city', hex: { q: 0, r: 0 }, integrity: 40 }),
      ],
    })
    const out = summarizeState(s, 'aurelia')

    expect(out).toContain('Air Base at (2,2)  1/2 sorties')
    expect(out).toContain('City at (0,0)  integrity 40')
  })
})

describe('summarizeState — allies and opposing forces', () => {
  it('lists aligned allies and flags opposing forces adjacent to your own', () => {
    const mine = { q: 0, r: 0 }
    const enemyHex = neighbors(mine)[0]
    const s = state({
      factions: {
        aurelia: faction('aurelia', { alignment: 'coalition' }),
        mirelle: faction('mirelle', { alignment: 'coalition' }),
        volkaria: faction('volkaria', { alignment: 'bloc' }),
      },
      forces: [
        force('aurelia', { hex: mine }),
        force('mirelle', { id: 'fm', hex: { q: 5, r: 5 } }),
        force('volkaria', { id: 'fv', hex: enemyHex }),
      ],
    })
    const out = summarizeState(s, 'aurelia')

    expect(out).toContain('ALLIED FORCES:')
    expect(out).toContain('[Mirelle] Army Group')
    expect(out).toContain('OPPOSING-ALIGNMENT FORCES:')
    expect(out).toContain('[Volkaria] Army Group')
    expect(out).toContain('near your Army Group (proximity alone is not hostile action)')
  })

  it('omits the allies section when there are no aligned allies', () => {
    const s = state({ factions: { aurelia: faction('aurelia') } })
    expect(summarizeState(s, 'aurelia')).not.toContain('ALLIED FORCES:')
  })
})

describe('summarizeState — flashpoints', () => {
  it('lists disputed and DMZ tiles under FLASHPOINTS', () => {
    const s = state({
      factions: {
        aurelia: faction('aurelia'),
        kazrek: faction('kazrek', { alignment: 'bloc' }),
      },
      tiles: tilesOf(
        tile({ q: 1, r: 6 }, { contested: true, disputedBy: ['kazrek', 'aurelia'], dmz: true }),
        tile({ q: 0, r: 0 }, { owner: 'aurelia' }),
      ),
    })
    const out = summarizeState(s, 'aurelia')

    expect(out).toContain('FLASHPOINTS:')
    expect(out).toContain('(1,6) —')
    expect(out).toContain('[DMZ]')
    expect(out).toContain('[disputed: Kazrek vs Aurelia]')
  })
})

describe('summarizeState — diplomacy', () => {
  it('renders active ceasefires with the prohibition note in the active view', () => {
    const s = state({
      turn: 2,
      factions: {
        aurelia: faction('aurelia'),
        volkaria: faction('volkaria', { alignment: 'bloc' }),
      },
      ceasefires: ['aurelia|volkaria'],
      peacePairAttemptTurn: { 'aurelia|volkaria': 2 },
    })
    const out = summarizeState(s, 'aurelia')

    expect(out).toContain('DIPLOMACY:')
    expect(out).toContain('Ceasefire active: Aurelia and Volkaria. Hostile moves and strikes between them are prohibited.')
    expect(out).toContain('Peace/ceasefire already raised this round: Aurelia - Volkaria')
  })

  it('omits the diplomacy section when nothing is pending', () => {
    const s = state({ factions: { aurelia: faction('aurelia') } })
    expect(summarizeState(s, 'aurelia')).not.toContain('DIPLOMACY:')
  })
})

describe('summarizeState — exile branch', () => {
  it('switches to the exile view: status, leverage, no military sections', () => {
    const s = state({
      factions: {
        aurelia: faction('aurelia', { exiled: true }),
        volkaria: faction('volkaria', { alignment: 'bloc' }),
      },
      ceasefires: ['aurelia|volkaria'],
      forces: [force('aurelia')],
    })
    const out = summarizeState(s, 'aurelia')

    expect(out).toContain('STATUS: Government in exile.')
    expect(out).toContain('EXILE LEVERAGE:')
    expect(out).toContain('YOUR MANDATE:')
    expect(out).not.toContain('YOUR FORCES:')
    expect(out).not.toContain('OPPOSING-ALIGNMENT FORCES:')
    // Exile ceasefire lines drop the "Hostile moves..." prohibition suffix.
    expect(out).toContain('Ceasefire active: Aurelia and Volkaria.')
    expect(out).not.toContain('prohibited.')
  })
})

describe('summarizeState — mandate', () => {
  it('always closes with objectives, red lines, and doctrine', () => {
    const s = state({
      factions: {
        aurelia: faction('aurelia', {
          objectives: ['hold the line', 'keep allies'],
          redLines: ['no strikes at home'],
          doctrine: 'deterrence first',
        }),
      },
    })
    const out = summarizeState(s, 'aurelia')

    expect(out).toContain('Objectives: hold the line | keep allies')
    expect(out).toContain('Red lines:  no strikes at home')
    expect(out).toContain('Doctrine:   deterrence first')
  })
})

describe('summarizeState — horizontal escalation', () => {
  function kazrekStruckState(turn = 2): GameState {
    return state({
      turn,
      factions: {
        aurelia: faction('aurelia', { alignment: 'coalition' }),
        volkaria: faction('volkaria', { alignment: 'bloc' }),
        tamarisk: faction('tamarisk', { alignment: 'coalition' }),
      },
      log: [
        { turn, kind: 'system', faction: 'aurelia', text: 'Aurelia launches a strike on Kazrek positions.' },
      ],
    })
  }

  it('offers escalation to the bloc when the coalition has struck Kazrek', () => {
    const out = summarizeState(kazrekStruckState(), 'volkaria')
    expect(out).toContain('HORIZONTAL ESCALATION OPTION:')
    expect(out).toContain('Trigger: [Round 2] Aurelia launches a strike on Kazrek positions.')
  })

  it('warns Tamarisk of escalation risk instead', () => {
    const out = summarizeState(kazrekStruckState(), 'tamarisk')
    expect(out).toContain('HORIZONTAL ESCALATION RISK:')
  })
})

describe('recentCoalitionPressureOnKazrek', () => {
  const base = {
    aurelia: faction('aurelia', { alignment: 'coalition' }),
    volkaria: faction('volkaria', { alignment: 'bloc' }),
  }

  it('matches recent coalition system events that strike Kazrek', () => {
    const s = state({
      turn: 3,
      factions: base,
      log: [
        { turn: 3, kind: 'system', faction: 'aurelia', text: 'Coalition forces assault Kazrek lines.' },
        { turn: 3, kind: 'system', faction: 'volkaria', text: 'Volkaria strikes Kazrek aid convoy.' }, // wrong alignment
        { turn: 3, kind: 'system', faction: 'aurelia', text: 'Aurelia holds a press conference.' }, // no combat verb
        { turn: 1, kind: 'system', faction: 'aurelia', text: 'Aurelia struck Kazrek long ago.' }, // too old
      ] as GameEvent[],
    })
    const hits = recentCoalitionPressureOnKazrek(s)
    expect(hits).toHaveLength(1)
    expect(hits[0].text).toContain('Coalition forces assault Kazrek lines.')
  })

  it('caps the result at four events', () => {
    const log: GameEvent[] = Array.from({ length: 6 }, (_, n) => ({
      turn: 3, kind: 'system', faction: 'aurelia', text: `Coalition strike ${n} on Kazrek.`,
    }))
    const s = state({ turn: 3, factions: base, log })
    expect(recentCoalitionPressureOnKazrek(s)).toHaveLength(4)
  })
})
