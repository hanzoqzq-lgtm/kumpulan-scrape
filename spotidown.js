//
// ✎ Scraper : Spotify Downloader (SpotiDown)
// ✎ Author  : Hanzo
// ✎ Source  : https://spotidown.app/id7
// ✎ Note    : Jika ada error fix sendiri
// ✎ Kode    : https://github.com/hanzoqzq-lgtm/kumpulan-scrape
//

const fs = require('fs');
const path = require('path');

const BASE_ORIGIN = 'https://spotidown.app';
const SOURCE_URL = 'https://spotidown.app/id7';

const DEFAULT_HEADERS = {
  'Accept': '*/*',
  'Origin': BASE_ORIGIN,
  'Referer': SOURCE_URL,
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
};

/**
 * Ekstrak Set-Cookie dari response fetch menjadi header Cookie string
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
 * Decode JWT payload pada parameter ?token= milik rapid.spotidown.app/v2
 */
function decodeRapidJwt(downloadUrl) {
  try {
    const u = new URL(downloadUrl);
    const token = u.searchParams.get('token');
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length < 2) return null;
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch (_) {
    return null;
  }
}

/**
 * Parse semua <form name="submitspurl"> dari HTML response Langkah 1 (/action)
 */
function parseTracksFromActionHtml(html) {
  const tracks = [];
  const formRegex = /<form[^>]*name=["']submitspurl["'][^>]*>([\s\S]*?)<\/form>/gi;
  let match;

  while ((match = formRegex.exec(html)) !== null) {
    const formBlock = match[1];
    const dataB64 = formBlock.match(/name=["']data["']\s+value=["']([^"']+)["']/i)?.[1] || null;
    const base = formBlock.match(/name=["']base["']\s+value=["']([^"']+)["']/i)?.[1] || null;
    const token = formBlock.match(/name=["']token["']\s+value=["']([^"']+)["']/i)?.[1] || null;

    let metadata = null;
    if (dataB64) {
      try {
        metadata = JSON.parse(Buffer.from(dataB64, 'base64').toString('utf8'));
      } catch (_) {}
    }

    if (dataB64 && base && token) {
      tracks.push({
        metadata,
        formPayload: {
          data: dataB64,
          base,
          token,
        },
      });
    }
  }

  return tracks;
}

/**
 * Parse link download MP3 & Cover [HD] dari HTML response Langkah 2 (/action/track)
 */
function parseDownloadLinksFromTrackHtml(html) {
  const linkRegex = /<a[^>]*href=["'](https:\/\/rapid\.spotidown\.app\/v2\?token=[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  let mp3Url = null;
  let coverHdUrl = null;
  const allLinks = [];

  while ((match = linkRegex.exec(html)) !== null) {
    const url = match[1];
    const label = match[2].replace(/<[^>]+>/g, '').trim();
    const jwtPayload = decodeRapidJwt(url);

    allLinks.push({ label, url, jwtPayload });

    if (/mp3/i.test(label) || (jwtPayload && jwtPayload.url)) {
      mp3Url = url;
    } else if (/cover/i.test(label) || (jwtPayload && jwtPayload.cover)) {
      coverHdUrl = url;
    }
  }

  return { mp3Url, coverHdUrl, allLinks };
}

/**
 * LANGKAH 1 - Kirim URL Spotify ke POST https://spotidown.app/action
 * Mendapatkan cookie `session_data`, metadata lagu (Base64 JSON), `base`, dan `token`
 */
async function getSpotifyTrackToken(spotifyUrl, recaptchaToken = 'bypass') {
  if (!spotifyUrl || !String(spotifyUrl).trim()) {
    throw new Error('URL Spotify tidak boleh kosong');
  }

  const formData = new FormData();
  formData.append('url', String(spotifyUrl).trim());
  formData.append('g-recaptcha-response', recaptchaToken);

  const res = await fetch(`${BASE_ORIGIN}/action`, {
    method: 'POST',
    headers: DEFAULT_HEADERS,
    body: formData,
  });

  const cookie = extractCookies(res);
  const json = await res.json().catch(() => null);

  if (!res.ok || !json) {
    throw new Error(`Gagal memanggil /action (HTTP ${res.status})`);
  }

  if (json.error) {
    throw new Error(json.message || 'Server mengembalikan error pada /action');
  }

  const tracks = parseTracksFromActionHtml(json.data || '');
  if (tracks.length === 0) {
    throw new Error('Tidak ditemukan data lagu pada response /action');
  }

  return {
    cookie,
    tracks,
    rawResponse: json,
  };
}

/**
 * LANGKAH 2 - Tukar (data, base, token) ke POST https://spotidown.app/action/track
 * Mendapatkan direct link download MP3 & Cover [HD] dari rapid.spotidown.app
 */
async function getTrackDownloadLinks(formPayload, cookie = '') {
  const formData = new FormData();
  formData.append('data', formPayload.data);
  formData.append('base', formPayload.base);
  formData.append('token', formPayload.token);

  const res = await fetch(`${BASE_ORIGIN}/action/track`, {
    method: 'POST',
    headers: {
      ...DEFAULT_HEADERS,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: formData,
  });

  const json = await res.json().catch(() => null);

  if (!res.ok || !json) {
    throw new Error(`Gagal memanggil /action/track (HTTP ${res.status})`);
  }

  if (json.error) {
    throw new Error(json.message || 'Server mengembalikan error pada /action/track');
  }

  const parsedLinks = parseDownloadLinksFromTrackHtml(json.data || '');
  return {
    ...parsedLinks,
    rawResponse: json,
  };
}

/**
 * FUNGSI UTAMA - Scrape & Download Lagu Spotify lewat SpotiDown
 * @param {string} spotifyUrl - Link lagu/album/playlist Spotify
 * @param {object} options - { downloadFile: boolean, outputDir: string, includeDebug: boolean }
 */
async function spotiDown(spotifyUrl, options = {}) {
  const {
    downloadFile = false,
    outputDir = process.cwd(),
    includeDebug = false,
  } = options;

  // Langkah 1: POST /action
  const step1 = await getSpotifyTrackToken(spotifyUrl);
  const firstTrack = step1.tracks[0];

  // Langkah 2: POST /action/track
  const step2 = await getTrackDownloadLinks(firstTrack.formPayload, step1.cookie);

  let savedFilePath = null;
  let fileSizeBytes = null;

  // Opsional Langkah 3: Unduh file MP3 langsung ke disk
  if (downloadFile && step2.mp3Url) {
    const mp3Res = await fetch(step2.mp3Url, {
      method: 'GET',
      headers: DEFAULT_HEADERS,
    });

    if (!mp3Res.ok) {
      throw new Error(`Gagal mengunduh file MP3 (HTTP ${mp3Res.status})`);
    }

    const disposition = mp3Res.headers.get('content-disposition') || '';
    const fileMatch = disposition.match(/filename="?([^"]+)"?/i);
    const defaultName = `${firstTrack.metadata?.name || 'track'} - ${firstTrack.metadata?.artist || 'spotify'}.mp3`
      .replace(/[\\/:*?"<>|]/g, '_');
    const fileName = fileMatch ? fileMatch[1].replace(/[\\/:*?"<>|]/g, '_') : defaultName;

    savedFilePath = path.resolve(outputDir, fileName);
    const arrayBuffer = await mp3Res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    fs.writeFileSync(savedFilePath, buffer);
    fileSizeBytes = buffer.length;
  }

  const result = {
    success: true,
    source: SOURCE_URL,
    metadata: firstTrack.metadata,
    download: {
      mp3: step2.mp3Url,
      cover_hd: step2.coverHdUrl,
      saved_file: savedFilePath,
      file_size_bytes: fileSizeBytes,
    },
    total_tracks_found: step1.tracks.length,
    all_tracks: step1.tracks.map((t) => t.metadata),
  };

  if (includeDebug) {
    result.debug = {
      session_cookie: step1.cookie,
      step1_form_payload: firstTrack.formPayload,
      step2_jwt_details: step2.allLinks,
    };
  }

  return result;
}

// Eksekusi via CLI:
// node spotidown.js <URL_SPOTIFY> [--save] [--debug]
if (require.main === module) {
  const args = process.argv.slice(2);
  const urlArg =
    args.find((a) => !a.startsWith('--')) ||
    'https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b';
  const saveMp3 = args.includes('--save');
  const debugMode = args.includes('--debug');

  console.log(`[SpotiDown] Memproses URL: ${urlArg} ...`);
  spotiDown(urlArg, { downloadFile: saveMp3, includeDebug: debugMode })
    .then((res) => {
      console.log(JSON.stringify(res, null, 2));
    })
    .catch((err) => {
      console.error(`[Error] ${err.message}`);
      process.exit(1);
    });
}

module.exports = {
  spotiDown,
  getSpotifyTrackToken,
  getTrackDownloadLinks,
};
