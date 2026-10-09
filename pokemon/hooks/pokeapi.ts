import type { ChainForm, Condition, Stone, TimeOfDay } from '../types'

export const STONES: readonly Stone[] = [
  'fire-stone', 'water-stone', 'thunder-stone', 'leaf-stone', 'moon-stone',
  'sun-stone', 'shiny-stone', 'dusk-stone', 'dawn-stone', 'ice-stone',
]
export const SPECIES_COUNT = 1025
export const BASE_LEVEL = 5

type Named = { name: string } | null | undefined
export type RawDetail = {
  trigger?: Named
  item?: Named
  min_level?: number | null
  min_happiness?: number | null
  time_of_day?: string | null
  is_default?: boolean
  [field: string]: unknown
}
export type RawNode = { species: { name: string; url: string }; evolution_details: RawDetail[]; evolves_to: RawNode[] }

/** Per-version bookkeeping, not conditions. `condition_expression` (Wurmple's coin flip) is dropped, so every branch is offered. */
const IGNORED = new Set([
  'version_group', 'is_default', 'required_pokemon_form', 'evolved_pokemon_form', 'region', 'gender',
  'condition_expression', 'trigger',
])

const isSet = (value: unknown) => value !== null && value !== undefined && value !== false && value !== ''

export const idFromUrl = (url: string) => Number(/\/(\d+)\/?$/.exec(url)?.[1] ?? 0)

const toTime = (value: unknown): TimeOfDay | null =>
  value === 'day' || value === 'night' || value === 'dusk' ? value : null

export const fallbackLevel = (fromReach: number) => Math.max(fromReach + 10, 38)

/** First match wins: stone, then friendship, then a plain level, else the fallback level. */
export const classify = (detail: RawDetail, fromReach: number): Condition => {
  const trigger = detail.trigger?.name
  const time = toTime(detail.time_of_day)
  const item = detail.item?.name
  if (trigger === 'use-item' && item && (STONES as readonly string[]).includes(item)) {
    return { kind: 'stone', stone: item as Stone }
  }
  if (typeof detail.min_happiness === 'number') return { kind: 'friendship', min: detail.min_happiness, time }
  const extras = Object.keys(detail).filter(
    field => !IGNORED.has(field) && field !== 'min_level' && field !== 'time_of_day' && isSet(detail[field]),
  )
  if (trigger === 'level-up' && typeof detail.min_level === 'number' && extras.length === 0) {
    return { kind: 'level', level: detail.min_level, time }
  }
  return { kind: 'fallback', level: fallbackLevel(fromReach) }
}

/** Prefers the entries PokeAPI marks `is_default`, then dedupes by (kind, stone/threshold/level, time). */
export const conditionsFor = (details: RawDetail[], fromReach: number): Condition[] => {
  const defaults = details.filter(d => d.is_default === true)
  const used = defaults.length > 0 ? defaults : details
  const conditions = used.length > 0 ? used.map(d => classify(d, fromReach)) : [{ kind: 'fallback', level: fallbackLevel(fromReach) } as Condition]
  const seen = new Set<string>()
  return conditions.filter(condition => {
    const key = JSON.stringify(condition)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** The earliest level a condition can plausibly happen at, for wild levels (stone and friendship: ten levels on). */
const reachOf = (condition: Condition, fromReach: number) =>
  condition.kind === 'level' || condition.kind === 'fallback' ? condition.level : fromReach + 10

export const buildForm = (node: RawNode, reach: number): ChainForm => ({
  name: node.species.name,
  id: idFromUrl(node.species.url),
  reachLevel: reach,
  edges: node.evolves_to.map(child => {
    const conditions = conditionsFor(child.evolution_details, reach)
    const childReach = Math.max(reach + 1, Math.min(...conditions.map(c => reachOf(c, reach))))
    return { to: buildForm(child, childReach), conditions }
  }),
})

export const findForm = (form: ChainForm, name: string): ChainForm | null => {
  if (form.name === name) return form
  for (const edge of form.edges) {
    const found = findForm(edge.to, name)
    if (found) return found
  }
  return null
}

export type SpeciesInfo = {
  id: number
  name: string
  captureRate: number
  legendary: boolean
  chainId: number
}

export type RawSpecies = {
  id: number; name: string; capture_rate: number; is_legendary: boolean; is_mythical: boolean
  evolution_chain: { url: string }
}

export const parseSpecies = (raw: RawSpecies): SpeciesInfo => ({
  id: raw.id,
  name: raw.name,
  captureRate: raw.capture_rate,
  legendary: raw.is_legendary || raw.is_mythical,
  chainId: idFromUrl(raw.evolution_chain.url),
})

/** The species' form with its evolutions resolved from it onward (reach levels counted from the chain's base). */
export const parseForm = (raw: { chain: RawNode }, speciesName: string): ChainForm => {
  const form = findForm(buildForm(raw.chain, BASE_LEVEL), speciesName)
  if (!form) throw new Error(`${speciesName} is not in its own evolution chain`)
  return form
}

export const parseTypes = (raw: { types: { type: { name: string } }[] }) => raw.types.map(t => t.type.name)

export const spritePath = (dir: string, id: number, shiny: boolean) =>
  `${dir}/sprites/${shiny ? 'shiny' : 'normal'}/${id}.png`

export const spriteUrl = (id: number, shiny: boolean) =>
  `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${shiny ? 'shiny/' : ''}${id}.png`

/** `date +%z` output (e.g. -0300) as minutes east of UTC, or null. */
export const parseOffset = (text: string): number | null => {
  const match = /^([+-])(\d{2})(\d{2})/.exec(text.trim())
  if (!match) return null
  const minutes = Number(match[2]) * 60 + Number(match[3])
  return match[1] === '-' ? -minutes : minutes
}
