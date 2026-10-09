'use strict';

/**
 * Import / refresh all parishes of one diocese from the live directory.mosc.in list page
 * (https://directory.mosc.in/parishes/?diocese=<id>) into api::parish.parish.
 *
 * - Runs for every local tenant that has a diocese with the page's diocese name
 *   (or only --tenants=a,b).
 * - Existing parishes (same tenant + diocese) are matched by exact name in page order,
 *   then by normalized name; matched rows get address/phones/email refreshed.
 * - Unmatched site parishes are created. Nothing is deleted.
 *
 * Usage (stop local Strapi first):
 *   node scripts/import-parishes-from-directory-mosc-in.js --diocese=179 --dry-run --verbose
 *   node scripts/import-parishes-from-directory-mosc-in.js --diocese=179
 *   node scripts/import-parishes-from-directory-mosc-in.js --diocese=179,250 --tenants=mosc_malankara_orthodox_2
 *   node scripts/import-parishes-from-directory-mosc-in.js --diocese=all
 *   --skip-images   do not upload site photos (photos only fill parishes without an image)
 *
 * npm: npm run import:parishes-directory-mosc-in -- --diocese=all
 */

try {
  require('dotenv').config();
} catch (_) {}

const fs = require('fs');
const os = require('os');
const path = require('path');
const cheerio = require('cheerio');
const { loadStrapiApp } = require('./lib/load-strapi-app');

const LIVE_BASE = 'https://directory.mosc.in';
const PARISH_UID = 'api::parish.parish';
const DIOCESE_UID = 'api::diocese.diocese';

function argValue(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=').trim() : null;
}

