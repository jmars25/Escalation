# Escalation — Design Doc

> A turn-based geopolitical crisis war-game where the opposing nations are driven by
> LLM agents. Force is treated as an extension of politics: every military action is a
> signal, and the AI reads it. A proof-of-concept / portfolio piece, given away on
> GitHub, run locally with your own API key.

---

## 1. Goals & non-goals

**Goal:** demonstrate modern LLM *agent* work inside something fun and legible. The
showpiece is watching multiple AI agents — each with a distinct national doctrine —
independently reason about the player's moves and react to one another. Impress a
technical audience.

**This is NOT:**
- A commercial product. No monetization, no accounts, no analytics.
- A hosted service. It ships as a GitHub repo you clone and run locally.
- A real-time/RTS game. It is turn-based. Nothing animates in real time.
- A graphics showcase. The map is functional; the *agents* are the star.
- **A grand-strategy / 4X game.** No procurement or resource economy. No conquest,
  attrition, or territory as a win condition. Those are explicitly out.

> **North star — a political sandbox, not a war game.** The core is *relations and the
> domestic politics of decision-making*. War is an **emergent failure state** of bad
> relations, never the objective. Force is the means that deteriorating politics reaches
> for. Striking a city is a *political* act (coercion + the rally-round-the-flag backfire),
> not a step toward military victory. If total war does erupt, strikes still need logic —
> but it is *defensive degradation* (stop them hitting your cities/forces) and *coercion*
> (raise the cost of continuing), never land-taking or economic grinding.

**Design pillars**
1. **Agents are the brain, the engine is thin.** Game rules are minimal; the LLM makes
   the interesting decisions.
2. **Reasoning is legible.** The player can read *why* the rival did what it did. This is
   the demo's "wow."
3. **Force is political.** No "destroy the enemy" win state. The win is political: achieve
   your objective (deter / compel / hold the coalition / keep your government standing)
   without your domestic support, relations, or legitimacy collapsing.
4. **Two minds per nation.** A **Government** (decides) and a **Population** (its mood
   constrains what the government can sustain). The player controls one Government.
5. **Cheap to run, easy to clone.** Bring-your-own-key, one command to start.

### Political model (the real core)
The variables that matter are political, not material:
- **Relations** — bilateral tension/trust between nations. The engine; war is downstream.
- **Domestic support** — each Government's backing at home. Bounds its freedom of action;
  collapse = forced capitulation / regime change (a political lose condition).
- **Escalation** — the global crisis temperature (already built).
- **Coalition cohesion** — do your actions hold the bloc together or fracture it.

Actions move these (pre-LLM: simple numeric rules; Phase 3: the agents judge/drive them).
Strikes: escalation up + relations/standing damage + **rally the target's population behind
its government** (often counterproductive); military targets additionally degrade the
enemy's ability to strike you.

---

## 2. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript | One language across UI + game logic + agent glue |
| Build/UI | Vite + React | `UI = f(gameState)` fits turn-based perfectly; instant dev server |
| Rendering | SVG (hex map) + HTML/CSS (panels) | No drawn art; war-games are 70% menus/text, which HTML nails |
| State | Zustand (or plain reducer) | Game state is one serializable object; simple turn transitions |
| Backend | Tiny local Node route | Only exists to hold the API key off the client. ~30 lines |
| LLM | Claude (Anthropic API), tool use for structured moves | Valid JSON decisions, not prose to parse |
| Audio | Howler.js (SFX/music) + Web Speech API (voice) | Free, no assets needed for voice |

**Explicitly rejected: three.js / Godot / Unity.** The game is 2D, turn-based, and
text-heavy. An engine would make the dialogue/reasoning/menu UI *harder* and buys nothing
without real-time rendering or physics. Closest genre cousin is a board war-game
(*Twilight Struggle*), not Civ.

**Why not a single static HTML file:** the API key cannot live in browser code. A thin
local server solves it. For a giveaway that's fine — contributors run it themselves.

---

## 3. The scenario

Asymmetric, fictional, abstract. Fixed cast:

