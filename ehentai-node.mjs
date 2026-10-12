#!/usr/bin/env node
/**
 * E-Hentai Search & Image Downloader (Node.js, standalone, ESM)
 * Scraper asli: Hanzo (kumpulan-scrape) — dipakai utuh, ditambah CLI.
 * Butuh Node.js 18+ (fetch bawaan). Tanpa dependensi npm.
 *
 * Pakai:
 *   node ehentai-node.mjs "<kata kunci>"                  -> daftar galeri
 *   node ehentai-node.mjs "<kata kunci>" --pick=1          -> download halaman galeri hasil ke-1
 *   node ehentai-node.mjs <url galeri> --pages=5           -> download 5 halaman pertama
 * Opsi: --limit=10 (jumlah hasil)  --pages=5 (jumlah halaman)  --out=./ehentai (folder simpan)
 *
 * Galeri bertag lolicon/shotacon/toddlercon otomatis disaring & ditolak.
 */

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

const CONFIG = {
  BASE_URL: "https://e-hentai.org",
  API_URL: "https://api.e-hentai.org/api.php",
  // Cookie `nw=1` bypasses the "Content Warning: Offensive For Everyone" interstitial page
  DEFAULT_COOKIE: "nw=1",
};

const CATEGORY_BITMASK = {
  misc: 1,
  doujinshi: 2,
  manga: 4,
  artistcg: 8,
  gamecg: 16,
  imageset: 32,
  cosplay: 64,
  asianporn: 128,
  nonh: 256,
  western: 512,
};

/**
 * Decode common HTML entities in titles/strings
 */
function decodeHtmlEntities(str = "") {
  return String(str)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)));
}

/**
 * Parse `/g/<gid>/<token>/` URL into `{ gid, token }`
 */
function parseGalleryUrl(urlStr) {
  const m = String(urlStr).match(/\/g\/(\d+)\/([a-f0-9]{10})/i);
  if (!m) return null;
  return { gid: Number(m[1]), token: m[2].toLowerCase() };
}

/**
 * Parse `/s/<imgkey>/<gid>-<page>` URL into `{ imgkey, gid, page }`
 */
function parseViewerUrl(urlStr) {
  const m = String(urlStr).match(/\/s\/([a-f0-9]{10})\/(\d+)-(\d+)/i);
  if (!m) return null;
  return {
    imgkey: m[1].toLowerCase(),
    gid: Number(m[2]),
    page: Number(m[3]),
  };
}

/**
 * Group E-Hentai tag strings (`["parody:naruto", "female:sole female"]`) by namespace
 */
function groupTagsByNamespace(tags = []) {
  const grouped = {};
  for (const raw of tags) {
    const idx = raw.indexOf(":");
    if (idx !== -1) {
      const ns = raw.slice(0, idx);
      const val = raw.slice(idx + 1);
      if (!grouped[ns]) grouped[ns] = [];
      grouped[ns].push(val);
    } else {
      if (!grouped.misc) grouped.misc = [];
      grouped.misc.push(raw);
    }
  }
  return grouped;
}

/**
 * Official E-Hentai JSON API: Batch Gallery Metadata (`method: "gdata"`)
 * Accepts up to 25 `[gid, token]` pairs per call (automatically chunks larger arrays).
 *
 * @param {Array<[number|string, string]>} gidList - Array of `[gid, token]` pairs
 * @returns {Promise<Array<object>>}
 */
