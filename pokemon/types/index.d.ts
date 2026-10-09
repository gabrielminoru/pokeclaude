export type Stone =
  | 'fire-stone' | 'water-stone' | 'thunder-stone' | 'leaf-stone' | 'moon-stone'
  | 'sun-stone' | 'shiny-stone' | 'dusk-stone' | 'dawn-stone' | 'ice-stone'

export type TimeOfDay = 'day' | 'night' | 'dusk'

/** One way an edge can be satisfied, classified from PokeAPI's evolution_details. */
export type Condition =
  | { kind: 'level'; level: number; time: TimeOfDay | null }
  | { kind: 'stone'; stone: Stone }
  | { kind: 'friendship'; min: number; time: TimeOfDay | null }
  | { kind: 'fallback'; level: number }

/** A species and the evolutions out of it, resolved from the species onward. */
export type ChainForm = { name: string; id: number; reachLevel: number; edges: Edge[] }
export type Edge = { to: ChainForm; conditions: Condition[] }

export type Member = {
  id: string
  speciesId: number
  name: string
  chain: ChainForm
  shiny: boolean
  nickname: string | null
  caughtAt: number
}

export type Progress = {
  level: number
  xp: number
  xpFrac: number
  friendship: number
  lastXpAt: number
  recentCalls: number[]
}

export type Party = { members: Member[]; activeId: string | null }

export type Meta = {
  salt: string
  installedAt: number
  utcOffsetMinutes: number
  lastRollHour: number
  lastStoneHour: number
  lastFriendshipBucket: number
}

export type Dex = { seen: number[]; caught: number[]; shinies: number[] }

export type Bag = { stones: Partial<Record<Stone, number>>; received: string[] }

export type Path = { id: number; name: string }

export type Choice =
  | { kind: 'starter'; id: 'starter'; createdAt: number }
  | {
      kind: 'encounter'; id: string; createdAt: number; hour: number
      speciesId: number; name: string; shiny: boolean; level: number; legendary: boolean; chain: ChainForm
    }
  | { kind: 'evolution'; id: string; createdAt: number; memberId: string; paths: Path[]; deadline: number; stone: Stone | null }
  | { kind: 'stone'; id: string; createdAt: number; stone: Stone; memberId: string }

/** Session-only UI state: the optional nickname field after a catch, and the pane's rename field. */
export type Naming = { memberId: string; until: number } | null

declare module 'claude-code' {
  interface PluginState {
    pokemon: {
      party: Party
      progress: Record<string, Progress>
      dex: Dex
      bag: Bag
      pending: Choice[]
      meta: Meta | null
      naming: Naming
      renaming: string | null
      isHidden: boolean
    }
  }
}