| Faction | Controlled by | Role |
|---|---|---|
| **The Hegemon** (you) | Human | A strong nation pursuing a political objective |
| **Allies** (N small nations) | LLM agents | Friendly but self-interested; each has its own risk tolerance and red lines |
| **The Rival** | LLM agent | An opposed government. **Not hostile at start**, but adversarial. The primary antagonist agent |

Optional later: neutral/swing states the rival and you both court.

The drama: you act → the Rival interprets your force posture as a political signal and
escalates or de-escalates → your Allies decide how much risk to absorb on your behalf.
Holding your coalition together is as important as deterring the Rival.

---

## 4. Core systems

### 4.1 Hex map
- Authored hex grid (axial coordinates). No drawn art.
- Each hex has an owner, plus simple terrain affecting movement/posture.
- Contested hexes are explicit disputed flashpoints, not every faction border.
- Rendered as SVG polygons; fill = owner color, hatch pattern = contested.
- The map is a *board*, not a simulation. It exists to give moves spatial meaning.

### 4.2 Units & posture
A unit is a token with stats — no animation:
```ts
{ id, owner, type: 'ground'|'air'|'naval', strength, posture: 'defensive'|'forward'|'strike', hex }
```
**Posture is the political lever.** Moving a carrier group to `forward` near the Rival's
border is itself a signal the Rival's agent will react to — even if no shot is fired.

### 4.3 Strike packages (orders)
The "command military units" feature is an **order composer**, not a combat sim:
1. Select assets → 2. Select target hex → 3. Select objective (demonstrate / interdict /
decapitate / etc.) → 4. Confirm.

Resolution = a function of game state + randomness + (later) the **Adjudicator agent**,
which produces both the *mechanical* outcome and a *political* outcome (escalation delta,
ally reactions). A strike is mostly a political act with military side effects.

### 4.4 Escalation model — **the spine of the game**
This is the real design work, more than the map or units. A scalar `escalation: 0–100`
(plus per-relationship tension). Every action has an escalation cost/signal value. The
Rival agent reasons *against* this state. Thresholds gate Rival behavior (e.g. >70 = Rival
considers kinetic responses; >90 = catastrophe / lose condition). Designed early; tuned
forever.

### 4.5 Diplomacy & dialogue
Structured + free-text exchanges with other nations: ultimatums, offers, back-channels,
public statements. Later these are LLM-generated and the player can *negotiate in natural
language*. Each message is logged and read aloud (§6).

### 4.6 Win / lose (political, not military)
- **Win:** achieve your objective while keeping escalation below catastrophe and your
  coalition intact.
- **Lose:** tip into catastrophic escalation, OR lose your allies, OR the Rival achieves
  *its* objective.
Multiple endings make the "war-gaming" framing land.

---

## 5. Agent architecture — the centerpiece

This is what the repo is really demonstrating. Keep it visible and impressive.

**Agents**
- **Rival agent** — system prompt = its doctrine, red lines, objectives, risk tolerance.
  Receives the world state (filtered to what it could plausibly know) and returns a
  structured move + an internal assessment.
- **Ally agents** — one per ally; each decides how far to back the player given its own
  interests. They react to the Rival's moves too, not just the player's.
- **Adjudicator/narrator agent** — turns mechanical outcomes into narrative dispatches and
  resolves ambiguous results. This is also the voice that gets read aloud.

**Structured moves via tool use.** Agents don't return prose to be parsed; they call tools
(`move_unit`, `issue_statement`, `propose_deal`, `change_posture`, `do_nothing`) so every
decision is valid, typed JSON. This is itself a thing to show off.

**Turn loop**
```
Player phase:  move units / compose orders / conduct diplomacy
      ↓
Resolution:    apply player moves, update escalation
      ↓
AI phase:      for each AI faction → send {filtered world state, doctrine} →
               Claude returns structured move + reasoning
      ↓
Adjudication:  Adjudicator agent narrates outcomes, computes political fallout
      ↓
Render + advance turn
```

**Legibility (the wow factor).** Surface each agent's reasoning: an "intelligence
assessment" panel showing the Rival's internal read of the situation, why it chose its
move, and how its disposition shifted. Watching three doctrines diverge on the same board
state is the demo.

**De-risking:** build the entire loop with a **stub AI** (random/rule-based) first, then
swap in Claude. The game must be playable before any token is spent.