async function getGalleryMetadata(gidList = []) {
  if (!Array.isArray(gidList) || gidList.length === 0) return [];

  const results = [];
  for (let i = 0; i < gidList.length; i += 25) {
    const chunk = gidList
      .slice(i, i + 25)
      .map(([g, t]) => [Number(g), String(t)]);

    const res = await fetch(CONFIG.API_URL, {
      method: "POST",
      headers: {
        "User-Agent": DEFAULT_UA,
        "Content-Type": "application/json",
        Origin: CONFIG.BASE_URL,
        Referer: `${CONFIG.BASE_URL}/`,
      },
      body: JSON.stringify({
        method: "gdata",
        gidlist: chunk,
        namespace: 1,
      }),
    });

    if (!res.ok) {
      throw new Error(
        `api.php (gdata) gagal (${res.status}): ${await res.text()}`
      );
    }

    const data = await res.json();
    if (Array.isArray(data.gmetadata)) {
      for (const item of data.gmetadata) {
        if (item.error) {
          results.push(item);
          continue;
        }
        results.push({
          gid: Number(item.gid),
          token: item.token,
          url: `${CONFIG.BASE_URL}/g/${item.gid}/${item.token}/`,
          title: decodeHtmlEntities(item.title),
          titleJpn: decodeHtmlEntities(item.title_jpn || ""),
          category: item.category,
          thumb: item.thumb,
          uploader: item.uploader,
          posted: Number(item.posted),
          postedIso: item.posted
            ? new Date(Number(item.posted) * 1000).toISOString()
            : null,
          filecount: Number(item.filecount),
          filesize: Number(item.filesize),
          expunged: Boolean(item.expunged),
          rating: Number(item.rating),
          torrentcount: Number(item.torrentcount),
          torrents: item.torrents || [],
          tags: item.tags || [],
          tagsByNamespace: groupTagsByNamespace(item.tags || []),
        });
      }
    }
  }

  return results;
}

/**
 * Official E-Hentai JSON API: Reverse Lookup Gallery Token from Page (`method: "gtoken"`)
 *
 * @param {Array<[number|string, string, number|string]>} pageList - Array of `[gid, imgkey, page]`
 */
async function getGalleryTokens(pageList = []) {
  const formatted = pageList.map(([gid, imgkey, page]) => [
    Number(gid),
    String(imgkey),
    Number(page),
  ]);
  const res = await fetch(CONFIG.API_URL, {
    method: "POST",
    headers: {
      "User-Agent": DEFAULT_UA,
      "Content-Type": "application/json",
      Origin: CONFIG.BASE_URL,
      Referer: `${CONFIG.BASE_URL}/`,
    },
    body: JSON.stringify({
      method: "gtoken",
      pagelist: formatted,
    }),
  });
  if (!res.ok) {
    throw new Error(
      `api.php (gtoken) gagal (${res.status}): ${await res.text()}`
    );
  }
  const data = await res.json();
  return data.tokenlist || [];
}

/**
 * Search galleries on `https://e-hentai.org/?f_search=...` and enrich with `api.php` (`gdata`)
 *
 * @param {string} query - Search keyword / tags (e.g. `naruto`, `parody:naruto`, `language:english`)
 * @param {object} [options]
 * @param {number} [options.limit=10] - Max galleries to return (up to 25 per page)
 * @param {number|string} [options.next] - Cursor `gid` for next page (`?next=<gid>`)
 * @param {number|string} [options.prev] - Cursor `gid` for previous page (`?prev=<gid>`)
 * @param {number} [options.f_cats] - Category filter bitmask (0..1023)
 * @param {number} [options.minRating] - Minimum rating filter (2..5)
 * @param {number} [options.minPages] - Minimum page count (`f_spf`)
 * @param {number} [options.maxPages] - Maximum page count (`f_spt`)
 * @param {boolean} [options.enrichWithApi=true] - Call `api.php` (`gdata`) for full metadata & tags
 */
