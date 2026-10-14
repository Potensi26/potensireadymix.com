/**
 * tools/lib/greeting.js
 *
 * Menjamin sapaan khas situs "Sahabat Potensi" SELALU ada di paragraf pertama artikel.
 * Prompt AI saja tidak cukup (model kadang lupa), jadi ini dijalankan sebagai jaring pengaman
 * deterministik setelah artikel dihasilkan, dan oleh tools/fix-greeting.js untuk artikel lama.
 *
 * Aturan:
 *   - Paragraf pertama = teks dari baris pertama sampai baris kosong pertama.
 *   - Kalau paragraf pertama sudah memuat "Sahabat Potensi" → tidak diubah.
 *   - Kalau belum → disisipkan tepat setelah pola pembuka "**Judul** – " sebagai "Sahabat Potensi, ..."
 *     dan huruf pertama kalimat berikutnya diturunkan menjadi huruf kecil (kecuali nama diri / singkatan),
 *     sehingga kalimat tetap gramatikal, mis.:
 *       "Tahukah Anda bahwa ..."  →  "Sahabat Potensi, tahukah Anda bahwa ..."
 *   - Paragraf pertama yang bukan prosa (gambar, heading, tabel, shortcode, daftar) tidak disentuh.
 */

const GREETING = 'Sahabat Potensi';

// Kata pembuka yang tetap berhuruf kapital (nama diri / kata ganti gaya situs ini).
const KEEP_CAPITAL = new Set([
  'Potensi', 'Kami', 'Anda', 'Bapak', 'Ibu', 'Indonesia', 'Bogor', 'Jakarta', 'Depok', 'Bekasi', 'Tangerang',
  'Jabodetabek', 'Sukabumi', 'Cianjur', 'Karawang', 'Cibinong', 'Jawa', 'Barat', 'Cilebut', 'Adhimix',
  'Jayamix', 'Holcim', 'Readymix', 'Sahabat',
]);

const OPENER_RE = /^(\*\*[^*\n]+\*\*\s*[–—-]\s*)/;

function splitFirstParagraph(body) {
  const m = body.match(/^(\s*)([\s\S]*?)(\r?\n[ \t]*\r?\n|$)([\s\S]*)$/);
  return { lead: m[1], first: m[2], sep: m[3], rest: m[4] };
}

function lowerFirstWord(sentence) {
  const m = sentence.match(/^([A-Z][a-z]+)(\b[\s\S]*)$/);
  if (!m) return sentence;                 // singkatan (SNI, K-225), angka, atau sudah huruf kecil
  if (KEEP_CAPITAL.has(m[1])) return sentence;
  return m[1].toLowerCase() + m[2];
}

/**
 * @returns {{ body: string, changed: boolean, reason?: string }}
 */
function ensureGreetingInOpening(body) {
  const { lead, first, sep, rest } = splitFirstParagraph(body);
  if (!first.trim()) return { body, changed: false, reason: 'artikel kosong' };
  if (first.includes(GREETING)) return { body, changed: false };

  // Bukan prosa biasa → jangan disentuh.
  if (/^(!\[|#|<|\{\{|\||[-*+]\s|\d+\.\s)/.test(first.trimStart()) && !OPENER_RE.test(first)) {
    return { body, changed: false, reason: 'paragraf pertama bukan prosa' };
  }

  const om = first.match(OPENER_RE);
  const opener = om ? om[1] : '';
  const sentence = first.slice(opener.length).trimStart();
  if (!sentence) return { body, changed: false, reason: 'tidak ada kalimat setelah judul' };

  const newFirst = `${opener}${GREETING}, ${lowerFirstWord(sentence)}`;
  return { body: `${lead}${newFirst}${sep}${rest}`, changed: true };
}

function greetingInFirstParagraph(body) {
  return splitFirstParagraph(body).first.includes(GREETING);
}

module.exports = { GREETING, ensureGreetingInOpening, greetingInFirstParagraph, splitFirstParagraph };
