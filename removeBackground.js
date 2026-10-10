// ============================================================
// ✎ Scraper : Hapus background
// ✎ Author  : Hanzo
// ✎ Source  : https://www.iloveimg.com/remove-background
// ✎ Note    : Jika ada error fix sendiri
// ============================================================

import FormData from 'form-data'
import axios from 'axios'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const PAGE_URL = 'https://www.iloveimg.com/remove-background'

const SERVERS = [
  'api1g', 'api2g', 'api3g', 'api4g', 'api5g', 'api6g', 'api8g', 'api9g', 'api10g',
  'api11g', 'api12g', 'api13g', 'api14g', 'api15g', 'api16g', 'api17g', 'api18g',
  'api19g', 'api20g', 'api21g', 'api22g', 'api24g', 'api25g',
]

const TASK =
  'r68zl88mq72xq94j2d5p66bn2z9lrbx20njsbw2qsAvgmzr11lvfhAx9kl87pp6yqgx7c8vg7sfbqnrr42qb16v0gj8jl5s0kq1kgp26mdyjjspd8c5A2wk8b4Adbm6vf5tpwbqlqdr8A9tfn7vbqvy28ylphlxdl379psxpd8r70nzs3sk1'

const HTTP_TIMEOUT_MS = 45_000
const GPU_TIMEOUT_MS = 180_000
const TOKEN_TTL_MS = 10 * 60_000
const MAX_RETRIES = 3

export const RM_BG_MAX_BYTES = 2 * 1024 * 1024
export const RM_BG_MAX_PIXELS = 4_403_200

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const sessionCache = new Map()

