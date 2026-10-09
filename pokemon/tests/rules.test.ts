import { expect, test } from 'claude-code/testing'

import type { ChainForm, Member, Progress } from '../types'
import { classify, conditionsFor, fallbackLevel, parseForm, parseOffset } from '../hooks/pokeapi'
import {
  HOUR, encounterLevel, findTarget, friendshipStep, gainCall, isShiny, levelUpPaths, moodOf, newProgress, rngFor,
  sortChoices, stoneFor, stonePaths, stoneTarget, timeMatches,
} from '../hooks/rules'
import { CHAINS } from './fixtures'

const form = (chainId: number, species: string): ChainForm => parseForm(CHAINS[chainId], species)
const member = (id: string, chain: ChainForm, nickname: string | null = null): Member => ({
  id, speciesId: chain.id, name: chain.name, chain, shiny: false, nickname, caughtAt: 0,
})
const NOON = 12
const NIGHT = 22

test('Charmander evolves at the game levels', async () => {
  const charmander = form(2, 'charmander')
  expect(charmander.edges[0]?.conditions).toEqual([{ kind: 'level', level: 16, time: null }])
  expect(charmander.edges[0]?.to.edges[0]?.conditions).toEqual([{ kind: 'level', level: 36, time: null }])
  expect(levelUpPaths(charmander, 15, 70, NOON)).toEqual([])
  expect(levelUpPaths(charmander, 16, 70, NOON)).toEqual([{ id: 5, name: 'charmeleon' }])
})

test('Eevee: stones from the default entries, friendship 160 by day or night, Sylveon as friendship', async () => {
  const eevee = form(67, 'eevee')
  const byName = Object.fromEntries(eevee.edges.map(e => [e.to.name, e.conditions]))
  expect(byName.vaporeon).toEqual([{ kind: 'stone', stone: 'water-stone' }])
  expect(byName.leafeon).toEqual([{ kind: 'stone', stone: 'leaf-stone' }])
  expect(byName.glaceon).toEqual([{ kind: 'stone', stone: 'ice-stone' }])
  expect(byName.espeon).toEqual([{ kind: 'friendship', min: 160, time: 'day' }])
  expect(byName.umbreon).toEqual([{ kind: 'friendship', min: 160, time: 'night' }])
  expect(byName.sylveon).toEqual([{ kind: 'friendship', min: 160, time: null }])
  expect(levelUpPaths(eevee, 20, 160, NOON).map(p => p.name)).toEqual(['espeon', 'sylveon'])
  expect(levelUpPaths(eevee, 20, 160, NIGHT).map(p => p.name)).toEqual(['umbreon', 'sylveon'])
  expect(levelUpPaths(eevee, 20, 159, NOON)).toEqual([])
  expect(stonePaths(eevee, 'fire-stone').map(p => p.name)).toEqual(['flareon'])
})

test("Wurmple's coin flip is ignored: both level-7 branches are offered", async () => {
  const wurmple = form(135, 'wurmple')
  expect(wurmple.edges.map(e => e.conditions)).toEqual([
    [{ kind: 'level', level: 7, time: null }],
    [{ kind: 'level', level: 7, time: null }],
  ])
  expect(levelUpPaths(wurmple, 7, 70, NOON).map(p => p.name)).toEqual(['silcoon', 'cascoon'])
})

test("Raichu's duplicate entries collapse; Pichu evolves by friendship 220", async () => {
  const pichu = form(10, 'pichu')
  expect(pichu.edges[0]?.conditions).toEqual([{ kind: 'friendship', min: 220, time: null }])
  expect(pichu.edges[0]?.to.edges[0]?.conditions).toEqual([{ kind: 'stone', stone: 'thunder-stone' }])
})

test('Lycanroc keeps day, night and dusk; Vulpix takes a fire or an ice stone', async () => {
  const rockruff = form(383, 'rockruff')
  expect(rockruff.edges[0]?.conditions.map(c => (c.kind === 'level' ? c.time : null))).toEqual(['day', 'night', 'dusk'])
  expect(levelUpPaths(rockruff, 25, 70, 18)).toEqual([{ id: 745, name: 'lycanroc' }]) // dusk and night both hold; one path
  const vulpix = form(15, 'vulpix')
  expect(vulpix.edges[0]?.conditions).toEqual([{ kind: 'stone', stone: 'fire-stone' }, { kind: 'stone', stone: 'ice-stone' }])
})

test('anything else is a fallback level', async () => {
  expect(classify({ trigger: { name: 'trade' } }, 5)).toEqual({ kind: 'fallback', level: 38 })
  expect(classify({ trigger: { name: 'level-up' }, min_level: 20, known_move: { name: 'x' } }, 30)).toEqual({ kind: 'fallback', level: 40 })
  expect(classify({ trigger: { name: 'use-item' }, item: { name: 'linking-cord' } }, 5)).toEqual({ kind: 'fallback', level: 38 })
  expect(fallbackLevel(5)).toBe(38)
  expect(conditionsFor([], 5)).toEqual([{ kind: 'fallback', level: 38 }])
})

test('a mid-chain species starts its line there, with the level it is reached at', async () => {
  const charmeleon = form(2, 'charmeleon')
  expect(charmeleon.reachLevel).toBe(16)
  expect(form(2, 'charizard').reachLevel).toBe(36)
  const level = encounterLevel(charmeleon.reachLevel, rngFor('s', 1, 'level'))
  expect(level >= 16 && level <= 19).toBe(true)
  expect(encounterLevel(1, () => 0)).toBe(5)
})

