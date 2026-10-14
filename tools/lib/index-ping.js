/**
 * tools/lib/index-ping.js
 *
 * Notifikasi mesin pencari yang BENAR-BENAR berfungsi (menggantikan pingSearchEngines() lama
 * yang memanggil endpoint yang sudah dimatikan: ping sitemap Google/Bing, pingomatic, dll).
 *
 *   - IndexNow (Bing, Yandex, Seznam, Naver — Google TIDAK ikut): POST JSON berisi URL halaman yang
 *     baru/berubah + kunci. Kunci dibuktikan lewat file teks di root situs: https://domain/<key>.txt
 *     (di repo: static/<key>.txt). Implementasi di bawah memakai api.indexnow.org.
 *   - Google: tidak ada "push URL" resmi untuk artikel biasa (Indexing API hanya untuk JobPosting /
 *     BroadcastEvent). Sinyal yang didukung adalah sitemap.xml dengan <lastmod> akurat (sudah dihasilkan
 *     Hugo dari `lastmod` di front matter) + pengiriman ulang sitemap lewat Search Console API
 *     (submitSitemapToGoogle) — itu hanya mempercepat Google membaca ulang sitemap, bukan memaksa index.
 *
 * KENAPA PING HARUS SETELAH DEPLOY: IndexNow memvalidasi kunci dengan mengunduh file kunci dari situs,
 * dan crawler langsung mengambil URL yang dikirim. Kalau situs belum ter-deploy, kunci ditolak (403/422)
 * atau halaman masih 404. Karena itu tools/ping-indexnow.js memanggil waitUntilLive() dulu.
 */

const fs     = require('fs');
const path   = require('path');
const https  = require('https');
const crypto = require('crypto');

const KEY_STATE_FILE = path.join(__dirname, '..', '..', '.indexnow-key.json');
const STATIC_DIR     = path.join(__dirname, '..', '..', 'static');

/**
 * Mengembalikan kunci IndexNow permanen situs ini. Jika belum ada, dibuat (dan file static/<key>.txt
 * ditulis). Kunci HARUS sama di setiap run — commit .indexnow-key.json dan static/<key>.txt.
 */
function ensureIndexNowKey() {
  let key;
  if (fs.existsSync(KEY_STATE_FILE)) {
    try { key = JSON.parse(fs.readFileSync(KEY_STATE_FILE, 'utf8')).key; } catch { key = null; }
  }
  if (!key || !/^[a-f0-9]{32}$/i.test(key)) {
    key = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(KEY_STATE_FILE, JSON.stringify({ key, createdAt: new Date().toISOString() }, null, 2));
    console.log(`   🔑 Kunci IndexNow baru dibuat di ${path.basename(KEY_STATE_FILE)}: ${key}`);
  }

  const keyFilePath = path.join(STATIC_DIR, `${key}.txt`);
  if (!fs.existsSync(keyFilePath)) {
    if (!fs.existsSync(STATIC_DIR)) fs.mkdirSync(STATIC_DIR, { recursive: true });
    fs.writeFileSync(keyFilePath, key); // isi file HARUS persis kunci, tanpa spasi/baris baru
    console.log(`   🔑 File kunci dibuat: static/${key}.txt — commit & deploy dulu sebelum ping akan diterima.`);
  }
  return key;
}

