import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Bag, Choice, Dex, Member, Meta, Party, Progress } from '../types'
import { parseForm } from '../hooks/pokeapi'
import { HOUR, expShareRoll, newProgress, rngFor, stoneFor } from '../hooks/rules'
import { CHAINS, POKEMON, SPECIES } from './fixtures'

// 15:00 UTC = noon at -0300: daytime.
const T0 = Date.UTC(2026, 9, 7, 15, 0, 0)
const H0 = Math.floor(T0 / HOUR)
const HOME = '/Users/trainer'
const DATA = `${HOME}/.claude/plugins/data/pokemon`

/** A chain where the species is only reached at level 30, like a late form. */
const lateChain = (id: number, name: string, url: string) => ({
  id,
  chain: {
    species: { name: 'ancestor', url: 'https://pokeapi.co/api/v2/pokemon-species/1/' },
    evolution_details: [],
    evolves_to: [{
      species: { name, url },
      evolution_details: [{ trigger: { name: 'level-up' }, min_level: 30 }],
      evolves_to: [],
    }],
  },
})

/** Any species id PokeAPI is asked about: real fixtures where we have them, else a plain single-stage Pokémon. */
const answer = (url: string, world: { evolved: boolean; advanced: boolean }): { status: number; text: string } => {
  const list = /pokemon-species\?limit=(\d+)$/.exec(url)
  const species = /pokemon-species\/(\d+)$/.exec(url)
  const chain = /evolution-chain\/(\d+)$/.exec(url)
  const pokemon = /\/pokemon\/(\d+)$/.exec(url)
  if (list) {
    const results = Array.from({ length: Number(list[1]) }, (_, i) => {
      const id = i + 1
      return { name: SPECIES[id]?.name ?? `mon-${id}`, url: `https://pokeapi.co/api/v2/pokemon-species/${id}/` }
    })
    return { status: 200, text: JSON.stringify({ results }) }
  }
  if (species) {
    const id = Number(species[1])
    const found = SPECIES[id] ?? {
      id, name: `mon-${id}`, capture_rate: 255, is_legendary: false, is_mythical: false, evolves_from_species: null,
      evolution_chain: { url: `https://pokeapi.co/api/v2/evolution-chain/${100_000 + id}/` },
    }
    const from = { name: 'predecessor', url: 'https://pokeapi.co/api/v2/pokemon-species/1/' }
    return { status: 200, text: JSON.stringify(world.evolved ? { ...found, evolves_from_species: from } : found) }
  }
  if (chain) {
    const id = Number(chain[1])
    const solo = id - 100_000
    const fixture = CHAINS[id]
    const name = fixture?.chain.species.name ?? `mon-${solo}`
    const url = fixture?.chain.species.url ?? `https://pokeapi.co/api/v2/pokemon-species/${solo}/`
    const found = world.advanced
      ? lateChain(id, name, url)
      : fixture ?? {
        id, chain: { species: { name: `mon-${solo}`, url: `https://pokeapi.co/api/v2/pokemon-species/${solo}/` }, evolution_details: [], evolves_to: [] },
      }
    return { status: 200, text: JSON.stringify(found) }
  }
  if (pokemon) {
    const id = Number(pokemon[1])
    return { status: 200, text: JSON.stringify(POKEMON[id] ?? { id, name: `mon-${id}`, types: [{ type: { name: 'normal' } }] }) }
  }
  return { status: 404, text: '{}' }
}

type World = { toasts: string[]; files: Set<string>; offline: { sprites: boolean; api: boolean }; evolved: boolean; advanced: boolean }

const world = (on: On, store: Record<string, unknown> = {}, now = T0) => {
  const state: World = { toasts: [], files: new Set(), offline: { sprites: false, api: false }, evolved: false, advanced: false }
  const texts = new Map<string, string>()
  const panes = new Map<string, { id: string; title: string }>()
  const clock = mock.clock(on, { now })
  const db = new Map<string, unknown>(Object.entries(store)) // the plugin's store, readable by the test
  on('store.get', ($, e) => ({ value: db.get(e.key) }))
  on('store.set', ($, e) => {
    db.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    db.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...db.keys()] }))
  mock.env(on, { HOME })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', ($, e) => {
    panes.set(e.id, { id: e.id, title: e.title })
    return { value: { isPlaced: true } }
  })
  on('ui.close', ($, e) => {
    panes.delete(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: [...panes.values()].map(pane => ({ ...pane, isShown: true, isFocused: false, isPlaced: true })) }))
  on('ui.toast', ($, e) => {
    state.toasts.push(e.text)
    return { value: undefined }
  })
  on('fs.exists', ($, e) => ({ value: state.files.has(e.path) }))
  on('fs.read', ($, e) => ({ value: texts.get(e.path) ?? '' }))
  on('fs.write', ($, e) => {
    state.files.add(e.path)
    texts.set(e.path, e.text)
    return { value: undefined }
  })
  on('http.fetch', ($, e) => {
    if (state.offline.api) return { value: { status: 503, ok: false, headers: {}, text: '' } }
const { status, text } = answer(e.url, state)
    return { value: { status, ok: status === 200, headers: {}, text } }
  })
  on('process.run', ($, e) => {
    const ran = (exitCode: number, stdout = '') => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv[0] === 'date') return ran(0, '-0300\n')
    if (e.argv[0] === 'curl') {
      if (state.offline.sprites) return ran(22)
      state.files.add(e.argv[e.argv.indexOf('-o') + 1] ?? '')
      return ran(0)
    }
    return ran(127)
  })
  return { clock, state, db, panes }
}

type Dollar = Parameters<TestBody>[0]

const start = async ($: Dollar, clock: { advance: (ms: number) => Promise<void> }) => {
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.advance(1) // let the catch-up tick settle
}

/** A slash command as typed in the composer. */
const run = async ($: Dollar, command: string, args: string) =>
  (await $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })).text ?? ''
const pokemon = ($: Dollar, args: string) => run($, 'pokemon', args)

