# Escalation

A turn-based geopolitical crisis war-game where the opposing nations are driven by
**LLM agents**. Force is treated as an extension of politics: every military move is a
*signal*, and the AI reads it. You do not win by destroying the enemy; you win by
achieving political objectives without tipping the crisis into catastrophe.

> Proof-of-concept / portfolio piece. Run it locally, bring your own API key.
> Not a commercial product, not hosted anywhere.

## Status: playable local prototype

What works today:

- Authored hex map with fictional coalition, bloc, and neutral nations.
  Contested territory is limited to authored disputed flashpoints.
- Select forces, move them across the board, claim territory, launch limited or full
  strikes, stage embargoes, procure units, and send aid.
- LLM-driven AI turns use the same engine actions as the player. The prompt frames the
  game as a political crisis simulation, not a simple territory grab.
- Diplomacy supports short state-to-state messages, ceasefire requests, peace offers,
  mediated peace between two other nations, and return-land terms.
- Player-facing diplomacy resolves immediately when a request targets the player. The
  rest of the turn is locked until the player accepts or rejects it.
- If every city of a nation is occupied, that government goes into exile. Exiled
  governments can issue statements, send messages, request peace, and mediate, but
  cannot command forces, trade, aid, procurement, or territory.
- City occupation transfers the city icon to the occupying nation's color.
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

Provider config lives in `.env`:

```bash
AI_PROVIDER=openai
OPENAI_MODEL=gpt-5.4-mini

# or
AI_PROVIDER=anthropic
ANTHROPIC_MODEL=claude-haiku-4-5-20251001
```

```bash
npm run typecheck   # type-check without emitting
npm run build       # production build
```

## How to play

1. Click one of your **blue** units to select it.
2. Click a highlighted hex to move, attack, or enter a contested tile.
3. Use the diplomacy panel to send messages, request ceasefires, mediate peace, or
   offer return-land terms.
4. Stage embargoes in the faction list; they commit when you end your turn.
5. Hit **End Turn** or **AI: Take Turn** to advance play.
6. Watch recent dispatches. The agents are intended to respond to what just happened,
   not blindly optimize for conquest.

## Roadmap

| Phase | Adds |
|---|---|
| 1 | Hex map, forces, strikes, turn loop, sound |
| 2 | LLM agent harness, provider switching, legal-action prompts |
| 3 | Diplomacy, mediation, ceasefires, return-land terms, exile governments |
| 4 | Richer political scoring, better adjudication, spoken dispatches, polish |

## Tech

TypeScript, React, Vite, Zustand, SVG. No game engine; it is turn-based and text-heavy,
so the browser is the right tool. The LLM integration runs through a thin local route so
your API key never touches the client. Set `AI_PROVIDER=openai` or
`AI_PROVIDER=anthropic` to choose the backend; OpenAI is the default.
