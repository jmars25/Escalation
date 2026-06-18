import { useState } from 'react'
import { useGameStore } from '../store/useGameStore'
import { LABEL, PROJECT_LABEL, airPower, canClaim, canStrike, procurementRate, projectCost } from '../game/engine'
import { key } from '../game/hexUtils'
import type { ProcurementBurden, ProcurementPolicy, ProcurementProjectType } from '../game/types'


const FORCE_NOTE: Record<string, string> = {
  army_group: 'Deploys anywhere inside its country, or attacks adjacent ground to claim it.',
  naval_group: 'Deploys once to home coastal waters. Strong strikes. Restocks next to a friendly base.',
  missile_battery: 'Deploys once inside its country; weak strikes; cannot occupy. Restocks next to a friendly base.',
}

const POLICY_LABEL: Record<ProcurementPolicy, string> = {
  civilian: 'Civilian',
  contracts: 'Contracts',
  emergency: 'Emergency',
  draft: 'Draft',
}

const BURDEN_LABEL: Record<ProcurementBurden, string> = {
  low: '1%',
  standard: '3%',
  high: '6%',
  crisis: '10%',
}

const PROJECTS: ProcurementProjectType[] = ['army_group', 'missile_battery', 'naval_group', 'air_base', 'naval_base']
const POLICIES: ProcurementPolicy[] = ['civilian', 'contracts', 'emergency', 'draft']
const BURDENS: ProcurementBurden[] = ['low', 'standard', 'high', 'crisis']

