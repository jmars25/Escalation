import { useState } from 'react'
import { useGameStore } from '../store/useGameStore'
import { LABEL, PROJECT_LABEL, airPower, canClaim, canStrike, hasHostileExchange, pairKey, procurementRate, projectCost, restorableContested, returnableLand } from '../game/engine'
import { key } from '../game/hexUtils'
import type { CeasefireRequest, GameState, Hex, ProcurementBurden, ProcurementPolicy, ProcurementProjectType } from '../game/types'


const FORCE_NOTE: Record<string, string> = {
  army_group: 'Deploys anywhere inside its country, or attacks adjacent ground to claim it.',
  marine: 'A lighter army group. Deploys over home soil or out onto the strait, then storms adjacent coast from the sea.',
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
  if (request.kind === 'mediation') {
    const sideA = game.factions[request.to]?.name ?? request.to
    const sideB = game.factions[request.counterpartId ?? '']?.name ?? request.counterpartId ?? 'unknown party'
    return `${from} mediates ${sideA} - ${sideB}`
  }
  if (request.kind === 'peace_offer') return `${from} offers peace`
  return `${from} asks for ceasefire`
}

function termText(game: GameState, request: CeasefireRequest): string[] {
  return (request.terms ?? []).map((term) =>
    term.type === 'return_land'
      ? `Return (${term.hex.q},${term.hex.r}) from ${game.factions[term.from]?.name ?? term.from} to ${game.factions[term.to]?.name ?? term.to}`
      : `${game.factions[term.from]?.name ?? term.from} pulls back from (${term.hex.q},${term.hex.r}) — restored to contested`,
  )
}

function peacePairAttemptedThisTurn(game: GameState, a: string, b: string): boolean {
  return (game.peacePairAttemptTurn?.[pairKey(a, b)] ?? -1) >= game.turn
}

function hexChoiceKey(hex: Hex): string {
  return `${hex.q},${hex.r}`
}

function toggleHexChoice(selected: string[], hex: Hex): string[] {
  const k = hexChoiceKey(hex)
  return selected.includes(k) ? selected.filter((item) => item !== k) : [...selected, k]
}

