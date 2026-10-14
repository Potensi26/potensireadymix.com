/**
 * tools/ping-indexnow.js
 *
 * Mengirim URL artikel yang BARU / BERUBAH ke IndexNow (Bing, Yandex, Seznam, Naver) SETELAH situs
 * ter-deploy, dan (opsional) mengirim ulang sitemap ke Google lewat Search Console.
 *
 * CARA KERJA (tidak bergantung workflow mana yang mengubah konten):
 *   1. Membaca semua content/**.md (kecuali draft, tanggal masa depan, _index.md, folder home/page/promo/subheader).
 *   2. Tiap halaman punya "stempel" = lastmod (jika ada) atau date. Stempel dibandingkan dengan catatan
 *      .indexnow-submitted.json. Yang stempelnya baru/berbeda = perlu dikirim. Artikel hasil generate,
 *      revisi, sisip link orphan, dan recycle semuanya menaikkan date/lastmod, jadi otomatis terdeteksi.
 *   3. Menunggu sampai file kunci + URL sampel benar-benar LIVE (deploy selesai). Kalau belum live,
 *      keluar tanpa mengubah catatan — run berikutnya mencoba lagi.
 *   4. Kirim ke IndexNow (maks --limit per run, terbaru dulu; sisanya menyusul di run berikutnya),
 *      lalu catat yang sukses ke .indexnow-submitted.json.
 *
 * USAGE:
 *   node tools/ping-indexnow.js --dry-run         → hanya tampilkan URL yang akan dikirim
 *   node tools/ping-indexnow.js                   → kirim (maks 500 URL)
 *   node tools/ping-indexnow.js --limit=200 --no-google --no-wait
 *   node tools/ping-indexnow.js --all             → abaikan catatan, kirim ulang semua (hati-hati)
 * ENV (opsional): GSC_CREDENTIALS, GSC_SITE_URL → kirim ulang sitemap ke Google.
 */

const fs   = require('fs');
const path = require('path');
const { submitToIndexNow, ensureIndexNowKey, waitUntilLive, submitSitemapToGoogle } = require('./lib/index-ping.js');

const ARGS     = process.argv.slice(2);
const DRY      = ARGS.includes('--dry-run');
const ALL      = ARGS.includes('--all');
const NO_WAIT  = ARGS.includes('--no-wait');
const NO_GOOGLE = ARGS.includes('--no-google');
const LIMIT    = parseInt((ARGS.find(a => a.startsWith('--limit=')) || '').replace('--limit=', ''), 10) || 500;
const DIR_ARG  = (ARGS.find(a => a.startsWith('--dir=')) || '--dir=content').replace('--dir=', '');

const ROOT        = path.join(__dirname, '..');
const CONTENT_DIR = path.join(ROOT, DIR_ARG);
const STATE_FILE  = path.join(ROOT, '.indexnow-submitted.json');
const EXCLUDED_TOP = new Set(['home', 'page', 'promo', 'subheader']);

function getSiteUrl() {
  for (const f of ['hugo.toml', 'config.toml']) {
    try {
      const m = fs.readFileSync(path.join(ROOT, f), 'utf8').match(/^baseURL\s*=\s*["']([^"']+)["']/m);
      if (m) return m[1].replace(/\/$/, '');
    } catch {}
  }
  return 'https://potensireadymix.com';
}

// Front matter YAML (---) atau TOML (+++): ambil nilai skalar sederhana.
function readMeta(raw) {
  const m = raw.match(/^(---|\+\+\+)\r?\n([\s\S]*?)\r?\n\1/);
  if (!m) return null;
  const block = m[2];
  const get = key => {
    const r = block.match(new RegExp(`^${key}\\s*[:=]\\s*["']?([^"'\\r\\n]*?)["']?\\s*$`, 'm'));
    return r ? r[1].trim() : '';
  };
  return { draft: /^draft\s*[:=]\s*true/m.test(block), date: get('date'), lastmod: get('lastmod'), url: get('url') };
}

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (dir === CONTENT_DIR && EXCLUDED_TOP.has(e.name)) continue;
      walk(full, out);
    } else if (e.isFile() && e.name.endsWith('.md') && e.name !== '_index.md') out.push(full);
  }
  return out;
}

