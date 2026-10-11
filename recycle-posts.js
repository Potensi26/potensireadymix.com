const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const axios = require('axios');
const toml = require('toml');

const contentDir = path.join(__dirname, 'content');
const configPath = path.join(__dirname, 'config.toml');
const now = new Date();

// Ambil baseURL langsung dari config.toml, agar tidak ada domain yang
// ketinggalan / salah ketik saat theme dipakai ulang di domain lain.
function getBaseUrl() {
  const configContent = fs.readFileSync(configPath, 'utf-8');
  const config = toml.parse(configContent);
  return config.baseURL.endsWith('/') ? config.baseURL.slice(0, -1) : config.baseURL;
}

// Daftar layanan ping
const pingServices = [
  'http://ping.googleapis.com/ping?sitemap=',
  'http://www.bing.com/ping?sitemap=',
  'http://www.sitemaps.org/ping?sitemap=',
];

// Fungsi untuk melakukan ping (dipanggil dengan await di main)
async function pingSearchEngines(sitemapUrl) {
  for (const service of pingServices) {
    try {
      await axios.get(`${service}${encodeURIComponent(sitemapUrl)}`, { timeout: 5000 });
      console.log(`Berhasil melakukan ping ke ${service}`);
    } catch (error) {
      console.error(`Gagal melakukan ping ke ${service}:`, error.message);
    }
  }
}

// Fungsi untuk memeriksa dan memperbarui artikel — mendukung subdirektori rekursif
function getMarkdownFiles(dir) {
  let results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(getMarkdownFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(fullPath);
    }
  }
  return results;
}

function recyclePost(filePath) {
  const fileContent = fs.readFileSync(filePath, 'utf8');
  const { data, content } = matter(fileContent);

  if (!data.date) return false;

  const postDate = new Date(data.date);
  const monthsDiff =
    (now.getFullYear() - postDate.getFullYear()) * 12 +
    now.getMonth() - postDate.getMonth();

  if (monthsDiff >= 12) {
    data.date = now.toISOString().split('T')[0];
    const updatedContent = matter.stringify(content, data);
    fs.writeFileSync(filePath, updatedContent);
    return true;
  }

  return false;
}

// Main async — agar pingSearchEngines bisa di-await dengan benar
async function main() {
  const allFiles = getMarkdownFiles(contentDir);
  let updatedCount = 0;

  for (const filePath of allFiles) {
    if (recyclePost(filePath)) {
      updatedCount++;
      console.log(`Diperbarui: ${filePath}`);
    }
  }

  if (updatedCount > 0) {
    console.log(`${updatedCount} artikel telah diperbarui.`);
    // Hugo build dilakukan di npm run build (via build:recycle), bukan di sini
    // agar tidak terjadi double-build dan flag --minify tetap teraplikasi
    const sitemapUrl = `${getBaseUrl()}/sitemap.xml`;
    await pingSearchEngines(sitemapUrl);
  } else {
    console.log('Tidak ada artikel yang perlu diperbarui.');
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});