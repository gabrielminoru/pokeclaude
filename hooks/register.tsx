import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Bag, Choice, Dex, DexView, Generation, LevelCap, Member, Meta, Party, Path, Progress, Stage, Stone } from '../types'
import { SPECIES_COUNT, STONES, parseForm, parseOffset, parseProfile, parseSpecies, parseSpeciesList, parseTypes, spritePath, spriteUrl } from './pokeapi'
import type { RawNode, RawPokemon, RawSpecies, RawSpeciesList, SpeciesInfo } from './pokeapi'
import {
  BOX_PAGE_SIZE, DEFAULT_GENERATION, DEFAULT_LEVEL_CAP, DEFAULT_STAGE, DEX_PAGE_SIZE, ENCOUNTER_ATTEMPTS,
  EVOLUTION_COUNTDOWN, EXP_SHARE_TARGET, GENERATION_NUMERALS, HOUR, MAX_LEVEL, MOOD_LABEL, PARTY_SIZE, SHARE_FACTOR,
  SHARED_EVOLUTION_COUNTDOWN, START_FRIENDSHIP, STARTERS, acceptChance, bar, bucketOf, canStore, caughtInGeneration,
  displayName, encounterLevel, energyOf, expShareGeneration, expShareRoll, findTarget, friendshipStep, gainCall, gainExp,
  generationCount, generationName, generationOf, generationRange, hourOf, isShiny, levelCapName, levelCapOf,
  levelCapValue, levelUpPaths, localHour, moodOf, newProgress, nextEvolutionText, pageCount, parseGeneration,
  parseLevelCap, parseStage, rngFor, sortChoices, speciesIdFor, speciesPage, stageName, stageOf, stoneFor, stonePaths,
  stoneTarget, title, typeFactor, upsertChoice, xpToNext,
} from './rules'
import { STAT_ROWS, emptyProfile, statBar, statLine, typeColor } from './cards'


// --- The ways out: PokeAPI, the file cache, sprites, the clock offset (each one `$` call a test can stub) ---

const API = 'https://pokeapi.co/api/v2'

/** Outside the plugin folder, so cache and sprite writes never trigger the plugin's hot reload. */
const dataDir = async ($: EngineInterface) => `${(await $.env.get('HOME')) ?? '/tmp'}/.claude/plugins/data/pokemon`

/** GETs PokeAPI JSON once and keeps it as a file. */
const fetchJson = async ($: EngineInterface, path: string): Promise<unknown> => {
  const file = `${await dataDir($)}/cache/${path.replace(/[^a-z0-9-]+/gi, '_')}.json`
  if (await $.fs.exists(file)) {
    const cached = await $.fs.read(file)
    if (typeof cached === 'string') return JSON.parse(cached)
  }
  const res = await $.http.fetch(`${API}/${path}`)
  if (!res.ok) throw new Error(res.status === 404 ? 'not-found' : `PokeAPI answered ${res.status}`)
  const data: unknown = JSON.parse(res.text)
  await $.fs.write(file, res.text).catch(() => undefined) // a cache miss next time is fine
  return data
}

const speciesInfo = async ($: EngineInterface, idOrName: number | string) =>
  parseSpecies((await fetchJson($, `pokemon-species/${idOrName}`)) as RawSpecies)

/** Every species id and its name, from the one call that carries them all. */
const speciesNames = async ($: EngineInterface): Promise<Map<number, string>> => {
  const names = parseSpeciesList((await fetchJson($, `pokemon-species?limit=${SPECIES_COUNT}`)) as RawSpeciesList)
  return new Map([...names].map(([id, name]) => [id, title(name)]))
}

const formOf = async ($: EngineInterface, species: SpeciesInfo) =>
  parseForm((await fetchJson($, `evolution-chain/${species.chainId}`)) as { chain: RawNode }, species.name)

/** A species' own numbers: its types, its base stats and its ability. */
const profileOf = async ($: EngineInterface, id: number) =>
  parseProfile((await fetchJson($, `pokemon/${id}`)) as RawPokemon)

const typesOf = async ($: EngineInterface, id: number) =>
  parseTypes((await fetchJson($, `pokemon/${id}`)) as { types: { type: { name: string } }[] })

const spriteExists = async ($: EngineInterface, id: number, shiny: boolean) =>
  $.fs.exists(spritePath(await dataDir($), id, shiny))

/** Downloads a sprite once; curl keeps the PNG bytes intact (`$.http.fetch` is text only). Resolves whether it is there. */
const ensureSprite = async ($: EngineInterface, id: number, shiny: boolean): Promise<boolean> => {
  const path = spritePath(await dataDir($), id, shiny)
  if (await $.fs.exists(path)) return true
  const ran = await $.process.run(['curl', '-fsSL', '--create-dirs', '-o', path, spriteUrl(id, shiny)], { timeoutMs: 20_000 })
  return ran.exitCode === 0 && (await $.fs.exists(path))
}

const localOffset = async ($: EngineInterface): Promise<number | null> => {
  const ran = await $.process.run(['date', '+%z'], { timeoutMs: 5_000 })
  return ran.exitCode === 0 ? parseOffset(ran.stdout) : null
}

// --- State: each store key mirrored in a session atom (store = truth, shared across sessions) ---

type Stored = {
  party: Party
  boxes: Member[]
  progress: Record<string, Progress>
  dex: Dex
  bag: Bag
  pending: Choice[]
  meta: Meta | null
}

const DEFAULTS: Stored = {
  party: { members: [], activeId: null },
  boxes: [],
  progress: {},
  dex: { seen: [], caught: [], shinies: [] },
  bag: { stones: {}, received: [] },
  pending: [],
  meta: null,
}

const partyAtom = atom({ plugin: 'pokemon', key: 'party' } as const, DEFAULTS.party)
const boxesAtom = atom({ plugin: 'pokemon', key: 'boxes' } as const, DEFAULTS.boxes)
const progressAtom = atom({ plugin: 'pokemon', key: 'progress' } as const, DEFAULTS.progress)
const dexAtom = atom({ plugin: 'pokemon', key: 'dex' } as const, DEFAULTS.dex)
const bagAtom = atom({ plugin: 'pokemon', key: 'bag' } as const, DEFAULTS.bag)
const pendingAtom = atom({ plugin: 'pokemon', key: 'pending' } as const, DEFAULTS.pending)
const metaAtom = atom({ plugin: 'pokemon', key: 'meta' } as const, DEFAULTS.meta)
const namingAtom = atom({ plugin: 'pokemon', key: 'naming' } as const, null)
const renamingAtom = atom({ plugin: 'pokemon', key: 'renaming' } as const, null)
const hiddenAtom = atom({ plugin: 'pokemon', key: 'isHidden' } as const, false)
const dexViewAtom = atom({ plugin: 'pokemon', key: 'dexView' } as const, { generation: 1, page: 0, selected: null } as DexView)
const boxPageAtom = atom({ plugin: 'pokemon', key: 'boxPage' } as const, 0)

const KEYS = Object.keys(DEFAULTS) as (keyof Stored)[]
const PANE = 'pokemon-party'
const BOXES_PANE = 'pokemon-boxes'
const DEX_PANE = 'pokemon-dex'
const NAMING_FOR = 10 * 60_000
const DEX_LIST = 20

const load = async <K extends keyof Stored>($: EngineInterface, key: K): Promise<Stored[K]> =>
  ((await $.store.get(key)) as Stored[K] | undefined) ?? DEFAULTS[key]

/** Writes a key's value into its session atom (each atom named directly, as the state scan requires). */
const mirror = async <K extends keyof Stored>($: EngineInterface, key: K, value: Stored[K]) => {
  if (key === 'party') await update($, partyAtom, () => value as Party)
  else if (key === 'boxes') await update($, boxesAtom, () => value as Member[])
  else if (key === 'progress') await update($, progressAtom, () => value as Record<string, Progress>)
  else if (key === 'dex') await update($, dexAtom, () => value as Dex)
  else if (key === 'bag') await update($, bagAtom, () => value as Bag)
  else if (key === 'pending') await update($, pendingAtom, () => value as Choice[])
  else await update($, metaAtom, () => value as Meta | null)
}

const held = async ($: EngineInterface, key: keyof Stored): Promise<unknown> =>
  key === 'party' ? read($, partyAtom)
  : key === 'boxes' ? read($, boxesAtom)
  : key === 'progress' ? read($, progressAtom)
  : key === 'dex' ? read($, dexAtom)
  : key === 'bag' ? read($, bagAtom)
  : key === 'pending' ? read($, pendingAtom)
  : read($, metaAtom)

