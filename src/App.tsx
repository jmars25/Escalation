import { HexMap } from './components/HexMap'
import { Sidebar } from './components/Sidebar'
import { InfoPanel } from './components/InfoPanel'
import { useGameStore } from './store/useGameStore'

export default function App() {
  const introPending = useGameStore((s) => s.introPending)
  const beginGame = useGameStore((s) => s.beginGame)

  return (
    <div className="layout">
      <Sidebar />
      <main className="board">
        <HexMap />
      </main>
      <InfoPanel />
      {introPending && (
        <div className="intro-overlay">
          <div className="intro-modal window">
            <div className="title-bar">
              <div className="title-bar-text">Escalation.exe</div>
              <div className="title-bar-controls" aria-hidden="true">
                <button aria-label="Minimize" />
                <button aria-label="Maximize" />
                <button aria-label="Close" />
              </div>
            </div>
            <div className="window-body">
              <h2>Crisis Flashpoint</h2>
              <p>Kazrek is poised to march into the demilitarized zone it claims as holy ground.</p>
              <div className="intro-actions">
                <button className="primary" onClick={beginGame}>Begin Game</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
