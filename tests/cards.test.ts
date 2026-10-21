import { expect, test } from 'claude-code/testing'

import { parseProfile } from '../hooks/pokeapi'
import { statBar, statLine, typeColor } from '../hooks/cards'
import { POKEMON } from './fixtures'

test('a species profile carries its types, its base stats and its ability', async () => {
  const profile = parseProfile(POKEMON[4])
  expect(profile.types).toEqual(['fire'])
  expect(profile.stats).toEqual({ hp: 39, atk: 52, def: 43, spa: 60, spd: 50, spe: 65 })
  expect(profile.ability).toBe('blaze')
})

test('a hidden ability is not the one shown', async () => {
  expect(parseProfile(POKEMON[4]).ability).toBe('blaze')
  expect(parseProfile(POKEMON[133]).ability).toBe('run-away')
})

test('a profile without stats or abilities reads as empty', async () => {
  const profile = parseProfile({ types: [{ type: { name: 'normal' } }] } as any)
  expect(profile.stats).toEqual({ hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 })
  expect(profile.ability).toBeNull()
})

test('the stat line reads HP, ATK, DEF, SPA, SPD and SPE', async () => {
  expect(statLine(parseProfile(POKEMON[4]).stats)).toBe('HP 39  ATK 52  DEF 43  SPA 60  SPD 50  SPE 65')
})

test('a stat bar fills in proportion to the value', async () => {
  expect(statBar(0, 4)).toBe('▱▱▱▱')
  expect(statBar(100, 4)).toBe('▰▰▰▰')
  expect(statBar(50, 4)).toBe('▰▰▱▱')
  expect(statBar(39, 5)).toBe('▰▰▱▱▱')
  expect(statBar(52, 5)).toBe('▰▰▰▱▱')
  expect(statBar(500, 4)).toBe('▰▰▰▰')
})

test('every type has a colour of its own, and an unknown one falls back', async () => {
  expect(typeColor('fire')).toBe('brightRed')
  expect(typeColor('water')).toBe('brightBlue')
  expect(typeColor('grass')).toBe('brightGreen')
  expect(typeColor('electric')).toBe('brightYellow')
  expect(typeColor('psychic')).toBe('magenta')
  expect(typeColor('dragon')).toBe('blue')
  expect(typeColor('nonsense')).toBe('brightBlack')
})
