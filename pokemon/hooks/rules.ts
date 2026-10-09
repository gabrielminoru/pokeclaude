import type { ChainForm, Choice, Member, Path, Progress, Stone, TimeOfDay } from '../types'
import { BASE_LEVEL, STONES } from './pokeapi'

// Pure game rules: every random pick takes an RNG, every time-dependent rule takes `now`.

export const HOUR = 3_600_000
export const BUCKET = 600_000
export const PARTY_SIZE = 6
export const MAX_LEVEL = 100
export const SHINY_ODDS = 1 / 256
export const ENCOUNTER_ATTEMPTS = 40
export const EVOLUTION_COUNTDOWN = 15_000
export const STARTERS = [
  { id: 1, name: 'bulbasaur' },
  { id: 4, name: 'charmander' },
  { id: 7, name: 'squirtle' },
] as const
export const START_FRIENDSHIP = 70

export const hourOf = (now: number) => Math.floor(now / HOUR)
export const bucketOf = (now: number) => Math.floor(now / BUCKET)

// --- Seeded randomness: every session derives the same outcome for the same hour ---

export type Rng = () => number

const hash = (text: string) => {
  let h = 1779033703 ^ text.length
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507)
  h = Math.imul(h ^ (h >>> 13), 3266489909)
  return (h ^ (h >>> 16)) >>> 0
}

export const mulberry32 = (seed: number): Rng => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const rngFor = (salt: string, hour: number, purpose: string): Rng => mulberry32(hash(`${salt}:${hour}:${purpose}`))

// --- Local time ---

export const localHour = (now: number, offsetMinutes: number) =>
  (((Math.floor((now + offsetMinutes * 60_000) / HOUR)) % 24) + 24) % 24

export const timeMatches = (time: TimeOfDay | null, hour: number) =>
  time === null ? true
  : time === 'day' ? hour >= 6 && hour < 18
  : time === 'night' ? hour >= 18 || hour < 6
  : hour >= 17 && hour < 20 // dusk

// --- Encounters ---

const NIGHT_TYPES = ['ghost', 'dark']
const DAY_TYPES = ['bug', 'grass', 'flying']
export const MAX_TYPE_FACTOR = 2

export const typeFactor = (types: string[], hour: number) => {
  const favored = timeMatches('night', hour) ? NIGHT_TYPES : DAY_TYPES
  return types.some(t => favored.includes(t)) ? 2 : 1
}

export const acceptChance = (captureRate: number, legendary: boolean, factor: number) =>
  (captureRate / 255) * (factor / MAX_TYPE_FACTOR) * (legendary ? 0.1 : 1)

export const encounterLevel = (reachLevel: number, rng: Rng) => Math.max(BASE_LEVEL, reachLevel) + Math.floor(rng() * 4)

export const isShiny = (rng: Rng) => rng() < SHINY_ODDS

/** The stone for hour `hour`, or null: one 50% roll per hour once 4 hours have passed since the last drop. */
export const stoneFor = (salt: string, hour: number, lastStoneHour: number): Stone | null => {
  if (hour - lastStoneHour < 4) return null
  const rng = rngFor(salt, hour, 'stone')
  if (rng() >= 0.5) return null
  return STONES[Math.floor(rng() * STONES.length)] ?? null
}

// --- EXP, mood, friendship ---

export type Mood = 'excited' | 'normal' | 'bored'
export const MOOD_MULTIPLIER: Record<Mood, number> = { excited: 1.5, normal: 1, bored: 0.75 }
const WINDOW = 30 * 60_000
const BORED_AFTER = 3 * HOUR

export const recentCount = (progress: Progress, now: number) => progress.recentCalls.filter(t => now - t < WINDOW).length

export const moodOf = (progress: Progress, now: number): Mood =>
  recentCount(progress, now) >= 20 ? 'excited' : now - progress.lastXpAt >= BORED_AFTER ? 'bored' : 'normal'

export const xpToNext = (level: number) => 4 + level

/** How close the recent pace is to excited (20 calls in 30 minutes), 0–1. */
export const energyOf = (progress: Progress, now: number) => Math.min(1, recentCount(progress, now) / 20)

export const MOOD_LABEL: Record<Mood, string> = { excited: 'excited ♪', normal: 'content', bored: 'bored 💤' }

export const bar = (fraction: number, slots = 6) => {
  const filled = Math.max(0, Math.min(slots, Math.round(fraction * slots)))
  return '▰'.repeat(filled) + '▱'.repeat(slots - filled)
}

export const newProgress = (level: number, friendship: number, now: number): Progress => ({
  level, xp: 0, xpFrac: 0, friendship, lastXpAt: now, recentCalls: [],
})