async function searchEhentai(query = "", options = {}) {
  const {
    limit = 10,
    next = null,
    prev = null,
    f_cats = null,
    minRating = null,
    minPages = null,
    maxPages = null,
    enrichWithApi = true,
  } = options;

  const u = new URL("/", CONFIG.BASE_URL);
  if (query) u.searchParams.set("f_search", query);
  if (next) u.searchParams.set("next", String(next));
  if (prev) u.searchParams.set("prev", String(prev));
  if (f_cats !== null && f_cats !== undefined) {
    u.searchParams.set("f_cats", String(f_cats));
  }
  if (minRating && minRating >= 2 && minRating <= 5) {
    u.searchParams.set("advsearch", "1");
    u.searchParams.set("f_sr", "on");
    u.searchParams.set("f_srdd", String(minRating));
  }
  if (minPages || maxPages) {
    u.searchParams.set("advsearch", "1");
    u.searchParams.set("f_sp", "on");
    if (minPages) u.searchParams.set("f_spf", String(minPages));
    if (maxPages) u.searchParams.set("f_spt", String(maxPages));
  }

  const res = await fetch(u.toString(), {
    method: "GET",
    headers: {
      "User-Agent": DEFAULT_UA,
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      Cookie: CONFIG.DEFAULT_COOKIE,
    },
  });

  if (!res.ok) {
    throw new Error(`Search gagal (${res.status} ${res.statusText})`);
  }

  const html = await res.text();

  // Extract total count text & cursor pagination
  const countMatch =
    html.match(/class="searchtext"[^>]*>\s*<p>([^<]+)<\/p>/i) ||
    html.match(/Found\s+(?:about\s+)?([\d,]+)\s+results/i);
  const totalText = countMatch ? decodeHtmlEntities(countMatch[1].trim()) : null;
  const totalCountMatch = totalText ? totalText.match(/([\d,]+)/) : null;
  const totalEstimate = totalCountMatch
    ? Number(totalCountMatch[1].replace(/,/g, ""))
    : null;

  const nextUrlMatch = html.match(/var\s+nexturl\s*=\s*"([^"]*)"/);
  const prevUrlMatch = html.match(/var\s+prevurl\s*=\s*"([^"]*)"/);
  const nextUrl = nextUrlMatch?.[1]
    ? decodeHtmlEntities(nextUrlMatch[1])
    : null;
  const prevUrl = prevUrlMatch?.[1]
    ? decodeHtmlEntities(prevUrlMatch[1])
    : null;

  const nextCursor = nextUrl
    ? new URL(nextUrl).searchParams.get("next")
    : null;
  const prevCursor = prevUrl
    ? new URL(prevUrl).searchParams.get("prev")
    : null;

  // Extract unique [gid, token] pairs in order
  const seen = new Set();
  const gidPairs = [];
  for (const m of html.matchAll(
    /https:\/\/e-hentai\.org\/g\/(\d+)\/([a-f0-9]{10})\//gi
  )) {
    const gid = Number(m[1]);
    const token = m[2].toLowerCase();
    const key = `${gid}/${token}`;
    if (!seen.has(key)) {
      seen.add(key);
      gidPairs.push([gid, token]);
    }
  }

  const slicedPairs = limit > 0 ? gidPairs.slice(0, limit) : gidPairs;

  let results = [];
  if (enrichWithApi && slicedPairs.length > 0) {
    results = await getGalleryMetadata(slicedPairs);
  } else {
    results = slicedPairs.map(([gid, token]) => ({
      gid,
      token,
      url: `${CONFIG.BASE_URL}/g/${gid}/${token}/`,
    }));
  }

  return {
    query,
    searchUrl: u.toString(),
    totalText,
    totalEstimate,
    pagination: {
      nextCursor,
      prevCursor,
      nextUrl,
      prevUrl,
    },
    count: results.length,
    results,
  };
}

/**
 * Parse a single viewer HTML (`/s/<imgkey>/<gid>-<page>`) or `showpage` JSON payload
 */
