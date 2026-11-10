export type Bitmap = { width: number; height: number; rgba: Uint8Array }

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const DEFAULT_COLOR = 0x1000000
const OPAQUE = 128

export const fromBase64 = (text: string): Uint8Array => {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let bits = 0
  let held = 0
  let at = 0
  for (const char of clean) {
    held = (held << 6) | ALPHABET.indexOf(char)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[at++] = (held >> bits) & 0xff
    }
  }
  return out
}

export const toBase64 = (bytes: Uint8Array): string => {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    const triple = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    out += ALPHABET[(triple >> 18) & 63]! + ALPHABET[(triple >> 12) & 63]!
    out += b === undefined ? '=' : ALPHABET[(triple >> 6) & 63]!
    out += c === undefined ? '=' : ALPHABET[triple & 63]!
  }
  return out
}

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
const DISTANCE_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
const DISTANCE_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]
const LENGTH_CODE_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

type Huffman = { count: number[]; symbol: number[] }

const huffman = (lengths: number[]): Huffman => {
  const count = new Array<number>(16).fill(0)
  for (const length of lengths) count[length]!++
  const offsets = new Array<number>(16).fill(0)
  for (let length = 1; length < 15; length++) offsets[length + 1] = offsets[length]! + count[length]!
  const symbol = new Array<number>(lengths.length).fill(0)
  lengths.forEach((length, index) => {
    if (length > 0) symbol[offsets[length]!++] = index
  })
  return { count, symbol }
}

const FIXED_LITERALS = huffman([
  ...new Array<number>(144).fill(8), ...new Array<number>(112).fill(9),
  ...new Array<number>(24).fill(7), ...new Array<number>(8).fill(8),
])
const FIXED_DISTANCES = huffman(new Array<number>(30).fill(5))

