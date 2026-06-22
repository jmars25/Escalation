# Escalation

A turn-based geopolitical crisis war-game where the opposing nations are driven by
**LLM agents**. Force is treated as an extension of politics: every military move is a
*signal*, and the AI reads it. You do not win by destroying the enemy; you win by
achieving political objectives without tipping the crisis into catastrophe.

> Proof-of-concept / portfolio piece. Run it locally, bring your own API key.
> Not a commercial product, not hosted anywhere.

## Status: Phase 1 - playable skeleton

What works today:

- Authored hex map with eight fictional nations: **you** (the Hegemon
  *Aurelia*), one **Rival** (*Volkaria*), three **Allies**, three **Neutrals**.
  Contested territory is limited to authored disputed flashpoints.
- Select your units, move them across the board, and set their **posture**
  (defensive / forward / strike). Posture is the political lever.
- An **escalation meter** (0-100), the spine of the game. Assertive postures near the
  Rival raise it.
- A local LLM agent route can run AI turns through OpenAI or Anthropic tool calls.
- Procedural sound via the Web Audio API (no asset files).

See [`DESIGN.md`](DESIGN.md) for the full design and roadmap.

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
```

In another terminal, run the local API server for LLM turns:

```bash
cp .env.example .env
# set OPENAI_API_KEY, or set AI_PROVIDER=anthropic and ANTHROPIC_API_KEY
npm run server   # http://localhost:3001
```

```bash
npm run typecheck   # type-check without emitting
npm run build       # production build
```

## How to play

1. Click one of your **blue** units to select it.
2. Click a highlighted hex to move it, or use the order buttons in the left panel.
3. Hit **End Turn** or **AI: Take Turn** to advance play.
4. Watch the escalation meter. Pushing forces toward Volkaria raises tension.

## Roadmap

| Phase | Adds |
|---|---|
| 1 | Hex map, units, posture, escalation, turn loop, stub AI, sound |
| 2 | Strike-package orders, richer escalation model, political win/lose |
| 3 | **LLM agents** replace the stub (doctrine system prompts, tool-use moves, an Adjudicator), with surfaced reasoning |
| 4 | Natural-language diplomacy, spoken dispatches (Web Speech API), polish |

## Tech

TypeScript, React, Vite, Zustand, SVG. No game engine; it is turn-based and text-heavy,
so the browser is the right tool. The LLM integration runs through a thin local route so
your API key never touches the client. Set `AI_PROVIDER=openai` or
`AI_PROVIDER=anthropic` to choose the backend; OpenAI is the default.
