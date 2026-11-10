import { expect, test } from 'claude-code/testing'

import { FINE_GLYPHS, cellsOf, cropToContent, decodePng, fitTo, fromBase64, sharpen, spriteCells, toBase64 } from '../hooks/pixels'
import type { Bitmap } from '../hooks/pixels'
import { dynamicPng, fixedPng, palettePng, storedPng } from './png'

const bitmapOf = (rows: (number | null)[][]): Bitmap => {
  const rgba = new Uint8Array(rows[0]!.length * rows.length * 4)
  rows.forEach((row, y) =>
    row.forEach((color, x) => {
      if (color !== null) rgba.set([(color >> 16) & 255, (color >> 8) & 255, color & 255, 255], (y * row.length + x) * 4)
    }),
  )
  return { width: rows[0]!.length, height: rows.length, rgba }
}

const cellAt = (cells: string, index: number) => {
  const view = new DataView(fromBase64(cells).buffer)
  return { glyph: view.getUint32(index * 12, true), foreground: view.getUint32(index * 12 + 4, true), background: view.getUint32(index * 12 + 8, true) }
}

test('base64 survives a round trip, with or without the padding and line breaks', async () => {
  for (const length of [0, 1, 2, 3, 4, 5, 255]) {
    const bytes = Uint8Array.from({ length }, (_, i) => (i * 37) % 256)
    expect(Array.from(fromBase64(toBase64(bytes)))).toEqual(Array.from(bytes))
  }
  expect(toBase64(Uint8Array.from([77, 97, 110]))).toBe('TWFu')
  expect(Array.from(fromBase64('TWF\nu\n'))).toEqual([77, 97, 110])
})

test('a PNG decodes from stored, fixed and dynamic deflate blocks, with all five filters', async () => {
  for (const fixture of [dynamicPng, fixedPng, storedPng]) {
    const bitmap = decodePng(fromBase64(fixture.png))
    expect([bitmap.width, bitmap.height]).toEqual([fixture.width, fixture.height])
    expect(Array.from(bitmap.rgba)).toEqual(Array.from(fromBase64(fixture.rgba)))
  }
})

test('a 4-bit palette PNG keeps its colors and its transparent entries', async () => {
  const bitmap = decodePng(fromBase64(palettePng.png))
  expect(Array.from(bitmap.rgba)).toEqual(Array.from(fromBase64(palettePng.rgba)))
  expect(bitmap.rgba.some((value, i) => i % 4 === 3 && value === 0)).toBe(true)
})

test('anything that is not a plain PNG is refused', async () => {
  expect(() => decodePng(Uint8Array.from([1, 2, 3]))).toThrow('not a PNG')
  const broken = fromBase64(dynamicPng.png)
  expect(() => decodePng(broken.subarray(0, 60))).toThrow()
  const interlaced = fromBase64(storedPng.png)
  interlaced[28] = 1
  expect(() => decodePng(interlaced)).toThrow('interlaced')
})

test('cropping keeps only the opaque box, and a blank bitmap becomes one clear pixel', async () => {
  const bitmap = bitmapOf([
    [null, null, null, null],
    [null, 0xff0000, 0x00ff00, null],
    [null, null, 0x0000ff, null],
    [null, null, null, null],
  ])
  const cropped = cropToContent(bitmap)
  expect([cropped.width, cropped.height]).toEqual([2, 2])
  expect(Array.from(cropped.rgba.subarray(0, 4))).toEqual([255, 0, 0, 255])
  expect(cropToContent(bitmapOf([[null, null], [null, null]]))).toEqual({ width: 1, height: 1, rgba: new Uint8Array(4) })
})

test('fitting keeps the aspect, centers the picture and averages the colors it merges', async () => {
  const wide = bitmapOf([[0xff0000, 0xff0000, 0x0000ff, 0x0000ff]])
  const fitted = fitTo(wide, 4, 4)
  expect([fitted.width, fitted.height]).toEqual([4, 4])
  const opaqueRows = [0, 1, 2, 3].filter(y => fitted.rgba[(y * 4) * 4 + 3] === 255)
  expect(opaqueRows).toEqual([1])
  const merged = fitTo(wide, 2, 2)
  expect(Array.from(merged.rgba.subarray(0, 4))).toEqual([255, 0, 0, 255])
  expect(Array.from(merged.rgba.subarray(4, 8))).toEqual([0, 0, 255, 255])
  const blended = fitTo(bitmapOf([[0xff0000, 0x0000ff]]), 1, 1)
  expect(Array.from(blended.rgba)).toEqual([128, 0, 128, 255])
})

const unitCell = (paint: (column: number, row: number) => number | null): Bitmap =>
  bitmapOf(Array.from({ length: 8 }, (_, row) => Array.from({ length: 4 }, (_, column) => paint(column, row))))

const RED = 0xff0000
const GREEN = 0x00ff00
const BLUE = 0x0000ff
const CLEAR = 0x1000000

