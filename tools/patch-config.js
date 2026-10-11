/**
 * tools/patch-config.js  — jalankan SEKALI: node tools/patch-config.js
 *
 * Menambahkan ke config.toml dan hugo.toml (yang ada di root repo), tanpa mengubah isi lain:
 *   1. [markup.goldmark.renderer] unsafe = true
 *      (dibutuhkan tools/lib/safe-table.js — tabel buatan AI dirender sebagai HTML mentah)
 *   2. Menu "Blog" -> /blog/ (Promo digeser ke weight 8 supaya Blog tampil sebelum Promo)
 * Aman dijalankan berulang kali (idempoten).
 */
const fs = require('fs');
const path = require('path');

for (const name of ['config.toml', 'hugo.toml']) {
  const file = path.join(__dirname, '..', name);
  if (!fs.existsSync(file)) continue;
  let s = fs.readFileSync(file, 'utf8');
  let changed = false;

  if (!/\[markup\.goldmark\.renderer\]/.test(s)) {
    s = s.replace(/\s*$/, '\n') +
      '\n  # Dibutuhkan tools/lib/safe-table.js: tabel buatan AI dirender sebagai HTML mentah.\n' +
      '[markup.goldmark.renderer]\n  unsafe = true\n';
    changed = true;
  }

  if (!/url\s*=\s*"\/blog\/"/.test(s)) {
    s = s.replace(/(name\s*=\s*"Promo"\s*\n\s*url\s*=\s*"\/promo\/"\s*\n\s*weight\s*=\s*)7/, '$18');
    s = s.replace(/\s*$/, '\n') +
      '\n[[menu.main]]\n  name   = "Blog"\n  url    = "/blog/"\n  weight = 7\n';
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(file, s);
    console.log(`✅ ${name} diperbarui.`);
  } else {
    console.log(`ℹ️  ${name} sudah lengkap — tidak ada perubahan.`);
  }
}