const meta = (overrides: Partial<Meta> = {}): Meta => ({
  salt: 'test-salt', installedAt: T0, utcOffsetMinutes: -180, lastRollHour: H0, lastStoneHour: H0, lastFriendshipBucket: 0, ...overrides,
})
const mon = (id: string, chainId: number, species: string, nickname: string | null = null): Member => {
  const chain = parseForm(CHAINS[chainId], species)
  return { id, speciesId: chain.id, name: chain.name, chain, shiny: false, nickname, caughtAt: T0 }
}
const withProfile = (m: Member): Member => ({
  ...m,
  profile: { types: ['fire'], stats: { hp: 39, atk: 52, def: 43, spa: 60, spd: 50, spe: 65 }, ability: 'blaze' },
})
const partyOf = (members: Member[]): Party => ({ members, activeId: members[0]?.id ?? null })
const progressOf = (members: Member[], level = 10): Record<string, Progress> =>
  Object.fromEntries(members.map(m => [m.id, newProgress(level, 70, T0)]))

test('first start: v1 is wiped, Professor Oak offers a starter, and no wild Pokémon comes while the party is empty', async ($, on) => {
  const { clock, db } = world(on, { mon: { level: 7 } })
  await start($, clock)
  expect(db.get('mon')).toBe(undefined)
  expect(((db.get('pending') ?? []) as Choice[]).map(c => c.kind)).toEqual(['starter'])
  await clock.advance(2 * HOUR)
  expect(((db.get('pending') ?? []) as Choice[]).map(c => c.kind)).toEqual(['starter'])
})

test('choosing a starter fills slot 1 and ends the offer', async ($, on) => {
  const { clock, state, db } = world(on)
  await start($, clock)
  expect(await pokemon($, 'starter charmander')).toContain('Charmander joined your party at Lv. 5')
  const party = db.get('party') as Party
  expect(party.members.map(m => m.name)).toEqual(['charmander'])
  expect(party.activeId).toBe(party.members[0]?.id)
  expect((db.get('pending') ?? []) as Choice[]).toEqual([])
  expect(state.files.has(`${DATA}/sprites/normal/4.png`)).toBe(true)
  expect(await pokemon($, 'starter squirtle')).toContain('already have')
})

test('one wild Pokémon per hour; missed hours do not stack; Keep commits once', async ($, on) => {
  const starter = mon('s1', 2, 'charmander')
  const { clock, db } = world(on, { meta: meta(), party: partyOf([starter]), progress: progressOf([starter]) })
  await start($, clock)
  expect((db.get('pending') ?? []) as Choice[]).toEqual([])
  await clock.advance(5 * HOUR)
  const pending = (db.get('pending') ?? []) as Choice[]
  expect(pending.map(c => c.id)).toEqual([`enc-${H0 + 5}`])
  expect(await pokemon($, 'keep ZIPPY')).toContain('Gotcha! ZIPPY was caught!')
  expect((db.get('party') as Party).members.map(m => m.nickname)).toEqual([null, 'ZIPPY'])
  expect(await pokemon($, 'keep')).toBe('No wild Pokémon is waiting.')
})

test('the same hour and salt give every session the same wild Pokémon', async ($, on) => {
  const starter = mon('s1', 2, 'charmander')
  const { clock, db } = world(on, { meta: meta(), party: partyOf([starter]), progress: progressOf([starter]) })
  await start($, clock)
  await clock.advance(HOUR)
  const first = ((db.get('pending') ?? []) as Choice[])[0]
  db.set('meta', meta({ lastRollHour: H0 })) // as if another session rolls the same hour again
  await clock.advance(60_000)
  const again = ((db.get('pending') ?? []) as Choice[])[0]
  expect(again).toEqual(first)
})

test('a failed download leaves the hour unrolled, and the next tick retries', async ($, on) => {
  const starter = mon('s1', 2, 'charmander')
  const { clock, state, db } = world(on, { meta: meta(), party: partyOf([starter]), progress: progressOf([starter]) })
  await start($, clock)
  state.offline.sprites = true
  await clock.advance(HOUR)
  expect((db.get('pending') ?? []) as Choice[]).toEqual([])
  expect((db.get('meta') as Meta).lastRollHour).toBe(H0)
  state.offline.sprites = false
  await clock.advance(60_000)
  expect(((db.get('pending') ?? []) as Choice[]).map(c => c.kind)).toEqual(['encounter'])
})

test('a full party gets no encounters, and Keep is refused if it filled meanwhile', async ($, on) => {
  const six = Array.from({ length: 6 }, (_, i) => mon(`m${i}`, 2, 'charmander'))
  const waiting: Choice = { kind: 'encounter', id: `enc-${H0}`, createdAt: T0, hour: H0, speciesId: 4, name: 'charmander', shiny: false, level: 5, legendary: false, chain: six[0]!.chain }
  const { clock, db } = world(on, { meta: meta(), party: partyOf(six), progress: progressOf(six), pending: [waiting] })
  await start($, clock)
  await clock.advance(3 * HOUR)
  expect(((db.get('pending') ?? []) as Choice[]).map(c => c.id)).toEqual([`enc-${H0}`])
  expect(await pokemon($, 'keep')).toContain('Your party is full (6)')
})

test('release: never the last one; names that match two are refused', async ($, on) => {
  const a = mon('a', 2, 'charmander')
  const b = mon('b', 2, 'charmander')
  const { clock, db } = world(on, { meta: meta(), party: partyOf([a, b]), progress: progressOf([a, b]) })
  await start($, clock)
  expect(await pokemon($, 'release charmander')).toContain('More than one matches')
  expect(await pokemon($, 'release 1')).toContain('was released')
  const party = db.get('party') as Party
  expect([party.members.length, party.activeId]).toEqual([1, 'b'])
  expect(await pokemon($, 'release 1')).toContain("can't release it")
})

