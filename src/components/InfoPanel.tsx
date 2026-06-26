import { useState } from 'react'
import { useGameStore } from '../store/useGameStore'
import { PROJECT_LABEL, embargoOwner, isEmbargoed, procurementRate, projectCost } from '../game/engine'
import { key } from '../game/hexUtils'
import type { Force, GameEvent, GameState, Installation } from '../game/types'

/** Color a 0–100 political stat (support / economy). */
function barColor(v: number): string {
  if (v >= 60) return '#22c55e'
  if (v >= 30) return '#eab308'
  return '#ef4444'
}

const SIDE_TITLE = { coalition: 'Aurelia Bloc', bloc: 'Volkaria Bloc', neutral: 'Neutrals' } as const
const INSTALL_NAME: Record<Installation['type'], string> = {
  city: 'City', army_base: 'Army base', air_base: 'Air base', naval_base: 'Naval base', radar: 'Radar',
}
const FORCE_NAME: Record<Force['type'], string> = {
  army_group: 'Army group', marine: 'Marines', naval_group: 'Naval group', missile_battery: 'Missile battery',
}

function isPressStatement(event: GameEvent): boolean {
  return event.kind === 'dispatch' && / press statement: /i.test(event.text)
}

function pressStatementLabel(game: GameState, event: GameEvent): string {
  return event.faction ? game.factions[event.faction]?.name ?? event.faction : 'Press statement'
}

function pressStatementText(event: GameEvent): string {
  const match = event.text.match(/press statement:\s*"?(.*?)"?$/i)
  return match?.[1]?.trim() || event.text
}

/** Right-hand column: faction roster grouped by side + event log. The log is a
 *  stand-in for the Phase 3 "intelligence assessment" panel (agent reasoning). */