---

## 6. Sound design

Free, no-asset-required, and one genuine showpiece.

- **Voice (showpiece):** the **Web Speech API** (`speechSynthesis`) reads diplomatic
  dispatches and the Rival's ultimatums aloud in a synthetic voice. Built into the
  browser, zero cost, zero assets, and "the Rival's ultimatum spoken aloud" is striking.
  *Upgrade path:* swap in ElevenLabs for higher-quality, distinct per-nation voices (BYO
  key, optional).
- **Music/ambience:** a low tension-bed that intensifies as `escalation` rises — drive
  volume/layers off the escalation scalar. CC0 packs (e.g. Kenney, freesound CC0).
- **SFX:** UI clicks, order-confirm, alert stings for threshold crossings. CC0 packs.
- **Engine:** Howler.js for mixing/looping/ducking.

All audio assets bundled in-repo must be CC0 / public-domain so the giveaway has no license
strings attached.

---

## 7. Data model (everything is JSON)

```ts
interface GameState {
  turn: number
  escalation: number                     // 0–100, the spine
  factions: Record<FactionId, {
    name: string
    type: 'player' | 'ally' | 'rival'
    doctrine: string                      // → system prompt
    redLines: string[]
    objectives: string[]
    disposition: number                   // toward the player
  }>
  hexes: Record<Coord, { owner: FactionId | null; contested: boolean; terrain: Terrain }>
  units: Unit[]
  pendingOrders: Order[]                  // strike packages
  relationships: Record<FactionPair, number>  // tension
  log: Event[]                            // dispatches, reasoning, outcomes
}
```
Whatever an agent needs to "think" lives in this object — which is exactly what gets sent
to Claude (filtered per faction's knowledge). Strike packages are `Order`s; dialogue lines
are `Event`s. Nothing here needs an engine.

---

## 8. Build plan (phased)

**Phase 1 — Playable skeleton, NO LLM.**
Vite + React + TS scaffold. Procedural SVG hex grid. Place the fixed cast. Turn loop runs
end to end with a **stub AI** (random/rule-based). Add basic SFX/click sound. Outcome: you
can click around and take turns. *De-risks everything before spending a token.*

**Phase 2 — Game systems, still stubbed AI.**
Unit movement, posture, the strike-package order composer, the escalation model, and the
political win/lose conditions. Tension-driven music bed. Outcome: a real game with a dumb
opponent.

**Phase 3 — Drop in Claude (the point of the project).**
Thin local Node route (`/api/agent`, reads `.env`). Replace the stub: Rival + Allies become
Claude agents with doctrine system prompts, returning structured moves via tool use. Add
the Adjudicator agent. Surface reasoning in the intelligence-assessment panel.

**Phase 4 — Diplomacy, voice & polish.**
Natural-language negotiation with the Rival/Allies. Web Speech API reading dispatches aloud.
Reasoning UI polish. Scenario authoring. Save/load. A README that *sells the agent work*
(this matters as much as the code for a portfolio piece).

---

## 9. Repo & developer experience

- **One command to run:** `npm install && npm run dev` starts the Vite app + the local API
  route together.
- **BYO key:** `.env.example` with `ANTHROPIC_API_KEY=`; the app shows a friendly "add your
  key" screen if it's missing.
- **README as a pitch:** GIF of the turn loop, a screenshot of the Rival's reasoning panel,
  a short "how the agents work" section. For a portfolio piece the README *is* the product.
- **All bundled assets CC0.** No license friction for people cloning it.

---

## 10. Open design questions (decide before/at each phase)

1. **Escalation tuning:** single global scalar, or per-relationship tension that rolls up?
   (Start global, add per-relationship if it feels flat.)
2. **Knowledge model:** how much of the world state does each agent see? Full visibility is
   simplest; fog/intel is more realistic and more impressive. (Start full, add fog later.)
3. **How many allies?** Suggest 2–3 for the demo — enough for divergent reactions, few
   enough to read.
4. **Win conditions:** how many distinct endings, and what exactly triggers each?
5. **Cost control:** how many agent calls per turn, and do Allies always act or only when
   stakes cross a threshold? (Gate Ally calls on relevance to keep token use sane.)
