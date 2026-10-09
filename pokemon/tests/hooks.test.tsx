import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Bag, Choice, Member, Meta, Party, Progress } from '../types'
import { parseForm } from '../hooks/pokeapi'
import { HOUR, newProgress, stoneFor } from '../hooks/rules'
import { CHAINS, POKEMON, SPECIES } from './fixtures'

// 15:00 UTC = noon at -0300: daytime.
const T0 = Date.UTC(2026, 9, 7, 15, 0, 0)
const H0 = Math.floor(T0 / HOUR)
const HOME = '/Users/trainer'
const DATA = `${HOME}/.claude/plugins/data/pokemon`

/** Any species id PokeAPI is asked about: real fixtures where we have them, else a plain single-stage Pokémon. */
const answer = (url: string): { status: number; text: string } => {
  const species = /pokemon-species\/(\d+)$/.exec(url)
  const chain = /evolution-chain\/(\d+)$/.exec(url)
  const pokemon = /\/pokemon\/(\d+)$/.exec(url)
  if (species) {
    const id = Number(species[1])
    const found = SPECIES[id] ?? {
      id, name: `mon-${id}`, capture_rate: 255, is_legendary: false, is_mythical: false,
      evolution_chain: { url: `https://pokeapi.co/api/v2/evolution-chain/${100_000 + id}/` },
    }
    return { status: 200, text: JSON.stringify(found) }
  }
  if (chain) {
    const id = Number(chain[1])
    const solo = id - 100_000
    const found = CHAINS[id] ?? {
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

type World = { toasts: string[]; files: Set<string>; offline: { sprites: boolean; api: boolean } }

const world = (on: On, store: Record<string, unknown> = {}, now = T0) => {
  const state: World = { toasts: [], files: new Set(), offline: { sprites: false, api: false } }
  const texts = new Map<string, string>()
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
  on('command.register', ($, e) => ({ value: { command: e.name } }))
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
    const { status, text } = answer(e.url)
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
  return { clock, state, db }
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
    expect(await ui.find({ type: 'Text', text: /1\. BLAZE Charmander Lv\.10\s+▶ active/ })).toBeDefined()
    expect(await ui.find({ key: 'active-b' })).toBeDefined()
    expect(await ui.find({ key: 'release-a' })).toBeDefined()
    await ui.unmount()
  }
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
  const { clock } = world(on, { meta: meta(), party: partyOf([a]), progress: progressOf([a]) })
  const open = new Set<string>()
  on('ui.open', ($, e) => {
    open.add(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', ($, e) => {
    open.delete(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: [...open].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })) }))
  await start($, clock)
  await run($, 'party', '')
  expect(open.has('pokemon-party')).toBe(true)
  expect(await run($, 'party', '')).toBe('Party closed.')
  expect(open.has('pokemon-party')).toBe(false)

  await run($, 'party', '')
  const ui = await $.ui.mount({ plugin: 'pokemon', surface: 'terminal', component: 'Pane', requestId: 'pokemon-party', props: { title: 'Pokémon party', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } })
  await ui.press({ key: 'close-party' })
  expect(open.has('pokemon-party')).toBe(false)
  await ui.unmount()
})
