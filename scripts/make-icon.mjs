// 生成应用图标：build/icon.png（512×512）+ build/icon.ico（16/24/32/48/64/128/256）
// 造型与界面左上角 logo 一致：蓝色渐变圆角方块 + 白色圆角播放三角。
// 不依赖任何外部库，PNG 用 zlib 自己编，ICO 直接内嵌 PNG。
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const build = join(root, 'build')
mkdirSync(build, { recursive: true })

// ---------- 几何（都写在 512×512 的设计坐标里，再按比例缩放） ----------

const RECT = { x0: 26, y0: 26, x1: 486, y1: 486, r: 116 }
const TRI = [
  [196, 152],
  [370, 256],
  [196, 360]
]
const TRI_R = 17
const GRAD_A = [59, 130, 246] // #3B82F6
const GRAD_B = [29, 78, 216] // #1D4ED8

function insideRoundRect(x, y, k) {
  const x0 = RECT.x0 * k,
    y0 = RECT.y0 * k,
    x1 = RECT.x1 * k,
    y1 = RECT.y1 * k,
    r = RECT.r * k
  if (x < x0 || x > x1 || y < y0 || y > y1) return false
  const cx = Math.min(Math.max(x, x0 + r), x1 - r)
  const cy = Math.min(Math.max(y, y0 + r), y1 - r)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= r * r
}

function cross(ax, ay, bx, by) {
  return ax * by - ay * bx
}

function insideTriangle(x, y, k) {
  const [a, b, c] = TRI.map(([px, py]) => [px * k, py * k])
  const d1 = cross(b[0] - a[0], b[1] - a[1], x - a[0], y - a[1])
  const d2 = cross(c[0] - b[0], c[1] - b[1], x - b[0], y - b[1])
  const d3 = cross(a[0] - c[0], a[1] - c[1], x - c[0], y - c[1])
  const neg = d1 < 0 || d2 < 0 || d3 < 0
  const pos = d1 > 0 || d2 > 0 || d3 > 0
  return !(neg && pos)
}

function distToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax
  const vy = by - ay
  const wx = px - ax
  const wy = py - ay
  const len2 = vx * vx + vy * vy
  let t = len2 ? (wx * vx + wy * vy) / len2 : 0
  t = Math.min(1, Math.max(0, t))
  const dx = px - (ax + t * vx)
  const dy = py - (ay + t * vy)
  return Math.hypot(dx, dy)
}

// 圆角三角形 = 三角形与半径 r 的圆盘的闵可夫斯基和
function insideRoundedTriangle(x, y, k) {
  if (insideTriangle(x, y, k)) return true
  const r = TRI_R * k
  const pts = TRI.map(([px, py]) => [px * k, py * k])
  for (let i = 0; i < 3; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % 3]
    if (distToSegment(x, y, a[0], a[1], b[0], b[1]) <= r) return true
  }
  return false
}

// ---------- 渲染：SS×SS 超采样抗锯齿 ----------

const SS = 4

function render(size) {
  const k = (size * SS) / 512
  const out = Buffer.alloc(size * size * 4)
  const span = (RECT.x1 - RECT.x0) * k
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = px * SS + sx + 0.5
          const y = py * SS + sy + 0.5
          if (!insideRoundRect(x, y, k)) continue
          a += 1
          if (insideRoundedTriangle(x, y, k)) {
            r += 255
            g += 255
            b += 255
          } else {
            const t = Math.min(1, Math.max(0, ((x - RECT.x0 * k) + (y - RECT.y0 * k)) / (2 * span)))
            r += GRAD_A[0] + (GRAD_B[0] - GRAD_A[0]) * t
            g += GRAD_A[1] + (GRAD_B[1] - GRAD_A[1]) * t
            b += GRAD_A[2] + (GRAD_B[2] - GRAD_A[2]) * t
          }
        }
      }
      const total = SS * SS
      const i = (py * size + px) * 4
      if (a === 0) continue
      // 颜色按覆盖到的子样本平均，alpha 按覆盖率
      out[i] = Math.round(r / a)
      out[i + 1] = Math.round(g / a)
      out[i + 2] = Math.round(b / a)
      out[i + 3] = Math.round((a / total) * 255)
    }
  }
  return out
}

// ---------- PNG 编码 ----------

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

function encodePng(size, rgba) {
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// ---------- 输出 ----------

const png512 = encodePng(512, render(512))
writeFileSync(join(build, 'icon.png'), png512)
console.log(`wrote ${join(build, 'icon.png')}  ${png512.length} bytes`)

const sizes = [16, 24, 32, 48, 64, 128, 256]
const blobs = sizes.map((s) => encodePng(s, render(s)))

const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(sizes.length, 4)
const entries = Buffer.alloc(16 * sizes.length)
let offset = 6 + entries.length
sizes.forEach((s, i) => {
  const o = i * 16
  entries[o] = s >= 256 ? 0 : s
  entries[o + 1] = s >= 256 ? 0 : s
  entries[o + 2] = 0
  entries[o + 3] = 0
  entries.writeUInt16LE(1, o + 4)
  entries.writeUInt16LE(32, o + 6)
  entries.writeUInt32LE(blobs[i].length, o + 8)
  entries.writeUInt32LE(offset, o + 12)
  offset += blobs[i].length
})
const ico = Buffer.concat([header, entries, ...blobs])
writeFileSync(join(build, 'icon.ico'), ico)
console.log(`wrote ${join(build, 'icon.ico')}  ${ico.length} bytes  (${sizes.join('/')})`)
