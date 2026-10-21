import type { Profile, Stats } from '../types'

export const TYPE_COLORS: Record<string, string> = {
  normal: 'brightBlack',
  fire: 'brightRed',
  water: 'brightBlue',
  electric: 'brightYellow',
  grass: 'brightGreen',
  ice: 'brightCyan',
  fighting: 'brightRed',
  poison: 'magenta',
  ground: 'yellow',
  flying: 'brightCyan',
  psychic: 'magenta',
  bug: 'green',
  rock: 'yellow',
  ghost: 'magenta',
  dragon: 'blue',
  dark: 'brightBlack',
  steel: 'brightBlack',
  fairy: 'brightMagenta',
}

export const typeColor = (type: string): string => TYPE_COLORS[type] ?? 'brightBlack'

export const STAT_LABELS: { key: keyof Stats; label: string }[] = [
  { key: 'hp', label: 'HP' },
  { key: 'atk', label: 'ATK' },
  { key: 'def', label: 'DEF' },
  { key: 'spa', label: 'SPA' },
  { key: 'spd', label: 'SPD' },
  { key: 'spe', label: 'SPE' },
]

/** The six stats in the two rows a card shows them in. */
export const STAT_ROWS: { key: keyof Stats; label: string }[][] = [
  [STAT_LABELS[0]!, STAT_LABELS[1]!, STAT_LABELS[2]!],
  [STAT_LABELS[3]!, STAT_LABELS[4]!, STAT_LABELS[5]!],
]

export const STAT_MAX = 100

export const statBar = (value: number, slots = 5): string => {
  const filled = Math.max(0, Math.min(slots, Math.round((value / STAT_MAX) * slots)))
  return '▰'.repeat(filled) + '▱'.repeat(slots - filled)
}

export const statLine = (stats: Stats): string =>
  STAT_LABELS.map(s => `${s.label} ${stats[s.key]}`).join('  ')

export const emptyProfile: Profile = {
  types: [],
  stats: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
  ability: null,
}
