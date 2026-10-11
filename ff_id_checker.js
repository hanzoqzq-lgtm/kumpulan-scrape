// ============================================================
// ✎ Scraper : Cek UID Free Fire (Node.js - Full Working & Fixed)
// ✎ Author  : Hanzo (Fixed & Completed in Node.js)
// ✎ Source  : https://gameskinbo.com/free_fire_id_checker
// ✎ Note    : Sudah di-fix masalah Double-Submit Cookie CSRF +
//             Bypass Gerbang Subscribe YouTube + Kalkulasi Harga Akun
// ============================================================

const BASE_URL = 'https://gameskinbo.com';

const DEFAULT_HEADERS = {
  'Accept': 'application/json',
  'Content-Type': 'application/json',
  'x-api-client': 'gameskinbo-web',
  'Origin': BASE_URL,
  'Referer': `${BASE_URL}/free_fire_id_checker`,
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
};

/**
 * Ekstrak header Set-Cookie dari response fetch Node.js
 * menjadi string Cookie yang siap dikirim ke request berikutnya.
 */
function extractCookies(response, existingCookie = '') {
  const cookieMap = new Map();

  if (existingCookie) {
    existingCookie.split(';').forEach((pair) => {
      const [k, ...v] = pair.trim().split('=');
      if (k) cookieMap.set(k.trim(), v.join('='));
    });
  }

  const rawCookies =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean);

  for (const raw of rawCookies) {
    const firstPart = raw.split(';')[0];
    const [k, ...v] = firstPart.trim().split('=');
    if (k) cookieMap.set(k.trim(), v.join('='));
  }

  return Array.from(cookieMap.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

/**
 * Rumus estimasi harga akun (diambil langsung dari bundle JS GamesKinbo)
 */
function estimateAccountPrice(player) {
  if (!player) return null;

  const toNum = (val) => {
    const n = Number(String(val ?? 0).replace(/,/g, ''));
    return Number.isFinite(n) ? n : 0;
  };

  const primeWeights = {
    0: 0,
    1: 0.01,
    2: 0.03,
    3: 0.05,
    4: 0.1,
    5: 0.15,
    6: 0.3,
    7: 0.5,
    8: 0.7,
  };

  const primeKey = Math.min(Math.max(toNum(player.prime_level), 0), 8);
  const primeScore = primeWeights[primeKey] ?? 0;
  const levelScore = (Math.min(Math.max(toNum(player.level), 0), 120) / 120) * 0.05;

  const accountAgeYears = (() => {
    if (!player.created_at) return 0;
    const created = new Date(player.created_at);
    if (Number.isNaN(created.getTime())) return 0;
    return Math.max(0, (Date.now() - created.getTime()) / (365.25 * 24 * 3600 * 1000));
  })();

  const ageScore = (Math.min(accountAgeYears, 12) / 12) * 0.1;
  const likesScore = (Math.min(Math.max(toNum(player.likes), 0), 200000) / 200000) * 0.15;

  const totalFactor = Math.min(Math.max(primeScore + levelScore + ageScore + likesScore, 0), 1);
  const baseBdt = Math.round(60000 * totalFactor);
  const region = String(player.region || '').toUpperCase();

  if (region === 'BD') return `${baseBdt.toLocaleString('en-US')} TK`;
  if (region === 'IND') return `${Math.round(baseBdt / 1.4).toLocaleString('en-US')} RS`;

  const usd = baseBdt / 125;
  return Number.isInteger(usd)
    ? `$${usd.toLocaleString('en-US')}`
    : `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * LANGKAH 1 - Ambil CSRF Token + Cookie `csrf_token`
 * Endpoint: GET https://gameskinbo.com/api/csrf-token
 * Response: { "success": true, "csrfToken": "<timestamp>|<nonce>|<hmac>" }
 * Set-Cookie: csrf_token=<sha256_hex>; HttpOnly; SameSite=strict
 */
async function getFreshCsrfToken(signal) {
  const res = await fetch(`${BASE_URL}/api/csrf-token`, {
    method: 'GET',
    headers: DEFAULT_HEADERS,
    signal,
  });

  const cookie = extractCookies(res);
  const data = await res.json().catch(() => ({}));

  if (!res.ok || !data?.csrfToken) {
    throw new Error(data?.error || `Gagal mengambil CSRF token (HTTP ${res.status})`);
  }

  return {
    csrfToken: data.csrfToken,
    cookie,
    rawResponse: data,
  };
}

/**
 * LANGKAH 2 - Ambil Session Token sementara untuk 1 UID
 * Endpoint: POST https://gameskinbo.com/api/ff_id_checker/session
 * Header  : x-csrf-token + Cookie (csrf_token)
 * Body    : { "uid": "<UID>" }
 * Response: { "success": true, "token": "<base64_session_token>", "expiresIn": 30000 }
 */
async function getSessionToken(uid, csrfToken, cookie, signal) {
  const res = await fetch(`${BASE_URL}/api/ff_id_checker/session`, {
    method: 'POST',
    headers: {
      ...DEFAULT_HEADERS,
      'x-csrf-token': csrfToken,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify({ uid }),
    signal,
  });

  const updatedCookie = extractCookies(res, cookie);
  const data = await res.json().catch(() => ({}));

  if (!res.ok || !data?.token) {
    throw new Error(data?.error || `Gagal membuat session token (HTTP ${res.status})`);
  }

  return {
    sessionToken: data.token,
    expiresIn: data.expiresIn,
    cookie: updatedCookie,
    rawResponse: data,
  };
}

/**
 * LANGKAH 3 - Cek Info Player Free Fire berdasarkan UID
 * Endpoint: POST https://gameskinbo.com/api/ff_id_checker
 * Header  : x-csrf-token + x-ff-id-checker-token + Cookie (csrf_token)
 * Body    : { "uid": "<UID>" }
 */
async function checkFreeFireUid(rawUid, options = {}) {
  const { timeoutMs = 45000, includeDebug = false } = options;

  // Validasi Input sesuai UI: buang semua karakter non-digit
  const cleanUid = String(rawUid || '').replace(/\D/g, '');
  if (!cleanUid) {
    throw new Error('Please enter a Player UID (UID hanya boleh berisi angka)');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // 1. GET /api/csrf-token
    const step1 = await getFreshCsrfToken(controller.signal);

    // 2. POST /api/ff_id_checker/session
    const step2 = await getSessionToken(
      cleanUid,
      step1.csrfToken,
      step1.cookie,
      controller.signal
    );

    // 3. POST /api/ff_id_checker
    const res3 = await fetch(`${BASE_URL}/api/ff_id_checker`, {
      method: 'POST',
      headers: {
        ...DEFAULT_HEADERS,
        'x-csrf-token': step1.csrfToken,
        'x-ff-id-checker-token': step2.sessionToken,
        ...(step2.cookie ? { Cookie: step2.cookie } : {}),
      },
      body: JSON.stringify({ uid: cleanUid }),
      signal: controller.signal,
    });

    const playerInfo = await res3.json().catch(() => ({}));

    if (!res3.ok) {
      throw new Error(
        playerInfo?.error || `Failed to fetch player info (HTTP ${res3.status})`
      );
    }

    // Parse stringified JSON array fields jika masih berbentuk string "[]"
    const parseJsonArrayField = (val) => {
      if (typeof val !== 'string') return val;
      try {
        return JSON.parse(val);
      } catch (_) {
        return val;
      }
    };

    const enrichedResult = {
      ...playerInfo,
      equipped_outfit: parseJsonArrayField(playerInfo.equipped_outfit),
      equipped_skills: parseJsonArrayField(playerInfo.equipped_skills),
      equipped_weapon: parseJsonArrayField(playerInfo.equipped_weapon),
      raw_data: parseJsonArrayField(playerInfo.raw_data),
      estimated_market_price: estimateAccountPrice(playerInfo),
      banner_urls: {
        webp: `${BASE_URL}/api/banner/banner_${cleanUid}.webp`,
        jpg: `${BASE_URL}/api/banner/banner_${cleanUid}.jpg`,
      },
    };

    if (includeDebug) {
      return {
        success: true,
        uid: cleanUid,
        debug: {
          step1_csrf: step1,
          step2_session: step2,
          step3_status: res3.status,
        },
        data: enrichedResult,
      };
    }

    return enrichedResult;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Request timed out after 45 seconds. Please try again.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Jalankan langsung dari CLI: node ff_id_checker.js <UID> [--debug]
if (require.main === module) {
  const args = process.argv.slice(2);
  const uidArg = args.find((a) => !a.startsWith('--')) || '432493599';
  const debugMode = args.includes('--debug');

  console.log(`[FF ID Checker] Mengecek UID: ${uidArg} ...`);
  checkFreeFireUid(uidArg, { includeDebug: debugMode })
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((err) => {
      console.error(`[Error] ${err.message}`);
      process.exit(1);
    });
}

module.exports = {
  checkFreeFireUid,
  getFreshCsrfToken,
  getSessionToken,
  estimateAccountPrice,
};