function parseViewerDataFromHtml(html, fallback = {}) {
  const gidMatch = html.match(/var\s+gid\s*=\s*(\d+)/);
  const pageMatch = html.match(/var\s+startpage\s*=\s*(\d+)/);
  const keyMatch = html.match(/var\s+startkey\s*=\s*"([^"]+)"/);
  const showkeyMatch = html.match(/var\s+showkey\s*=\s*"([^"]+)"/);
  const siMatch = html.match(/var\s+si\s*=\s*"([^"]+)"/);
  const xresMatch = html.match(/var\s+xres\s*=\s*(\d+)/);
  const yresMatch = html.match(/var\s+yres\s*=\s*(\d+)/);

  const imgMatch = html.match(/<img[^>]+id="img"[^>]+src="([^"]+)"/i);
  const nlMatch = html.match(/nl\(\x27([^\x27]+)\x27\)/);
  const infoMatch = html.match(
    /<div>([^<]+\.(?:jpg|jpeg|png|webp|gif)\s*::\s*[^<]+)<\/div>/i
  );
  const fullImgMatch = html.match(
    /href="(https:\/\/e-hentai\.org\/fullimg\/[^"]+)"/i
  );
  const nextMatch = html.match(
    /id="next"[^>]+onclick="return\s+load_image\((\d+),\s*\x27([a-f0-9]{10})\x27\)"/i
  );
  const prevMatch = html.match(
    /id="prev"[^>]+onclick="return\s+load_image\((\d+),\s*\x27([a-f0-9]{10})\x27\)"/i
  );

  const fileInfo = infoMatch ? decodeHtmlEntities(infoMatch[1].trim()) : null;
  let filename = null;
  let dimensionsText = null;
  let fileSizeText = null;
  if (fileInfo) {
    const parts = fileInfo.split("::").map((s) => s.trim());
    filename = parts[0] || null;
    dimensionsText = parts[1] || null;
    fileSizeText = parts[2] || null;
  }

  const gid = gidMatch ? Number(gidMatch[1]) : fallback.gid || null;
  const page = pageMatch ? Number(pageMatch[1]) : fallback.page || null;
  const imgkey = keyMatch ? keyMatch[1] : fallback.imgkey || null;

  return {
    gid,
    page,
    imgkey,
    viewerUrl:
      gid && page && imgkey
        ? `${CONFIG.BASE_URL}/s/${imgkey}/${gid}-${page}`
        : fallback.viewerUrl || null,
    showkey: showkeyMatch ? showkeyMatch[1] : null,
    si: siMatch ? siMatch[1] : null,
    imageUrl: imgMatch ? decodeHtmlEntities(imgMatch[1]) : null,
    width: xresMatch ? Number(xresMatch[1]) : null,
    height: yresMatch ? Number(yresMatch[1]) : null,
    filename,
    dimensionsText,
    fileSizeText,
    fileInfo,
    reloadKey: nlMatch ? nlMatch[1] : null,
    originalDownloadUrl: fullImgMatch
      ? decodeHtmlEntities(fullImgMatch[1])
      : null,
    nextPage: nextMatch
      ? {
          page: Number(nextMatch[1]),
          imgkey: nextMatch[2],
          viewerUrl: `${CONFIG.BASE_URL}/s/${nextMatch[2]}/${gid}-${nextMatch[1]}`,
        }
      : null,
    prevPage: prevMatch
      ? {
          page: Number(prevMatch[1]),
          imgkey: prevMatch[2],
          viewerUrl: `${CONFIG.BASE_URL}/s/${prevMatch[2]}/${gid}-${prevMatch[1]}`,
        }
      : null,
  };
}

/**
 * Extract full-resolution image URL and metadata from an E-Hentai Viewer Page (`/s/<imgkey>/<gid>-<page>`)
 * or via `POST https://api.e-hentai.org/api.php` (`method: "showpage"`) when `showkey` is supplied.
 *
 * @param {string|object} viewerUrlOrParams - Viewer URL string or `{ gid, page, imgkey, showkey, nl }`
 */
async function getPageImage(viewerUrlOrParams, options = {}) {
  let params = {};
  if (typeof viewerUrlOrParams === "string") {
    const parsed = parseViewerUrl(viewerUrlOrParams);
    if (!parsed) {
      throw new Error(`Format URL viewer tidak valid: ${viewerUrlOrParams}`);
    }
    params = { ...parsed, viewerUrl: viewerUrlOrParams, ...options };
  } else if (viewerUrlOrParams && typeof viewerUrlOrParams === "object") {
    const parsedFromUrl = viewerUrlOrParams.viewerUrl
      ? parseViewerUrl(viewerUrlOrParams.viewerUrl)
      : {};
    params = { ...parsedFromUrl, ...viewerUrlOrParams, ...options };
  } else {
    throw new Error("Parameter viewerUrlOrParams tidak valid.");
  }

  const { gid, page, imgkey, showkey, nl } = params;

  // Mode 1: If `showkey` is provided and no `nl` reload is forced, use JSON API `method: "showpage"`
  if (showkey && !nl) {
    const apiRes = await fetch(CONFIG.API_URL, {
      method: "POST",
      headers: {
        "User-Agent": DEFAULT_UA,
        "Content-Type": "application/json",
        Origin: CONFIG.BASE_URL,
        Referer: `${CONFIG.BASE_URL}/s/${imgkey}/${gid}-${page}`,
      },
      body: JSON.stringify({
        method: "showpage",
        gid: Number(gid),
        page: Number(page),
        imgkey: String(imgkey),
        showkey: String(showkey),
      }),
    });

    if (apiRes.ok) {
      const d = await apiRes.json();
      if (!d.error && d.i3) {
        const combinedHtml = `${d.n || ""}${d.i || ""}${d.i3 || ""}${d.i5 || ""}${
          d.i6 || ""
        }`;
        const parsed = parseViewerDataFromHtml(combinedHtml, {
          gid: Number(gid),
          page: Number(d.p || page),
          imgkey: d.k || imgkey,
        });
        return {
          ...parsed,
          showkey,
          si: d.si || parsed.si,
          width: d.x ? Number(d.x) : parsed.width,
          height: d.y ? Number(d.y) : parsed.height,
          via: "api.php:showpage",
        };
      }
    }
  }

  // Mode 2: Fetch Viewer HTML (`/s/<imgkey>/<gid>-<page>`)
  const viewerUrl = `${CONFIG.BASE_URL}/s/${imgkey}/${gid}-${page}${
    nl ? `?nl=${encodeURIComponent(nl)}` : ""
  }`;
  const res = await fetch(viewerUrl, {
    method: "GET",
    headers: {
      "User-Agent": DEFAULT_UA,
      Cookie: CONFIG.DEFAULT_COOKIE,
      Referer: `${CONFIG.BASE_URL}/`,
    },
  });

  if (!res.ok) {
    throw new Error(
      `Gagal memuat halaman viewer (${res.status}): ${viewerUrl}`
    );
  }

  const html = await res.text();
  const parsed = parseViewerDataFromHtml(html, {
    gid: Number(gid),
    page: Number(page),
    imgkey: String(imgkey),
    viewerUrl,
  });

  return {
    ...parsed,
    via: nl ? "viewer-html-reload" : "viewer-html",
  };
}

