# Escalation

A turn-based geopolitical crisis war-game where the opposing nations are driven by
**LLM agents**. Force is treated as an extension of politics: every military move is a
*signal*, and the AI reads it. You don't win by destroying the enemy — you win by
achieving political objectives without tipping the crisis into catastrophe.

> Proof-of-concept / portfolio piece. Run it locally, bring your own API key.
> Not a commercial product, not hosted anywhere.

## Status: Phase 1 — playable skeleton

What works today (no LLM, no API key needed):

- Procedurally generated hex map with eight fictional nations — **you** (the Hegemon
  *Aurelia*), one **Rival** (*Volkaria*), three **Allies**, three **Neutrals**. Territory
  is carved by nearest-capital; the frontier between two states is flagged *contested*.
- Select your units, move them across the board, and set their **posture**
  (defensive / forward / strike). Posture is the political lever.
- An **escalation meter** (0–100) — the spine of the game. Assertive postures near the
  Rival raise it.
- A **stub AI** drives every other nation (random + a more assertive Rival). This is the
  seam the Claude agents plug into next.
- Procedural sound via the Web Audio API (no asset files).

See [`DESIGN.md`](DESIGN.md) for the full design and roadmap.

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
```

```bash
npm run typecheck   # type-check without emitting
npm run build       # production build
```

## How to play (Phase 1)

1. Click one of your **blue** units to select it.
2. Click a highlighted hex to move it, or use the posture buttons in the left panel.
3. Hit **End Turn** — every AI nation acts, and the *Dispatches* log updates.
4. Watch the escalation meter. Pushing forces toward Volkaria raises tension.

## Roadmap

| Phase | Adds |
|---|---|
| 1 ✅ | Hex map, units, posture, escalation, turn loop, stub AI, sound |
| 2 | Strike-package orders, richer escalation model, political win/lose |
| 3 | **Claude agents** replace the stub (doctrine system prompts, tool-use moves, an Adjudicator), with surfaced reasoning |
| 4 | Natural-language diplomacy, spoken dispatches (Web Speech API), polish |

## Tech

TypeScript · React · Vite · Zustand · SVG. No game engine — it's turn-based and
text-heavy, so the browser is the right tool. The Claude integration (Phase 3) runs
through a thin local route so your API key never touches the client.