// Edits run one at a time: parallel tool calls each read-modify-write `progress`, and unqueued they overwrite each other.
let queue: Promise<unknown> = Promise.resolve()
const serially = <T,>(work: () => Promise<T>): Promise<T> => {
  const run = queue.then(work, work)
  queue = run.catch(() => undefined)
  return run
}

/** Read fresh from the store, change, write back, mirror into the atom: another session's write is never overwritten by a stale copy. */
const edit = <K extends keyof Stored>($: EngineInterface, key: K, change: (value: Stored[K]) => Stored[K]) =>
  serially(async () => {
    const next = change(await load($, key))
    await $.store.set(key, next)
    await mirror($, key, next)
    return next
  })

/** Pulls other sessions' writes into this session's atoms (only what changed, so nothing redraws needlessly). */
const syncAll = async ($: EngineInterface) => {
  for (const key of KEYS) {
    const fresh = await load($, key)
    if (JSON.stringify(fresh) !== JSON.stringify(await held($, key))) await mirror($, key, fresh)
  }
}

// --- Telling the player ---

let band = { rows: 99, hasSurvey: false } // what the band could last show; module state, reset on reload

const bandHidden = async ($: EngineInterface) => (await read($, hiddenAtom)) || band.hasSurvey || band.rows < 5

/** A toast, naming the command too when the band can't show the buttons. */
const announce = async ($: EngineInterface, text: string, command?: string) => {
  $.ui.toast(command && (await bandHidden($)) ? `${text}  (${command})` : text)
}

const activeOf = (party: Party) => party.members.find(m => m.id === party.activeId) ?? party.members[0] ?? null

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

const addToDex = (dex: Dex, id: number, shiny: boolean, caught: boolean): Dex => ({
  seen: dex.seen.includes(id) ? dex.seen : [...dex.seen, id],
  caught: !caught || dex.caught.includes(id) ? dex.caught : [...dex.caught, id],
  shinies: !caught || !shiny || dex.shinies.includes(id) ? dex.shinies : [...dex.shinies, id],
})

const maybeUnlockExpShare = async ($: EngineInterface, dex: Dex, meta: Meta, hour: number, roll: boolean) => {
  if (meta.expShareUnlocked || !expShareGeneration(generationOf(meta))) return
  const caught = caughtInGeneration(dex.caught, 1)
  const found = caught >= EXP_SHARE_TARGET || (roll && expShareRoll(rngFor(meta.salt, hour, 'exp-share')))
  if (!found) return
  let unlocked = false
  await edit($, 'meta', m => {
    if (!m || m.expShareUnlocked) return m
    unlocked = true
    return { ...m, expShareUnlocked: true }
  })
  if (unlocked) {
    $.ui.toast(`Professor Oak's aide: "Take this Exp. All! Type /pokemon share-exp to turn it on or off."`)
  }
}

const removeChoice = (id: string) => (pending: Choice[]) => pending.filter(c => c.id !== id)

const reconcileBoxes = async ($: EngineInterface) => {
  const party = await load($, 'party')
  const boxes = await load($, 'boxes')
  const partyIds = new Set(party.members.map(m => m.id))
  const clean = boxes.filter(m => !partyIds.has(m.id))
  if (clean.length !== boxes.length) await edit($, 'boxes', () => clean)
}

// shortcut: party and boxes are separate keys; a crash between writes can duplicate until the tick reconciles.
const storeMember = async ($: EngineInterface, member: Member): Promise<string> => {
  const party = await load($, 'party')
  const progress = await load($, 'progress')
  if (!party.members.some(m => m.id === member.id)) return `${displayName(member)} is not in your party.`
  const level = progress[member.id]?.level ?? 0
  if (!canStore(level)) return `Only Lv. 100 Pokémon can be stored. ${displayName(member)} is Lv. ${level}.`
  if (party.members.length <= 1) return `You can't store your last Pokémon.`
  await edit($, 'boxes', boxes => (boxes.some(m => m.id === member.id) ? boxes : [...boxes, member]))
  let stored = false
  await edit($, 'party', p => {
    if (!p.members.some(m => m.id === member.id)) return p
    stored = true
    const members = p.members.filter(m => m.id !== member.id)
    return { members, activeId: p.activeId === member.id ? (members[0]?.id ?? null) : p.activeId }
  })
  await edit($, 'pending', p => p.filter(c => !((c.kind === 'evolution' || c.kind === 'stone') && c.memberId === member.id)))
  await update($, namingAtom, n => (n?.memberId === member.id ? null : n))
  await update($, renamingAtom, r => (r === member.id ? null : r))
  return `${displayName(member)} was stored in the Boxes.`
}

const takeMember = async ($: EngineInterface, member: Member): Promise<string> => {
  const party = await load($, 'party')
  if (party.members.some(m => m.id === member.id)) {
    await edit($, 'boxes', boxes => boxes.filter(m => m.id !== member.id))
    return `${displayName(member)} is already in your party.`
  }
  if (party.members.length >= PARTY_SIZE) return `Your party is full (6). Swap a Lv. 100 Pokémon or release one first.`
  let taken = false
  await edit($, 'party', p => {
    if (p.members.length >= PARTY_SIZE || p.members.some(m => m.id === member.id)) return p
    taken = true
    return { members: [...p.members, member], activeId: p.activeId ?? member.id }
  })
  if (!taken) {
    const fresh = await load($, 'party')
    if (fresh.members.some(m => m.id === member.id)) {
      await edit($, 'boxes', boxes => boxes.filter(m => m.id !== member.id))
      return `${displayName(member)} is already in your party.`
    }
    return `Your party is full (6). Swap a Lv. 100 Pokémon or release one first.`
  }
  await edit($, 'boxes', boxes => boxes.filter(m => m.id !== member.id))
  const now = await $.clock.now()
  await edit($, 'progress', p => (p[member.id] ? p : { ...p, [member.id]: newProgress(MAX_LEVEL, START_FRIENDSHIP, now) }))
  return `${displayName(member)} joined your party!`
}

const swapMembers = async ($: EngineInterface, fromParty: Member, fromBox: Member): Promise<string> => {
  if (fromParty.id === fromBox.id) return 'Those are the same Pokémon.'
  const party = await load($, 'party')
  const boxes = await load($, 'boxes')
  const progress = await load($, 'progress')
  if (!party.members.some(m => m.id === fromParty.id)) return `${displayName(fromParty)} is not in your party.`
  if (!boxes.some(m => m.id === fromBox.id)) return `${displayName(fromBox)} is not in your Boxes.`
  if (!canStore(progress[fromParty.id]?.level ?? 0)) {
    return `Only Lv. 100 Pokémon can be stored. ${displayName(fromParty)} is Lv. ${progress[fromParty.id]?.level ?? 0}.`
  }
  if (party.members.length >= PARTY_SIZE) {
    const stored = await storeMember($, fromParty)
    if (!stored.includes('was stored')) return stored
    const taken = await takeMember($, fromBox)
    if (party.activeId === fromParty.id) await edit($, 'party', p => ({ ...p, activeId: fromBox.id }))
    return `${stored} ${taken}`
  }
  const taken = await takeMember($, fromBox)
  if (taken.includes('party is full')) return taken
  const stored = await storeMember($, fromParty)
  if (party.activeId === fromParty.id) await edit($, 'party', p => ({ ...p, activeId: fromBox.id }))
  return `${taken} ${stored}`
}

// --- Starter ---

const ensureStarterChoice = async ($: EngineInterface, now: number) => {
  const party = await load($, 'party')
  const pending = await load($, 'pending')
  const hasChoice = pending.some(c => c.kind === 'starter')
  if (party.members.length === 0 && !hasChoice) {
    await edit($, 'pending', p => upsertChoice(p, { kind: 'starter', id: 'starter', createdAt: now }))
    await announce($, 'Professor Oak: choose your first Pokémon!', '/pokemon starter bulbasaur|charmander|squirtle')
  } else if (party.members.length > 0 && hasChoice) {
    await edit($, 'pending', p => p.filter(c => c.kind !== 'starter'))
  }
}