/**
 * Fetch gallery detail, page list (`#gdt`), and optionally resolve direct full-size image URLs
 *
 * @param {string|number} galleryUrlOrGid - Full gallery URL (`https://e-hentai.org/g/<gid>/<token>/`) or `gid`
 * @param {string} [tokenArg] - Gallery `token` (if first argument is `gid`)
 * @param {object} [options]
 * @param {number} [options.galleryPage=0] - 0-indexed thumbnail page (`?p=0`, `?p=1`, ...)
 * @param {boolean} [options.resolveImages=true] - Resolve direct full-resolution H@H image URLs
 * @param {number} [options.maxImages=5] - How many pages to resolve into direct image URLs (set `0` for all on page)
 */
async function getGalleryDetail(
  galleryUrlOrGid,
  tokenArg = null,
  options = {}
) {
  let gid;
  let token;
  let opts = options;

  if (
    typeof tokenArg === "object" &&
    tokenArg !== null &&
    !Array.isArray(tokenArg)
  ) {
    opts = tokenArg;
    tokenArg = null;
  }

  if (typeof galleryUrlOrGid === "string" && galleryUrlOrGid.includes("/g/")) {
    const parsed = parseGalleryUrl(galleryUrlOrGid);
    if (!parsed) {
      throw new Error(`Format URL galeri tidak valid: ${galleryUrlOrGid}`);
    }
    gid = parsed.gid;
    token = parsed.token;
  } else {
    gid = Number(galleryUrlOrGid);
    token = String(tokenArg || "").toLowerCase();
  }

  if (!gid || !token) {
    throw new Error("gid dan token galeri wajib diisi.");
  }

  const {
    galleryPage = 0,
    resolveImages = true,
    maxImages = 5,
  } = opts;

  // 1. Fetch official metadata via api.php (`gdata`) and gallery HTML page in parallel
  const pageUrl = `${CONFIG.BASE_URL}/g/${gid}/${token}/?p=${galleryPage}`;
  const [metaList, htmlRes] = await Promise.all([
    getGalleryMetadata([[gid, token]]),
    fetch(pageUrl, {
      method: "GET",
      headers: {
        "User-Agent": DEFAULT_UA,
        Cookie: CONFIG.DEFAULT_COOKIE,
      },
    }),
  ]);

  if (!htmlRes.ok) {
    throw new Error(
      `Gagal mengambil halaman galeri (${htmlRes.status}): ${pageUrl}`
    );
  }

  const metadata = metaList[0] || { gid, token };
  const html = await htmlRes.text();

  // 2. Extract all page entries inside `#gdt`
  const pages = [];
  const pageRegex =
    /<a\s+href="(https:\/\/e-hentai\.org\/s\/([a-f0-9]{10})\/(\d+)-(\d+))"[^>]*>\s*<div\s+title="Page\s+\d+:\s*([^"]+)"\s+style="([^"]+)"/gi;

  for (const m of html.matchAll(pageRegex)) {
    const viewerUrl = m[1];
    const imgkey = m[2].toLowerCase();
    const pageNum = Number(m[4]);
    const filename = decodeHtmlEntities(m[5].trim());
    const style = m[6];

    const bgMatch = style.match(
      /url\(([^)]+)\)\s*(-?\d+)px\s+(-?\d+)px/i
    );
    const wMatch = style.match(/width:(\d+)px/i);
    const hMatch = style.match(/height:(\d+)px/i);

    pages.push({
      gid,
      page: pageNum,
      imgkey,
      viewerUrl,
      filename,
      spriteThumb: bgMatch
        ? {
            spriteUrl: bgMatch[1],
            offsetX: Number(bgMatch[2]),
            offsetY: Number(bgMatch[3]),
            width: wMatch ? Number(wMatch[1]) : 200,
            height: hMatch ? Number(hMatch[1]) : 200,
          }
        : null,
    });
  }

  // 3. Optionally resolve direct full-resolution image URLs
  const images = [];
  if (resolveImages && pages.length > 0) {
    const targetPages =
      maxImages > 0 ? pages.slice(0, maxImages) : pages;

    // Resolve first page to acquire `showkey`, then use `showpage` JSON API for remaining pages
    const firstImg = await getPageImage(targetPages[0]);
    images.push(firstImg);

    const sharedShowkey = firstImg.showkey;
    for (let i = 1; i < targetPages.length; i++) {
      const p = targetPages[i];
      const imgData = await getPageImage({
        gid,
        page: p.page,
        imgkey: p.imgkey,
        showkey: sharedShowkey,
      });
      images.push(imgData);
    }
  }

  return {
    ...metadata,
    galleryPage,
    pageCountOnIndex: pages.length,
    pages,
    images,
  };
}