const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');
const SKIP_IMAGES = process.argv.includes('--skip-images');
const DIOCESE_ID = argValue('diocese') || '179';
const TENANT_FILTER = (argValue('tenants') || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const FOREIGN_COUNTRIES = [
  'Qatar',
  'Kuwait',
  'Bahrain',
  'Oman',
  'UAE',
  'United Arab Emirates',
  'Saudi Arabia',
  'USA',
  'UK',
  'Canada',
  'Australia',
];
const INDIAN_STATES = [
  'Maharashtra',
  'Gujarat',
  'Karnataka',
  'Goa',
  'Kerala',
  'Tamil Nadu',
  'Delhi',
  'West Bengal',
  'Madhya Pradesh',
  'Dadra and Nagar Haveli',
];

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function cleanText(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function afterColon(value) {
  return cleanText(value).replace(/^:\s*/, '').trim();
}

const GENERIC_PLACE_WORDS = new Set([
  'road',
  'nagar',
  'colony',
  'marg',
  'compound',
  'complex',
  'highway',
  'village',
  'section',
  'post',
  'box',
  'opp',
  'opp.',
  'near',
  'east',
  'west',
]);

/** Best-effort locality: last comma segment before the PIN, minus state/country/district/direction noise. */
function deriveCity(line, pinText, state, country) {
  let text = pinText ? line.slice(0, line.lastIndexOf(pinText)) : line;
  for (const word of [state, country !== 'India' ? country : null].filter(Boolean)) {
    text = text.replace(new RegExp(`\\b${word}\\b`, 'gi'), '');
  }
  const segments = text
    .split(',')
    .map((s) =>
      s
        .replace(/\(\s*[ew]\s*\)|\b[ew]\)/gi, '')
        .replace(/[\s–-]+$/g, '')
        .trim(),
    )
    .filter((s) => s && !/\bdistrict\b/i.test(s));
  const segment = segments[segments.length - 1];
  if (!segment) return null;
  const words = segment.split(/\s+/);
  if (/navi mumbai$/i.test(segment)) return 'Navi Mumbai';
  const last = words[words.length - 1];
  if (words.length > 1 && GENERIC_PLACE_WORDS.has(last.toLowerCase())) return words.slice(-2).join(' ');
  return /[a-z]/i.test(last) ? last : null;
}

function parseAddress(lines) {
  if (!lines.length) return {};
  const full = lines.join('\n');
  const pinMatches = [...full.matchAll(/\b(\d{3})\s?(\d{3})\b/g)];
  const pin = pinMatches.length ? pinMatches[pinMatches.length - 1] : null;
  const postalCode = pin ? `${pin[1]}${pin[2]}` : null;

  const country = FOREIGN_COUNTRIES.find((c) => new RegExp(`\\b${c}\\b`, 'i').test(full)) || 'India';
  const state = INDIAN_STATES.find((s) => new RegExp(`\\b${s}\\b`, 'i').test(full)) || null;
  const cityLine = pin ? lines.find((l) => l.includes(pin[0])) || lines[lines.length - 1] : lines[lines.length - 1];
  const city = deriveCity(cityLine, pin?.[0], state, country);

  return {
    address: full,
    addressLine1: lines[0],
    addressLine2: lines.length >= 3 ? lines.slice(1, -1).join(', ') : null,
    city,
    state,
    postalCode,
    country,
  };
}

function parseListPage(html) {
  const $ = cheerio.load(html);
  const dioceseName = $('h1')
    .map((_, el) => cleanText($(el).text()))
    .get()
    .find((t) => t && !/^(address info|login only for admin)$/i.test(t));

  const items = [];
  $('article').each((_, el) => {
    const art = $(el);
    const name = cleanText(art.find('h3').first().text());
    if (!name) return;
    const href = art.find('a[href*="/parishes/"]').first().attr('href') || '';
    const siteSlug = (href.match(/\/parishes\/([^/?#]+)/) || [])[1] || null;

    let phones = [];
    let email = null;
    let addressLines = [];
    art.find('p').each((__, p) => {
      const $p = $(p);
      if ($p.find('.glyphicon-earphone').length) {
        phones = $p
          .find('a[href^="tel:"]')
          .map((___, a) => cleanText($(a).text()))
          .get()
          .filter(Boolean);
        if (!phones.length) {
          phones = afterColon($p.text()).split(/[,/]/).map(cleanText).filter(Boolean);
        }
      } else if ($p.find('.glyphicon-envelope').length) {
        const found = afterColon($p.text()).match(/[^\s,;]+@[^\s,;]+/);
        email = found ? found[0] : null;
      } else if (!$p.find('.glyphicon').length) {
        addressLines = ($p.html() || '')
          .split(/<br\s*\/?>/i)
          .map((part) => cleanText(cheerio.load(`<div>${part}</div>`)('div').text()))
          .filter(Boolean);
      }
    });

    let imageUrl = art.find('img').first().attr('src') || null;
    if (imageUrl && /default-logo|default-image|parish\.jpg/i.test(imageUrl)) imageUrl = null;

    items.push({
      name,
      siteSlug,
      phones,
      email,
      imageUrl,
      ...parseAddress(addressLines),
    });
  });
  return { dioceseName, items };
}

function asList(result) {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  return result.results ?? result.data ?? [];
}

function matchExisting(items, existing) {
  const unused = [...existing];
  const take = (pred) => {
    const idx = unused.findIndex(pred);
    return idx >= 0 ? unused.splice(idx, 1)[0] : null;
  };
  const matches = new Map();
  for (const item of items) {
    const hit = take((e) => cleanText(e.name) === item.name);
    if (hit) matches.set(item, hit);
  }
  for (const item of items) {
    if (matches.has(item)) continue;
    const hit = take((e) => normalizeName(e.name) === normalizeName(item.name));
    if (hit) matches.set(item, hit);
  }
  return { matches, leftover: unused };
}

async function uniqueSlug(app, base, taken) {
  let slug = base;
  for (let n = 2; ; n++) {
    if (!taken.has(slug)) {
      const clash = await app.db.query(PARISH_UID).findOne({ where: { slug }, select: ['id'] });
      if (!clash) break;
    }
    slug = `${base}-${n}`;
  }
  taken.add(slug);
  return slug;
}

function detailFields(item) {
  return {
    address: item.address || null,
    addressLine1: item.addressLine1 || null,
    addressLine2: item.addressLine2 || null,
    city: item.city || null,
    state: item.state || null,
    postalCode: item.postalCode || null,
    country: item.country || null,
    email: item.email || null,
    phones: item.phones.length ? item.phones.join(', ') : null,
    phoneSecondary: item.phones[1] || null,
  };
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

/** Diocese ids from --diocese=179,250 or every option in the site's diocese dropdown (--diocese=all). */
async function resolveDioceseIds() {
  if (DIOCESE_ID !== 'all')
    return DIOCESE_ID.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  const $ = cheerio.load(await fetchText(`${LIVE_BASE}/parishes/`));
  const ids = $('select option')
    .map((_, o) => $(o).attr('value'))
    .get()
    .filter((v) => /^\d+$/.test(v || ''));
  return [...new Set(ids)];
}

const uploadedFileIdByUrl = new Map();

/** Earlier imports stored the site's default logo as the parish image; a real photo should replace it. */
function isPlaceholderImage(image) {
  return /default[-_]logo|default[-_]image/i.test(`${image?.name || ''} ${image?.url || ''}`);
}

/** Upload a site photo once (full size if available, else the 150x150 thumbnail); returns upload file id. */
async function uploadParishImage(app, thumbUrl, altText) {
  if (uploadedFileIdByUrl.has(thumbUrl)) return uploadedFileIdByUrl.get(thumbUrl);
  const fullUrl = thumbUrl.replace(/-\d+x\d+(\.\w+)$/, '$1');
  const candidates = [...new Set([fullUrl, thumbUrl].flatMap((u) => [u.replace(/^http:/, 'https:'), u]))];
  let fileId = null;
  for (const candidate of candidates) {
    const res = await fetch(candidate).catch(() => null);
    const type = res?.headers.get('content-type') || '';
    if (!res?.ok || !type.startsWith('image/')) continue;
    const buffer = Buffer.from(await res.arrayBuffer());
    const baseName = decodeURIComponent(path.basename(new URL(candidate).pathname)).replace(/[^a-zA-Z0-9._-]/g, '_');
    const tempPath = path.join(os.tmpdir(), `parish-${Date.now()}-${baseName}`);
    fs.writeFileSync(tempPath, buffer);
    try {
      const [file] = await app
        .plugin('upload')
        .service('upload')
        .upload({
          data: { fileInfo: { name: baseName, alternativeText: altText, caption: altText } },
          files: {
            filepath: tempPath,
            originalFilename: baseName,
            originalFileName: baseName,
            mimetype: type.split(';')[0],
            size: buffer.length,
          },
        });
      fileId = file?.id ?? null;
    } catch (err) {
      console.warn(`  Image upload failed (${candidate}): ${err.message}`);
    } finally {
      fs.rmSync(tempPath, { force: true });
    }
    if (fileId) break;
  }
  uploadedFileIdByUrl.set(thumbUrl, fileId);
  return fileId;
}

/** Strapi 5 Document Service rejects connect for media fields, so link through the morph table. */
async function linkParishImage(app, parishDocumentId, fileId) {
  const row = await app.db.query(PARISH_UID).findOne({ where: { documentId: parishDocumentId }, select: ['id'] });
  if (!row?.id) return false;
  const knex = app.db.connection;
  const where = { related_id: row.id, related_type: PARISH_UID, field: 'image' };
  await knex('files_related_mph').where(where).del();
  await knex('files_related_mph').insert({ ...where, file_id: fileId, order: 1 });
  return true;
}

async function main() {
  console.log('Import parishes from directory.mosc.in');
  console.log('  Dry run:', DRY_RUN);
  const dioceseIds = await resolveDioceseIds();
  console.log(`  Dioceses: ${dioceseIds.length} (${dioceseIds.join(', ')})`);

  const totals = { created: 0, updated: 0, kept: 0, images: 0, failedDioceses: [] };
  const takenSlugs = new Set();
  const app = await loadStrapiApp();
  try {
    for (const dioceseId of dioceseIds) {
      try {
        await importDiocese(app, dioceseId, takenSlugs, totals);
      } catch (err) {
        totals.failedDioceses.push(dioceseId);
        console.error(`  Diocese ${dioceseId} failed: ${err.message}`);
      }
      if (dioceseIds.length > 1) await new Promise((r) => setTimeout(r, 400));
    }
  } finally {
    await app.destroy();
  }
  console.log(
    `\nTotal: created=${totals.created} updated=${totals.updated} imagesLinked=${totals.images} keptUnmatched=${totals.kept} failedDioceses=${totals.failedDioceses.join(',') || 'none'}`,
  );
  if (totals.failedDioceses.length) process.exitCode = 1;
}

async function importDiocese(app, dioceseId, takenSlugs, totals) {
  const url = `${LIVE_BASE}/parishes/?diocese=${encodeURIComponent(dioceseId)}`;
  const { dioceseName, items } = parseListPage(await fetchText(url));
  if (!dioceseName) throw new Error(`Could not read diocese name from ${url}`);
  console.log(
    `\n== ${dioceseName} (site ${dioceseId}) | parishes=${items.length} phone=${items.filter((i) => i.phones.length).length} email=${items.filter((i) => i.email).length} PIN=${items.filter((i) => i.postalCode).length} image=${items.filter((i) => i.imageUrl).length}`,
  );

  const dioceses = asList(
    await app.documents(DIOCESE_UID).findMany({
      filters: { name: { $eqi: dioceseName } },
      populate: { tenant: true },
      limit: 100,
    }),
  ).filter((d) => d.tenant?.tenantId && (!TENANT_FILTER.length || TENANT_FILTER.includes(d.tenant.tenantId)));

  if (!dioceses.length) {
    throw new Error(`No local "${dioceseName}" diocese for tenants: ${TENANT_FILTER.join(', ') || '(any)'}`);
  }

  for (const diocese of dioceses) {
    const tenantId = diocese.tenant.tenantId;
    const tenantDocId = diocese.tenant.documentId;
    if (!tenantDocId) throw new Error(`Tenant documentId missing for ${tenantId}`);
    // Dioceses are tenant-scoped, so matching on diocese alone also picks up parishes whose tenant link is missing.
    const existing = asList(
      await app.documents(PARISH_UID).findMany({
        filters: { diocese: { documentId: diocese.documentId } },
        fields: ['name', 'slug'],
        populate: { image: { fields: ['id', 'name', 'url'] } },
        limit: 2000,
      }),
    );
    const { matches, leftover } = matchExisting(items, existing);

    let created = 0;
    let updated = 0;
    let images = 0;
    const attachImage = async (documentId, item) => {
      if (SKIP_IMAGES || !item.imageUrl) return;
      if (DRY_RUN) {
        images++;
        return;
      }
      const fileId = await uploadParishImage(app, item.imageUrl, item.name);
      if (fileId && (await linkParishImage(app, documentId, fileId))) images++;
    };
    for (const item of items) {
      const data = { ...detailFields(item), tenant: tenantDocId };
      const hit = matches.get(item);
      if (hit) {
        if (!DRY_RUN) await app.documents(PARISH_UID).update({ documentId: hit.documentId, data });
        if (!hit.image || isPlaceholderImage(hit.image)) await attachImage(hit.documentId, item);
        updated++;
        if (VERBOSE)
          console.log(
            `  update ${hit.slug} | ${data.city || '-'} | ${data.postalCode || '-'} | ${data.phones || '-'} | ${(data.address || '').replace(/\n/g, ' / ')}`,
          );
        continue;
      }
      const base = slugify(
        [item.name, item.city || item.siteSlug?.match(/-(\d+)$/)?.[1], diocese.slug].filter(Boolean).join(' '),
      );
      const slug = await uniqueSlug(app, base, takenSlugs);
      if (DRY_RUN) {
        await attachImage(null, item);
      } else {
        const doc = await app.documents(PARISH_UID).create({
          data: { name: item.name, slug, diocese: diocese.documentId, ...data },
        });
        await attachImage(doc.documentId, item);
      }
      created++;
      if (VERBOSE)
        console.log(
          `  create ${slug} | ${data.city || '-'} | ${data.postalCode || '-'} | ${data.phones || '-'} | ${(data.address || '').replace(/\n/g, ' / ')}`,
        );
    }
    if (VERBOSE) for (const row of leftover) console.log(`  kept (not on page): ${row.slug}`);
    console.log(
      `  [${tenantId}] existing=${existing.length} created=${created} updated=${updated} images=${images} keptUnmatched=${leftover.length}`,
    );
    totals.images += images;
    totals.created += created;
    totals.updated += updated;
    totals.kept += leftover.length;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