/** A salt whose first drop is `stone` at `hour`, with nothing in the hour before (the catch-up tick's). */
const saltFor = (stone: string, hour: number) => {
  for (let i = 0; i < 20_000; i++) {
    if (stoneFor(`salt-${i}`, hour - 1, 0) === null && stoneFor(`salt-${i}`, hour, 0) === stone) return `salt-${i}`
  }
  throw new Error('no salt')
}

test('a found Fire Stone is offered to Vulpix; with nobody to use it, it goes to the bag', async ($, on) => {
  const vulpix = mon('v', 15, 'vulpix')
  const salt = saltFor('fire-stone', H0 + 1)
  const { clock, state, db } = world(on, { meta: meta({ salt, lastStoneHour: 0 }), party: partyOf([vulpix]), progress: progressOf([vulpix]) })
  await start($, clock)
  await clock.advance(HOUR)
  const choices = (db.get('pending') ?? []) as Choice[]
  expect(choices.find(c => c.kind === 'stone')).toEqual(expect.objectContaining({ stone: 'fire-stone', memberId: 'v' }))
  expect((db.get('bag') as Bag).stones['fire-stone']).toBe(1)
  expect(state.toasts.some(t => t.includes('Found a Fire Stone! Use it on VULPIX?'))).toBe(true)
})

test('nobody can use the stone: straight to the bag, no choice', async ($, on) => {
  const charmander = mon('c', 2, 'charmander')
  const salt = saltFor('fire-stone', H0 + 1)
  const { clock, state, db } = world(on, { meta: meta({ salt, lastStoneHour: 0 }), party: partyOf([charmander]), progress: progressOf([charmander]) })
  await start($, clock)
  await clock.advance(HOUR)
  expect(((db.get('pending') ?? []) as Choice[]).some(c => c.kind === 'stone')).toBe(false)
  expect(state.toasts.some(t => t.includes('It went into your bag'))).toBe(true)
})

test('a stone evolution: Stop keeps the stone; letting it run evolves and uses it up', async ($, on) => {
  const vulpix = mon('v', 15, 'vulpix')
  const { clock, db } = world(on, { meta: meta(), party: partyOf([vulpix]), progress: progressOf([vulpix]), bag: { stones: { 'fire-stone': 1 }, received: [] } })
  await start($, clock)
  expect(await run($, 'bag', 'use fire 1')).toContain('reacts to the Fire Stone')
  expect(await pokemon($, 'stop')).toContain('stopped evolving')
  expect((db.get('bag') as Bag).stones['fire-stone']).toBe(1)
  expect((db.get('party') as Party).members[0]?.name).toBe('vulpix')

  await run($, 'bag', 'use fire-stone vulpix')
  await clock.advance(16_000)
  expect((db.get('party') as Party).members[0]?.name).toBe('ninetales')
  expect((db.get('bag') as Bag).stones['fire-stone']).toBe(0)
})

test('a stone already in an evolution cannot be used on a second Pokémon', async ($, on) => {
  const a = mon('a', 15, 'vulpix')
  const b = mon('b', 15, 'vulpix')
  const { clock, db } = world(on, { meta: meta(), party: partyOf([a, b]), progress: progressOf([a, b]), bag: { stones: { 'fire-stone': 1 }, received: [] } })
  await start($, clock)
  expect(await run($, 'bag', 'use fire 1')).toContain('reacts to the Fire Stone')
  expect(await run($, 'bag', 'use fire 2')).toContain('The Fire Stone is already in use.')
  await clock.advance(16_000)
  expect((db.get('party') as Party).members.map(m => m.name)).toEqual(['ninetales', 'vulpix'])
  expect((db.get('bag') as Bag).stones['fire-stone']).toBe(0)
})

test('two stones can evolve two Pokémon at once', async ($, on) => {
  const a = mon('a', 15, 'vulpix')
  const b = mon('b', 15, 'vulpix')
  const { clock, db } = world(on, { meta: meta(), party: partyOf([a, b]), progress: progressOf([a, b]), bag: { stones: { 'fire-stone': 2 }, received: [] } })
  await start($, clock)
  expect(await run($, 'bag', 'use fire 1')).toContain('reacts to the Fire Stone')
  expect(await run($, 'bag', 'use fire 2')).toContain('reacts to the Fire Stone')
  await clock.advance(16_000)
  expect((db.get('party') as Party).members.map(m => m.name)).toEqual(['ninetales', 'ninetales'])
  expect((db.get('bag') as Bag).stones['fire-stone']).toBe(0)
})

test('an evolution that no longer has its stone says so', async ($, on) => {
  const vulpix = mon('v', 15, 'vulpix')
  const evolving: Choice = {
    kind: 'evolution', id: 'evo-v', createdAt: T0, memberId: 'v', deadline: T0 + 15_000, stone: 'fire-stone',
    paths: [{ id: 38, name: 'ninetales' }],
  }
  const { clock, state, db } = world(on, { meta: meta(), party: partyOf([vulpix]), progress: progressOf([vulpix]), pending: [evolving], bag: { stones: {}, received: [] } })
  await start($, clock)
  await clock.advance(60_000)
  expect(state.toasts.some(t => t.includes('You no longer have a Fire Stone.'))).toBe(true)
  expect((db.get('party') as Party).members[0]?.name).toBe('vulpix')
})

test('a branching evolution nobody chooses counts as Stop', async ($, on) => {
  const eevee = mon('e', 67, 'eevee')
  const evolving: Choice = {
    kind: 'evolution', id: 'evo-e', createdAt: T0, memberId: 'e', deadline: T0 + 15_000, stone: null,
    paths: [{ id: 196, name: 'espeon' }, { id: 700, name: 'sylveon' }],
  }
  const { clock, db } = world(on, { meta: meta(), party: partyOf([eevee]), progress: progressOf([eevee]), pending: [evolving] })
  await start($, clock)
  await clock.advance(60_000)
  expect((db.get('pending') ?? []) as Choice[]).toEqual([])
  expect((db.get('party') as Party).members[0]?.name).toBe('eevee')
})