export function Sidebar() {
  const [confirmRestart, setConfirmRestart] = useState(false)
  const [diploTarget, setDiploTarget] = useState('')
  const [diploMessage, setDiploMessage] = useState('')
  const [peaceReturnKeys, setPeaceReturnKeys] = useState<string[]>([])
  const [peaceRestoreKeys, setPeaceRestoreKeys] = useState<string[]>([])
  const [mediateSideA, setMediateSideA] = useState('')
  const [mediateSideB, setMediateSideB] = useState('')
  const [mediateMessage, setMediateMessage] = useState('')
  const [mediationReturnKeys, setMediationReturnKeys] = useState<string[]>([])
  const [mediationRestoreKeys, setMediationRestoreKeys] = useState<string[]>([])
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
  const autoTakeTurns = useGameStore((s) => s.autoTakeTurns)
  const publicOpinion = useGameStore((s) => s.publicOpinionArticle)
  const setAutoTakeTurns = useGameStore((s) => s.setAutoTakeTurns)
  const setPolicy = useGameStore((s) => s.setProcurementPolicy)
  const setBurden = useGameStore((s) => s.setProcurementBurden)
  const startProject = useGameStore((s) => s.startProcurement)
  const sendAid = useGameStore((s) => s.sendAidPackage)
  const sendMessage = useGameStore((s) => s.sendDiplomaticMessage)
  const mediatePeace = useGameStore((s) => s.mediatePeace)
  const requestPeace = useGameStore((s) => s.requestPeace)
  const requestCeasefire = useGameStore((s) => s.requestCeasefire)
  const answerCeasefire = useGameStore((s) => s.respondCeasefire)

  const currentId = game.order[game.turnIndex]
  const current = game.factions[currentId]
  const currentExiled = !!current.exiled
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
  const incomingCeasefires = (game.ceasefireRequests ?? []).filter((request) =>
    request.kind === 'mediation'
      ? game.factions[request.to]?.type === 'player' || (!!request.counterpartId && game.factions[request.counterpartId]?.type === 'player')
      : game.factions[request.to]?.type === 'player',
  )
  const responseRequired = incomingCeasefires.length > 0
  const turnLocked = aiPending || responseRequired
  const opinionDelta = publicOpinion
    ? publicOpinion.supportDelta > 0 ? `+${publicOpinion.supportDelta}` : String(publicOpinion.supportDelta)
    : ''
  const canSendDiplomacy = !!selectedDiploTarget && diploMessage.trim().length > 0 && !turnLocked
  const selectedPair = [currentId, selectedDiploTarget].sort().join('|')
  const selectedPairHasFire = hasHostileExchange(game, currentId, selectedDiploTarget)
  const ceasefireUnavailable =
    !selectedPairHasFire ||
    (game.ceasefires ?? []).includes(selectedPair) ||
    peacePairAttemptedThisTurn(game, currentId, selectedDiploTarget) ||
    (game.ceasefireRequests ?? []).some((request) =>
      pairKey(request.to, request.counterpartId ?? request.from) === selectedPair,
    )
  const mediationPair = [selectedMediateA, selectedMediateB].sort().join('|')
  const mediationPairHasFire = hasHostileExchange(game, selectedMediateA, selectedMediateB)
  const mediationUnavailable =
    !selectedMediateA ||
    !selectedMediateB ||
    selectedMediateA === selectedMediateB ||
    !mediationPairHasFire ||
    (game.ceasefires ?? []).includes(mediationPair) ||
    peacePairAttemptedThisTurn(game, selectedMediateA, selectedMediateB) ||
    (game.ceasefireRequests ?? []).some((request) =>
      pairKey(request.to, request.counterpartId ?? request.from) === mediationPair,
    )
  const mediationText =
    mediateMessage.trim() ||
    diploMessage.trim() ||
    'We ask both governments to accept a mediated pause in hostilities and prevent further escalation.'
  const canMediate = !turnLocked && !mediationUnavailable
  const peaceReturnOptions = returnableLand(game, currentId).filter((land) => land.to === selectedDiploTarget)
  const selectedPeaceReturnHexes = peaceReturnOptions
    .filter((land) => peaceReturnKeys.includes(hexChoiceKey(land.hex)))
    .map((land) => land.hex)
  // Seized flashpoints the acting nation could hand back to contested status as a term.
  const peaceRestoreOptions = restorableContested(game, currentId)
  const selectedPeaceRestoreHexes = peaceRestoreOptions
    .filter((land) => peaceRestoreKeys.includes(hexChoiceKey(land.hex)))
    .map((land) => land.hex)
  const mediationReturnOptions = selectedMediateA && selectedMediateB
    ? returnableLand(game, selectedMediateB).filter((land) => land.to === selectedMediateA)
    : []
  const selectedMediationReturnHexes = mediationReturnOptions
    .filter((land) => mediationReturnKeys.includes(hexChoiceKey(land.hex)))
    .map((land) => land.hex)
  const mediationRestoreOptions = selectedMediateA && selectedMediateB
    ? restorableContested(game, selectedMediateB)
    : []
  const selectedMediationRestoreHexes = mediationRestoreOptions
    .filter((land) => mediationRestoreKeys.includes(hexChoiceKey(land.hex)))
    .map((land) => land.hex)
  const [expandedDiplomacy, setExpandedDiplomacy] = useState(false)
  const handleAutoTakeTurns = (enabled: boolean) => {
    setAutoTakeTurns(enabled)
    if (enabled && !turnLocked && current.type !== 'player') {
      setTimeout(() => { void runAiTurn() }, 0)
    }
  }

  const renderReturnChoices = (
    options: Array<{ hex: Hex; to: string }>,
    selectedKeys: string[],
    onToggle: (hex: Hex) => void,
    label: string,
  ) => options.length > 0 && (
    <div className="return-terms">
      <div className="terms-title">{label}</div>
      {options.map((land) => {
        const k = hexChoiceKey(land.hex)
        return (
          <label key={k} className="return-row">
            <input
              type="checkbox"
              checked={selectedKeys.includes(k)}
              onChange={() => onToggle(land.hex)}
              disabled={turnLocked}
            />
            <span>({land.hex.q},{land.hex.r}) to {game.factions[land.to]?.name ?? land.to}</span>
          </label>
        )
      })}
    </div>
  )

  const renderRestoreChoices = (
    options: Array<{ hex: Hex }>,
    selectedKeys: string[],
    onToggle: (hex: Hex) => void,
    label: string,
  ) => options.length > 0 && (
    <div className="return-terms">
      <div className="terms-title">{label}</div>
      {options.map((land) => {
        const k = hexChoiceKey(land.hex)
        return (
          <label key={k} className="return-row">
            <input
              type="checkbox"
              checked={selectedKeys.includes(k)}
              onChange={() => onToggle(land.hex)}
              disabled={turnLocked}
            />
            <span>({land.hex.q},{land.hex.r}) → contested</span>
          </label>
        )
      })}
    </div>
  )

  const renderDiplomacyControls = () => (
    <>
      <select value={selectedDiploTarget} onChange={(event) => setDiploTarget(event.target.value)} disabled={turnLocked}>
        {diplomacyTargets.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
      </select>
      <textarea
        value={diploMessage}
        onChange={(event) => setDiploMessage(event.target.value)}
        placeholder="Diplomatic message, max 3 sentences"
        maxLength={420}
        rows={3}
        disabled={turnLocked}
      />
      {renderReturnChoices(
        peaceReturnOptions,
        peaceReturnKeys,
        (hex) => setPeaceReturnKeys((selectedKeys) => toggleHexChoice(selectedKeys, hex)),
        'Offer returned land',
      )}
      {renderRestoreChoices(
        peaceRestoreOptions,
        peaceRestoreKeys,
        (hex) => setPeaceRestoreKeys((selectedKeys) => toggleHexChoice(selectedKeys, hex)),
        'Restore contested territory',
      )}
      <div className="action-row">
        <button
          disabled={!canSendDiplomacy}
          onClick={() => { sendMessage(selectedDiploTarget, diploMessage); setDiploMessage('') }}
        >Send</button>
        <button
          disabled={!canSendDiplomacy || ceasefireUnavailable}
          title={selectedPairHasFire ? undefined : 'Ceasefire requires prior exchange of fire between these countries.'}
          onClick={() => {
            void requestCeasefire(selectedDiploTarget, diploMessage, selectedPeaceReturnHexes, selectedPeaceRestoreHexes)
            setDiploMessage('')
            setPeaceReturnKeys([])
            setPeaceRestoreKeys([])
          }}
        >Ask Ceasefire</button>
        <button
          disabled={!canSendDiplomacy || ceasefireUnavailable}
          title={selectedPairHasFire ? undefined : 'Peace offer requires prior exchange of fire between these countries.'}
          onClick={() => {
            void requestPeace(selectedDiploTarget, diploMessage, selectedPeaceReturnHexes, selectedPeaceRestoreHexes)
            setDiploMessage('')
            setPeaceReturnKeys([])
            setPeaceRestoreKeys([])
          }}
        >Offer Peace</button>
      </div>
      <div className="mediation-box">
        <div className="mediation-row">
          <select value={selectedMediateA} onChange={(event) => setMediateSideA(event.target.value)} disabled={turnLocked}>
            {mediationTargets.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          <select value={selectedMediateB} onChange={(event) => setMediateSideB(event.target.value)} disabled={turnLocked}>
            {mediationTargets.filter((f) => f.id !== selectedMediateA).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </div>
        <textarea
          value={mediateMessage}
          onChange={(event) => setMediateMessage(event.target.value)}
          placeholder="Mediation proposal, max 3 sentences"
          maxLength={420}
          rows={2}
          disabled={turnLocked}
        />
        {renderReturnChoices(
          mediationReturnOptions,
          mediationReturnKeys,
          (hex) => setMediationReturnKeys((selectedKeys) => toggleHexChoice(selectedKeys, hex)),
          `${game.factions[selectedMediateB]?.name ?? selectedMediateB} returns land`,
        )}
        {renderRestoreChoices(
          mediationRestoreOptions,
          mediationRestoreKeys,
          (hex) => setMediationRestoreKeys((selectedKeys) => toggleHexChoice(selectedKeys, hex)),
          `${game.factions[selectedMediateB]?.name ?? selectedMediateB} restores contested territory`,
        )}
        <button
          className="ghost full"
          disabled={!canMediate}
          title={mediationPairHasFire ? undefined : 'Mediation requires prior exchange of fire between the two parties.'}
          onClick={() => {
            void mediatePeace(selectedMediateA, selectedMediateB, mediationText, selectedMediationReturnHexes, selectedMediationRestoreHexes)
            setMediateMessage('')
            setMediationReturnKeys([])
            setMediationRestoreKeys([])
            if (!mediateMessage.trim()) setDiploMessage('')
          }}
        >Mediate Peace</button>
      </div>
    </>
  )

  const renderIncomingCeasefireModal = () => incomingCeasefires.length > 0 && (
    <div className="modal-backdrop ceasefire-modal-backdrop">
      <div className="expanded-window ceasefire-window" role="dialog" aria-modal="true" aria-label="Ceasefire proposal">
        <div className="modal-head">
          <h2>Ceasefire Proposal</h2>
        </div>
        <div className="expanded-body ceasefire-modal-body">
          {incomingCeasefires.map((request) => (
            <div key={request.id} className="ceasefire-request prominent">
              <strong>{requestTitle(game, request)}</strong>
              <p>{request.message}</p>
              <p className="hint flush">
                {request.kind === 'mediation'
                  ? 'This peace only takes effect if both named parties accept.'
                  : 'The proposer has already agreed; your answer decides whether this bilateral ceasefire takes effect.'}
              </p>
              {termText(game, request).map((term) => <p key={term} className="hint flush">{term}</p>)}
              <textarea
                value={ceasefireReply}
                onChange={(event) => setCeasefireReply(event.target.value)}
                placeholder="Response, max 3 sentences"
                maxLength={420}
                rows={3}
                disabled={aiPending}
              />
              <div className="action-row">
                <button disabled={aiPending} onClick={() => { void answerCeasefire(request.id, true, ceasefireReply); setCeasefireReply('') }}>Accept</button>
                <button disabled={aiPending} onClick={() => { void answerCeasefire(request.id, false, ceasefireReply); setCeasefireReply('') }}>Reject</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )

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

      {publicOpinion && (
        <div className="panel opinion-panel">
          <div className="opinion-kicker">Aurelian Opinion - Round {publicOpinion.turn}</div>
          <h3>{publicOpinion.headline}</h3>
          <div className={`opinion-score ${publicOpinion.supportDelta >= 0 ? 'positive' : 'negative'}`}>
            Support {publicOpinion.supportBefore} to {publicOpinion.supportAfter} ({opinionDelta}) - {publicOpinion.mood}
          </div>
          <p>{publicOpinion.article}</p>
          <p className="opinion-preferred"><strong>Preferred course:</strong> {publicOpinion.preferredCourse}</p>
        </div>
      )}

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
            {currentExiled && (
              <div className="exile-banner">
                Government in exile
              </div>
            )}
            {!currentExiled && air.bases > 0 && (
              <div className="air-power">
                <span>Air bases <strong>{air.bases}</strong> · {air.charges} sorties</span>
              </div>
            )}
          </div>

          {!currentExiled && <div className="panel procurement-panel">
            <h2>Procurement</h2>
            <div className="seg-row">
              {POLICIES.map((p) => (
                <button key={p} disabled={turnLocked} className={proc.policy === p ? 'active' : ''} onClick={() => setPolicy(p)}>{POLICY_LABEL[p]}</button>
              ))}
            </div>
            <div className="seg-row compact">
              {BURDENS.map((b) => (
                <button key={b} disabled={turnLocked} className={proc.burden === b ? 'active' : ''} onClick={() => setBurden(b)}>{BURDEN_LABEL[b]}</button>
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
                return <button key={p} disabled={disabled || turnLocked} onClick={() => startProject(p)}>{PROJECT_LABEL[p]}</button>
              })}
            </div>
            {allies.length > 0 && (
              <div className="aid-list">
                {allies.map((ally) => (
                  <div key={ally.id} className="aid-row">
                    <span>{ally.name}</span>
                    <button disabled={turnLocked} onClick={() => sendAid(ally.id, 'economic')}>Economic Aid</button>
                    <button disabled={turnLocked} onClick={() => sendAid(ally.id, 'arms')}>Arms</button>
                  </div>
                ))}
              </div>
            )}
          </div>}

          <div className="panel diplomacy-panel">
            <div className="panel-header">
              <h2>Diplomacy</h2>
              <button className="expand-btn" onClick={() => setExpandedDiplomacy(true)} title="Expand diplomacy" aria-label="Expand diplomacy">□</button>
            </div>
            {renderDiplomacyControls()}
          </div>

          {expandedDiplomacy && (
            <div className="modal-backdrop" onClick={() => setExpandedDiplomacy(false)}>
              <div className="expanded-window diplomacy-window" role="dialog" aria-modal="true" aria-label="Expanded diplomacy controls" onClick={(event) => event.stopPropagation()}>
                <div className="modal-head">
                  <h2>Diplomacy</h2>
                  <button className="expand-btn close-btn" onClick={() => setExpandedDiplomacy(false)} title="Close" aria-label="Close expanded window">x</button>
                </div>
                <div className="expanded-body diplomacy-panel">
                  {renderDiplomacyControls()}
                </div>
              </div>
            </div>
          )}

          <div className="panel">
            <h2>{currentExiled ? 'Government in Exile' : targeting ? 'Choose a target' : selectedBase ? 'Air Base' : 'Selected Force'}</h2>
            {currentExiled ? (
              <p className="hint flush">This government controls no cities. It can send statements, ask for ceasefires or peace, and mediate agreements.</p>
            ) : targeting ? (
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
                  <button disabled={turnLocked || baseCharges < 1} onClick={() => enterAirStrike('limited')}>Limited</button>
                  <button disabled={turnLocked || baseCharges < 2} onClick={() => enterAirStrike('full')}>Full</button>
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
                  {claimable && <button disabled={turnLocked} onClick={claim}>Claim {tile?.dmz ? 'DMZ' : 'hex'}</button>}
                  {strikeable && <button disabled={turnLocked || charges < 1} onClick={() => enterStrike('limited')}>Limited</button>}
                  {strikeable && <button disabled={turnLocked || charges < 2} onClick={() => enterStrike('full')}>Full</button>}
                </div>
                <p className="hint">{selected.acted ? 'This force has already acted this turn.' : 'Click a highlighted hex to deploy or attack.'}</p>
              </>
            ) : (
              <p className="hint">It is <strong style={{ color: current.color }}>{current.name}</strong>’s turn. Click a force to move it, claim ground, or strike — or click one of your <strong>air bases</strong> (✈) to launch an air strike.</p>
            )}
          </div>

          <div className="panel actions">
            <label className="auto-turn-toggle">
              <input
                type="checkbox"
                checked={autoTakeTurns}
                onChange={(event) => handleAutoTakeTurns(event.target.checked)}
              />
              <span>Auto AI turns until Aurelia</span>
            </label>
            <button className="primary" onClick={endTurn} style={{ background: current.color }} disabled={turnLocked}>
              End {current.name}{currentExiled ? ' Exile' : ''} Turn ▸
            </button>
            <button className="ghost" onClick={() => void runAiTurn()} disabled={turnLocked}>
              {aiPending ? "AI thinking..." : "AI: Take Turn"}
            </button>
          </div>
        </>
      )}
      {renderIncomingCeasefireModal()}
    </aside>
  )
}