test('day, night and dusk windows', async () => {
  expect(timeMatches('day', 6)).toBe(true)
  expect(timeMatches('day', 18)).toBe(false)
  expect(timeMatches('night', 5)).toBe(true)
  expect(timeMatches('dusk', 17)).toBe(true)
  expect(timeMatches('dusk', 20)).toBe(false)
  expect(parseOffset('-0300')).toBe(-180)
  expect(parseOffset('+0530')).toBe(330)
  expect(parseOffset('garbage')).toBe(null)
})

const progress = (overrides: Partial<Progress>): Progress => ({ ...newProgress(5, 70, 0), ...overrides })

test('EXP: mood multiplies it and fractions carry over', async () => {
  const now = 10 * HOUR
  const excited = progress({ lastXpAt: now, recentCalls: Array.from({ length: 20 }, (_, i) => now - i * 1000) })
  expect(moodOf(excited, now)).toBe('excited')
  const one = gainCall(excited, now).progress
  expect([one.xp, one.xpFrac]).toEqual([1, 0.5])
  expect(gainCall(one, now).progress.xp).toBe(3)

  const bored = progress({ lastXpAt: now - 3 * HOUR })
  expect(moodOf(bored, now)).toBe('bored')
  const slow = gainCall(bored, now).progress
  expect([slow.xp, slow.xpFrac]).toEqual([0, 0.75])
  expect(moodOf(slow, now)).toBe('normal') // it just gained EXP

  const leveled = gainCall(progress({ xp: 8, lastXpAt: now }), now)
  expect([leveled.progress.level, leveled.progress.xp, leveled.levelsGained]).toEqual([6, 0, 1])
})

test('friendship: +1 normal, +2 excited, −1 every third bucket while bored', async () => {
  const now = 10 * HOUR
  expect(friendshipStep(progress({ lastXpAt: now }), now, 1).friendship).toBe(71)
  const excited = progress({ lastXpAt: now, recentCalls: Array.from({ length: 20 }, () => now) })
  expect(friendshipStep(excited, now, 1).friendship).toBe(72)
  const bored = progress({ lastXpAt: 0 })
  expect(friendshipStep(bored, now, 3).friendship).toBe(69)
  expect(friendshipStep(bored, now, 4).friendship).toBe(70)
  expect(friendshipStep(progress({ friendship: 255, lastXpAt: now }), now, 1).friendship).toBe(255)
})

test('seeded rolls repeat for the same hour and salt', async () => {
  const a = rngFor('salt', 42, 'species')
  const b = rngFor('salt', 42, 'species')
  expect([a(), a(), a()]).toEqual([b(), b(), b()])
  expect(rngFor('salt', 43, 'species')()).not.toBe(rngFor('salt', 42, 'species')())
})

test('shinies come up about 1 in 256', async () => {
  let shinies = 0
  const trials = 51_200
  for (let hour = 0; hour < trials; hour++) if (isShiny(rngFor('salt', hour, 'shiny'))) shinies++
  expect(shinies > 140 && shinies < 260).toBe(true) // expected 200
})

test('stones: never within 4 hours of the last, about half the hours after', async () => {
  expect(stoneFor('salt', 103, 100)).toBe(null)
  let drops = 0
  for (let hour = 1000; hour < 3000; hour++) if (stoneFor('salt', hour, 0)) drops++
  expect(drops > 850 && drops < 1150).toBe(true)
})

test('a found stone goes to the active member first, else whoever can use it', async () => {
  const vulpix = member('a', form(15, 'vulpix'))
  const eevee = member('b', form(67, 'eevee'))
  expect(stoneTarget([vulpix, eevee], 'b', 'fire-stone')?.id).toBe('b')
  expect(stoneTarget([vulpix, eevee], 'a', 'ice-stone')?.id).toBe('a')
  expect(stoneTarget([vulpix], 'a', 'moon-stone')).toBe(null)
})

test('targets: slot numbers, names, and refusing an ambiguous name', async () => {
  const pidgeys = [member('a', form(2, 'charmander'), 'ZIPPY'), member('b', form(2, 'charmander')), member('c', form(2, 'charmander'))]
  expect(findTarget(pidgeys, '2')).toEqual({ member: pidgeys[1] })
  expect(findTarget(pidgeys, 'zippy')).toEqual({ member: pidgeys[0] })
  expect(findTarget(pidgeys, 'charmander')).toEqual({ error: 'More than one matches "charmander": slots 1, 2, 3. Use the slot number.' })
  expect('error' in findTarget(pidgeys, '9')).toBe(true)
})

test('pending choices: evolution before starter before encounter before stone', async () => {
  const sorted = sortChoices([
    { kind: 'stone', id: 's', createdAt: 1, stone: 'fire-stone', memberId: 'a' },
    { kind: 'starter', id: 'starter', createdAt: 3 },
    { kind: 'evolution', id: 'e', createdAt: 4, memberId: 'a', paths: [], deadline: 0, stone: null },
  ])
  expect(sorted.map(c => c.kind)).toEqual(['evolution', 'starter', 'stone'])
})