export function Sidebar() {
  const [confirmRestart, setConfirmRestart] = useState(false)
  const game = useGameStore((s) => s.game)
  const selectedForceId = useGameStore((s) => s.selectedForceId)
  const selectedInstallId = useGameStore((s) => s.selectedInstallId)
  const mode = useGameStore((s) => s.mode)
  const claim = useGameStore((s) => s.claim)
  const enterStrike = useGameStore((s) => s.enterStrike)
  const enterAirStrike = useGameStore((s) => s.enterAirStrike)
  const cancelAction = useGameStore((s) => s.cancelAction)
  const endTurn = useGameStore((s) => s.endTurn)
  const reset = useGameStore((s) => s.reset)
  const setPolicy = useGameStore((s) => s.setProcurementPolicy)
  const setBurden = useGameStore((s) => s.setProcurementBurden)
  const startProject = useGameStore((s) => s.startProcurement)
  const sendAid = useGameStore((s) => s.sendAidPackage)

  const currentId = game.order[game.turnIndex]
  const current = game.factions[currentId]
  const selected = game.forces.find((f) => f.id === selectedForceId)
  const selectedBase = game.installations.find((i) => i.id === selectedInstallId)
  const tile = selected ? game.tiles[key(selected.hex)] : undefined
  const claimable = selected ? canClaim(game, selected) : false
  const strikeable = selected ? canStrike(selected) : false
  const charges = selected?.charges ?? 0
  const baseCharges = selectedBase?.charges ?? 0
  const air = airPower(game, currentId)
  const targeting = mode === 'strike' || mode === 'airstrike'
  const proc = current.procurement
  const project = proc.project
  const rate = procurementRate(game, currentId)
  const progressPct = project ? Math.min(100, (project.progress / projectCost(project.type)) * 100) : 0
  const allies = Object.values(game.factions)
    .filter((f) => f.id !== currentId && f.alignment === current.alignment && current.alignment !== 'neutral')

  return (
    <aside className="sidebar">
      <div className="panel">
        <h1>ESCALATION</h1>
        <div className="row-between" style={{ marginTop: '4px' }}>
          <span className="turn">Round {game.turn}</span>
          {confirmRestart ? (
            <span style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.7rem' }}>
              Sure?
              <button className="ghost" onClick={() => { reset(); setConfirmRestart(false) }} style={{ fontSize: '0.7rem', padding: '2px 6px' }}>Yes</button>
              <button className="ghost" onClick={() => setConfirmRestart(false)} style={{ fontSize: '0.7rem', padding: '2px 6px' }}>Cancel</button>
            </span>
          ) : (
            <button className="ghost" onClick={() => setConfirmRestart(true)} style={{ fontSize: '0.7rem', padding: '2px 8px' }}>Restart</button>
          )}
        </div>

      </div>

      {game.regimeFallen ? (
        <div className="panel gameover">
          <h2>Game Over</h2>
          <p><strong>{game.factions[game.regimeFallen].name}</strong>’s government has fallen.</p>
          <button className="primary" onClick={reset}>New Crisis</button>
        </div>
      ) : (
        <>
          <div className="panel current-turn" style={{ borderColor: current.color }}>
            <h2>Now acting</h2>
            <div className="unit-head">
              <span className="dot" style={{ background: current.color }} />
              <strong>{current.name}</strong>
              <span className="ftype">{game.turnIndex + 1}/{game.order.length}</span>
            </div>
            <div className="stat-row">
              <span>Support <strong>{current.support}</strong></span>
              <span>Economy <strong>{current.market}</strong></span>
            </div>
            {air.bases > 0 && (
              <div className="air-power">
                <span>Air bases <strong>{air.bases}</strong> · {air.charges} sorties</span>
              </div>
            )}
          </div>

          <div className="panel procurement-panel">
            <h2>Procurement</h2>
            <div className="seg-row">
              {POLICIES.map((p) => (
                <button key={p} className={proc.policy === p ? 'active' : ''} onClick={() => setPolicy(p)}>{POLICY_LABEL[p]}</button>
              ))}
            </div>
            <div className="seg-row compact">
              {BURDENS.map((b) => (
                <button key={b} className={proc.burden === b ? 'active' : ''} onClick={() => setBurden(b)}>{BURDEN_LABEL[b]}</button>
              ))}
            </div>
            <div className="proc-status">
              {project ? (
                <>
                  <div className="meter-label">
                    <span>{PROJECT_LABEL[project.type]}</span>
                    <strong>{Math.floor(project.progress)}/{projectCost(project.type)} · +{rate}</strong>
                  </div>
                  <div className="meter small"><div className="meter-fill" style={{ width: `${progressPct}%`, background: current.color }} /></div>
                </>
              ) : (
                <p className="hint flush">No active build.</p>
              )}
            </div>
            <div className="project-grid">
              {PROJECTS.map((p) => {
                const army = p === 'army_group'
                const hardware = !army
                const disabled = (army && proc.policy !== 'draft') || (hardware && proc.policy !== 'contracts' && proc.policy !== 'emergency')
                return <button key={p} disabled={disabled} onClick={() => startProject(p)}>{PROJECT_LABEL[p]}</button>
              })}
            </div>
            {allies.length > 0 && (
              <div className="aid-list">
                {allies.map((ally) => (
                  <div key={ally.id} className="aid-row">
                    <span>{ally.name}</span>
                    <button onClick={() => sendAid(ally.id, 'economic')}>Economic Aid</button>
                    <button onClick={() => sendAid(ally.id, 'arms')}>Arms</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="panel">
            <h2>{targeting ? 'Choose a target' : selectedBase ? 'Air Base' : 'Selected Force'}</h2>
            {targeting ? (
              <>
                <p className="hint">Click a <span style={{ color: '#ef4444' }}>red</span> hex to strike. Hitting a city rallies its population — a political risk.</p>
                <button className="ghost full" onClick={cancelAction}>Cancel</button>
              </>
            ) : selectedBase ? (
              <>
                <div className="unit-head">
                  <span className="dot" style={{ background: game.factions[selectedBase.owner].color }} />
                  Air base <span className="ftype">· {baseCharges}/{selectedBase.maxCharges ?? 2} sorties</span>
                </div>
                <p className="hint">Launch aircraft at any enemy in range. Devastating against army groups.</p>
                <div className="action-row">
                  <button disabled={baseCharges < 1} onClick={() => enterAirStrike('limited')}>Limited</button>
                  <button disabled={baseCharges < 2} onClick={() => enterAirStrike('full')}>Full</button>
                </div>
              </>
            ) : selected ? (
              <>
                <div className="unit-head">
                  <span className="dot" style={{ background: game.factions[selected.owner].color }} />
                  {LABEL[selected.type].replace(/^an? /, '')} · {selected.health}/{selected.maxHealth} HP · str {selected.strength}
                  {selected.maxCharges != null && <span className="ftype">· {charges}/{selected.maxCharges} ⚡</span>}
                </div>
                <p className="hint">{FORCE_NOTE[selected.type]}</p>
                <div className="action-row">
                  {claimable && <button onClick={claim}>Claim {tile?.dmz ? 'DMZ' : 'hex'}</button>}
                  {strikeable && <button disabled={charges < 1} onClick={() => enterStrike('limited')}>Limited</button>}
                  {strikeable && <button disabled={charges < 2} onClick={() => enterStrike('full')}>Full</button>}
                </div>
                <p className="hint">{selected.acted ? 'This force has already acted this turn.' : 'Click a highlighted hex to deploy or attack.'}</p>
              </>
            ) : (
              <p className="hint">It is <strong style={{ color: current.color }}>{current.name}</strong>’s turn. Click a force to move it, claim ground, or strike — or click one of your <strong>air bases</strong> (✈) to launch an air strike.</p>
            )}
          </div>

          <div className="panel actions">
            <button className="primary" onClick={endTurn} style={{ background: current.color }}>End {current.name}’s Turn ▸</button>
            <button className="ghost" onClick={reset}>Restart</button>
          </div>
        </>
      )}
    </aside>
  )
}