const chooseStarter = async ($: EngineInterface, name: string): Promise<string> => {
  const starter = STARTERS.find(s => s.name === name.trim().toLowerCase())
  if (!starter) return 'Choose bulbasaur, charmander or squirtle.'
  if ((await load($, 'party')).members.length > 0) return 'You already have a Pokémon; the starter offer is over.'
  const now = await $.clock.now()
  try {
    const species = await speciesInfo($, starter.id)
    const chain = await formOf($, species)
    await ensureSprite($, starter.id, false).catch(() => false)
    const profile = await profileOf($, starter.id).catch(() => undefined)
    const member: Member = {
      id: crypto.randomUUID(), speciesId: starter.id, name: starter.name, chain, shiny: false, nickname: null, caughtAt: now,
      ...(profile ? { profile } : {}),
    }
    let added = false
    await edit($, 'party', party => {
      if (party.members.length > 0) return party // another session chose first
      added = true
      return { members: [member], activeId: member.id }
    })
    if (!added) return 'Another session already chose your starter.'
    await edit($, 'progress', p => ({ ...p, [member.id]: newProgress(5, START_FRIENDSHIP, now) }))
    await edit($, 'dex', dex => addToDex(dex, starter.id, false, true))
    await edit($, 'pending', p => p.filter(c => c.kind !== 'starter'))
    await update($, namingAtom, () => ({ memberId: member.id, until: now + NAMING_FOR }))
    $.ui.toast(`You chose ${title(starter.name).toUpperCase()}!`)
    return `${title(starter.name)} joined your party at Lv. 5. Give it a nickname with /pokemon nick 1 <name>, or in the field above the prompt.`
  } catch (error) {
    return `Couldn't reach PokeAPI (${String(error)}). Try again in a moment.`
  }
}

// --- Encounters and stones (deterministic per hour: two sessions compute the same thing) ---

const generateEncounter = async ($: EngineInterface, meta: Meta, hour: number, cap: number): Promise<Choice> => {
  const rng = rngFor(meta.salt, hour, 'species')
  const clock = localHour(hour * HOUR, meta.utcOffsetMinutes)
  const stage = stageOf(meta)
  let picked: SpeciesInfo | null = null
  for (let attempt = 0; attempt < ENCOUNTER_ATTEMPTS; attempt++) {
    const id = speciesIdFor(rng, generationOf(meta))
    const species = await speciesInfo($, id)
    if (stage === 'base' && !species.baseForm) continue
    if (cap !== Infinity && (await formOf($, species)).reachLevel > cap) continue
    const roll = rng()
    picked = species
    const factor = typeFactor(await typesOf($, id), clock)
    if (roll < acceptChance(species.captureRate, species.legendary, factor)) break
  }
  if (!picked) throw new Error('no species')
  const chain = await formOf($, picked)
  const shiny = isShiny(rngFor(meta.salt, hour, 'shiny'))
  const level = encounterLevel(chain.reachLevel, rngFor(meta.salt, hour, 'level'), cap)
  if (!(await ensureSprite($, picked.id, shiny))) throw new Error('sprite download failed')
  return {
    kind: 'encounter', id: `enc-${hour}`, createdAt: hour * HOUR, hour,
    speciesId: picked.id, name: picked.name, shiny, level, legendary: picked.legendary, chain,
  }
}

/** The level of every member of the party, as the progress knows it. */
const partyLevels = async ($: EngineInterface): Promise<number[]> => {
  const party = await load($, 'party')
  const progress = await load($, 'progress')
  return party.members.map(m => progress[m.id]?.level ?? 0)
}

const rollEncounter = async ($: EngineInterface, now: number) => {
  const meta = await load($, 'meta')
  const hour = hourOf(now)
  if (!meta || hour <= meta.lastRollHour) return
  const party = await load($, 'party')
  if (party.members.length === 0 || party.members.length >= PARTY_SIZE) return

  const cap = levelCapValue(levelCapOf(meta), await partyLevels($))
  const encounter = await generateEncounter($, meta, hour, cap) // throws on PokeAPI/sprite failure: the next tick retries
  if (encounter.kind !== 'encounter') return
  const fresh = await load($, 'meta')
  if (!fresh || fresh.lastRollHour >= hour) return // another session published it meanwhile
  await edit($, 'meta', m => (m ? { ...m, lastRollHour: Math.max(m.lastRollHour, hour) } : m))

  const fled = (await load($, 'pending')).filter(c => c.kind === 'encounter' && c.id !== encounter.id)
  await edit($, 'pending', p => upsertChoice(p.filter(c => c.kind !== 'encounter'), encounter))
  await edit($, 'dex', dex => addToDex(dex, encounter.speciesId, encounter.shiny, false))
  for (const old of fled) if (old.kind === 'encounter') $.ui.toast(`The wild ${title(old.name).toUpperCase()} fled!`)

  const name = title(encounter.name).toUpperCase()
  if (encounter.legendary) $.ui.toast('A legendary Pokémon appeared!')
  await announce($, `${encounter.shiny ? '✨ ' : ''}A wild ${name} appeared! (Lv. ${encounter.level})`, '/pokemon keep [nickname] or /pokemon letgo')
}

const rollStone = async ($: EngineInterface, now: number) => {
  const meta = await load($, 'meta')
  if (!meta) return
  const hour = hourOf(now)
  const stone = stoneFor(meta.salt, hour, meta.lastStoneHour)
  if (!stone) return
  const dropId = `stone-${hour}`
  if ((await load($, 'bag')).received.includes(dropId)) return
  await edit($, 'meta', m => (m ? { ...m, lastStoneHour: Math.max(m.lastStoneHour, hour) } : m))
  let isNew = false
  await edit($, 'bag', bag => {
    if (bag.received.includes(dropId)) return bag
    isNew = true
    return { stones: { ...bag.stones, [stone]: (bag.stones[stone] ?? 0) + 1 }, received: [...bag.received, dropId].slice(-20) }
  })
  if (!isNew) return
  const party = await load($, 'party')
  const target = stoneTarget(party.members, party.activeId, stone)
  const found = `Found a ${title(stone)}!`
  if (!target) {
    $.ui.toast(`${found} It went into your bag.`)
    return
  }
  await edit($, 'pending', p => upsertChoice(p, { kind: 'stone', id: dropId, createdAt: now, stone, memberId: target.id }))
  await announce($, `${found} Use it on ${displayName(target)}?`, `/bag use ${stone} ${displayName(target)}`)
}

// --- Evolution ---

const startEvolution = async (
  $: EngineInterface, member: Member, paths: Path[], stone: Stone | null, now: number, countdown = EVOLUTION_COUNTDOWN,
) => {
  const pending = await load($, 'pending')
  if (pending.some(c => c.kind === 'evolution' && c.memberId === member.id)) return
  const choice: Choice = {
    kind: 'evolution', id: `evo-${member.id}-${now}`, createdAt: now, memberId: member.id, paths,
    deadline: now + countdown, stone,
  }
  await edit($, 'pending', p => upsertChoice(p, choice))
  const hint = paths.length > 1 ? `/pokemon evolve ${paths.map(p => p.name).join('|')} or /pokemon stop` : '/pokemon stop'
  await announce($, `What? ${displayName(member)} is evolving!`, hint)
  $.clock.after(countdown + 200, () => void settleEvolutions($).catch(() => undefined))
}

const finishEvolution = async ($: EngineInterface, choiceId: string, path: Path): Promise<string> => {
  const choice = (await load($, 'pending')).find(c => c.id === choiceId)
  if (!choice || choice.kind !== 'evolution') return 'Nothing is evolving.'
  const member = (await load($, 'party')).members.find(m => m.id === choice.memberId)
  const edge = member?.chain.edges.find(e => e.to.id === path.id)
  if (!member || !edge) {
    await edit($, 'pending', removeChoice(choiceId))
    const text = 'That evolution is no longer possible.'
    $.ui.toast(text)
    return text
  }
  if (choice.stone && !((await load($, 'bag')).stones[choice.stone] ?? 0)) {
    await edit($, 'pending', removeChoice(choiceId))
    const text = `You no longer have a ${title(choice.stone)}.`
    $.ui.toast(text)
    return text
  }
  // Claim the choice first, so a second settle (another session, the tick) does nothing.
  let claimed = false
  await edit($, 'pending', p => {
    claimed = p.some(c => c.id === choiceId)
    return p.filter(c => c.id !== choiceId)
  })
  if (!claimed) return 'Already settled.'
  await ensureSprite($, path.id, member.shiny).catch(() => false) // on failure the badge shows until the tick retries
  const profile = await profileOf($, path.id).catch(() => undefined)
  const before = displayName(member)
  await edit($, 'party', party => ({
    ...party,
    members: party.members.map(m => (m.id === member.id
      ? { ...m, speciesId: path.id, name: path.name, chain: edge.to, ...(profile ? { profile } : {}) }
      : m)),
  }))
  if (choice.stone) {
    const stone = choice.stone
    await edit($, 'bag', bag => ({ ...bag, stones: { ...bag.stones, [stone]: Math.max(0, (bag.stones[stone] ?? 0) - 1) } }))
  }
  const dex = await edit($, 'dex', d => addToDex(d, path.id, member.shiny, true))
  const meta = await load($, 'meta')
  if (meta) await maybeUnlockExpShare($, dex, meta, hourOf(await $.clock.now()), false)
  const text = `✨ Congratulations! Your ${before} evolved into ${title(path.name).toUpperCase()}!`
  $.ui.toast(text)
  return text
}