function httpsRequest(urlStr, { method = 'GET', headers = {}, body = null, timeoutMs = 15000, maxRedirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method,
      headers: { 'User-Agent': 'potensireadymix-indexnow/1.0', ...headers },
    }, res => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && maxRedirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, urlStr).toString();
        return resolve(httpsRequest(next, { method, headers, body, timeoutMs, maxRedirects: maxRedirects - 1 }));
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timeout ${timeoutMs / 1000}s (${urlStr})`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Menunggu sampai situs LIVE: file kunci terbaca di root DAN beberapa URL sampel mengembalikan 200.
 * Mengembalikan { live: true } atau { live: false, reason }.
 */
async function waitUntilLive(siteUrl, key, sampleUrls, { attempts = 12, delayMs = 30000 } = {}) {
  const base = siteUrl.replace(/\/$/, '');
  let reason = 'belum dicek';
  for (let i = 1; i <= attempts; i++) {
    try {
      const k = await httpsRequest(`${base}/${key}.txt`);
      if (k.statusCode !== 200 || k.body.trim() !== key) {
        reason = `file kunci ${base}/${key}.txt belum live (HTTP ${k.statusCode})`;
      } else {
        reason = null;
        for (const u of sampleUrls) {
          const r = await httpsRequest(u);
          if (r.statusCode !== 200) { reason = `URL sampel belum live: ${u} (HTTP ${r.statusCode})`; break; }
        }
      }
    } catch (err) {
      reason = `gagal mengakses situs: ${err.message}`;
    }
    if (!reason) return { live: true };
    if (i < attempts) {
      console.log(`   ⏳ (${i}/${attempts}) ${reason} — tunggu ${delayMs / 1000}s...`);
      await sleep(delayMs);
    }
  }
  return { live: false, reason };
}

/**
 * Mengirim `urls` (URL halaman penuh, host sama dengan siteUrl — BUKAN URL sitemap) ke IndexNow,
 * dipecah per 1000 URL. Mengembalikan { sent: [url,...], failed: [url,...], stopped: bool }.
 * Kode status: 200 OK, 202 diterima (validasi kunci menyusul), 400 format salah, 403 kunci tidak valid
 * / file kunci tidak terbaca, 422 URL bukan milik host / kunci tidak cocok, 429 terlalu banyak request.
 */
async function submitToIndexNow(siteUrl, urls) {
  const result = { sent: [], failed: [], stopped: false };
  if (!urls || !urls.length) return result;

  const key = ensureIndexNowKey();
  const base = siteUrl.replace(/\/$/, '');
  const host = new URL(base).host;
  const keyLocation = `${base}/${key}.txt`;

  for (let i = 0; i < urls.length; i += 1000) {
    const chunk = urls.slice(i, i + 1000);
    const payload = JSON.stringify({ host, key, keyLocation, urlList: chunk });
    try {
      const { statusCode, body } = await httpsRequest('https://api.indexnow.org/indexnow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) },
        body: payload,
        timeoutMs: 20000,
      });
      if (statusCode === 200 || statusCode === 202) {
        console.log(`   ✅ IndexNow: ${chunk.length} URL dikirim ke Bing/Yandex/Seznam/Naver (HTTP ${statusCode}).`);
        result.sent.push(...chunk);
      } else {
        console.warn(`   ⚠️  IndexNow HTTP ${statusCode}: ${String(body).slice(0, 200)}`);
        result.failed.push(...chunk);
        if ([403, 422, 429].includes(statusCode)) { result.stopped = true; result.failed.push(...urls.slice(i + 1000)); break; }
      }
    } catch (err) {
      console.warn(`   ⚠️  IndexNow gagal: ${err.message}`);
      result.failed.push(...chunk);
      result.stopped = true;
      result.failed.push(...urls.slice(i + 1000));
      break;
    }
  }
  return result;
}

/**
 * OPSIONAL: kirim ulang sitemap ke Google lewat Search Console API (sitemaps.submit).
 * Butuh service account (GSC_CREDENTIALS) yang berstatus "Full" (bukan Restricted) di Search Console.
 * Tidak fatal bila gagal.
 */
async function submitSitemapToGoogle(propertyUrl, sitemapUrl, credentials) {
  try {
    if (!credentials || !credentials.client_email || !credentials.private_key) {
      return { ok: false, skipped: true, reason: 'GSC_CREDENTIALS tidak ada' };
    }
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      iss: credentials.client_email,
      scope: 'https://www.googleapis.com/auth/webmasters',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now, exp: now + 3600,
    })).toString('base64url');
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(`${header}.${payload}`);
    const jwt = `${header}.${payload}.${sign.sign(credentials.private_key, 'base64url')}`;
    const form = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
    const tok = await httpsRequest('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(form) },
      body: form,
    });
    const access = JSON.parse(tok.body).access_token;
    if (!access) return { ok: false, reason: `token ditolak (HTTP ${tok.statusCode})` };

    const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(propertyUrl)}/sitemaps/${encodeURIComponent(sitemapUrl)}`;
    const r = await httpsRequest(url, { method: 'PUT', headers: { Authorization: `Bearer ${access}`, 'Content-Length': 0 } });
    if (r.statusCode >= 200 && r.statusCode < 300) {
      console.log(`   ✅ Google Search Console: sitemap dikirim ulang (${sitemapUrl}).`);
      return { ok: true };
    }
    const hint = r.statusCode === 403 ? ' — service account perlu izin "Full" di Search Console untuk properti ini.' : '';
    console.warn(`   ⚠️  Kirim ulang sitemap ke Google gagal (HTTP ${r.statusCode})${hint} ${String(r.body).slice(0, 150)}`);
    return { ok: false, reason: `HTTP ${r.statusCode}` };
  } catch (err) {
    console.warn(`   ⚠️  Kirim ulang sitemap ke Google gagal: ${err.message}`);
    return { ok: false, reason: err.message };
  }
}

module.exports = { submitToIndexNow, ensureIndexNowKey, waitUntilLive, submitSitemapToGoogle, httpsRequest };