export const inflate = (data: Uint8Array, size: number): Uint8Array => {
  const out = new Uint8Array(size)
  let written = 0
  let position = 0
  let bitBuffer = 0
  let bitCount = 0

  const bits = (need: number): number => {
    while (bitCount < need) {
      if (position >= data.length) throw new Error('the deflate stream ends early')
      bitBuffer |= data[position++]! << bitCount
      bitCount += 8
    }
    const value = bitBuffer & ((1 << need) - 1)
    bitBuffer >>>= need
    bitCount -= need
    return value
  }

  const decode = (table: Huffman): number => {
    let code = 0
    let first = 0
    let index = 0
    for (let length = 1; length <= 15; length++) {
      code |= bits(1)
      const count = table.count[length]!
      if (code - count < first) return table.symbol[index + (code - first)]!
      index += count
      first += count
      first <<= 1
      code <<= 1
    }
    throw new Error('a deflate code is not in its table')
  }

  const codes = (literals: Huffman, distances: Huffman) => {
    for (;;) {
      const symbol = decode(literals)
      if (symbol < 256) {
        if (written >= size) throw new Error('the deflate stream is longer than its header says')
        out[written++] = symbol
      } else if (symbol === 256) {
        return
      } else {
        const lengthIndex = symbol - 257
        if (lengthIndex >= LENGTH_BASE.length) throw new Error('a deflate length code is invalid')
        const length = LENGTH_BASE[lengthIndex]! + bits(LENGTH_EXTRA[lengthIndex]!)
        const distanceIndex = decode(distances)
        if (distanceIndex >= DISTANCE_BASE.length) throw new Error('a deflate distance code is invalid')
        const distance = DISTANCE_BASE[distanceIndex]! + bits(DISTANCE_EXTRA[distanceIndex]!)
        if (distance > written || written + length > size) throw new Error('a deflate copy leaves the output')
        for (let i = 0; i < length; i++, written++) out[written] = out[written - distance]!
      }
    }
  }

  const dynamic = () => {
    const literalCount = bits(5) + 257
    const distanceCount = bits(5) + 1
    const lengthCount = bits(4) + 4
    const lengths = new Array<number>(19).fill(0)
    for (let i = 0; i < lengthCount; i++) lengths[LENGTH_CODE_ORDER[i]!] = bits(3)
    const lengthTable = huffman(lengths)
    const all: number[] = []
    while (all.length < literalCount + distanceCount) {
      const symbol = decode(lengthTable)
      if (symbol < 16) {
        all.push(symbol)
      } else {
        const previous = symbol === 16 ? all[all.length - 1] : 0
        if (previous === undefined) throw new Error('a deflate repeat has nothing to repeat')
        const repeat = symbol === 16 ? 3 + bits(2) : symbol === 17 ? 3 + bits(3) : 11 + bits(7)
        for (let i = 0; i < repeat; i++) all.push(previous)
      }
    }
    codes(huffman(all.slice(0, literalCount)), huffman(all.slice(literalCount)))
  }

  const stored = () => {
    bitBuffer = 0
    bitCount = 0
    const length = data[position]! | (data[position + 1]! << 8)
    position += 4
    if (position + length > data.length || written + length > size) throw new Error('a stored deflate block leaves its bounds')
    out.set(data.subarray(position, position + length), written)
    written += length
    position += length
  }

  let last = false
  while (!last) {
    last = bits(1) === 1
    const type = bits(2)
    if (type === 0) stored()
    else if (type === 1) codes(FIXED_LITERALS, FIXED_DISTANCES)
    else if (type === 2) dynamic()
    else throw new Error('a deflate block has an invalid type')
  }
  return out
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

const u32 = (bytes: Uint8Array, at: number) =>
  ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0

const paeth = (left: number, up: number, upLeft: number) => {
  const estimate = left + up - upLeft
  const toLeft = Math.abs(estimate - left)
  const toUp = Math.abs(estimate - up)
  const toUpLeft = Math.abs(estimate - upLeft)
  if (toLeft <= toUp && toLeft <= toUpLeft) return left
  return toUp <= toUpLeft ? up : upLeft
}

const unfilter = (raw: Uint8Array, height: number, stride: number, step: number): Uint8Array => {
  const out = new Uint8Array(height * stride)
  for (let row = 0; row < height; row++) {
    const filter = raw[row * (stride + 1)]!
    const from = row * (stride + 1) + 1
    const to = row * stride
    for (let i = 0; i < stride; i++) {
      const left = i >= step ? out[to + i - step]! : 0
      const up = row > 0 ? out[to - stride + i]! : 0
      const upLeft = row > 0 && i >= step ? out[to - stride + i - step]! : 0
      const value = raw[from + i]!
      let predicted = 0
      if (filter === 1) predicted = left
      else if (filter === 2) predicted = up
      else if (filter === 3) predicted = (left + up) >> 1
      else if (filter === 4) predicted = paeth(left, up, upLeft)
      else if (filter !== 0) throw new Error(`a PNG scanline has the unknown filter ${filter}`)
      out[to + i] = (value + predicted) & 0xff
    }
  }
  return out
}

const sampleAt = (row: Uint8Array, index: number, depth: number): number => {
  if (depth === 8) return row[index]!
  if (depth === 16) return row[index * 2]!
  const perByte = 8 / depth
  const shift = 8 - depth * ((index % perByte) + 1)
  return (row[Math.floor(index / perByte)]! >> shift) & ((1 << depth) - 1)
}

export const decodePng = (bytes: Uint8Array): Bitmap => {
  if (SIGNATURE.some((value, i) => bytes[i] !== value)) throw new Error('not a PNG')
  let width = 0
  let height = 0
  let depth = 0
  let colorType = 0
  let palette = new Uint8Array(0)
  let transparency = new Uint8Array(0)
  const parts: Uint8Array[] = []
  let at = 8
  while (at + 8 <= bytes.length) {
    const length = u32(bytes, at)
    const type = String.fromCharCode(bytes[at + 4]!, bytes[at + 5]!, bytes[at + 6]!, bytes[at + 7]!)
    const body = bytes.subarray(at + 8, at + 8 + length)
    if (type === 'IHDR') {
      width = u32(body, 0)
      height = u32(body, 4)
      depth = body[8]!
      colorType = body[9]!
      if (body[12] !== 0) throw new Error('an interlaced PNG')
    } else if (type === 'PLTE') palette = body
    else if (type === 'tRNS') transparency = body
    else if (type === 'IDAT') parts.push(body)
    else if (type === 'IEND') break
    at += 12 + length
  }
  const channels = CHANNELS[colorType]
  if (!channels || width === 0 || height === 0) throw new Error('a PNG with no usable header')
  const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    joined.set(part, offset)
    offset += part.length
  }
  const bitsPerPixel = channels * depth
  const stride = Math.ceil((width * bitsPerPixel) / 8)
  const raw = inflate(joined.subarray(2), (stride + 1) * height)
  const lines = unfilter(raw, height, stride, Math.max(1, bitsPerPixel >> 3))
  const rgba = new Uint8Array(width * height * 4)
  const scale = depth < 8 ? 255 / ((1 << depth) - 1) : 1
  for (let y = 0; y < height; y++) {
    const row = lines.subarray(y * stride, (y + 1) * stride)
    for (let x = 0; x < width; x++) {
      const out = (y * width + x) * 4
      const first = sampleAt(row, x * channels, depth)
      if (colorType === 3) {
        rgba[out] = palette[first * 3] ?? 0
        rgba[out + 1] = palette[first * 3 + 1] ?? 0
        rgba[out + 2] = palette[first * 3 + 2] ?? 0
        rgba[out + 3] = transparency[first] ?? 255
      } else if (colorType === 0 || colorType === 4) {
        const grey = Math.round(first * scale)
        rgba[out] = rgba[out + 1] = rgba[out + 2] = grey
        rgba[out + 3] = colorType === 4 ? sampleAt(row, x * channels + 1, depth) : 255
      } else {
        rgba[out] = first
        rgba[out + 1] = sampleAt(row, x * channels + 1, depth)
        rgba[out + 2] = sampleAt(row, x * channels + 2, depth)
        rgba[out + 3] = colorType === 6 ? sampleAt(row, x * channels + 3, depth) : 255
      }
    }
  }
  return { width, height, rgba }
}