function collectPages() {
  const now = Date.now();
  const pages = [];
  for (const file of walk(CONTENT_DIR)) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const meta = readMeta(raw);
    if (!meta || meta.draft) continue;
    const dateMs = Date.parse(meta.date);
    if (isNaN(dateMs) || dateMs > now) continue;      // tanpa tanggal / terjadwal masa depan: Hugo tidak menerbitkan
    const rel = path.relative(CONTENT_DIR, file).replace(/\\/g, '/').replace(/\.md$/, '');
    const urlPath = meta.url ? (meta.url.startsWith('/') ? meta.url : `/${meta.url}`) : `/${rel}/`;
    const lastMs = Date.parse(meta.lastmod);
    pages.push({ urlPath, stamp: meta.lastmod || meta.date, sortMs: isNaN(lastMs) ? dateMs : Math.max(lastMs, dateMs) });
  }
  return pages;
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { urls: {} }; }
}

async function main() {
  const site = getSiteUrl();
  console.log(`\n📡 IndexNow ping — ${site} ${DRY ? '[DRY-RUN]' : ''}`);
  console.log('─'.repeat(55));

  const state = loadState();
  const pages = collectPages();
  const pending = pages
    .filter(p => ALL || state.urls[p.urlPath] !== p.stamp)
    .sort((a, b) => b.sortMs - a.sortMs);

  console.log(`📁 ${pages.length} halaman terbit, ${pending.length} baru/berubah sejak ping terakhir.`);
  if (!pending.length) { console.log('✅ Tidak ada yang perlu dikirim.'); return; }

  const batch = pending.slice(0, LIMIT);
  if (pending.length > LIMIT) console.log(`   (dibatasi ${LIMIT} URL per run; ${pending.length - LIMIT} sisanya menyusul di run berikutnya)`);

  // Halaman daftar (beranda & indeks seksi) ikut dikirim karena isinya ikut berubah.
  const listPaths = new Set(['/']);
  batch.forEach(p => { const seg = p.urlPath.split('/').filter(Boolean)[0]; if (seg && p.urlPath.split('/').filter(Boolean).length > 1) listPaths.add(`/${seg}/`); });
  const urlList = [...new Set([...batch.map(p => p.urlPath), ...listPaths])].map(p => site + p);

  if (DRY) {
    console.log(`\n🧪 DRY-RUN — ${urlList.length} URL akan dikirim:`);
    urlList.slice(0, 30).forEach(u => console.log(`   • ${u}`));
    if (urlList.length > 30) console.log(`   ... +${urlList.length - 30} lainnya`);
    return;
  }

  const key = ensureIndexNowKey();
  if (!NO_WAIT) {
    console.log('\n⏳ Memastikan situs sudah live (file kunci + URL sampel)...');
    const sample = batch.slice(0, 3).map(p => site + p.urlPath);
    const live = await waitUntilLive(site, key, sample);
    if (!live.live) {
      console.warn(`\n⚠️  Situs belum live: ${live.reason}`);
      console.warn('   Tidak ada yang dikirim & catatan tidak diubah — akan dicoba lagi di run berikutnya.');
      console.warn(`   Pastikan static/${key}.txt sudah di-commit dan ter-deploy.`);
      return;
    }
    console.log('   ✅ Situs live.');
  }

  const res = await submitToIndexNow(site, urlList);
  const sentSet = new Set(res.sent);
  let recorded = 0;
  for (const p of batch) {
    if (sentSet.has(site + p.urlPath)) { state.urls[p.urlPath] = p.stamp; recorded++; }
  }
  if (recorded) {
    const sorted = {};
    Object.keys(state.urls).sort().forEach(k => { sorted[k] = state.urls[k]; });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), urls: sorted }, null, 2));
  }
  console.log(`\n📝 ${recorded} halaman dicatat sebagai sudah dikirim (${res.failed.length} gagal/ditunda).`);

  if (!NO_GOOGLE && process.env.GSC_CREDENTIALS) {
    let creds = {};
    try { creds = JSON.parse(process.env.GSC_CREDENTIALS); } catch {}
    await submitSitemapToGoogle(process.env.GSC_SITE_URL || `${site}/`, `${site}/sitemap.xml`, creds);
  }
}

main().catch(err => { console.error('\n💥 Fatal error:', err.message); process.exit(1); });
