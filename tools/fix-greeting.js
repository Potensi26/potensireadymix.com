/**
 * fix-greeting.js
 *
 * Memperbaiki artikel LAMA yang paragraf pertamanya belum memuat sapaan "Sahabat Potensi"
 * (aturan ada di lib/greeting.js). Hanya paragraf pertama yang diubah; front matter dan isi lain
 * tetap identik — kecuali `lastmod`, yang dinaikkan ke hari ini agar sitemap & label "Diperbarui"
 * mencerminkan perubahan (lalu otomatis ikut dikirim ke IndexNow oleh workflow indexnow.yml).
 *
 * USAGE:
 *   node tools/fix-greeting.js                    → DRY-RUN: tampilkan artikel yang akan diubah
 *   node tools/fix-greeting.js --apply            → tulis perubahan ke file
 *   node tools/fix-greeting.js --dir=content/info → folder lain (default: content/blog)
 *   node tools/fix-greeting.js --no-lastmod       → jangan ubah lastmod
 * Tanpa dependensi npm (hanya modul bawaan Node).
 */

const fs   = require('fs');
const path = require('path');
const { ensureGreetingInOpening } = require('./lib/greeting.js');
const { splitFrontMatter, setLastmod } = require('./lib/orphan-link.js');

const ARGS = process.argv.slice(2);
const APPLY = ARGS.includes('--apply');
const NO_LASTMOD = ARGS.includes('--no-lastmod');
const DIR_ARG = (ARGS.find(a => a.startsWith('--dir=')) || '--dir=content/blog').replace('--dir=', '');
const DIR = path.join(process.cwd(), DIR_ARG);

function walk(dir) {
  let out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(full));
    else if (e.name.endsWith('.md') && e.name !== '_index.md') out.push(full);
  }
  return out;
}

const today = new Date().toISOString().split('T')[0];
let scanned = 0, changed = 0, skipped = 0;

console.log(`\n👋 fix-greeting — pastikan "Sahabat Potensi" ada di paragraf pertama`);
console.log(`   Folder : ${DIR}`);
console.log(`   Mode   : ${APPLY ? 'APPLY (menulis file)' : 'DRY-RUN (hanya pratinjau)'}`);
console.log('─'.repeat(60));

for (const file of walk(DIR)) {
  const raw = fs.readFileSync(file, 'utf8');
  const fm = splitFrontMatter(raw);
  if (!fm) { skipped++; continue; }
  if (/^draft:\s*true/m.test(fm.rawMatter)) { skipped++; continue; }
  scanned++;

  const res = ensureGreetingInOpening(fm.body);
  if (!res.changed) {
    if (res.reason) { console.log(`⚠️  ${path.relative(process.cwd(), file)} — dilewati (${res.reason})`); skipped++; }
    continue;
  }
  changed++;
  const rel = path.relative(process.cwd(), file);
  const firstOf = b => b.trimStart().split(/\r?\n[ \t]*\r?\n/)[0];
  console.log(`✏️  ${rel}`);
  console.log(`   sebelum: ${firstOf(fm.body).slice(0, 170)}…`);
  console.log(`   sesudah: ${firstOf(res.body).slice(0, 190)}…`);

  if (APPLY) {
    const matter = NO_LASTMOD ? fm.rawMatter : setLastmod(fm.rawMatter, today);
    fs.writeFileSync(file, `---${matter}\n---\n${res.body}`);
  }
}

console.log('─'.repeat(60));
console.log(`📄 Diperiksa: ${scanned} | ${APPLY ? 'Diperbaiki' : 'Akan diperbaiki'}: ${changed} | Dilewati: ${skipped}`);
if (!APPLY && changed) console.log('ℹ️  Dry-run — jalankan ulang dengan --apply untuk menulis perubahan.');