export const cropToContent = (bitmap: Bitmap): Bitmap => {
  let left = bitmap.width
  let top = bitmap.height
  let right = -1
  let bottom = -1
  for (let y = 0; y < bitmap.height; y++) {
    for (let x = 0; x < bitmap.width; x++) {
      if (bitmap.rgba[(y * bitmap.width + x) * 4 + 3]! >= OPAQUE) {
        left = Math.min(left, x)
        right = Math.max(right, x)
        top = Math.min(top, y)
        bottom = Math.max(bottom, y)
      }
    }
  }
  if (right < 0) return { width: 1, height: 1, rgba: new Uint8Array(4) }
  const width = right - left + 1
  const height = bottom - top + 1
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    rgba.set(bitmap.rgba.subarray(((top + y) * bitmap.width + left) * 4, ((top + y) * bitmap.width + left + width) * 4), y * width * 4)
  }
  return { width, height, rgba }
}

export const fitTo = (bitmap: Bitmap, width: number, height: number, darkBias = 0): Bitmap => {
  const scale = Math.min(width / bitmap.width, height / bitmap.height)
  const fitted = {
    width: Math.max(1, Math.round(bitmap.width * scale)),
    height: Math.max(1, Math.round(bitmap.height * scale)),
  }
  const rgba = new Uint8Array(width * height * 4)
  const shiftX = Math.floor((width - fitted.width) / 2)
  const shiftY = Math.floor((height - fitted.height) / 2)
  for (let y = 0; y < fitted.height; y++) {
    const fromY = (y * bitmap.height) / fitted.height
    const toY = Math.max(fromY + 1e-6, ((y + 1) * bitmap.height) / fitted.height)
    for (let x = 0; x < fitted.width; x++) {
      const fromX = (x * bitmap.width) / fitted.width
      const toX = Math.max(fromX + 1e-6, ((x + 1) * bitmap.width) / fitted.width)
      let weight = 0
      let colorWeight = 0
      let alpha = 0
      let red = 0
      let green = 0
      let blue = 0
      for (let sy = Math.floor(fromY); sy < Math.ceil(toY); sy++) {
        const heightShare = Math.min(sy + 1, toY) - Math.max(sy, fromY)
        for (let sx = Math.floor(fromX); sx < Math.ceil(toX); sx++) {
          const share = heightShare * (Math.min(sx + 1, toX) - Math.max(sx, fromX))
          const index = (sy * bitmap.width + sx) * 4
          const opacity = bitmap.rgba[index + 3]! * share
          const luma = (0.299 * bitmap.rgba[index]! + 0.587 * bitmap.rgba[index + 1]! + 0.114 * bitmap.rgba[index + 2]!) / 255
          const biased = opacity * (1 + darkBias * (1 - luma) ** 2)
          weight += share
          alpha += opacity
          colorWeight += biased
          red += bitmap.rgba[index]! * biased
          green += bitmap.rgba[index + 1]! * biased
          blue += bitmap.rgba[index + 2]! * biased
        }
      }
      const out = ((y + shiftY) * width + x + shiftX) * 4
      if (alpha > 0) {
        rgba[out] = Math.round(red / colorWeight)
        rgba[out + 1] = Math.round(green / colorWeight)
        rgba[out + 2] = Math.round(blue / colorWeight)
        rgba[out + 3] = Math.round(alpha / weight)
      }
    }
  }
  return { width, height, rgba }
}