test('with the band hidden, a new encounter toast names the command', async ($, on) => {
  const starter = mon('s1', 2, 'charmander')
  const { clock, state, db } = world(on, { meta: meta(), party: partyOf([starter]), progress: progressOf([starter]) })
  await start($, clock)
  await pokemon($, 'hide')
  await clock.advance(HOUR)
  expect(state.toasts.some(t => t.includes('appeared!') && t.includes('(/pokemon keep [nickname] or /pokemon letgo)'))).toBe(true)
})

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

test('the band offers the starters, then shows the active Pokémon and a pending encounter, on every surface', async ($, on) => {
  const { clock, db } = world(on)
  await start($, clock)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'pokemon', surface, ...BAND })
    expect(await ui.find({ key: 'starter-4' })).toBeDefined()
    await ui.unmount()
  }
  await pokemon($, 'starter charmander')
  await clock.advance(HOUR)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'pokemon', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: /Charmander Lv\.5/ })).toBeDefined()
    expect(await ui.find({ key: 'keep' })).toBeDefined()
    if (surface === 'terminal') expect(await ui.find({ key: 'sprite-4-n' })).toBeDefined()
    else expect(await ui.find({ type: 'Text', text: '[Charmander]' })).toBeDefined()
    await ui.unmount()
  }
})

test('the party pane lists every member with its buttons', async ($, on) => {
  const a = mon('a', 2, 'charmander', 'BLAZE')
  const b = mon('b', 67, 'eevee')
  const { clock, db } = world(on, { meta: meta(), party: partyOf([a, b]), progress: progressOf([a, b]) })
  await start($, clock)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'pokemon', surface, component: 'Pane', requestId: 'pokemon-party', props: { title: 'Pokémon party', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } })
    expect(await ui.find({ type: 'Text', text: /BLAZE/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Charmander Lv\.10/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /▶ active/ })).toBeDefined()
    expect(await ui.find({ key: 'active-b' })).toBeDefined()
    expect(await ui.find({ key: 'release-a' })).toBeDefined()
    expect(await ui.find({ key: 'store-a' })).toBeUndefined()
    await ui.unmount()
  }
})

test('a Lv. 100 party member can be stored and taken back; lower levels are refused', async ($, on) => {
  const a = mon('a', 2, 'charmander', 'BLAZE')
  const b = mon('b', 67, 'eevee')
  const progress = { ...progressOf([a], 100), ...progressOf([b], 42) }
  const { clock, db } = world(on, { meta: meta(), party: partyOf([a, b]), progress })
  await start($, clock)
  expect(await pokemon($, 'store 1')).toContain('BLAZE was stored in the Boxes.')
  expect((db.get('boxes') as Member[]).map(m => m.id)).toEqual(['a'])
  expect((db.get('party') as Party).members.map(m => m.id)).toEqual(['b'])
  expect((db.get('progress') as Record<string, Progress>).a?.level).toBe(100)
  expect(await pokemon($, 'store 1')).toContain('Only Lv. 100 Pokémon can be stored. EEVEE is Lv. 42.')
  expect(await pokemon($, 'take 1')).toContain('BLAZE joined your party!')
  expect((db.get('party') as Party).members.map(m => m.id)).toEqual(['b', 'a'])
  expect(db.get('boxes')).toEqual([])
})

test('the last party member cannot be stored', async ($, on) => {
  const a = mon('a', 2, 'charmander')
  const { clock } = world(on, { meta: meta(), party: partyOf([a]), progress: progressOf([a], 100) })
  await start($, clock)
  expect(await pokemon($, 'store 1')).toContain("You can't store your last Pokémon.")
})

test('a full party cannot take a boxed Pokémon; swap trades a Lv. 100 member', async ($, on) => {
  const six = Array.from({ length: 6 }, (_, i) => mon(`m${i}`, 2, 'charmander'))
  const boxed = mon('boxed', 67, 'eevee')
  const { clock, db } = world(on, {
    meta: meta(), party: partyOf(six), boxes: [boxed], progress: progressOf(six, 100),
  })
  await start($, clock)
  expect(await pokemon($, 'take 1')).toContain('Your party is full (6)')
  expect(await pokemon($, 'swap 1 1')).toContain('was stored in the Boxes.')
  expect((db.get('party') as Party).members.map(m => m.id)).toContain('boxed')
  expect((db.get('party') as Party).members.map(m => m.id)).not.toContain('m0')
  expect((db.get('party') as Party).activeId).toBe('boxed')
  expect((db.get('boxes') as Member[]).map(m => m.id)).toEqual(['m0'])
})

test('swap also works when the party has a single member', async ($, on) => {
  const a = mon('a', 2, 'charmander')
  const boxed = mon('b', 67, 'eevee')
  const { clock, db } = world(on, {
    meta: meta(), party: partyOf([a]), boxes: [boxed], progress: progressOf([a, boxed], 100),
  })
  await start($, clock)
  expect(await pokemon($, 'swap 1 1')).toContain('was stored in the Boxes.')
  expect((db.get('party') as Party).members.map(m => m.id)).toEqual(['b'])
  expect((db.get('boxes') as Member[]).map(m => m.id)).toEqual(['a'])
})

test('boxed Pokémon do not gain EXP and are not shared with', async ($, on) => {
  const a = mon('a', 2, 'charmander')
  const boxed = mon('b', 67, 'eevee')
  const { clock, db } = world(on, {
    meta: meta({ expShare: true, expShareUnlocked: true }), party: partyOf([a]), boxes: [boxed],
    progress: progressOf([a, boxed]),
  })
  await start($, clock)
  await $.tool.call({ tool: 'Read', file_path: '/tmp/x' })
  const progress = db.get('progress') as Record<string, Progress>
  expect([progress.b?.xp, progress.b?.xpFrac]).toEqual([0, 0])
})