const stopEvolution = async ($: EngineInterface, choiceId: string): Promise<string> => {
  const choice = (await load($, 'pending')).find(c => c.id === choiceId)
  if (!choice || choice.kind !== 'evolution') return 'Nothing is evolving.'
  await edit($, 'pending', removeChoice(choiceId))
  const member = (await load($, 'party')).members.find(m => m.id === choice.memberId)
  const text = `Huh? ${member ? displayName(member) : 'It'} stopped evolving!`
  $.ui.toast(text)
  return text
}

/** Past the deadline: one path evolves; a branch nobody chose counts as Stop. */
const settleEvolutions = async ($: EngineInterface) => {
  const now = await $.clock.now()
  for (const choice of await load($, 'pending')) {
    if (choice.kind !== 'evolution' || choice.deadline > now) continue
    if (choice.paths.length === 1 && choice.paths[0]) await finishEvolution($, choice.id, choice.paths[0])
    else await stopEvolution($, choice.id)
  }
}

// --- The minute tick: sync, settle, friendship, encounter, stone, sprites ---

let ticking = false
let lastMeal = '' // the last tool that fed the active Pokémon, shown while a turn runs

const grewTo = async (
  $: EngineInterface, member: Member, progress: Progress | undefined, levelsGained: number, now: number,
  countdown = EVOLUTION_COUNTDOWN,
) => {
  if (levelsGained <= 0 || !progress) return
  $.ui.toast(`${displayName(member)} grew to Lv. ${progress.level}!`)
  const meta = await load($, 'meta')
  const paths = levelUpPaths(member.chain, progress.level, progress.friendship, localHour(now, meta?.utcOffsetMinutes ?? 0))
  if (paths.length > 0) await startEvolution($, member, paths, null, now, countdown)
}

/** Fills in a member's missing profile, for a Pokémon caught before the plugin knew about them. */
const fillProfile = async ($: EngineInterface, member: Member): Promise<void> => {
  if (member.profile) return
  const profile = await profileOf($, member.speciesId).catch(() => undefined)
  if (!profile) return
  const patch = (m: Member) => (m.id === member.id ? { ...m, profile } : m)
  await edit($, 'party', party => ({ ...party, members: party.members.map(patch) }))
  await edit($, 'boxes', boxes => boxes.map(patch))
}

const tick = async ($: EngineInterface) => {
  if (ticking) return
  ticking = true
  try {
    const now = await $.clock.now()
    await syncAll($)
    await reconcileBoxes($).catch(() => undefined)
    await settleEvolutions($).catch(() => undefined)
    await friendshipTick($, now).catch(() => undefined)
    const meta = await load($, 'meta')
    if (meta) await maybeUnlockExpShare($, await load($, 'dex'), meta, hourOf(now), false).catch(() => undefined)
    await rollEncounter($, now).catch(() => undefined)
    await rollStone($, now).catch(() => undefined)
    const party = await load($, 'party')
    const boxes = await load($, 'boxes')
    for (const member of [...party.members, ...boxes]) {
      await ensureSprite($, member.speciesId, member.shiny).catch(() => false)
      if (!member.profile) await fillProfile($, member)
    }
    const naming = await read($, namingAtom)
    if (naming && naming.until <= now) await update($, namingAtom, () => null)
  } finally {
    ticking = false
  }
}

const friendshipTick = async ($: EngineInterface, now: number) => {
  const meta = await load($, 'meta')
  const bucket = bucketOf(now)
  if (!meta || bucket <= meta.lastFriendshipBucket) return
  await edit($, 'meta', m => (m ? { ...m, lastFriendshipBucket: Math.max(m.lastFriendshipBucket, bucket) } : m))
  const active = activeOf(await load($, 'party'))
  if (!active) return
  await edit($, 'progress', p => {
    const mine = p[active.id]
    return mine ? { ...p, [active.id]: friendshipStep(mine, now, bucket) } : p
  })
}

// --- Choices the player answers ---

const topOf = async ($: EngineInterface, kind: Choice['kind']) => (await load($, 'pending')).find(c => c.kind === kind) ?? null

const keepEncounter = async ($: EngineInterface, nickname?: string): Promise<string> => {
  const choice = await topOf($, 'encounter')
  if (!choice || choice.kind !== 'encounter') return 'No wild Pokémon is waiting.'
  const party = await load($, 'party')
  if (party.members.some(m => m.id === choice.id)) {
    await edit($, 'pending', removeChoice(choice.id))
    return 'You already caught that one.'
  }
  if (party.members.length >= PARTY_SIZE) return 'Your party is full (6). Release one first: /pokemon release <slot>.'
  const now = await $.clock.now()
  const profile = await profileOf($, choice.speciesId).catch(() => undefined)
  const member: Member = {
    id: choice.id, speciesId: choice.speciesId, name: choice.name, chain: choice.chain, shiny: choice.shiny,
    nickname: nickname?.trim() ? nickname.trim().slice(0, 12) : null, caughtAt: now,
    ...(profile ? { profile } : {}),
  }
  let added = false
  await edit($, 'party', p => {
    if (p.members.some(m => m.id === member.id) || p.members.length >= PARTY_SIZE) return p
    added = true
    return { ...p, members: [...p.members, member] }
  })
  await edit($, 'pending', removeChoice(choice.id))
  if (!added) return 'Someone was faster: it is already in your party, or the party filled up.'
  await edit($, 'progress', p => ({ ...p, [member.id]: newProgress(choice.level, START_FRIENDSHIP, now) }))
  const before = await load($, 'dex')
  const dex = await edit($, 'dex', d => addToDex(d, member.speciesId, member.shiny, true))
  const meta = await load($, 'meta')
  const newGenOne = choice.speciesId >= 1 && choice.speciesId <= 151 && !before.caught.includes(choice.speciesId)
  if (meta) await maybeUnlockExpShare($, dex, meta, choice.hour, newGenOne)
  if (!member.nickname) await update($, namingAtom, () => ({ memberId: member.id, until: now + NAMING_FOR }))
  const text = `Gotcha! ${displayName(member)} was caught!`
  $.ui.toast(text)
  return text
}

const letGo = async ($: EngineInterface): Promise<string> => {
  const choice = await topOf($, 'encounter')
  if (!choice || choice.kind !== 'encounter') return 'No wild Pokémon is waiting.'
  await edit($, 'pending', removeChoice(choice.id))
  return `Bye, ${title(choice.name).toUpperCase()}!`
}

const useStone = async ($: EngineInterface, stone: Stone, member: Member): Promise<string> => {
  const count = (await load($, 'bag')).stones[stone] ?? 0
  if (count <= 0) return `You don't have a ${title(stone)}.`
  const reserved = (await load($, 'pending')).filter(c => c.kind === 'evolution' && c.stone === stone).length
  if (reserved >= count) return `The ${title(stone)} is already in use.`
  const paths = stonePaths(member.chain, stone)
  if (paths.length === 0) return `It won't have any effect on ${displayName(member)}.`
  await edit($, 'pending', p => p.filter(c => !(c.kind === 'stone' && c.stone === stone && c.memberId === member.id)))
  await startEvolution($, member, paths, stone, await $.clock.now())
  return `${displayName(member)} reacts to the ${title(stone)}!`
}

const answerStone = async ($: EngineInterface, use: boolean): Promise<string> => {
  const choice = await topOf($, 'stone')
  if (!choice || choice.kind !== 'stone') return 'No stone is waiting.'
  await edit($, 'pending', removeChoice(choice.id))
  if (!use) return `The ${title(choice.stone)} is in your bag.`
  const member = (await load($, 'party')).members.find(m => m.id === choice.memberId)
  return member ? useStone($, choice.stone, member) : 'That Pokémon is no longer in your party.'
}

const rename = async ($: EngineInterface, memberId: string, nickname: string) => {
  const clean = nickname.trim().slice(0, 12)
  await edit($, 'party', p => ({ ...p, members: p.members.map(m => (m.id === memberId ? { ...m, nickname: clean || null } : m)) }))
  await update($, namingAtom, n => (n?.memberId === memberId ? null : n))
  await update($, renamingAtom, r => (r === memberId ? null : r))
}

