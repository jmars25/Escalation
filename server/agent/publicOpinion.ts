import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { applyPublicSupportDelta } from '../../src/game/engine.ts'
import type { FactionId, GameEvent, GameState, PublicOpinionArticle } from '../../src/game/types.ts'
import { agentRuntimeConfig } from './provider.ts'

type OpinionDraft = {
  delta?: unknown
  mood?: unknown
  headline?: unknown
  article?: unknown
  preferredCourse?: unknown
}

type OpinionRange = {
  min: number
  max: number
  basis: string
}

let anthropicClient: Anthropic | null = null
let openAiClient: OpenAI | null = null

export async function runPlayerPublicOpinion(
  stateBeforeEnd: GameState,
  stateAfterEnd: GameState,
  factionId: FactionId,
): Promise<{ finalState: GameState; article: PublicOpinionArticle }> {
  if (factionId !== 'aurelia' || stateBeforeEnd.factions[factionId]?.type !== 'player') {
    throw new Error('public opinion is only available for Aurelia after the player turn')
  }

  const config = agentRuntimeConfig()
  if (!config.hasKey) throw new Error(`${config.keyEnv} not set`)

  const range = opinionRange(stateBeforeEnd, factionId)
  const prompt = buildOpinionPrompt(stateBeforeEnd, stateAfterEnd, factionId, range)
  const raw = config.provider === 'openai'
    ? await completeOpenAiJson(config.model, prompt)
    : await completeAnthropicJson(config.model, prompt)
  const draft = parseOpinion(raw)
  const supportBefore = stateAfterEnd.factions[factionId]?.support ?? 0
  const delta = clampNumber(toInt(draft.delta, 0), range.min, range.max)
  const finalState = applyPublicSupportDelta(stateAfterEnd, factionId, delta)
  const supportAfter = finalState.factions[factionId]?.support ?? supportBefore

  return {
    finalState,
    article: {
      id: `op-${stateBeforeEnd.turn}-${Date.now()}`,
      turn: stateBeforeEnd.turn,
      factionId,
      supportDelta: delta,
      supportBefore,
      supportAfter,
      mood: cleanText(draft.mood, delta < 0 ? 'uneasy' : delta > 0 ? 'encouraged' : 'watchful', 32),
      headline: cleanText(draft.headline, 'Public Takes Stock of the Crisis', 90),
      article: cleanText(draft.article, fallbackArticle(delta), 700),
      preferredCourse: cleanText(draft.preferredCourse, fallbackPreferred(delta), 180),
    },
  }
}

function opinionRange(state: GameState, factionId: FactionId): OpinionRange {
  const events = playerTurnEvents(state, factionId)
  if (events.length === 0) return { min: -1, max: 4, basis: 'quiet turn or no visible public action' }

  const text = events.map((event) => event.text.toLowerCase()).join('\n')
  const neutralNames = Object.values(state.factions)
    .filter((faction) => faction.alignment === 'neutral')
    .map((faction) => faction.name.toLowerCase())
  const affectsNeutral = neutralNames.some((name) => text.includes(name))
  const cityStrike = /strike/.test(text) && /\bcity\b/.test(text)
  const militaryAction = /strike|assault|pushes into|seizes|claims|occupies|destroyed/.test(text)
  const majorClaim = /demilitarized zone|seizes disputed|claims disputed|seizes contested|claims contested/.test(text)
  const diplomacy = /asks .*ceasefire|offers .*peace|mediated peace|returns .* as part of a peace|restores trade|sends .* diplomatic message/.test(text)
  const aid = /sends economic aid|ships arms/.test(text)
  const embargo = /embargoes/.test(text)

  if (cityStrike && affectsNeutral) return { min: -26, max: -6, basis: 'strike on a neutral city' }
  if (cityStrike) return { min: -22, max: -4, basis: 'city strike' }
  if (affectsNeutral && militaryAction) return { min: -22, max: 2, basis: 'military action against a neutral state' }
  if (majorClaim) return { min: -18, max: 2, basis: 'territorial escalation' }
  if (militaryAction) return { min: -10, max: 8, basis: 'military action with contextual justification' }
  if (diplomacy && !embargo) return { min: 0, max: 12, basis: 'diplomatic or de-escalatory turn' }
  if (aid) return { min: -3, max: 8, basis: 'support to allies' }
  if (embargo) return { min: -6, max: 6, basis: 'economic pressure' }
  return { min: -5, max: 6, basis: 'mixed political turn' }
}