test('the boxes pane lists stored Pokémon and offers Take', async ($, on) => {
  const a = mon('a', 2, 'charmander', 'BLAZE')
  const boxed = withProfile(mon('b', 67, 'eevee', 'BUBBLES'))
  const { clock, panes } = world(on, { meta: meta(), party: partyOf([a]), boxes: [boxed], progress: progressOf([a, boxed], 100) })
  await start($, clock)
  await run($, 'boxes', '')
  expect(panes.has('pokemon-boxes')).toBe(true)
  expect(await run($, 'boxes', '')).toBe('Boxes closed.')
  expect(panes.has('pokemon-boxes')).toBe(false)
  await run($, 'boxes', '')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'pokemon', surface, component: 'Pane', requestId: 'pokemon-boxes', props: { title: 'Pokémon Boxes', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } })
    expect(await ui.find({ type: 'Text', text: /Boxes · 1 stored/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /BUBBLES/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Eevee Lv\.100/ })).toBeDefined()
    expect(await ui.find({ key: 'take-b' })).toBeDefined()
    await ui.unmount()
  }
})

test('the party pane offers Store only for Lv. 100 members', async ($, on) => {
  const a = withProfile(mon('a', 2, 'charmander', 'BLAZE'))
  const b = mon('b', 67, 'eevee')
  const progress = { ...progressOf([a], 100), ...progressOf([b], 42) }
  const { clock } = world(on, { meta: meta(), party: partyOf([a, b]), progress })
  await start($, clock)
  const ui = await $.ui.mount({ plugin: 'pokemon', surface: 'terminal', component: 'Pane', requestId: 'pokemon-party', props: { title: 'Pokémon party', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } })
  expect(await ui.find({ key: 'store-a' })).toBeDefined()
  expect(await ui.find({ key: 'store-b' })).toBeUndefined()
  await ui.unmount()
})

test('the dex lists the species you have seen and caught', async ($, on) => {
  const starter = mon('s1', 2, 'charmander')
  const { clock, db } = world(on, {
    meta: meta(), party: partyOf([starter]), progress: progressOf([starter]),
    dex: { seen: [4, 37], caught: [4], shinies: [] },
  })
  await start($, clock)
  expect(await run($, 'pokedex', '')).toContain('Seen 2/151 · Caught 1/151')
  expect(await run($, 'pokedex', 'seen')).toContain('Seen (2): Charmander, Vulpix')
  expect(await run($, 'pokedex', 'caught')).toContain('Caught (1): Charmander')
  expect(await run($, 'pokedex', '37')).toContain('#037 Vulpix — seen')
  expect(await run($, 'pokedex', '4')).toContain('#004 Charmander — caught')
  expect(await run($, 'pokedex', '92')).toContain('#092 Gastly — not seen')
})

test('a long list says how many are left out', async ($, on) => {
  const starter = mon('s1', 2, 'charmander')
  const { clock, db } = world(on, {
    meta: meta(), party: partyOf([starter]), progress: progressOf([starter]),
    dex: { seen: Array.from({ length: 25 }, (_, i) => i + 1), caught: [], shinies: [] },
  })
  await start($, clock)
  const list = await run($, 'pokedex', 'seen')
  expect(list).toContain('Seen (25):')
  expect(list).toContain('and 5 more')
  expect(await run($, 'pokedex', 'caught')).toBe('Caught: none yet')
})

test('the Pokédex pane shows generations, statuses and hides unknown species', async ($, on) => {
  const starter = mon('s1', 2, 'charmander')
  const { clock, panes } = world(on, {
    meta: meta(), party: partyOf([starter]), progress: progressOf([starter]),
    dex: { seen: [4, 37], caught: [4], shinies: [] },
  })
  await start($, clock)
  await run($, 'pokedex', '')
  expect(panes.has('pokemon-dex')).toBe(true)
  expect(await run($, 'pokedex', 'close')).toBe('Pokédex closed.')
  expect(panes.has('pokemon-dex')).toBe(false)
  await run($, 'pokedex', '')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'pokemon', surface, component: 'Pane', requestId: 'pokemon-dex', props: { title: 'Pokédex', isFocused: true, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} } })
    expect(await ui.find({ type: 'Text', text: /Generation I \(Kanto\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Seen 2\/151 · Caught 1\/151/ })).toBeDefined()
    expect(await ui.find({ key: 'dex-gen-3' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '???' })).toBeDefined()
    expect(await ui.find({ key: 'dex-view-4' })).toBeDefined()
    expect(await ui.find({ key: 'dex-view-1' })).toBeUndefined()
    await ui.press({ key: 'dex-view-4' })
    expect(await ui.find({ type: 'Text', text: /Ability: Blaze/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Evolves:/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the Pokédex generation is independent from the wild encounters', async ($, on) => {
  const starter = mon('s1', 2, 'charmander')
  const { clock, db, panes } = world(on, {
    meta: meta({ generation: 1 }), party: partyOf([starter]), progress: progressOf([starter]),
    dex: { seen: [4, 37], caught: [4], shinies: [] },
  })
  await start($, clock)
  expect(await run($, 'pokedex', 'gen 3')).toContain('Generation III (Hoenn)')
  expect((db.get('meta') as Meta).generation).toBe(1)
  expect(panes.has('pokemon-dex')).toBe(true)
  const ui = await $.ui.mount({ plugin: 'pokemon', surface: 'terminal', component: 'Pane', requestId: 'pokemon-dex', props: { title: 'Pokédex', isFocused: true, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} } })
  expect(await ui.find({ type: 'Text', text: /Generation III \(Hoenn\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Seen 0\/135 · Caught 0\/135/ })).toBeDefined()
  await ui.unmount()
})

test('evolving registers every stage in the Pokédex', async ($, on) => {
  const charmander = mon('a', 2, 'charmander')
  const { clock, db } = world(on, {
    meta: meta(), party: partyOf([charmander]), progress: progressOf([charmander]),
    dex: { seen: [4], caught: [4], shinies: [] },
    pending: [{ kind: 'evolution', id: 'evo-a', createdAt: T0, memberId: 'a', paths: [{ id: 5, name: 'charmeleon' }], deadline: T0 + 15_000, stone: null }],
  })
  await start($, clock)
  expect(await pokemon($, 'evolve charmeleon')).toContain('CHARMELEON')
  db.set('pending', [{ kind: 'evolution', id: 'evo-a-2', createdAt: T0, memberId: 'a', paths: [{ id: 6, name: 'charizard' }], deadline: T0 + 15_000, stone: null }])
  expect(await pokemon($, 'evolve charizard')).toContain('CHARIZARD')
  expect((db.get('dex') as Dex).caught).toEqual([4, 5, 6])
})

const boxes = (node: unknown): { type?: string; props?: Record<string, unknown>; children?: unknown[] }[] => {
  if (!node || typeof node !== 'object') return []
  const here = node as { type?: string; props?: Record<string, unknown>; children?: unknown[] }
  const kids = Array.isArray(here.children) ? here.children : []
  return [here, ...kids.flatMap(boxes)]
}

test('the band centers the text against the sprite', async ($, on) => {
  const a = withProfile(mon('a', 2, 'charmander', 'BLAZE'))
  const { clock } = world(on, { meta: meta(), party: partyOf([a]), progress: progressOf([a]) })
  await start($, clock)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'pokemon', surface, ...BAND })
    const centered = boxes(await ui.drawn()).filter(n => n.type === 'Box' && n.props?.alignSelf === 'center')
    expect(centered.length).toBe(1)
    await ui.unmount()
  }
})