/** Ambil token, csrf, dan daftar server dari HTML halaman. */
function parseConfig(html) {
  const text = typeof html === 'string' ? html : Buffer.from(html || '').toString()

  let cfg = null
  const idx = text.indexOf('ilovepdfConfig')
  if (idx !== -1) {
    const start = text.indexOf('{', idx)
    const end = text.indexOf('};', start)
    if (start !== -1 && end !== -1) {
      try { cfg = JSON.parse(text.slice(start, end + 1)) } catch {}
    }
  }

  const csrf = text.match(/<meta[^>]*name=["']csrf-token["'][^>]*content=["']([^"']+)["']/i)?.[1] || null
  return {
    token: cfg?.token || null,
    csrf,
    servers: Array.isArray(cfg?.servers) && cfg.servers.length ? cfg.servers : null,
  }
}

/**
 * Ambil session (cache 10 menit). force=true untuk refresh.
 * @returns {Promise<{token: string, csrf: string, servers: string[]|null}>}
 */
export async function getTokenInfo(force = false, pageUrl = PAGE_URL) {
  const now = Date.now()
  const hit = sessionCache.get(pageUrl)
  if (!force && hit && now - hit.ts < TOKEN_TTL_MS) {
    return { token: hit.token, csrf: hit.csrf, servers: hit.servers }
  }

  const res = await axios.get(pageUrl, {
    timeout: 15_000,
    headers: { 'User-Agent': UA, Accept: 'text/html' },
  })

  const { token, csrf, servers } = parseConfig(res.data)
  if (!token || !csrf) {
    throw new Error('Token/CSRF gagal diambil dari iloveimg.com (mungkin sedang down)')
  }

  sessionCache.set(pageUrl, { token, csrf, servers, ts: now })
  return { token, csrf, servers }
}

function buildHeaders(token, csrf, form) {
  return {
    Authorization: `Bearer ${token}`,
    Origin: 'https://www.iloveimg.com',
    Cookie: `_csrf=${csrf}`,
    'User-Agent': UA,
    ...(form ? form.getHeaders() : {}),
  }
}

function classifyError(err) {
  const st = err?.response?.status
  if (st === 401 || st === 403) return 'auth'
  if (st === 429) return 'rate'
  if (st && st >= 500) return 'server'
  if (/unauthorized|forbidden|invalid token/i.test(String(err?.message || ''))) return 'auth'
  return null
}

function pickServer(pool, used) {
  const avail = pool.filter((s) => !used.includes(s))
  const src = avail.length ? avail : pool
  return src.length ? src[Math.floor(Math.random() * src.length)] : null
}

/** POST multipart ke https://{server}.iloveimg.com/v1/{path}. */
async function postToTool({ server, path, token, csrf, form, timeout, responseType }) {
  const res = await axios.post(`https://${server}.iloveimg.com/v1/${path}`, form, {
    headers: buildHeaders(token, csrf, form),
    responseType,
    timeout,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    validateStatus: () => true,
  })

  if (res.status < 200 || res.status >= 300) {
    const body = responseType === 'arraybuffer'
      ? Buffer.from(res.data || []).toString('utf8')
      : JSON.stringify(res.data)
    const err = new Error(`HTTP ${res.status} pada /v1/${path}: ${String(body).slice(0, 200)}`)
    err.response = { status: res.status }
    throw err
  }
  return res
}

/** Validasi PNG lewat magic byte, lalu baca ukuran dari IHDR. */
export function inspectPng(buf) {
  if (!buf || buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIG)) return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

async function uploadFile({ server, token, csrf, buffer, fileName }) {
  const form = new FormData()
  form.append('name', fileName)
  form.append('chunk', '0')
  form.append('chunks', '1')
  form.append('task', TASK)
  form.append('preview', '1')
  form.append('file', buffer, { filename: fileName, contentType: 'image/jpeg' })

  const res = await postToTool({ server, path: 'upload', token, csrf, form, timeout: HTTP_TIMEOUT_MS })
  const serverFilename = res.data?.server_filename
  if (!serverFilename) throw new Error('Upload gagal: server_filename tidak ada di response')
  return serverFilename
}

async function requestRemoveBackground({ server, token, csrf, serverFilename }) {
  const form = new FormData()
  form.append('task', TASK)
  form.append('server_filename', serverFilename)

  const res = await postToTool({
    server, path: 'removebackground', token, csrf, form,
    timeout: GPU_TIMEOUT_MS, responseType: 'arraybuffer',
  })
  return Buffer.from(res.data || [])
}

/**
 * Hapus background gambar → PNG transparan.
 *
 * @param {Buffer} buffer
 * @param {{fileName?: string, onProgress?: (stage: string, detail?: string) => void}} [opts]
 * @returns {Promise<{buffer: Buffer, width: number, height: number, server: string, transparent: true}>}
 */
export async function removeBackgroundImage(buffer, opts = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new Error('Buffer gambar kosong / bukan Buffer')
  }
  if (buffer.length > RM_BG_MAX_BYTES) {
    throw new Error(`Ukuran ${(buffer.length / 1048576).toFixed(2)} MB melebihi batas 2 MB`)
  }

  const fileName = String(opts.fileName || 'image.jpg').replace(/[^\w.-]/g, '_') || 'image.jpg'
  const progress = (stage, detail) => {
    try { opts.onProgress?.(stage, detail) } catch {}
  }

  progress('token')
  let session = await getTokenInfo(false)
  const pool = (session.servers?.length ? session.servers : SERVERS).filter(Boolean)
  const used = []
  let lastErr = null

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const server = pickServer(pool, used)
    if (!server) break
    used.push(server)

    try {
      progress('upload', server)
      const serverFilename = await uploadFile({ server, ...session, buffer, fileName })

      progress('process', server)
      const out = await requestRemoveBackground({ server, ...session, serverFilename })
      if (!out.length) throw new Error('Hasil kosong dari server')

      const png = inspectPng(out)
      if (!png) throw new Error('Respons bukan PNG yang valid')
      if (png.width * png.height > RM_BG_MAX_PIXELS) {
        throw new Error(`Hasil ${png.width}x${png.height} melebihi batas 4.4MP`)
      }

      return { buffer: out, width: png.width, height: png.height, server, transparent: true }
    } catch (err) {
      lastErr = err
      if (classifyError(err) === 'auth') {
        try { session = await getTokenInfo(true) } catch {}
      }
    }
  }

  throw lastErr || new Error('Gagal remove background (semua server error)')
}