export const sharpen = (bitmap: Bitmap, amount: number, saturation: number): Bitmap => {
  const rgba = new Uint8Array(bitmap.rgba)
  const opaque = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < bitmap.width && y < bitmap.height && bitmap.rgba[(y * bitmap.width + x) * 4 + 3]! >= OPAQUE
  for (let y = 0; y < bitmap.height; y++) {
    for (let x = 0; x < bitmap.width; x++) {
      if (!opaque(x, y)) continue
      const at = (y * bitmap.width + x) * 4
      const around = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]].filter(([nx, ny]) => opaque(nx!, ny!))
      const sharp = [0, 1, 2].map(channel => {
        const value = bitmap.rgba[at + channel]!
        if (around.length === 0) return value
        const mean = around.reduce((sum, [nx, ny]) => sum + bitmap.rgba[(ny! * bitmap.width + nx!) * 4 + channel]!, 0) / around.length
        return value + amount * (value - mean)
      })
      const grey = 0.299 * sharp[0]! + 0.587 * sharp[1]! + 0.114 * sharp[2]!
      for (let channel = 0; channel < 3; channel++) {
        rgba[at + channel] = Math.max(0, Math.min(255, Math.round(grey + (sharp[channel]! - grey) * saturation)))
      }
    }
  }
  return { width: bitmap.width, height: bitmap.height, rgba }
}

export type PixelDetail = 'half' | 'fine'

const UNIT_COLUMNS = 4
const UNIT_ROWS = 8
const UNITS = UNIT_COLUMNS * UNIT_ROWS
const CLEAR_COST = 24000
const CHANNEL_WEIGHTS = [0.9, 1.77, 0.33]
const DETAIL_ROWS = 8
const SHARPNESS = 0.8
const SATURATION = 1.15

export type Glyph = { code: number; covers: boolean[] }

const glyph = (code: number, inside: (column: number, row: number) => boolean): Glyph => ({
  code,
  covers: Array.from({ length: UNITS }, (_, i) => inside(i % UNIT_COLUMNS, Math.floor(i / UNIT_COLUMNS))),
})

const upperLeft = (column: number, row: number) => column < 2 && row < 4
const upperRight = (column: number, row: number) => column >= 2 && row < 4
const lowerLeft = (column: number, row: number) => column < 2 && row >= 4
const lowerRight = (column: number, row: number) => column >= 2 && row >= 4
const anyOf = (...shapes: ((column: number, row: number) => boolean)[]) => (column: number, row: number) =>
  shapes.some(shape => shape(column, row))

export const HALF_GLYPHS: Glyph[] = [
  glyph(0x20, () => false),
  glyph(0x2580, (_, row) => row < 4),
  glyph(0x2584, (_, row) => row >= 4),
  glyph(0x2588, () => true),
]

export const FINE_GLYPHS: Glyph[] = [
  ...HALF_GLYPHS,
  glyph(0x2581, (_, row) => row >= 7),
  glyph(0x2582, (_, row) => row >= 6),
  glyph(0x2583, (_, row) => row >= 5),
  glyph(0x2585, (_, row) => row >= 3),
  glyph(0x2586, (_, row) => row >= 2),
  glyph(0x2587, (_, row) => row >= 1),
  glyph(0x2594, (_, row) => row < 1),
  glyph(0x258e, column => column < 1),
  glyph(0x258c, column => column < 2),
  glyph(0x258a, column => column < 3),
  glyph(0x2590, column => column >= 2),
  glyph(0x2598, upperLeft),
  glyph(0x259d, upperRight),
  glyph(0x2596, lowerLeft),
  glyph(0x2597, lowerRight),
  glyph(0x259a, anyOf(upperLeft, lowerRight)),
  glyph(0x259e, anyOf(upperRight, lowerLeft)),
  glyph(0x259b, anyOf(upperLeft, upperRight, lowerLeft)),
  glyph(0x259c, anyOf(upperLeft, upperRight, lowerRight)),
  glyph(0x2599, anyOf(upperLeft, lowerLeft, lowerRight)),
  glyph(0x259f, anyOf(upperRight, lowerLeft, lowerRight)),
]

