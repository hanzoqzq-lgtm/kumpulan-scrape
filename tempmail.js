// ============================================================
// ✎ Scraper : Temp Mail (client Node)
// ✎ Author  : Hanzo
// ✎ Source  : https://tempmail.ing/id/
// ✎ Note    : Jika ada error fix sendiri
// ============================================================

const API_BASE = 'https://api.tempmail.ing'
const HEADERS_JSON = { 'Content-Type': 'application/json' }

/** Buat satu alamat email sementara. */
export async function generateEmail(duration) {
  const res = await fetch(`${API_BASE}/api/generate`, {
    method: 'POST',
    headers: HEADERS_JSON,
    body: JSON.stringify({ duration }),
  })
  if (res.status === 429) {
    const wait = res.headers.get('Retry-After')
    throw new Error(`Rate limit, coba lagi setelah ${wait ?? '?'} detik`)
  }
  if (!res.ok) throw new Error(`generate gagal: HTTP ${res.status}`)
  return res.json()
}

/** Ambil daftar email masuk. etag opsional (untuk cek perubahan). */
export async function listEmails(emailAddress, etag) {
  const headers = etag ? { 'If-None-Match': etag } : {}
  const res = await fetch(`${API_BASE}/api/emails/${encodeURIComponent(emailAddress)}`, { headers })
  if (res.status === 304) return { changed: false, etag, data: null }
  if (!res.ok) throw new Error(`list gagal: HTTP ${res.status}`)
  return { changed: true, etag: res.headers.get('ETag'), data: await res.json() }
}

/** Baca satu email berdasarkan id. */
export async function readEmail(emailId) {
  const res = await fetch(`${API_BASE}/api/emails/${encodeURIComponent(emailId)}`)
  if (!res.ok) throw new Error(`baca gagal: HTTP ${res.status}`)
  return res.json()
}

/** Hapus email. */
export async function deleteEmail(emailId, emailAddress) {
  const res = await fetch(`${API_BASE}/api/emails/${encodeURIComponent(emailId)}`, {
    method: 'DELETE',
    headers: HEADERS_JSON,
    body: JSON.stringify({ emailAddress }),
  })
  if (!res.ok) throw new Error(`hapus gagal: HTTP ${res.status}`)
  return true
}

// Contoh pemakaian: satu alamat, cek inbox sekali.
// Jalankan: node tempmail.js
if (import.meta.url === `file://${process.argv[1]}`) {
  const gen = await generateEmail(10)
  console.log('Generate:', JSON.stringify(gen))
  const address = gen.email?.address
  if (address) {
    const inbox = await listEmails(address)
    console.log('Inbox:', JSON.stringify(inbox.data))
  }
}
