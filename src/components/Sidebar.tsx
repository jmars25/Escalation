import { useState } from 'react'
import { useGameStore } from '../store/useGameStore'
import { LABEL, PROJECT_LABEL, airPower, canClaim, canStrike, procurementRate, projectCost } from '../game/engine'
import { key } from '../game/hexUtils'
import type { CeasefireRequest, GameState, ProcurementBurden, ProcurementPolicy, ProcurementProjectType } from '../game/types'


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
const CASUALTY_FORMAT = new Intl.NumberFormat('en-US')

function requestTitle(game: GameState, request: CeasefireRequest): string {
  const from = game.factions[request.from]?.name ?? request.from
  const to = game.factions[request.counterpartId ?? request.to]?.name ?? (request.counterpartId ?? request.to)
  if (request.kind === 'mediation') return `${from} mediates peace with ${to}`
  if (request.kind === 'peace_offer') return `${from} offers peace`
  return `${from} asks for ceasefire`
}

function termText(game: GameState, request: CeasefireRequest): string[] {
  return (request.terms ?? []).map((term) =>
    `Return (${term.hex.q},${term.hex.r}) from ${game.factions[term.from]?.name ?? term.from} to ${game.factions[term.to]?.name ?? term.to}`,
  )
}

export function Sidebar() {
  const [confirmRestart, setConfirmRestart] = useState(false)
  const [diploTarget, setDiploTarget] = useState('')
  const [diploMessage, setDiploMessage] = useState('')
  const [mediateSideA, setMediateSideA] = useState('')
  const [mediateSideB, setMediateSideB] = useState('')
  const [mediateMessage, setMediateMessage] = useState('')
  const [ceasefireReply, setCeasefireReply] = useState('')
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
  const runAiTurn = useGameStore((s) => s.runAiTurn)
  const aiPending = useGameStore((s) => s.aiPending)
  const setPolicy = useGameStore((s) => s.setProcurementPolicy)
  const setBurden = useGameStore((s) => s.setProcurementBurden)
  const startProject = useGameStore((s) => s.startProcurement)
  const sendAid = useGameStore((s) => s.sendAidPackage)
  const sendMessage = useGameStore((s) => s.sendDiplomaticMessage)
  const mediatePeace = useGameStore((s) => s.mediatePeace)
  const requestCeasefire = useGameStore((s) => s.requestCeasefire)
  const answerCeasefire = useGameStore((s) => s.respondCeasefire)

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
  const globalDeaths = game.deathToll ?? 0
  const currentDeaths = game.factionDeaths?.[currentId] ?? 0
  const allies = Object.values(game.factions)
    .filter((f) => f.id !== currentId && f.alignment === current.alignment && current.alignment !== 'neutral')
  const diplomacyTargets = Object.values(game.factions).filter((f) => f.id !== currentId)
  const selectedDiploTarget = diplomacyTargets.some((f) => f.id === diploTarget) ? diploTarget : diplomacyTargets[0]?.id || ''
  const mediationTargets = Object.values(game.factions)
  const selectedMediateA = mediationTargets.some((f) => f.id === mediateSideA) ? mediateSideA : mediationTargets[0]?.id || ''
  const selectedMediateB =
    mediationTargets.some((f) => f.id === mediateSideB && f.id !== selectedMediateA)
      ? mediateSideB
      : mediationTargets.find((f) => f.id !== selectedMediateA)?.id || ''
  const incomingCeasefires = (game.ceasefireRequests ?? []).filter((request) => request.to === currentId)
  const canSendDiplomacy = !!selectedDiploTarget && diploMessage.trim().length > 0 && !aiPending
  const selectedPair = [currentId, selectedDiploTarget].sort().join('|')
  const ceasefireUnavailable =
    (game.ceasefires ?? []).includes(selectedPair) ||
    (game.ceasefireRequests ?? []).some((request) =>
      (request.from === currentId && request.to === selectedDiploTarget) ||
      (request.from === selectedDiploTarget && request.to === currentId),
    )
  const mediationPair = [selectedMediateA, selectedMediateB].sort().join('|')
  const mediationUnavailable =
    !selectedMediateA ||
    !selectedMediateB ||
    selectedMediateA === selectedMediateB ||
    (game.ceasefires ?? []).includes(mediationPair)
  const mediationText =
    mediateMessage.trim() ||
    diploMessage.trim() ||
    'We ask both governments to accept a mediated pause in hostilities and prevent further escalation.'
  const canMediate = !aiPending && !mediationUnavailable

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
        <div className="death-toll">
          <span>Death toll <strong>{CASUALTY_FORMAT.format(globalDeaths)}</strong></span>
          <span>{current.name} deaths <strong>{CASUALTY_FORMAT.format(currentDeaths)}</strong></span>
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
                <button key={p} disabled={aiPending} className={proc.policy === p ? 'active' : ''} onClick={() => setPolicy(p)}>{POLICY_LABEL[p]}</button>
              ))}
            </div>
            <div className="seg-row compact">
              {BURDENS.map((b) => (
                <button key={b} disabled={aiPending} className={proc.burden === b ? 'active' : ''} onClick={() => setBurden(b)}>{BURDEN_LABEL[b]}</button>
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
                return <button key={p} disabled={disabled || aiPending} onClick={() => startProject(p)}>{PROJECT_LABEL[p]}</button>
              })}
            </div>
            {allies.length > 0 && (
              <div className="aid-list">
                {allies.map((ally) => (
                  <div key={ally.id} className="aid-row">
                    <span>{ally.name}</span>
                    <button disabled={aiPending} onClick={() => sendAid(ally.id, 'economic')}>Economic Aid</button>
                    <button disabled={aiPending} onClick={() => sendAid(ally.id, 'arms')}>Arms</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="panel diplomacy-panel">
            <h2>Diplomacy</h2>
            {incomingCeasefires.length > 0 && (
              <div className="ceasefire-inbox">
                {incomingCeasefires.map((request) => (
                  <div key={request.id} className="ceasefire-request">
                    <strong>{requestTitle(game, request)}</strong>
                    <p>{request.message}</p>
                    {termText(game, request).map((term) => <p key={term} className="hint flush">{term}</p>)}
                    <textarea
                      value={ceasefireReply}
                      onChange={(event) => setCeasefireReply(event.target.value)}
                      placeholder="Response, max 3 sentences"
                      maxLength={420}
                      rows={2}
                    />
                    <div className="action-row">
                      <button disabled={aiPending} onClick={() => { answerCeasefire(request.id, true, ceasefireReply); setCeasefireReply('') }}>Accept</button>
                      <button disabled={aiPending} onClick={() => { answerCeasefire(request.id, false, ceasefireReply); setCeasefireReply('') }}>Reject</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <select value={selectedDiploTarget} onChange={(event) => setDiploTarget(event.target.value)} disabled={aiPending}>
              {diplomacyTargets.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
            <textarea
              value={diploMessage}
              onChange={(event) => setDiploMessage(event.target.value)}
              placeholder="Diplomatic message, max 3 sentences"
              maxLength={420}
              rows={3}
              disabled={aiPending}
            />
            <div className="action-row">
              <button
                disabled={!canSendDiplomacy}
                onClick={() => { sendMessage(selectedDiploTarget, diploMessage); setDiploMessage('') }}
              >Send</button>
              <button
                disabled={!canSendDiplomacy || ceasefireUnavailable}
                onClick={() => { void requestCeasefire(selectedDiploTarget, diploMessage); setDiploMessage('') }}
              >Ask Ceasefire</button>
            </div>
            <div className="mediation-box">
              <div className="mediation-row">
                <select value={selectedMediateA} onChange={(event) => setMediateSideA(event.target.value)} disabled={aiPending}>
                  {mediationTargets.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
                <select value={selectedMediateB} onChange={(event) => setMediateSideB(event.target.value)} disabled={aiPending}>
                  {mediationTargets.filter((f) => f.id !== selectedMediateA).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              </div>
              <textarea
                value={mediateMessage}
                onChange={(event) => setMediateMessage(event.target.value)}
                placeholder="Mediation proposal, max 3 sentences"
                maxLength={420}
                rows={2}
                disabled={aiPending}
              />
              <button
                className="ghost full"
                disabled={!canMediate}
                onClick={() => {
                  void mediatePeace(selectedMediateA, selectedMediateB, mediationText)
                  setMediateMessage('')
                  if (!mediateMessage.trim()) setDiploMessage('')
                }}
              >Mediate Peace</button>
            </div>
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
                <p className="hint">Launch aircraft at any opposing force in range. Devastating against army groups.</p>
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
            <button className="primary" onClick={endTurn} style={{ background: current.color }} disabled={aiPending}>
              End {current.name}’s Turn ▸
            </button>
            <button className="ghost" onClick={() => void runAiTurn()} disabled={aiPending}>
              {aiPending ? "AI thinking..." : "AI: Take Turn"}
            </button>
          </div>
        </>
      )}
    </aside>
  )
}