test('the stage can be read and changed, and an unknown one is refused', async ($, on) => {
  const starter = mon('s1', 2, 'charmander')
  const { clock, db } = world(on, { meta: meta(), party: partyOf([starter]), progress: progressOf([starter]) })
  await start($, clock)
  expect(await pokemon($, 'stage')).toContain('Wild encounters: base forms only.')
  expect(await pokemon($, 'stage all')).toContain('Wild encounters now come from any stage of the chain.')
  expect((db.get('meta') as Meta).stage).toBe('all')
  expect(await pokemon($, 'stage evolved')).toContain('I don\'t know "evolved"')
  expect((db.get('meta') as Meta).stage).toBe('all')
  expect(await pokemon($, 'stage base')).toContain('Wild encounters now come from base forms only.')
  expect((db.get('meta') as Meta).stage).toBe('base')
})

test('with base forms only, an evolved species never comes', async ($, on) => {
  const starter = mon('s1', 2, 'charmander')
  const { clock, state, db } = world(on, { meta: meta(), party: partyOf([starter]), progress: progressOf([starter]) })
  state.evolved = true
  await start($, clock)
  await clock.advance(3 * HOUR)
  expect(((db.get('pending') ?? []) as Choice[]).some(c => c.kind === 'encounter')).toBe(false)
})

test('with the stage set to all, an evolved species can come', async ($, on) => {
  const starter = mon('s1', 2, 'charmander')
  const { clock, state, db } = world(on, { meta: meta({ stage: 'all' }), party: partyOf([starter]), progress: progressOf([starter]) })
  state.evolved = true
  await start($, clock)
  await clock.advance(3 * HOUR)
  expect(((db.get('pending') ?? []) as Choice[]).some(c => c.kind === 'encounter')).toBe(true)
})

test('the encounter never goes past the level of the best Pokémon', async ($, on) => {
  const starter = mon('s1', 2, 'charmander')
  const { clock, db } = world(on, { meta: meta(), party: partyOf([starter]), progress: progressOf([starter], 5) })
  await start($, clock)
  await clock.advance(HOUR)
  const choice = ((db.get('pending') ?? []) as Choice[])[0]
  expect(choice?.kind === 'encounter' && choice.level).toBe(5)
})

test('a species too strong for the party never comes', async ($, on) => {
  const starter = mon('s1', 2, 'charmander')
  const { clock, state, db } = world(on, { meta: meta(), party: partyOf([starter]), progress: progressOf([starter], 5) })
  state.advanced = true
  await start($, clock)
  await clock.advance(2 * HOUR)
  expect(((db.get('pending') ?? []) as Choice[]).some(c => c.kind === 'encounter')).toBe(false)
})

test('a party of level 40 can meet a strong species', async ($, on) => {
  const starter = mon('s1', 2, 'charmander')
  const { clock, state, db } = world(on, { meta: meta(), party: partyOf([starter]), progress: progressOf([starter], 40) })
  state.advanced = true
  await start($, clock)
  await clock.advance(HOUR)
  const choice = ((db.get('pending') ?? []) as Choice[])[0]
  expect(choice?.kind).toBe('encounter')
  expect(choice?.kind === 'encounter' && choice.level >= 30 && choice.level <= 33).toBe(true)
})

test('the level cap can be read and changed, and an unknown one is refused', async ($, on) => {
  const starter = mon('s1', 2, 'charmander')
  const { clock, db } = world(on, { meta: meta(), party: partyOf([starter]), progress: progressOf([starter], 12) })
  await start($, clock)
  expect(await pokemon($, 'levelcap')).toContain('level 12 at most (your best Pokémon)')
  expect(await pokemon($, 'levelcap 30')).toContain('level 30 at most')
  expect((db.get('meta') as Meta).levelCap).toBe(30)
  expect(await pokemon($, 'levelcap party')).toContain('level 12 at most (your best Pokémon)')
  expect((db.get('meta') as Meta).levelCap).toBe('party')
  expect(await pokemon($, 'levelcap off')).toContain('any level')
  expect(await pokemon($, 'levelcap nope')).toContain('I don\'t know "nope"')
  expect((db.get('meta') as Meta).levelCap).toBe('off')
})