function buildOpinionPrompt(
  before: GameState,
  after: GameState,
  factionId: FactionId,
  range: OpinionRange,
): string {
  const faction = before.factions[factionId]
  const events = playerTurnEvents(before, factionId)
  const recent = before.log
    .filter((event) => !events.includes(event))
    .slice(0, 6)
  const eventLines = events.length
    ? events.map((event) => `- ${shortEvent(event)}`).join('\n')
    : '- No major public action recorded.'
  const recentLines = recent.length
    ? recent.map((event) => `- ${shortEvent(event)}`).join('\n')
    : '- None.'

  return `Return JSON only.
You are a private Aurelian opinion columnist judging the player government's last turn.
Pick support delta inside [${range.min}, ${range.max}] based on context. Basis: ${range.basis}.
Do not write diplomacy visible to other nations.
Fields: delta integer, mood 1-3 words, headline <=10 words, article 70-110 words, preferredCourse one sentence <=24 words.

State: ${faction.name} support ${after.factions[factionId]?.support ?? faction.support}/100, economy ${after.factions[factionId]?.market ?? faction.market}/100, crisis deaths ${after.deathToll ?? 0}.
Mandate: ${faction.objectives.join('; ')}
Red lines: ${faction.redLines.join('; ')}

Aurelia actions this turn:
${eventLines}

Recent context:
${recentLines}`
}

function playerTurnEvents(state: GameState, factionId: FactionId): GameEvent[] {
  return state.log
    .filter((event) => event.turn === state.turn && event.faction === factionId)
    .slice(0, 10)
    .reverse()
}

function shortEvent(event: GameEvent): string {
  return event.text.replace(/\s+/g, ' ').slice(0, 180)
}

async function completeOpenAiJson(model: string, prompt: string): Promise<string> {
  openAiClient ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  const response = await openAiClient.chat.completions.create({
    model,
    max_completion_tokens: 650,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: 'You score domestic public support for a short political-crisis sandbox. Output valid JSON only.' },
      { role: 'user', content: prompt },
    ],
  })
  return response.choices[0]?.message?.content ?? '{}'
}

async function completeAnthropicJson(model: string, prompt: string): Promise<string> {
  anthropicClient ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const response = await anthropicClient.messages.create({
    model,
    max_tokens: 550,
    system: 'You score domestic public support for a short political-crisis sandbox. Output valid JSON only.',
    messages: [{ role: 'user', content: prompt }],
  })
  return response.content
    .map((block) => block.type === 'text' ? block.text : '')
    .join('')
}

function parseOpinion(raw: string): OpinionDraft {
  try {
    const direct = JSON.parse(raw)
    return direct && typeof direct === 'object' && !Array.isArray(direct) ? direct as OpinionDraft : {}
  } catch {
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) return {}
    try {
      const parsed = JSON.parse(match[0])
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as OpinionDraft : {}
    } catch {
      return {}
    }
  }
}

function toInt(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(n) ? Math.round(n) : fallback
}

function cleanText(value: unknown, fallback: string, max: number): string {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  return (text || fallback).slice(0, max).trim()
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function fallbackArticle(delta: number): string {
  if (delta < 0) return 'Aurelians are not rejecting the government outright, but the latest turn has left voters asking what strategic purpose the pressure serves. The public wants clarity, restraint where possible, and proof that costs are tied to a concrete political aim rather than drift.'
  if (delta > 0) return 'Aurelians appear more confident after a turn that looked disciplined and politically legible. The government still faces a volatile crisis, but the public is rewarding signs that force, diplomacy, and alliance management are serving a recognizable objective.'
  return 'Aurelians remain watchful. The government has not clearly lost the public, but it has not earned much new trust either. Voters want the next move to connect visible risk with a concrete diplomatic or security result.'
}

function fallbackPreferred(delta: number): string {
  if (delta < 0) return 'Explain the objective, reduce avoidable escalation, and pursue a ceasefire or allied backing.'
  if (delta > 0) return 'Keep the pressure disciplined and convert the stronger mood into a diplomatic settlement.'
  return 'Clarify the next objective before taking another costly step.'
}