/**
 * Download the full-resolution image binary (`Buffer`) from a viewer URL or page object.
 * Automatically retries with `?nl=<reloadKey>` if the primary H@H node fails!
 *
 * @param {string|object} viewerUrlOrPageObj - Viewer URL (`/s/<imgkey>/<gid>-<page>`) or object from `getPageImage`
 * @param {string} [outputPath] - Optional file path to save the downloaded image
 */
async function downloadPageImage(viewerUrlOrPageObj, outputPath = null) {
  let pageInfo =
    viewerUrlOrPageObj && viewerUrlOrPageObj.imageUrl
      ? viewerUrlOrPageObj
      : await getPageImage(viewerUrlOrPageObj);

  let imgRes = null;
  let usedReload = false;

  try {
    imgRes = await fetch(pageInfo.imageUrl, {
      headers: {
        "User-Agent": DEFAULT_UA,
        Referer: `${CONFIG.BASE_URL}/`,
      },
    });
  } catch (err) {
    imgRes = null;
  }

  // Automatic H@H fallback reload using `nl` token if primary H@H node failed
  if ((!imgRes || !imgRes.ok) && pageInfo.reloadKey) {
    usedReload = true;
    pageInfo = await getPageImage({
      gid: pageInfo.gid,
      page: pageInfo.page,
      imgkey: pageInfo.imgkey,
      nl: pageInfo.reloadKey,
    });
    imgRes = await fetch(pageInfo.imageUrl, {
      headers: {
        "User-Agent": DEFAULT_UA,
        Referer: `${CONFIG.BASE_URL}/`,
      },
    });
  }

  if (!imgRes || !imgRes.ok) {
    throw new Error(
      `Gagal mengunduh gambar dari H@H CDN (${imgRes ? imgRes.status : "network error"}): ${
        pageInfo.imageUrl
      }`
    );
  }

  const buffer = Buffer.from(await imgRes.arrayBuffer());
  const contentType = imgRes.headers.get("content-type") || "image/webp";

  let savedTo = null;
  if (outputPath) {
    savedTo = path.resolve(outputPath);
    fs.writeFileSync(savedTo, buffer);
  }

  return {
    gid: pageInfo.gid,
    page: pageInfo.page,
    imgkey: pageInfo.imgkey,
    filename: pageInfo.filename,
    imageUrl: pageInfo.imageUrl,
    width: pageInfo.width,
    height: pageInfo.height,
    contentType,
    bytes: buffer.length,
    usedReload,
    savedTo,
    buffer,
  };
}