test('the party card shows the type, the stat bars and the ability', async ($, on) => {
  const a = withProfile(mon('a', 2, 'charmander', 'BLAZE'))
  const { clock } = world(on, { meta: meta(), party: partyOf([a]), progress: progressOf([a]) })
  await start($, clock)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'pokemon', surface, component: 'Pane', requestId: 'pokemon-party', props: { title: 'Pokémon party', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } })
    expect(await ui.find({ type: 'Text', text: 'Fire' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /HP .* 39/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Ability: Blaze' })).toBeDefined()
    await ui.unmount()
  }
})

test('a member without a profile has it filled in on the next tick', async ($, on) => {
  const a = mon('a', 2, 'charmander', 'BLAZE')
  const { clock, db } = world(on, { meta: meta(), party: partyOf([a]), progress: progressOf([a]) })
  await start($, clock)
  await clock.advance(60_000)
  const filled = (db.get('party') as Party).members[0]?.profile
  expect(filled?.types).toEqual(['fire'])
  expect(filled?.stats.hp).toBe(39)
  expect(filled?.ability).toBe('blaze')
})

test('friendship moves once per 10-minute bucket, however many ticks land in it', async ($, on) => {
  const a = mon('a', 2, 'charmander')
  const { clock, db } = world(on, { meta: meta({ lastFriendshipBucket: Math.floor(T0 / 600_000) }), party: partyOf([a]), progress: progressOf([a]) })
  await start($, clock)
  await clock.advance(10 * 60_000)
  const friendship = () => (db.get('progress') as Record<string, Progress>).a?.friendship
  expect(friendship()).toBe(71)
  await clock.advance(5 * 60_000)
  expect(friendship()).toBe(71)
  await clock.advance(5 * 60_000)
  expect(friendship()).toBe(72)
})

test('EXP Share starts off, shares a flat half with the party, and toggles', async ($, on) => {
  const a = mon('a', 2, 'charmander')
  const b = mon('b', 67, 'eevee')
  const { clock, db } = world(on, {
    meta: meta({ expShareUnlocked: true }), party: partyOf([a, b]),
    progress: { ...progressOf([a]), b: { ...newProgress(10, 70, T0), lastXpAt: T0 - 4 * HOUR } },
  })
  await start($, clock)
  await $.tool.call({ tool: 'Read', file_path: '/tmp/x' })
  let progress = db.get('progress') as Record<string, Progress>
  expect([progress.b?.xp, progress.b?.xpFrac]).toEqual([0, 0])

  expect(await pokemon($, 'share-exp')).toContain('EXP Share on')
  expect((db.get('meta') as Meta).expShare).toBe(true)
  await $.tool.call({ tool: 'Read', file_path: '/tmp/y' })
  progress = db.get('progress') as Record<string, Progress>
  expect([progress.a?.xp, progress.b?.xp]).toEqual([2, 0])
  expect(progress.b?.xpFrac).toBe(0.5)
  await $.tool.call({ tool: 'Read', file_path: '/tmp/z' })
  progress = db.get('progress') as Record<string, Progress>
  expect([progress.a?.xp, progress.b?.xp, progress.b?.xpFrac]).toEqual([3, 1, 0])

  expect(await pokemon($, 'share-exp')).toBe('EXP Share off.')
  expect((db.get('meta') as Meta).expShare).toBe(false)
  await $.tool.call({ tool: 'Read', file_path: '/tmp/w' })
  progress = db.get('progress') as Record<string, Progress>
  expect([progress.b?.xp, progress.b?.xpFrac]).toEqual([1, 0])
})

test('EXP Share cannot be forced on without the unlock', async ($, on) => {
  const a = mon('a', 2, 'charmander')
  const b = mon('b', 67, 'eevee')
  const { clock, db } = world(on, {
    meta: meta({ expShare: true }), party: partyOf([a, b]), progress: progressOf([a, b]),
  })
  await start($, clock)
  await $.tool.call({ tool: 'Read', file_path: '/tmp/x' })
  const progress = db.get('progress') as Record<string, Progress>
  expect([progress.b?.xp, progress.b?.xpFrac]).toEqual([0, 0])
})

test('a shared level-up starts an evolution with a longer wait', async ($, on) => {
  const a = mon('a', 67, 'eevee')
  const b = mon('b', 2, 'charmander')
  const { clock, db } = world(on, {
    meta: meta({ expShare: true, expShareUnlocked: true }), party: partyOf([a, b]),
    progress: { ...progressOf([a]), b: { ...newProgress(15, 70, T0), xp: 18, xpFrac: 0.5 } },
  })
  await start($, clock)
  await $.tool.call({ tool: 'Read', file_path: '/tmp/x' })
  const evolving = (db.get('pending') as Choice[]).filter(c => c.kind === 'evolution')
  expect(evolving.map(c => c.kind === 'evolution' && c.memberId)).toEqual(['b'])
  expect(evolving[0]?.kind === 'evolution' && evolving[0].deadline - T0).toBe(600_001)
})

test('the share-exp command stays hidden until the feature is unlocked', async ($, on) => {
  const a = mon('a', 2, 'charmander')
  const { clock, db } = world(on, { meta: meta(), party: partyOf([a]), progress: progressOf([a]) })
  await start($, clock)
  const text = await pokemon($, 'share-exp')
  expect(text).toContain('/pokemon')
  expect(text).not.toContain('EXP Share on')
  expect((db.get('meta') as Meta).expShare).toBe(undefined)
})

test('50 distinct Gen I caught unlock the hidden EXP Share, and it stays off', async ($, on) => {
  const starter = mon('s1', 2, 'charmander')
  const caught = Array.from({ length: 49 }, (_, i) => i + 1)
  const waiting: Choice = {
    kind: 'encounter', id: `enc-${H0}`, createdAt: T0, hour: H0, speciesId: 133, name: 'eevee', shiny: false, level: 5,
    legendary: false, chain: parseForm(CHAINS[67], 'eevee'),
  }
  const { clock, state, db } = world(on, {
    meta: meta(), party: partyOf([starter]), progress: progressOf([starter]),
    dex: { seen: caught, caught, shinies: [] }, pending: [waiting],
  })
  await start($, clock)
  expect(await pokemon($, 'keep')).toContain('Gotcha!')
  const storedMeta = db.get('meta') as Meta
  expect(storedMeta.expShareUnlocked).toBe(true)
  expect(storedMeta.expShare).toBe(undefined)
  expect(state.toasts.some(t => t.includes('/pokemon share-exp'))).toBe(true)
})

