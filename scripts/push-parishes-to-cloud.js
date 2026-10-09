'use strict';

/**
 * Push Directory – Parishes from local Strapi to Cloud (overwrite by slug + tenant).
 * Every content field is sent (nulls included) so Cloud mirrors local. Diocese is
 * mapped by slug to the Cloud diocese of the same tenant. Images are NOT uploaded
 * here — use durable S3 after the content push:
 *
 *   npm run push:collection-images-s3-to-cloud -- --collection=parishes --tenant-id=mosc_malankara_orthodox_2 --skip-api
 *
 * Prerequisites (.env): STRAPI_CLOUD_URL, STRAPI_CLOUD_API_TOKEN (Full Access)
 *
 * Run:
 *   npm run push:parishes-to-cloud -- --tenant-id=mosc_malankara_orthodox_2 --dry-run
 *   npm run push:parishes-to-cloud -- --tenant-id=mosc_malankara_orthodox_2 --delete-missing
 *
 * Options:
 *   --tenant-id=XXX     Tenant to push (default mosc_malankara_orthodox_2)
 *   --dry-run           Preview (also DRY_RUN=1); no HTTP writes
 *   --delete-missing    Delete Cloud parishes of this tenant whose slug is not in local
 *   --concurrency=N     Parallel Cloud writes (default 4)
 */

try {
  require('dotenv').config();
} catch (_) {}

const { DRY_RUN: DRY_RUN_ENV, getTenantId, getArg, hasFlag } = require('./lib/liturgy-cli');
const { loadStrapiApp } = require('./lib/load-strapi-app');

const CLOUD_URL = (process.env.STRAPI_CLOUD_URL || '').replace(/\/$/, '');
const API_TOKEN = process.env.STRAPI_CLOUD_API_TOKEN || '';
const UID = 'api::parish.parish';
const PLURAL = 'parishes';
const DRY_RUN = DRY_RUN_ENV || hasFlag('dry-run');
const DELETE_MISSING = hasFlag('delete-missing');
const CONCURRENCY = Math.max(1, parseInt(getArg('concurrency', '4'), 10) || 4);
const CONTENT_FIELDS = [
  'name',
  'slug',
  'address',
  'addressLine1',
  'addressLine2',
  'city',
  'state',
  'postalCode',
  'country',
  'email',
  'phones',
  'phoneSecondary',
];