/** One successful tool call for the active member: mood-scaled EXP (fractions carry), then level-ups. */
export const gainCall = (progress: Progress, now: number): { progress: Progress; levelsGained: number } => {
  const pool = progress.xpFrac + MOOD_MULTIPLIER[moodOf(progress, now)]
  const whole = Math.floor(pool)
  let { level } = progress
  let xp = progress.xp + whole
  let levelsGained = 0
  while (level < MAX_LEVEL && xp >= xpToNext(level)) {
    xp -= xpToNext(level)
    level += 1
    levelsGained += 1
  }
  if (level >= MAX_LEVEL) xp = 0
  return {
    progress: {
      ...progress,
      level,
      xp,
      xpFrac: pool - whole,
      lastXpAt: now,
      recentCalls: [...progress.recentCalls.filter(t => now - t < WINDOW), now].slice(-100),
    },
    levelsGained,
  }
}

/** One 10-minute bucket with a session open: +1 normal, +2 excited, −1 every third bucket while bored. */
export const friendshipStep = (progress: Progress, now: number, bucket: number): Progress => {
  const mood = moodOf(progress, now)
  const delta = mood === 'excited' ? 2 : mood === 'normal' ? 1 : bucket % 3 === 0 ? -1 : 0
  return { ...progress, friendship: Math.max(0, Math.min(255, progress.friendship + delta)) }
}

// --- Evolution ---

const pathOf = (form: ChainForm): Path => ({ id: form.id, name: form.name })

/** The evolutions a level-up allows (level, friendship and fallback conditions; never stones). */
export const levelUpPaths = (form: ChainForm, level: number, friendship: number, hour: number): Path[] =>
  form.edges
    .filter(edge =>
      edge.conditions.some(c =>
        c.kind === 'level' ? level >= c.level && timeMatches(c.time, hour)
        : c.kind === 'friendship' ? friendship >= c.min && timeMatches(c.time, hour)
        : c.kind === 'fallback' ? level >= c.level
        : false,
      ),
    )
    .map(edge => pathOf(edge.to))

export const stonePaths = (form: ChainForm, stone: Stone): Path[] =>
  form.edges.filter(edge => edge.conditions.some(c => c.kind === 'stone' && c.stone === stone)).map(edge => pathOf(edge.to))

/** Who a found stone is offered to: the active member first, then party order. */
export const stoneTarget = (members: Member[], activeId: string | null, stone: Stone): Member | null => {
  const ordered = [...members].sort((a, b) => Number(b.id === activeId) - Number(a.id === activeId))
  return ordered.find(member => stonePaths(member.chain, stone).length > 0) ?? null
}

export const nextEvolutionText = (form: ChainForm): string => {
  if (form.edges.length === 0) return 'Final form'
  return form.edges
    .map(edge => {
      const how = edge.conditions.map(c =>
        c.kind === 'level' ? `Lv. ${c.level}${c.time ? ` (${c.time})` : ''}`
        : c.kind === 'fallback' ? `Lv. ${c.level}`
        : c.kind === 'stone' ? title(c.stone)
        : `friendship ${c.min}${c.time ? ` (${c.time})` : ''}`,
      )
      return `${title(edge.to.name)} at ${how.join(' or ')}`
    })
    .join('; ')
}

// --- Pending choices ---

const PRIORITY: Record<Choice['kind'], number> = { evolution: 0, starter: 1, encounter: 2, stone: 3 }

export const sortChoices = (choices: Choice[]) =>
  [...choices].sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || a.createdAt - b.createdAt)

/** Adds a choice, replacing one with the same id, so writing the same outcome twice is harmless. */
export const upsertChoice = (choices: Choice[], choice: Choice) => sortChoices([...choices.filter(c => c.id !== choice.id), choice])

// --- Names ---

export const title = (name: string) =>
  name.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')

export const displayName = (member: { nickname: string | null; name: string }) => member.nickname ?? title(member.name).toUpperCase()

/** A slot number (1–6) or a name (nickname or species); ambiguous names are refused with their slots. */
export const findTarget = (members: Member[], query: string): { member: Member } | { error: string } => {
  const text = query.trim()
  if (!text) return { error: 'Say which one: a slot number (1–6) or a name.' }
  if (/^\d+$/.test(text)) {
    const member = members[Number(text) - 1]
    return member ? { member } : { error: `No Pokémon in slot ${text}.` }
  }
  const lower = text.toLowerCase()
  const matches = members
    .map((member, index) => ({ member, slot: index + 1 }))
    .filter(({ member }) => member.nickname?.toLowerCase() === lower || member.name === lower.replace(/\s+/g, '-'))
  if (matches.length === 1) return { member: matches[0]!.member }
  if (matches.length === 0) return { error: `No Pokémon called "${text}" in your party.` }
  return { error: `More than one matches "${text}": slots ${matches.map(m => m.slot).join(', ')}. Use the slot number.` }
}