test('a lucky Gen I capture unlocks the EXP Share before 50', async ($, on) => {
  const starter = mon('s1', 2, 'charmander')
  let salt = ''
  for (let i = 0; i < 5000 && !salt; i++) {
    const candidate = `roll-${i}`
    if (expShareRoll(rngFor(candidate, H0 + 1, 'exp-share'))) salt = candidate
  }
  expect(salt).not.toBe('')
  const waiting: Choice = {
    kind: 'encounter', id: `enc-${H0 + 1}`, createdAt: (H0 + 1) * HOUR, hour: H0 + 1, speciesId: 37, name: 'vulpix',
    shiny: false, level: 5, legendary: false, chain: parseForm(CHAINS[15], 'vulpix'),
  }
  const { clock, db } = world(on, {
    meta: meta({ salt }), party: partyOf([starter]), progress: progressOf([starter]),
    dex: { seen: [4], caught: [4], shinies: [] }, pending: [waiting],
  })
  await start($, clock)
  expect(await pokemon($, 'keep')).toContain('Gotcha!')
  expect((db.get('meta') as Meta).expShareUnlocked).toBe(true)
})

test('switching away from Gen I pauses the EXP Share count until it returns', async ($, on) => {
  const starter = mon('s1', 2, 'charmander')
  const caught = Array.from({ length: 50 }, (_, i) => i + 1)
  const { clock, db } = world(on, {
    meta: meta({ generation: 2 }), party: partyOf([starter]), progress: progressOf([starter]),
    dex: { seen: caught, caught, shinies: [] },
  })
  await start($, clock)
  expect((db.get('meta') as Meta).expShareUnlocked).toBe(undefined)
  expect(await pokemon($, 'gen 1')).toContain('Generation I')
  expect((db.get('meta') as Meta).expShareUnlocked).toBe(true)
})

test('parallel edits in one session all land', async ($, on) => {
  const a = mon('a', 2, 'charmander')
  const b = mon('b', 2, 'charmander')
  const c = mon('c', 2, 'charmander')
  const { clock, db } = world(on, { meta: meta(), party: partyOf([a, b, c]), progress: progressOf([a, b, c]) })
  await start($, clock)
  await Promise.all([pokemon($, 'nick 1 ONE'), pokemon($, 'nick 2 TWO'), pokemon($, 'nick 3 THREE')])
  expect((db.get('party') as Party).members.map(m => m.nickname)).toEqual(['ONE', 'TWO', 'THREE'])
})

test('/party opens the pane, /party again closes it, and the pane has a Close button', async ($, on) => {
  const a = mon('a', 2, 'charmander')
  const { clock, panes } = world(on, { meta: meta(), party: partyOf([a]), progress: progressOf([a]) })
  await start($, clock)
  await run($, 'party', '')
  expect(panes.has('pokemon-party')).toBe(true)
  expect(await run($, 'party', '')).toBe('Party closed.')
  expect(panes.has('pokemon-party')).toBe(false)

  await run($, 'party', '')
  const ui = await $.ui.mount({ plugin: 'pokemon', surface: 'terminal', component: 'Pane', requestId: 'pokemon-party', props: { title: 'Pokémon party', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } })
  await ui.press({ key: 'close-party' })
  expect(panes.has('pokemon-party')).toBe(false)
  await ui.unmount()
})

test('the generation can be read and changed, and an unknown one is refused', async ($, on) => {
  const starter = mon('s1', 2, 'charmander')
  const { clock, db } = world(on, { meta: meta(), party: partyOf([starter]), progress: progressOf([starter]) })
  await start($, clock)
  expect(await pokemon($, 'gen')).toContain('Wild encounters: Generation I (Kanto) · 151 species.')
  expect(await pokemon($, 'gen 3')).toContain('Wild encounters now come from Generation III (Hoenn) · 135 species.')
  expect((db.get('meta') as Meta).generation).toBe(3)
  expect(await pokemon($, 'gen hoenn')).toContain('Generation III (Hoenn)')
  expect(await pokemon($, 'gen all')).toContain('every generation · 1025 species.')
  expect((db.get('meta') as Meta).generation).toBe('all')
  expect(await pokemon($, 'gen 42')).toContain('I don\'t know "42"')
  expect((db.get('meta') as Meta).generation).toBe('all')
})

test('the wild encounters come from the generation in play', async ($, on) => {
  const starter = mon('s1', 2, 'charmander')
  const { clock, db } = world(on, { meta: meta(), party: partyOf([starter]), progress: progressOf([starter]) })
  await start($, clock)
  await pokemon($, 'gen 3')
  await clock.advance(HOUR)
  const choice = ((db.get('pending') ?? []) as Choice[])[0]
  expect(choice?.kind).toBe('encounter')
  expect(choice?.kind === 'encounter' && choice.speciesId >= 252 && choice.speciesId <= 386).toBe(true)
})

test('the dex counts against the generation in play', async ($, on) => {
  const starter = mon('s1', 2, 'charmander')
  const { clock } = world(on, {
    meta: meta(), party: partyOf([starter]), progress: progressOf([starter]),
    dex: { seen: [1, 300, 700], caught: [1, 300], shinies: [] },
  })
  await start($, clock)
  expect(await run($, 'pokedex', '')).toContain('Seen 1/151 · Caught 1/151')
  await pokemon($, 'gen 3')
  expect(await run($, 'pokedex', '')).toContain('Seen 1/135 · Caught 1/135')
  await pokemon($, 'gen all')
  expect(await run($, 'pokedex', '')).toContain('Seen 3/1025 · Caught 2/1025')
})