// ============================================================================
// CLI
// ============================================================================
const TAG_DILARANG = new Set(['lolicon', 'shotacon', 'toddlercon', 'loli', 'shota']);
const REGEX_JUDUL_DILARANG = /\b(loli(con)?|shota(con)?|toddler(con)?)\b/i;

function dilarang(item) {
  const tagList = (item.tags || []).map((t) => String(t).split(':').pop().toLowerCase().trim());
  if (tagList.some((t) => TAG_DILARANG.has(t))) return true;
  return REGEX_JUDUL_DILARANG.test(`${item.title || ''} ${item.titleJpn || ''}`);
}

const argv = process.argv.slice(2);
const flag = (nama, awal) => {
  const hit = argv.find((a) => a.startsWith(`--${nama}=`));
  return hit ? hit.split('=').slice(1).join('=') : awal;
};
const target = argv.find((a) => !a.startsWith('--'));

function bantuan() {
  console.log(`E-Hentai Node.js
  node ehentai-node.mjs "<kata kunci>"            daftar galeri
  node ehentai-node.mjs "<kata kunci>" --pick=1    download galeri hasil ke-1
  node ehentai-node.mjs <url galeri> --pages=5     download 5 halaman pertama
Opsi: --limit=10  --pages=5  --out=./ehentai`);
}

async function unduhGaleri(urlGaleri, jumlah, folderOut) {
  const detail = await getGalleryDetail(urlGaleri, { resolveImages: true, maxImages: jumlah });
  if (dilarang(detail)) throw new Error('Galeri ditolak (konten melibatkan karakter di bawah umur).');
  if (!detail.images?.length) throw new Error('Tidak ada gambar yang bisa diambil.');

  console.log(`\n[+] ${detail.title}`);
  console.log(`    ${detail.category} • ${detail.filecount} hal • ★${detail.rating}`);
  console.log(`    Tag: ${(detail.tags || []).slice(0, 12).join(', ') || '-'}`);

  const dir = path.resolve(folderOut, String(detail.gid));
  fs.mkdirSync(dir, { recursive: true });

  let ok = 0;
  for (const img of detail.images) {
    try {
      const ext = (img.filename && path.extname(img.filename)) || '.jpg';
      const out = path.join(dir, `${String(img.page).padStart(3, '0')}${ext}`);
      const dl = await downloadPageImage(img, out);
      console.log(`    hal ${img.page}: ${dl.savedTo} (${dl.bytes} bytes)`);
      ok++;
    } catch (e) {
      console.error(`    hal ${img.page}: GAGAL — ${e.message}`);
    }
  }
  console.log(`\n[+] ${ok}/${detail.images.length} halaman tersimpan di ${dir}`);
}

(async () => {
  if (!target || argv.includes('--help') || argv.includes('-h')) return bantuan();

  const limit = Math.min(25, Math.max(1, Number(flag('limit', 10))));
  const pages = Math.min(50, Math.max(1, Number(flag('pages', 5))));
  const folderOut = flag('out', './ehentai');
  const pick = flag('pick', null);

  try {
    if (/\/g\/\d+\/[a-f0-9]{10}/i.test(target)) {
      console.log(`[*] Mode galeri: ${target} (${pages} halaman)`);
      return await unduhGaleri(target, pages, folderOut);
    }

    console.log(`[*] Mencari: ${target}`);
    const hasil = await searchEhentai(target, { limit: limit + 10 });
    const aman = hasil.results.filter((r) => !r.error && !dilarang(r)).slice(0, limit);
    if (!aman.length) return console.log('[!] Tidak ada hasil.');

    console.log(`\n[+] ${hasil.totalText || `${aman.length} hasil`} (menampilkan ${aman.length}):`);
    aman.forEach((r, i) => {
      console.log(`  ${i + 1}. [${r.category}] ${r.title} (${r.filecount} hal, ★${r.rating})\n     ${r.url}`);
    });

    if (pick) {
      const item = aman[Number(pick) - 1];
      if (!item) throw new Error(`--pick=${pick} di luar daftar (1-${aman.length}).`);
      await unduhGaleri(item.url, pages, folderOut);
    }
  } catch (e) {
    console.error('\n[!] Error:', e.message);
    process.exit(1);
  }
})();