async function cloudFetch(pathname, options = {}, attempt = 1) {
  const res = await fetch(`${CLOUD_URL}${pathname}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_TOKEN}`, ...options.headers },
  });
  const text = await res.text();
  if (!res.ok) {
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await new Promise((r) => setTimeout(r, 1000 * attempt));
      return cloudFetch(pathname, options, attempt + 1);
    }
    throw new Error(`HTTP ${res.status} ${pathname}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : {};
}

async function cloudFindAll(query) {
  const rows = [];
  for (let page = 1; ; page++) {
    const data = await cloudFetch(`/api/${query}&pagination[page]=${page}&pagination[pageSize]=100`);
    rows.push(...(data?.data ?? []));
    if (!data?.meta?.pagination || page >= data.meta.pagination.pageCount) break;
  }
  return rows;
}

async function runPool(items, worker) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (next < items.length) await worker(items[next++]);
    }),
  );
}

async function loadLocal(tenantId) {
  const app = await loadStrapiApp();
  try {
    const result = await app.documents(UID).findMany({
      filters: { tenant: { tenantId } },
      populate: { diocese: { fields: ['slug', 'name'] } },
      limit: 10000,
    });
    return Array.isArray(result) ? result : (result?.results ?? []);
  } finally {
    await app.destroy();
  }
}

async function main() {
  if (!CLOUD_URL || !API_TOKEN) {
    console.error('Set STRAPI_CLOUD_URL and STRAPI_CLOUD_API_TOKEN in .env');
    process.exit(1);
  }
  const tenantId = getTenantId({ defaultValue: 'mosc_malankara_orthodox_2' });
  const tenantFilter = `filters[tenant][tenantId][$eq]=${encodeURIComponent(tenantId)}`;

  const local = await loadLocal(tenantId);
  console.log('Push Parishes to Cloud');
  console.log('  Cloud:', CLOUD_URL);
  console.log('  Tenant:', tenantId);
  console.log('  Local parishes:', local.length);
  console.log('  Delete missing on Cloud:', DELETE_MISSING);
  if (DRY_RUN) console.log('  DRY RUN');
  if (!local.length) process.exit(0);

  const [cloudTenant] = await cloudFindAll(`tenants?filters[tenantId][$eq]=${encodeURIComponent(tenantId)}`);
  if (!cloudTenant?.documentId) throw new Error(`Tenant ${tenantId} not found on Cloud; run push:tenant-to-cloud first`);

  const cloudDioceses = await cloudFindAll(`dioceses?${tenantFilter}&fields[0]=slug`);
  const dioceseBySlug = new Map(cloudDioceses.map((d) => [d.slug, d.documentId]));
  const cloudParishes = await cloudFindAll(`${PLURAL}?${tenantFilter}&fields[0]=slug`);
  const cloudBySlug = new Map(cloudParishes.map((p) => [p.slug, p.documentId]));
  const localSlugs = new Set(local.map((p) => p.slug));
  // Earlier creates can land without a tenant; adopt them by slug instead of duplicating.
  const untenanted = await cloudFindAll(`${PLURAL}?filters[tenant][id][$null]=true&fields[0]=slug`);
  const adopted = untenanted.filter((p) => localSlugs.has(p.slug) && !cloudBySlug.has(p.slug));
  for (const p of adopted) cloudBySlug.set(p.slug, p.documentId);

  const missingDioceses = [...new Set(local.map((p) => p.diocese?.slug).filter((s) => s && !dioceseBySlug.has(s)))];
  const toDelete = cloudParishes.filter((p) => !localSlugs.has(p.slug));
  const toUpdate = local.filter((p) => cloudBySlug.has(p.slug));

  console.log('  Cloud parishes (tenant):', cloudParishes.length, '| untenanted adopted by slug:', adopted.length);
  console.log(`  Plan: update=${toUpdate.length} create=${local.length - toUpdate.length} cloudOnly=${toDelete.length}`);
  if (missingDioceses.length) console.warn('  Dioceses missing on Cloud (parishes skipped):', missingDioceses.join(', '));
  if (toDelete.length) console.log('  Cloud-only slugs:', toDelete.map((p) => p.slug).join(', '));
  if (DRY_RUN) process.exit(0);

  const stats = { created: 0, updated: 0, deleted: 0, failed: 0 };
  let done = 0;
  await runPool(local, async (doc) => {
    const dioceseDocId = dioceseBySlug.get(doc.diocese?.slug);
    if (!dioceseDocId) {
      stats.failed++;
      return;
    }
    const data = { diocese: dioceseDocId, tenant: cloudTenant.documentId };
    for (const field of CONTENT_FIELDS) data[field] = doc[field] ?? null;
    const existing = cloudBySlug.get(doc.slug);
    try {
      if (existing) {
        await cloudFetch(`/api/${PLURAL}/${existing}`, { method: 'PUT', body: JSON.stringify({ data }) });
        stats.updated++;
      } else {
        const res = await cloudFetch(`/api/${PLURAL}`, { method: 'POST', body: JSON.stringify({ data }) });
        // Cloud parish beforeCreate may strip the tenant on POST; a follow-up PUT keeps it.
        const createdDocId = res?.data?.documentId;
        if (createdDocId) {
          await cloudFetch(`/api/${PLURAL}/${createdDocId}`, {
            method: 'PUT',
            body: JSON.stringify({ data: { tenant: cloudTenant.documentId } }),
          });
        }
        stats.created++;
      }
    } catch (err) {
      stats.failed++;
      console.warn('  Failed', doc.slug, err.message);
    }
    if (++done % 100 === 0) console.log(`  ... ${done}/${local.length}`);
  });

  if (DELETE_MISSING) {
    await runPool(toDelete, async (row) => {
      try {
        await cloudFetch(`/api/${PLURAL}/${row.documentId}`, { method: 'DELETE' });
        stats.deleted++;
      } catch (err) {
        stats.failed++;
        console.warn('  Delete failed', row.slug, err.message);
      }
    });
  }

  console.log(
    `\nDone. created=${stats.created} updated=${stats.updated} deleted=${stats.deleted} failed=${stats.failed} → ${CLOUD_URL}`,
  );
  console.log(
    `Next: npm run push:collection-images-s3-to-cloud -- --collection=parishes --tenant-id=${tenantId} --skip-api`,
  );
  if (stats.failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