export function InfoPanel() {
  const [expandedLog, setExpandedLog] = useState<'diplomacy' | 'dispatches' | null>(null)
  const game = useGameStore((s) => s.game)
  const inspectHex = useGameStore((s) => s.inspectHex)
  const toggleTrade = useGameStore((s) => s.toggleTrade)
  const pendingTrade = useGameStore((s) => s.pendingTrade)
  const currentId = game.order[game.turnIndex]
  const currentName = game.factions[currentId].name
  const currentExiled = !!game.factions[currentId].exiled
  const diplomaticMessages = game.diplomaticMessages ?? []
  const ceasefires = game.ceasefires ?? []
  const pressStatements = game.log.filter(isPressStatement)
  const dispatchEvents = game.log.filter((event) => !isPressStatement(event))

  const tile = inspectHex ? game.tiles[key(inspectHex)] : undefined
  const tileInstalls = inspectHex ? game.installations.filter((i) => key(i.hex) === key(inspectHex)) : []
  const tileForces = inspectHex ? game.forces.filter((f) => key(f.hex) === key(inspectHex)) : []

  const groups = (['coalition', 'bloc', 'neutral'] as const).map((side) => ({
    side,
    factions: Object.values(game.factions)
      .filter((f) => f.alignment === side)
      .sort((a, b) => (a.type === 'player' || a.type === 'rival' ? -1 : 0) - (b.type === 'player' || b.type === 'rival' ? -1 : 0)),
  }))
  const showDiplomacyLog = ceasefires.length > 0 || diplomaticMessages.length > 0 || pressStatements.length > 0

  const renderDiplomacyLog = (limit?: number) => (
    <>
      {ceasefires.map((pair) => {
        const [a, b] = pair.split('|')
        return <div key={pair} className="diplo-line active">Ceasefire: {game.factions[a]?.name ?? a} - {game.factions[b]?.name ?? b}</div>
      })}
      {diplomaticMessages.slice(0, limit).map((msg) => (
        <div key={msg.id} className={`diplo-line ${msg.response ?? msg.kind}`}>
          <strong>{game.factions[msg.from]?.name ?? msg.from} {'->'} {game.factions[msg.to]?.name ?? msg.to}</strong>
          <span>{msg.message}</span>
        </div>
      ))}
      {pressStatements.slice(0, limit).map((event, index) => (
        <div key={`press-${event.turn}-${event.faction ?? 'none'}-${index}`} className="diplo-line press-statement">
          <strong>{pressStatementLabel(game, event)} press statement</strong>
          <span>{pressStatementText(event)}</span>
        </div>
      ))}
    </>
  )

  const renderDispatchLog = () => (
    <ul className="log">
      {dispatchEvents.map((e, i) => (
        <li key={i} className={`log-${e.kind}`}>
          <span className="log-turn">T{e.turn}</span>
          <span>{e.text}</span>
        </li>
      ))}
    </ul>
  )

  return (
    <section className="infopanel">
      <div className="panel inspect-panel">
        <h2>On Tile</h2>
        {tile ? (
          <>
            <div className="inspect-head">
              <span className="dot" style={{ background: tile.owner ? game.factions[tile.owner].color : '#475569' }} />
              <strong>{tile.owner ? game.factions[tile.owner].name : tile.disputedBy ? 'Disputed' : 'Unclaimed'}</strong>
              <span className="ftype">{tile.terrain}{tile.dmz ? ' · DMZ' : ''}</span>
            </div>
            {tile.disputedBy && <div className="inspect-line">Claimed by {tile.disputedBy.map((id) => game.factions[id].name).join(' & ')}</div>}
            {tileInstalls.map((i) => (
              <div key={i.id} className="inspect-line" style={{ color: game.factions[i.owner].color }}>
                {INSTALL_NAME[i.type]} — integrity {i.integrity}%{i.maxCharges != null ? `, ${i.charges}/${i.maxCharges} sorties` : ''}
              </div>
            ))}
            {tileForces.map((f) => (
              <div key={f.id} className="inspect-line" style={{ color: game.factions[f.owner].color }}>
                {FORCE_NAME[f.type]} — {f.health}/{f.maxHealth} HP, str {f.strength}{f.maxCharges != null ? `, ${f.charges}/${f.maxCharges} charges` : ''}
              </div>
            ))}
            {!tileInstalls.length && !tileForces.length && <div className="inspect-line muted">No forces or installations.</div>}
          </>
        ) : (
          <p className="hint">Hover or click any tile to see what’s on it.</p>
        )}
      </div>

      <div className="panel">
        <h2>Factions</h2>
        <p className="panel-note">Trade column shows <strong>{currentName}</strong>’s links. Click to stage an embargo/restore — it applies when you End Turn.</p>
        {groups.map(({ side, factions }) => (
          <div key={side} className="faction-group">
            <div className="group-title">{SIDE_TITLE[side]}</div>
            <ul className="factions">
              {factions.map((f) => (
                <li key={f.id} className={f.id === currentId ? 'acting' : ''}>
                  <span className="dot" style={{ background: f.color }} />
                  <span className="fname">{f.name}</span>
                  <span className="fstats">
                    <span title="domestic support" style={{ color: barColor(f.support) }}>♥{f.support}</span>
                    <span title={`economy ${f.market} · trade weight ${f.tradeWeight}`} style={{ color: barColor(f.market) }}>▤{f.market}</span>
                  </span>
                  {f.exiled ? (
                    <span className="fproc exile-badge" title={`Government in exile since round ${f.exiledTurn ?? '?'}`}>
                      Exile
                    </span>
                  ) : f.procurement.project && (
                    <span className="fproc" title={`${PROJECT_LABEL[f.procurement.project.type]} +${procurementRate(game, f.id)} per turn`}>
                      {PROJECT_LABEL[f.procurement.project.type].split(' ')[0]} {Math.floor(f.procurement.project.progress)}/{projectCost(f.procurement.project.type)}
                    </span>
                  )}
                  {f.id !== currentId ? (() => {
                    const actual = isEmbargoed(game, currentId, f.id)
                    const owner = actual ? embargoOwner(game, currentId, f.id) : undefined
                    const locked = actual && owner !== currentId
                    const intended = f.id in pendingTrade ? pendingTrade[f.id] : actual
                    const pending = intended !== actual
                    return (
                      <button
                        className={`trade-btn ${intended ? 'cut' : 'open'}${pending ? ' pending' : ''}${locked ? ' locked' : ''}`}
                        disabled={locked || currentExiled}
                        title={`${currentName} ↔ ${f.name}: currently ${actual ? 'embargoed' : 'trading'}.` +
                          (currentExiled ? ' Exiled governments cannot change trade policy.' : pending ? ` Staged to ${intended ? 'embargo' : 'restore'} — applies on End Turn.` : ' Click to stage a change.')}
                        onClick={() => toggleTrade(f.id)}
                      >{locked ? 'Blocked' : pending ? (intended ? 'Embargo*' : 'Restore*') : (intended ? 'Embargoed' : 'Trading')}</button>
                    )
                  })() : <span className="trade-btn placeholder" aria-hidden />}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {showDiplomacyLog && (
        <div className="panel diplomacy-log">
          <div className="panel-header">
            <h2>Diplomacy</h2>
            <button className="expand-btn" onClick={() => setExpandedLog('diplomacy')} title="Expand diplomacy" aria-label="Expand diplomacy">□</button>
          </div>
          {renderDiplomacyLog(8)}
        </div>
      )}

      <div className="panel log-panel">
        <div className="panel-header">
          <h2>Dispatches</h2>
          <button className="expand-btn" onClick={() => setExpandedLog('dispatches')} title="Expand dispatches" aria-label="Expand dispatches">□</button>
        </div>
        {renderDispatchLog()}
      </div>

      {expandedLog && (
        <div className="modal-backdrop" onClick={() => setExpandedLog(null)}>
          <div className="expanded-window wide" role="dialog" aria-modal="true" aria-label={expandedLog === 'diplomacy' ? 'Expanded diplomacy' : 'Expanded dispatches'} onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <h2>{expandedLog === 'diplomacy' ? 'Diplomacy' : 'Dispatches'}</h2>
              <button className="expand-btn close-btn" onClick={() => setExpandedLog(null)} title="Close" aria-label="Close expanded window">x</button>
            </div>
            <div className={`expanded-body ${expandedLog === 'diplomacy' ? 'diplomacy-log expanded-log' : 'dispatch-log expanded-log'}`}>
              {expandedLog === 'diplomacy' ? renderDiplomacyLog() : renderDispatchLog()}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
