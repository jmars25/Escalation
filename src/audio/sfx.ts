// Minimal procedural sound — no audio files, no licensing. Short synthesized
// tones via the Web Audio API. Phase 4 swaps/augments this with Howler.js + CC0
// music, and the Web Speech API reads dispatches aloud.

let ctx: AudioContext | null = null
let muted = false

function audio(): AudioContext | null {
  if (muted) return null
  if (!ctx) {
    try {
      ctx = new AudioContext()
    } catch {
      return null
    }
  }
  // Browsers start the context suspended until a user gesture.
  if (ctx.state === 'suspended') void ctx.resume()
  return ctx
}

function tone(freq: number, durationMs: number, type: OscillatorType = 'sine', gain = 0.05) {
  const ac = audio()
  if (!ac) return
  const osc = ac.createOscillator()
  const g = ac.createGain()
  osc.type = type
  osc.frequency.value = freq
  g.gain.value = gain
  osc.connect(g).connect(ac.destination)
  const now = ac.currentTime
  g.gain.setValueAtTime(gain, now)
  g.gain.exponentialRampToValueAtTime(0.0001, now + durationMs / 1000)
  osc.start(now)
  osc.stop(now + durationMs / 1000)
}

export const sfx = {
  setMuted(m: boolean) {
    muted = m
  },
  isMuted() {
    return muted
  },
  select() {
    tone(440, 60, 'triangle')
  },
  move() {
    tone(330, 80, 'sine')
    setTimeout(() => tone(494, 90, 'sine'), 60)
  },
  confirm() {
    tone(523, 70, 'square', 0.04)
    setTimeout(() => tone(784, 110, 'square', 0.04), 70)
  },
  /** Pitch rises with escalation so the end-of-turn cue reflects tension. */
  endTurn(escalation: number) {
    const base = 200 + escalation * 4
    tone(base, 120, 'sawtooth', 0.04)
    setTimeout(() => tone(base * 1.5, 140, 'sawtooth', 0.03), 110)
  },
  alert() {
    tone(660, 120, 'square', 0.06)
    setTimeout(() => tone(660, 120, 'square', 0.06), 180)
  },
  /** Short arcade-cabinet machine-gun burst: square ticks plus crunchy noise. */
  machineGun() {
    const ac = audio()
    if (!ac) return
    const shots = 7
    for (let i = 0; i < shots; i++) {
      const t = i * 42
      setTimeout(() => {
        tone(170 + Math.random() * 45, 28, 'square', 0.035)
        tone(720 + Math.random() * 120, 18, 'square', 0.018)
      }, t)
    }

    const dur = 0.32
    const n = Math.floor(ac.sampleRate * dur)
    const buffer = ac.createBuffer(1, n, ac.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < n; i++) {
      const gate = Math.floor(i / (ac.sampleRate * 0.04)) % 2 === 0 ? 1 : 0.35
      data[i] = (Math.random() * 2 - 1) * gate * Math.pow(1 - i / n, 1.8)
    }
    const src = ac.createBufferSource()
    src.buffer = buffer
    const hp = ac.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 700
    const bp = ac.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = 1800
    bp.Q.value = 5
    const g = ac.createGain()
    g.gain.value = 0.06
    src.connect(hp).connect(bp).connect(g).connect(ac.destination)
    src.start()
  },
  /** Explosion: a low thump + a filtered noise burst. */
  boom() {
    const ac = audio()
    if (!ac) return
    tone(85, 240, 'sine', 0.1)
    const dur = 0.35
    const n = Math.floor(ac.sampleRate * dur)
    const buffer = ac.createBuffer(1, n, ac.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2)
    const src = ac.createBufferSource()
    src.buffer = buffer
    const g = ac.createGain()
    g.gain.value = 0.2
    const lp = ac.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 1100
    src.connect(lp).connect(g).connect(ac.destination)
    src.start()
  },
}