const release = async ($: EngineInterface, member: Member): Promise<string> => {
  const party = await load($, 'party')
  if (party.members.length <= 1) return `${displayName(member)} is your only Pokémon; you can't release it.`
  await edit($, 'party', p => {
    const members = p.members.filter(m => m.id !== member.id)
    return { members, activeId: p.activeId === member.id ? (members[0]?.id ?? null) : p.activeId }
  })
  await edit($, 'progress', p => Object.fromEntries(Object.entries(p).filter(([id]) => id !== member.id)))
  await edit($, 'pending', p => p.filter(c => !((c.kind === 'evolution' || c.kind === 'stone') && c.memberId === member.id)))
  return `${displayName(member)} was released. Bye bye, ${displayName(member)}!`
}

const switchTo = async ($: EngineInterface, member: Member): Promise<string> => {
  const now = await $.clock.now()
  await edit($, 'party', p => ({ ...p, activeId: member.id }))
  await edit($, 'progress', p => {
    const mine = p[member.id]
    return mine ? { ...p, [member.id]: { ...mine, lastXpAt: now } } : p // so it doesn't arrive bored
  })
  return `Go, ${displayName(member)}!`
}

// --- Text answers ---

const statsText = (member: Member, progress: Progress | undefined, now: number) => {
  const p = progress ?? newProgress(5, START_FRIENDSHIP, now)
  const profile = member.profile ?? emptyProfile
  const lines = [
    `${member.shiny ? '✨ ' : ''}${displayName(member)}  ${title(member.name)} #${member.speciesId}  Lv. ${p.level}`,
  ]
  if (profile.types.length > 0) lines.push(profile.types.map(title).join(' · '))
  if (profile.ability) lines.push(`Ability: ${title(profile.ability)}`)
  if (profile.stats.hp > 0) lines.push(statLine(profile.stats))
  lines.push(`EXP ${p.xp}/${xpToNext(p.level)}  ·  mood ${moodOf(p, now)}  ·  friendship ${p.friendship}/255`)
  lines.push(`Evolves: ${nextEvolutionText(member.chain)}`)
  return lines.join('\n')
}

const partyText = (party: Party, progress: Record<string, Progress>) =>
  party.members
    .map((m, i) => `${i + 1}. ${m.id === party.activeId ? '▶ ' : ''}${displayName(m)} (${title(m.name)} Lv. ${progress[m.id]?.level ?? '?'})`)
    .join('\n')

const boxesText = (boxes: Member[]) => `Boxes: ${boxes.length} stored · /boxes`

const dexSummary = async ($: EngineInterface, dex: Dex, generation: Generation): Promise<string> => {
  const [lo, hi] = generationRange(generation)
  const total = generationCount(generation)
  const inRange = (id: number) => id >= lo && id <= hi
  const shinies: string[] = []
  for (const id of dex.shinies.filter(inRange)) shinies.push(await speciesInfo($, id).then(s => title(s.name)).catch(() => `#${id}`))
  return [
    `${capitalize(generationName(generation))} · Seen ${dex.seen.filter(inRange).length}/${total} · Caught ${dex.caught.filter(inRange).length}/${total}`,
    `Shinies: ${shinies.length ? shinies.join(', ') : 'none yet'}`,
    'The list: /pokedex seen · /pokedex caught · /pokedex <number>',
  ].join('\n')
}

const preloadDexPage = async ($: EngineInterface, generation: number, page: number, dex: Dex) => {
  const ids = speciesPage(generation, page, DEX_PAGE_SIZE).filter(id => dex.seen.includes(id) || dex.caught.includes(id))
  await Promise.allSettled(ids.map(id => ensureSprite($, id, dex.shinies.includes(id))))
}

const dexStatus = async ($: EngineInterface, dex: Dex, id: number): Promise<string> => {
  const name = await speciesInfo($, id).then(s => title(s.name)).catch(() => `#${id}`)
  const state = dex.caught.includes(id) ? 'caught' : dex.seen.includes(id) ? 'seen' : 'not seen'
  return `#${String(id).padStart(3, '0')} ${name} — ${state}`
}

const generationLine = (generation: Generation) =>
  `Wild encounters: ${capitalize(generationName(generation))} · ${generationCount(generation)} species.`

const generationText = (generation: Generation) =>
  [
    generationLine(generation),
    '/pokemon gen <1-9|all> · /pokemon region <kanto|johto|hoenn|sinnoh|unova|kalos|alola|galar|paldea>',
  ].join('\n')

const stageLine = (stage: Stage) => `Wild encounters: ${stageName(stage)}.`

const stageText = (stage: Stage) =>
  [
    stageLine(stage),
    '/pokemon stage <base|all>',
  ].join('\n')

const HELP = [
  '/pokemon                         active Pokémon stats',
  '/pokemon switch|release <slot|name>, /pokemon nick <slot|name> <nickname>',
  '/pokemon store|take <slot|name>  move a Lv. 100 Pokémon in or out of the Boxes',
  '/pokemon swap <party slot> <box slot>  trade a Lv. 100 party member for a boxed one',
  '/pokemon keep [nickname] | letgo | stop | evolve <species> | starter <name>',
'/pokemon gen|region <1-9|all>     wild encounters come from one generation',
  '/pokemon stage <base|all>         wild encounters come from one stage of the chain',
  '/pokemon levelcap <party|off|n>   wild encounters never go past a level',
  '/pokemon hide|show · /party · /boxes · /pokedex · /bag [use <stone> <slot|name>]',
].join('\n')