test('a cell takes the glyph that fits its units best, with the colors of each side', async () => {
  expect(cellAt(cellsOf(unitCell((_, row) => (row < 4 ? RED : GREEN))), 0)).toEqual({ glyph: 0x2580, foreground: RED, background: GREEN })
  expect(cellAt(cellsOf(unitCell(column => (column < 2 ? RED : GREEN))), 0)).toEqual({ glyph: 0x258c, foreground: RED, background: GREEN })
  expect(cellAt(cellsOf(unitCell((column, row) => ((column < 2) === (row < 4) ? RED : GREEN))), 0)).toEqual({ glyph: 0x259a, foreground: RED, background: GREEN })
  expect(cellAt(cellsOf(unitCell((column, row) => (column < 2 && row < 4 ? null : BLUE))), 0).glyph).toBe(0x259f)
})

test('a transparent side stays the terminal background, never a painted glyph', async () => {
  expect(cellAt(cellsOf(unitCell((_, row) => (row < 4 ? RED : null))), 0)).toEqual({ glyph: 0x2580, foreground: RED, background: CLEAR })
  expect(cellAt(cellsOf(unitCell((_, row) => (row >= 4 ? RED : null))), 0)).toEqual({ glyph: 0x2584, foreground: RED, background: CLEAR })
  expect(cellAt(cellsOf(unitCell((_, row) => (row >= 6 ? RED : null))), 0)).toEqual({ glyph: 0x2582, foreground: RED, background: CLEAR })
  expect(cellAt(cellsOf(unitCell(() => null)), 0)).toEqual({ glyph: 0x20, foreground: CLEAR, background: CLEAR })
})

test('a flat cell is a background fill, which leaves no seam between rows', async () => {
  expect(cellAt(cellsOf(unitCell(() => RED)), 0)).toEqual({ glyph: 0x20, foreground: CLEAR, background: RED })
})

test('the half detail only ever uses halves, a block or a space', async () => {
  const halves = new Set([0x20, 0x2580, 0x2584, 0x2588])
  const diagonal = unitCell((column, row) => ((column < 2) === (row < 4) ? RED : GREEN))
  expect(halves.has(cellAt(cellsOf(diagonal, 'half'), 0).glyph)).toBe(true)
  expect(cellAt(cellsOf(diagonal, 'fine'), 0).glyph).toBe(0x259a)
})

test('every cell holds one printable width-1 glyph, whatever the sprite', async () => {
  const bytes = fromBase64(spriteCells(fromBase64(dynamicPng.png), 6, 3))
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < 18; i++) {
    const glyph = view.getUint32(i * 12, true)
    expect(glyph === 0x20 || (glyph >= 0x2580 && glyph <= 0x259f)).toBe(true)
  }
})

test('a sprite becomes exactly columns × rows cells', async () => {
  const cells = spriteCells(fromBase64(dynamicPng.png), 10, 5)
  expect(fromBase64(cells).length).toBe(10 * 5 * 12)
})

test('no two glyphs cover the same units, so none is a wasted candidate', async () => {
  const shapes = FINE_GLYPHS.map(g => g.covers.map(c => (c ? 1 : 0)).join(''))
  expect(new Set(shapes).size).toBe(FINE_GLYPHS.length)
  expect(new Set(FINE_GLYPHS.map(g => g.code)).size).toBe(FINE_GLYPHS.length)
})

test('a dark bias keeps the dark pixel a merge would wash out', async () => {
  const pair = bitmapOf([[0x000000, 0xffffff]])
  const plain = fitTo(pair, 1, 1)
  const biased = fitTo(pair, 1, 1, 3)
  expect(plain.rgba[0]).toBe(128)
  expect(biased.rgba[0]!).toBeLessThan(plain.rgba[0]!)
  expect(biased.rgba[3]).toBe(255)
})

test('sharpening pushes an edge apart, leaves a flat area alone and never reads a clear neighbour', async () => {
  const flat = bitmapOf([[0x808080, 0x808080, 0x808080]])
  expect(Array.from(sharpen(flat, 0.8, 1).rgba)).toEqual(Array.from(flat.rgba))
  const edge = sharpen(bitmapOf([[0x404040, 0x808080, 0xc0c0c0]]), 1, 1)
  expect(edge.rgba[0]!).toBeLessThan(0x40)
  expect(edge.rgba[8]!).toBeGreaterThan(0xc0)
  expect(edge.rgba[4]).toBe(0x80)
  const lone = bitmapOf([[0x808080, null]])
  expect(Array.from(sharpen(lone, 1, 1).rgba)).toEqual(Array.from(lone.rgba))
  expect(sharpen(bitmapOf([[0x808080, null]]), 1, 1).rgba[7]).toBe(0)
})

test('saturation moves the colors away from grey, and grey stays grey', async () => {
  const vivid = sharpen(bitmapOf([[0xc08040, 0xc08040]]), 0, 1.5)
  expect(vivid.rgba[0]!).toBeGreaterThan(0xc0)
  expect(vivid.rgba[2]!).toBeLessThan(0x40)
  expect(Array.from(sharpen(bitmapOf([[0x777777]]), 0, 1.5).rgba.subarray(0, 3))).toEqual([0x77, 0x77, 0x77])
})