type Group = { count: number; clear: number; sum: number[]; squares: number[] }

const emptyGroup = (): Group => ({ count: 0, clear: 0, sum: [0, 0, 0], squares: [0, 0, 0] })

const takeInto = (group: Group, bitmap: Bitmap, index: number) => {
  if (bitmap.rgba[index + 3]! < OPAQUE) {
    group.clear++
    return
  }
  group.count++
  for (let channel = 0; channel < 3; channel++) {
    const value = bitmap.rgba[index + channel]!
    group.sum[channel]! += value
    group.squares[channel]! += value * value
  }
}

const meanOf = (group: Group) =>
  (Math.round(group.sum[0]! / group.count) << 16) | (Math.round(group.sum[1]! / group.count) << 8) | Math.round(group.sum[2]! / group.count)

const spreadOf = (group: Group) =>
  group.count === 0 ? 0 : CHANNEL_WEIGHTS.reduce((total, weight, c) => total + weight * (group.squares[c]! - group.sum[c]! ** 2 / group.count), 0)

type Fit = { code: number; foreground: number; background: number; cost: number }

const fitCell = (bitmap: Bitmap, left: number, top: number, glyphs: Glyph[]): Fit => {
  let best: Fit = { code: 0x20, foreground: DEFAULT_COLOR, background: DEFAULT_COLOR, cost: Infinity }
  for (const candidate of glyphs) {
    const covered = emptyGroup()
    const bare = emptyGroup()
    for (let i = 0; i < UNITS; i++) {
      const index = ((top + Math.floor(i / UNIT_COLUMNS)) * bitmap.width + left + (i % UNIT_COLUMNS)) * 4
      takeInto(candidate.covers[i]! ? covered : bare, bitmap, index)
    }
    let cost = spreadOf(covered) + covered.clear * CLEAR_COST
    const foreground = covered.count > 0 ? meanOf(covered) : 0
    let background = DEFAULT_COLOR
    if (bare.count >= bare.clear && bare.count > 0) {
      background = meanOf(bare)
      cost += spreadOf(bare) + bare.clear * CLEAR_COST
    } else {
      cost += bare.count * CLEAR_COST
    }
    if (candidate.code === 0x20) {
      best = cost < best.cost ? { code: 0x20, foreground: DEFAULT_COLOR, background, cost } : best
    } else if (cost < best.cost) {
      best = { code: candidate.code, foreground, background, cost }
    }
  }
  return best
}

export const cellsOf = (bitmap: Bitmap, detail: PixelDetail = 'fine'): string => {
  const columns = Math.floor(bitmap.width / UNIT_COLUMNS)
  const rows = Math.floor(bitmap.height / UNIT_ROWS)
  const glyphs = detail === 'half' ? HALF_GLYPHS : FINE_GLYPHS
  const bytes = new Uint8Array(columns * rows * 12)
  const view = new DataView(bytes.buffer)
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const fit = fitCell(bitmap, x * UNIT_COLUMNS, y * UNIT_ROWS, glyphs)
      const at = (y * columns + x) * 12
      view.setUint32(at, fit.code, true)
      view.setUint32(at + 4, fit.foreground, true)
      view.setUint32(at + 8, fit.background, true)
    }
  }
  return toBase64(bytes)
}

export const spriteCells = (png: Uint8Array, columns: number, rows: number, detail: PixelDetail = 'fine'): string => {
  const units = fitTo(cropToContent(decodePng(png)), columns * UNIT_COLUMNS, rows * UNIT_ROWS, Math.max(0, DETAIL_ROWS - rows))
  return cellsOf(sharpen(units, SHARPNESS, SATURATION), detail)
}