// --- Hooks ---

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const now = await $.clock.now()
    await $.store.delete('mon') // v1's single Pokémon: the player chose to start fresh
    await edit($, 'meta', meta =>
      meta ?? {
        salt: crypto.randomUUID(), installedAt: now, utcOffsetMinutes: 0,
        lastRollHour: hourOf(now), lastStoneHour: hourOf(now), lastFriendshipBucket: bucketOf(now),
generation: DEFAULT_GENERATION,
        stage: DEFAULT_STAGE,
        levelCap: DEFAULT_LEVEL_CAP,
      },
    )
    const offset = await localOffset($).catch(() => null)
    if (offset !== null) await edit($, 'meta', m => (m ? { ...m, utcOffsetMinutes: offset } : m))
    await syncAll($)
    await ensureStarterChoice($, now)

    for (const [name, description, argumentHint] of [
      ['pokemon', 'Your active Pokémon, and the choices: keep, letgo, stop, evolve, nick, switch, release, store, take, swap, gen, stage, levelcap', '[keep|letgo|stop|evolve|nick|switch|release|store|take|swap|starter|gen|region|stage|levelcap|hide|show] …'],
      ['party', 'Open or close your Pokémon party', '[open|close]'],
      ['boxes', 'Open or close your Pokémon Boxes', '[open|close]'],
      ['pokedex', 'Browse the Pokédex by generation, or list seen and caught Pokémon', '[open|close|gen <1-9>|seen|caught|<number>]'],
      ['bag', 'Your evolution stones; /bag use <stone> <slot|name>', '[use <stone> <slot|name>]'],
    ] as const) {
      await $.command.register({ name, description, ...(argumentHint ? { argumentHint } : {}) })
    }

    $.clock.every(60_000, () => void tick($).catch(() => undefined))
    void tick($).catch(() => undefined) // catch up on the hour we came back in
    return started
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    try {
      const now = await $.clock.now()
      const party = await load($, 'party')
      const active = activeOf(party)
      if (!active) return ran
      lastMeal = e.tool
      let levelsGained = 0
      const progress = await edit($, 'progress', p => {
        const gained = gainCall(p[active.id] ?? newProgress(5, START_FRIENDSHIP, now), now)
        levelsGained = gained.levelsGained
        return { ...p, [active.id]: gained.progress }
      })
      await grewTo($, active, progress[active.id], levelsGained, now)

      const meta = await load($, 'meta')
      const sharing = meta?.expShareUnlocked && meta.expShare ? party.members.filter(m => m.id !== active.id) : []
      if (sharing.length === 0) return ran
      const gained = new Map<string, { progress: Progress; levelsGained: number }>()
      await edit($, 'progress', p => {
        const updated = { ...p }
        for (const member of sharing) {
          const shared = gainExp(p[member.id] ?? newProgress(5, START_FRIENDSHIP, now), SHARE_FACTOR, now)
          updated[member.id] = shared.progress
          gained.set(member.id, shared)
        }
        return updated
      })
      for (const member of sharing) {
        const shared = gained.get(member.id)
        if (shared) await grewTo($, member, shared.progress, shared.levelsGained, now, SHARED_EVOLUTION_COUNTDOWN)
      }
    } catch {
      // a Pokémon bug never fails a tool call
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'pokemon' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    const arg = rest.join(' ')
    const party = await load($, 'party')
    const now = await $.clock.now()
    const target = (query: string) => findTarget(party.members, query)

    switch (verb) {
      case '': {
        const active = activeOf(party)
        if (!active) return { text: `No Pokémon yet: choose a starter. /pokemon starter bulbasaur|charmander|squirtle\n\n${HELP}` }
        const generation = generationOf(await load($, 'meta'))
        return { text: `${generationLine(generation)}\n\n${statsText(active, (await load($, 'progress'))[active.id], now)}\n\n${partyText(party, await load($, 'progress'))}\n${boxesText(await load($, 'boxes'))}\n\n${HELP}` }
      }
      case 'starter': return { text: await chooseStarter($, arg) }
case 'gen':
      case 'region': {
        const current = generationOf(await load($, 'meta'))
        if (!arg.trim()) return { text: generationText(current) }
        const generation = parseGeneration(arg)
        if (generation === null) return { text: `I don't know "${arg.trim()}".\n\n${generationText(current)}` }
        await edit($, 'meta', m => (m ? { ...m, generation } : m))
        if (expShareGeneration(generation)) {
          const meta = await load($, 'meta')
          if (meta) await maybeUnlockExpShare($, await load($, 'dex'), meta, hourOf(now), false)
        }
        return { text: `Wild encounters now come from ${generationName(generation)} · ${generationCount(generation)} species.` }
      }
      case 'stage': {
        const current = stageOf(await load($, 'meta'))
        if (!arg.trim()) return { text: stageText(current) }
        const stage = parseStage(arg)
        if (stage === null) return { text: `I don't know "${arg.trim()}".\n\n${stageText(current)}` }
        await edit($, 'meta', m => (m ? { ...m, stage } : m))
        return { text: `Wild encounters now come from ${stageName(stage)}.` }
      }
      case 'levelcap': {
        const levels = await partyLevels($)
        const current = levelCapOf(await load($, 'meta'))
        const line = `Wild encounters: ${levelCapName(current, levelCapValue(current, levels))}.`
        if (!arg.trim()) return { text: line }
        const cap = parseLevelCap(arg)
        if (cap === null) return { text: `I don't know "${arg.trim()}".\n\n${line}` }
        await edit($, 'meta', m => (m ? { ...m, levelCap: cap } : m))
        return { text: `Wild encounters now come at ${levelCapName(cap, levelCapValue(cap, levels))}.` }
      }
      case 'store': {
        const found = target(arg)
        return { text: 'error' in found ? found.error : await storeMember($, found.member) }
      }
      case 'take': {
        const found = findTarget(await load($, 'boxes'), arg, 'boxes')
        return { text: 'error' in found ? found.error : await takeMember($, found.member) }
      }
      case 'swap': {
        const [partySlot = '', boxSlot = ''] = rest
        if (!/^\d+$/.test(partySlot) || !/^\d+$/.test(boxSlot)) return { text: 'Use /pokemon swap <party slot> <box slot>.' }
        const foundParty = findTarget(party.members, partySlot)
        if ('error' in foundParty) return { text: foundParty.error }
        const foundBox = findTarget(await load($, 'boxes'), boxSlot, 'boxes')
        if ('error' in foundBox) return { text: foundBox.error }
        return { text: await swapMembers($, foundParty.member, foundBox.member) }
      }
      case 'share-exp': {
        const meta = await load($, 'meta')
        if (!meta?.expShareUnlocked) return { text: HELP }
        const enabled = !meta.expShare
        await edit($, 'meta', m => (m ? { ...m, expShare: enabled } : m))
        return { text: enabled
          ? 'EXP Share on: every other party member gains a flat 0.5 EXP per successful tool call.'
          : 'EXP Share off.' }
      }
      case 'keep': return { text: await keepEncounter($, arg) }
      case 'letgo': return { text: await letGo($) }
      case 'stop': {
        const choice = await topOf($, 'evolution')
        return { text: choice ? await stopEvolution($, choice.id) : 'Nothing is evolving.' }
      }
      case 'evolve': {
        const choice = await topOf($, 'evolution')
        if (!choice || choice.kind !== 'evolution') return { text: 'Nothing is evolving.' }
        const path = choice.paths.find(p => p.name === arg.toLowerCase().replace(/\s+/g, '-')) ?? (choice.paths.length === 1 ? choice.paths[0] : undefined)
        return { text: path ? await finishEvolution($, choice.id, path) : `Choose one of: ${choice.paths.map(p => p.name).join(', ')}` }
      }
      case 'nick': {
        const [who = '', ...name] = rest
        const found = target(who)
        if ('error' in found) return { text: found.error }
        await rename($, found.member.id, name.join(' '))
        return { text: name.length ? `${title(found.member.name)} is now called ${name.join(' ').slice(0, 12)}.` : 'Nickname cleared.' }
      }
      case 'switch': {
        const found = target(arg)
        return { text: 'error' in found ? found.error : await switchTo($, found.member) }
      }
      case 'release': {
        const found = target(arg)
        return { text: 'error' in found ? found.error : await release($, found.member) }
      }
      case 'hide':
      case 'show':
        await update($, hiddenAtom, () => verb === 'hide')
        return { text: verb === 'hide' ? 'Your Pokémon went back in its ball (it still earns EXP).' : 'Your Pokémon came out!' }
      default:
        return { text: HELP }
    }
  })

  on('command.run', { command: 'party' }, async ($, e) => {
    const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
    if (e.args.trim() === 'close' || (isOpen && e.args.trim() !== 'open')) {
      await $.ui.close({ id: PANE })
      return { text: 'Party closed.' }
    }
    await $.ui.open({ id: PANE, title: 'Pokémon party' })
    return { text: partyText(await load($, 'party'), await load($, 'progress')) || 'No Pokémon yet.' }
  })

  on('command.run', { command: 'boxes' }, async ($, e) => {
    const isOpen = (await $.ui.panes()).some(pane => pane.id === BOXES_PANE)
    if (e.args.trim() === 'close' || (isOpen && e.args.trim() !== 'open')) {
      await $.ui.close({ id: BOXES_PANE })
      return { text: 'Boxes closed.' }
    }
    await $.ui.open({ id: BOXES_PANE, title: 'Pokémon Boxes' })
    return { text: boxesText(await load($, 'boxes')) }
  })

  on('command.run', { command: 'pokedex' }, async ($, e) => {
    const dex = await load($, 'dex')
    const generation = generationOf(await load($, 'meta'))
    const [lo, hi] = generationRange(generation)
    const inRange = (id: number) => id >= lo && id <= hi
    const arg = e.args.trim()
    if (arg === 'close') {
      await $.ui.close({ id: DEX_PANE })
      return { text: 'Pokédex closed.' }
    }
    if (arg === 'gen' || arg.startsWith('gen ')) {
      const viewed = parseGeneration(arg.slice(3).trim())
      if (viewed === null || viewed === 'all') return { text: 'Use /pokedex gen <1-9>.' }
      await update($, dexViewAtom, () => ({ generation: viewed, page: 0, selected: null }))
      await preloadDexPage($, viewed, 0, dex)
      await $.ui.open({ id: DEX_PANE, title: 'Pokédex' })
      return { text: `Pokédex: ${generationName(viewed)}.` }
    }
    if (/^\d+$/.test(arg)) return { text: await dexStatus($, dex, Number(arg)) }
    if (arg === 'seen' || arg === 'caught') {
      const ids = (arg === 'seen' ? dex.seen : dex.caught).filter(inRange)
      const label = arg === 'seen' ? 'Seen' : 'Caught'
      if (ids.length === 0) return { text: `${label}: none yet` }
      const names = await speciesNames($)
      const list = [...ids].sort((a, b) => a - b).map(id => names.get(id) ?? `#${id}`)
      const more = list.length > DEX_LIST ? `, and ${list.length - DEX_LIST} more` : ''
      return { text: `${label} (${list.length}): ${list.slice(0, DEX_LIST).join(', ')}${more}` }
    }
    const viewed = generation === 'all' ? 1 : generation
    await update($, dexViewAtom, () => ({ generation: viewed, page: 0, selected: null }))
    await preloadDexPage($, viewed, 0, dex)
    await $.ui.open({ id: DEX_PANE, title: 'Pokédex' })
    return { text: await dexSummary($, dex, generation) }
  })

  on('command.run', { command: 'bag' }, async ($, e) => {
    const [verb = '', stoneArg = '', ...who] = e.args.trim().split(/\s+/)
    if (verb === 'use') {
      const stone = STONES.find(s => s === stoneArg || s === `${stoneArg}-stone`)
      if (!stone) return { text: `Which stone? ${STONES.join(', ')}` }
      const found = findTarget((await load($, 'party')).members, who.join(' '))
      return { text: 'error' in found ? found.error : await useStone($, stone, found.member) }
    }
    const bag = await load($, 'bag')
    const lines = STONES.filter(s => (bag.stones[s] ?? 0) > 0).map(s => `${title(s)} ×${bag.stones[s]}`)
    return { text: `${lines.length ? lines.join('\n') : 'Your bag is empty.'}\n\n/bag use <stone> <slot|name>` }
  })

  // --- Drawing ---

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    band = { rows: e.props.maxRows, hasSurvey: e.props.hasSurvey }
    if (e.props.hasSurvey || (await read($, hiddenAtom))) return next(e)

    const party = await read($, partyAtom)
    const progress = await read($, progressAtom)
    const pending = sortChoices(await read($, pendingAtom))
    const naming = await read($, namingAtom)
    const now = await $.clock.now()
    const active = activeOf(party)
    const top = pending[0]
    if (!active && !top) return next(e)

    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    const Input = 'Input' in elements ? elements.Input : null
    // A sprite file is read by the terminal itself; other surfaces (and a sprite not downloaded yet) get a text badge.
    const Image = e.surface === 'terminal' && 'Image' in elements ? elements.Image : null
    const dir = await dataDir($)

    const choice = top ? (
      <Box flexDirection="row" gap={1}>
        {top.kind === 'starter' && <Text bold>Professor Oak: choose your first Pokémon!</Text>}
        {top.kind === 'starter' &&
          STARTERS.map(s => <Button key={`starter-${s.id}`} label={title(s.name)} onPress={() => void chooseStarter($, s.name)} />)}
        {top.kind === 'encounter' && (
          <Text bold>{top.shiny ? '✨ ' : ''}A wild {title(top.name).toUpperCase()} appeared! Lv.{top.level}</Text>
        )}
        {top.kind === 'encounter' && <Button key="keep" label="Keep" onPress={() => void keepEncounter($)} />}
        {top.kind === 'encounter' && <Button key="letgo" label="Let go" onPress={() => void letGo($)} />}
        {top.kind === 'evolution' && (
          <Text bold>What? {displayName(party.members.find(m => m.id === top.memberId) ?? { nickname: null, name: '?' })} is evolving!</Text>
        )}
        {top.kind === 'evolution' && top.paths.length > 1 &&
          top.paths.map(p => <Button key={`evolve-${p.id}`} label={title(p.name)} onPress={() => void finishEvolution($, top.id, p)} />)}
        {top.kind === 'evolution' && <Button key="stop" label="Stop" onPress={() => void stopEvolution($, top.id)} />}
        {top.kind === 'stone' && (
          <Text bold>
            Found a {title(top.stone)}! Use on {displayName(party.members.find(m => m.id === top.memberId) ?? { nickname: null, name: '?' })}?
          </Text>
        )}
        {top.kind === 'stone' && <Button key="use-stone" label="Use" onPress={() => void answerStone($, true)} />}
        {top.kind === 'stone' && <Button key="bag-stone" label="Keep in bag" onPress={() => void answerStone($, false)} />}
        {pending.length > 1 && <Text dimColor>+{pending.length - 1} more</Text>}
      </Box>
    ) : null

    if (!active) return <Box flexDirection="column">{choice}</Box>

    const mine = progress[active.id] ?? newProgress(5, START_FRIENDSHIP, now)
    const mood = moodOf(mine, now)
    const named = naming && naming.until > now ? party.members.find(m => m.id === naming.memberId) : undefined
    const profile = active.profile ?? emptyProfile
    const header = (
      <Box flexDirection="row" gap={1}>
        <Text bold color={mood === 'excited' ? 'green' : mood === 'bored' ? 'gray' : undefined}>
          {active.shiny ? '✨' : ''}{displayName(active)}
        </Text>
        <Text dimColor>{`${title(active.name)} Lv.${mine.level}`}</Text>
        {profile.types.map(t => (
          <Text key={`band-type-${t}`} color={typeColor(t)}>{title(t)}</Text>
        ))}
      </Box>
    )

    if (e.props.maxRows < 5) {
      return (
        <Box flexDirection="column">
          {header}
          {choice}
        </Box>
      )
    }

    const hasSprite = Image !== null && (await spriteExists($, active.speciesId, active.shiny))
    return (
      <Box flexDirection="row" gap={1}>
        {Image && hasSprite ? (
          <Image
            key={`sprite-${active.speciesId}-${active.shiny ? 's' : 'n'}`}
            source={{ file: spritePath(dir, active.speciesId, active.shiny), format: 'png' }}
            columns={10}
            rows={5}
            alt={`[${title(active.name)}]`}
          />
        ) : (
          <Text>[{title(active.name)}]</Text>
        )}
        <Box flexDirection="column" alignSelf="center">
          {header}
          <Text dimColor>{`Mood ${bar(energyOf(mine, now))}  ${MOOD_LABEL[mood]}`}</Text>
          <Text dimColor>
            {`EXP  ${bar(mine.xp / xpToNext(mine.level))}  ${mine.xp}/${xpToNext(mine.level)}${e.props.isWorking && lastMeal ? `  nom ${lastMeal}` : ''}`}
          </Text>
          {named && Input && (
            <Input
              key="nickname"
              label={`Nickname for ${title(named.name)}?`}
              placeholder="Enter keeps the default"
              onSubmit={(value: string) => void rename($, named.id, value)}
            />
          )}
          {choice}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const party = await read($, partyAtom)
    const progress = await read($, progressAtom)
    const renaming = await read($, renamingAtom)
    const now = await $.clock.now()
    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    const Input = 'Input' in elements ? elements.Input : null
    const Image = e.surface === 'terminal' && 'Image' in elements ? elements.Image : null
    const dir = await dataDir($)
    const close = <Button key="close-party" label="Close" onPress={() => void $.ui.close({ id: PANE })} />
    if (party.members.length === 0) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text dimColor>No Pokémon yet. Choose a starter above the prompt.</Text>
          {close}
        </Box>
      )
    }

    const rows = []
    for (const [index, member] of party.members.entries()) {
      const mine = progress[member.id] ?? newProgress(5, START_FRIENDSHIP, now)
      const isActive = member.id === party.activeId
      const hasSprite = Image !== null && (await spriteExists($, member.speciesId, member.shiny))
      const profile = member.profile ?? emptyProfile
      rows.push(
        <Box
          key={`row-${member.id}`}
          flexDirection="column"
          borderStyle="round"
          borderColor={isActive ? 'permission' : undefined}
          borderDimColor={!isActive}
          paddingX={1}
          paddingY={0}
        >
          <Box flexDirection="row" gap={1}>
            {Image && hasSprite ? (
              <Image
                key={`pane-sprite-${member.id}-${member.speciesId}`}
                source={{ file: spritePath(dir, member.speciesId, member.shiny), format: 'png' }}
                columns={8}
                rows={4}
                alt={`[${title(member.name)}]`}
              />
            ) : (
              <Text dimColor>[{title(member.name)}]</Text>
            )}
            <Box flexDirection="column" flexGrow={1}>
              <Box flexDirection="row" gap={1}>
                <Text dimColor>{index + 1}.</Text>
                <Text bold={isActive}>
                  {member.shiny ? '✨' : ''}{displayName(member)}
                </Text>
                <Text dimColor>{title(member.name)} Lv.{mine.level}</Text>
                {isActive && <Text color="permission">▶ active</Text>}
              </Box>
              {profile.types.length > 0 && (
                <Box flexDirection="row" gap={1}>
                  {profile.types.map(t => (
                    <Text key={`type-${member.id}-${t}`} color={typeColor(t)}>{title(t)}</Text>
                  ))}
                </Box>
              )}
              {profile.stats.hp > 0 && (
                <Box flexDirection="column">
                  {STAT_ROWS.map((row, i) => (
                    <Box key={`stat-row-${member.id}-${i}`} flexDirection="row" gap={2}>
                      {row.map(s => (
                        <Text key={`stat-${member.id}-${s.key}`} dimColor>{`${s.label} ${statBar(profile.stats[s.key])} ${profile.stats[s.key]}`}</Text>
                      ))}
                    </Box>
                  ))}
                </Box>
              )}
              {profile.ability && <Text dimColor>Ability: {title(profile.ability)}</Text>}
              <Text dimColor>{moodOf(mine, now)} · friendship {mine.friendship} · {nextEvolutionText(member.chain)}</Text>
            </Box>
          </Box>
          {renaming === member.id && Input ? (
            <Input key={`rename-${member.id}`} label="New nickname" placeholder="Empty clears it" onSubmit={(value: string) => void rename($, member.id, value)} />
          ) : (
            <Box flexDirection="row" gap={1}>
              {!isActive && <Button key={`active-${member.id}`} label="Make active" onPress={() => void switchTo($, member)} />}
              <Button key={`rename-btn-${member.id}`} label="Rename" onPress={() => void update($, renamingAtom, () => member.id)} />
              {canStore(mine.level) && party.members.length > 1 && (
                <Button key={`store-${member.id}`} label="Store" onPress={() => void storeMember($, member).then(text => $.ui.toast(text))} />
              )}
              {party.members.length > 1 && (
                <Button key={`release-${member.id}`} label="Release" onPress={() => void release($, member).then(text => $.ui.toast(text))} />
              )}
            </Box>
          )}
        </Box>,
      )
    }
    return (
      <Box flexDirection="column" gap={1}>
        {rows}
        {close}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: BOXES_PANE }, async ($, e) => {
    const boxes = await read($, boxesAtom)
    const progress = await read($, progressAtom)
    const page = await read($, boxPageAtom)
    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    const Image = e.surface === 'terminal' && 'Image' in elements ? elements.Image : null
    const dir = await dataDir($)
    const close = <Button key="close-boxes" label="Close" onPress={() => void $.ui.close({ id: BOXES_PANE })} />
    const pages = Math.max(1, Math.ceil(boxes.length / BOX_PAGE_SIZE))
    const current = Math.min(page, pages - 1)
    const shown = boxes.slice(current * BOX_PAGE_SIZE, current * BOX_PAGE_SIZE + BOX_PAGE_SIZE)
    const rows = []
    for (const [index, member] of shown.entries()) {
      const hasSprite = Image !== null && (await spriteExists($, member.speciesId, member.shiny))
      const profile = member.profile ?? emptyProfile
      const mine = progress[member.id] ?? newProgress(MAX_LEVEL, START_FRIENDSHIP, 0)
      rows.push(
        <Box
          key={`box-row-${member.id}`}
          flexDirection="column"
          borderStyle="round"
          borderDimColor
          paddingX={1}
          paddingY={0}
        >
          <Box flexDirection="row" gap={1}>
            {Image && hasSprite ? (
              <Image
                key={`box-sprite-${member.id}-${member.speciesId}`}
                source={{ file: spritePath(dir, member.speciesId, member.shiny), format: 'png' }}
                columns={8}
                rows={4}
                alt={`[${title(member.name)}]`}
              />
            ) : (
              <Text dimColor>[{title(member.name)}]</Text>
            )}
            <Box flexDirection="column" flexGrow={1}>
              <Box flexDirection="row" gap={1}>
                <Text dimColor>{current * BOX_PAGE_SIZE + index + 1}.</Text>
                <Text bold>{member.shiny ? '✨' : ''}{displayName(member)}</Text>
                <Text dimColor>{title(member.name)} Lv.{mine.level}</Text>
              </Box>
              {profile.types.length > 0 && (
                <Box flexDirection="row" gap={1}>
                  {profile.types.map(t => (
                    <Text key={`box-type-${member.id}-${t}`} color={typeColor(t)}>{title(t)}</Text>
                  ))}
                </Box>
              )}
              {profile.ability && <Text dimColor>Ability: {title(profile.ability)}</Text>}
            </Box>
            <Button key={`take-${member.id}`} label="Take" onPress={() => void takeMember($, member).then(text => $.ui.toast(text))} />
          </Box>
        </Box>,
      )
    }
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Boxes · {boxes.length} stored</Text>
        {boxes.length === 0
          ? <Text dimColor>Your Boxes are empty. Store a Lv. 100 Pokémon from the party pane.</Text>
          : rows}
        <Box flexDirection="row" gap={1}>
          <Button key="box-prev" label="Prev" onPress={() => void update($, boxPageAtom, p => Math.max(0, p - 1))} />
          <Text dimColor>Page {current + 1}/{pages}</Text>
          <Button key="box-next" label="Next" onPress={() => void update($, boxPageAtom, p => Math.min(pages - 1, p + 1))} />
        </Box>
        {close}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: DEX_PANE }, async ($, e) => {
    const dex = await read($, dexAtom)
    const view = await read($, dexViewAtom)
    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    const Image = e.surface === 'terminal' && 'Image' in elements ? elements.Image : null
    const dir = await dataDir($)
    const generation = view.generation
    const [lo, hi] = generationRange(generation)
    const total = generationCount(generation)
    const pages = pageCount(generation, DEX_PAGE_SIZE)
    const current = Math.min(view.page, pages - 1)
    const ids = speciesPage(generation, current, DEX_PAGE_SIZE)
    const names = await speciesNames($)
    const seen = dex.seen.filter(id => id >= lo && id <= hi).length
    const caught = dex.caught.filter(id => id >= lo && id <= hi).length
    const stateOf = (id: number) => dex.caught.includes(id) ? 'caught' : dex.seen.includes(id) ? 'seen' : 'unknown'
    const close = <Button key="close-dex" label="Close" onPress={() => void $.ui.close({ id: DEX_PANE })} />
    const chooseGeneration = async (next: number) => {
      await preloadDexPage($, next, 0, dex)
      await update($, dexViewAtom, () => ({ generation: next, page: 0, selected: null }))
    }
    const changePage = async (next: number) => {
      await preloadDexPage($, generation, next, dex)
      await update($, dexViewAtom, v => ({ ...v, page: next, selected: null }))
    }
    const generationButtons = Array.from({ length: GENERATION_NUMERALS.length }, (_, index) => index + 1).map(g => (
      <Button key={`dex-gen-${g}`} label={GENERATION_NUMERALS[g - 1] ?? String(g)} onPress={() => void chooseGeneration(g)} />
    ))
    let detail = null
    if (view.selected !== null) {
      const id = view.selected
      const state = stateOf(id)
      if (state !== 'unknown') {
        const profile = (await profileOf($, id).catch(() => undefined)) ?? emptyProfile
        const info = state === 'caught' ? await speciesInfo($, id).catch(() => null) : null
        const chain = info ? await formOf($, info).catch(() => null) : null
        const name = names.get(id) ?? `#${id}`
        detail = (
          <Box key={`dex-detail-${id}`} flexDirection="column" borderStyle="round" paddingX={1}>
            <Text bold>
              #{String(id).padStart(3, '0')} {title(name)} {state === 'caught' ? '● caught' : '○ seen'}
              {dex.shinies.includes(id) ? ' ✨' : ''}
            </Text>
            {profile.types.length > 0 && <Text>{profile.types.map(title).join(' · ')}</Text>}
            {profile.ability && <Text dimColor>Ability: {title(profile.ability)}</Text>}
            {profile.stats.hp > 0 && <Text>{statLine(profile.stats)}</Text>}
            {state === 'caught' && chain && <Text dimColor>Evolves: {nextEvolutionText(chain)}</Text>}
          </Box>
        )
      }
    }
    const rows = []
    for (const id of ids) {
      const state = stateOf(id)
      const name = names.get(id) ?? `#${id}`
      const shiny = state === 'caught' && dex.shinies.includes(id)
      const hasSprite = state !== 'unknown' && Image !== null && (await spriteExists($, id, shiny))
      rows.push(
        <Box key={`dex-row-${id}`} flexDirection="row" gap={1}>
          {state === 'unknown' ? (
            <Text dimColor>▓▓</Text>
          ) : Image && hasSprite ? (
            <Image
              key={`dex-sprite-${id}-${shiny ? 's' : 'n'}`}
              source={{ file: spritePath(dir, id, shiny), format: 'png' }}
              columns={6}
              rows={3}
              alt={`[${title(name)}]`}
            />
          ) : (
            <Text dimColor>[{title(name)}]</Text>
          )}
          <Text dimColor>#{String(id).padStart(3, '0')}</Text>
          <Text bold={state === 'caught'}>{state === 'unknown' ? '???' : title(name)}</Text>
          {state === 'caught' && <Text color="brightRed">●</Text>}
          {state === 'seen' && <Text dimColor>○</Text>}
          {shiny && <Text color="brightYellow">✨</Text>}
          {state !== 'unknown' && (
            <Button key={`dex-view-${id}`} label="View" onPress={() => void update($, dexViewAtom, v => ({ ...v, selected: id }))} />
          )}
        </Box>,
      )
      if (view.selected === id && detail) rows.push(detail)
    }
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Pokédex · {generationName(generation)}</Text>
        <Text dimColor>Seen {seen}/{total} · Caught {caught}/{total}</Text>
        <Box flexDirection="row" gap={1}>{generationButtons}</Box>
        {rows}
        <Box flexDirection="row" gap={1}>
          <Button key="dex-prev" label="Prev" onPress={() => void changePage(Math.max(0, current - 1))} />
          <Text dimColor>Page {current + 1}/{pages}</Text>
          <Button key="dex-next" label="Next" onPress={() => void changePage(Math.min(pages - 1, current + 1))} />
        </Box>
        {close}
      </Box>
    )
  })
}
