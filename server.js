const express = require('express');
const { Pool } = require('pg');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// -- Database ------------------------------------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Product catalog DB (Grand Emotion) — for pulling product images
const catalogPool = process.env.CATALOG_DATABASE_URL
  ? new Pool({
      connectionString: process.env.CATALOG_DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      max: 3,                    // only need a few connections
    })
  : null;

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS aged_inventory (
      id SERIAL PRIMARY KEY,
      style VARCHAR(100),
      color VARCHAR(100),
      commodity VARCHAR(100),
      sizes TEXT,
      total_remaining NUMERIC DEFAULT 0,
      total_value NUMERIC DEFAULT 0,
      total_current NUMERIC DEFAULT 0,
      total_committed NUMERIC DEFAULT 0,
      unit_cost_avg NUMERIC DEFAULT 0,
      age_days INT DEFAULT 0,
      age_bracket VARCHAR(60),
      trsc_date VARCHAR(30),
      po_no VARCHAR(60),
      image_url TEXT,
      flagged BOOLEAN DEFAULT false,
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS catalog_images (
      id SERIAL PRIMARY KEY,
      style VARCHAR(100) UNIQUE,
      image_url TEXT,
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_aged_style_color ON aged_inventory(style, color);
    CREATE INDEX IF NOT EXISTS idx_aged_bracket ON aged_inventory(age_bracket);
    CREATE INDEX IF NOT EXISTS idx_catalog_style ON catalog_images(style);
  `);
  console.log('Database tables ready');
}

// -- Sync images from Product Catalog (Grand Emotion) DB ------
async function syncCatalogImages() {
  if (!catalogPool) {
    console.log('No CATALOG_DATABASE_URL set — skipping image sync');
    return;
  }
  try {
    console.log('Syncing product images from catalog DB...');
    const result = await catalogPool.query(
      `SELECT base_style, image_url FROM products WHERE image_url IS NOT NULL AND image_url != ''`
    );
    if (result.rows.length === 0) {
      console.log('No images found in catalog DB');
      return;
    }
    // Upsert each image into local catalog_images table
    let synced = 0;
    for (const row of result.rows) {
      if (!row.base_style || !row.image_url) continue;
      await pool.query(
        `INSERT INTO catalog_images (style, image_url, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (style) DO UPDATE SET image_url = $2, updated_at = NOW()`,
        [row.base_style.trim(), row.image_url]
      );
      synced++;
    }
    // Also update any existing aged_inventory rows that are missing images
    await pool.query(`
      UPDATE aged_inventory ai
      SET image_url = ci.image_url
      FROM catalog_images ci
      WHERE ai.style = ci.style AND (ai.image_url IS NULL OR ai.image_url = '')
    `);
    console.log(`Synced ${synced} product images from catalog DB`);
  } catch (err) {
    console.error('Catalog image sync error:', err.message);
  }
}

// -- Helpers -------------------------------------------------
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

function parseNum(s) {
  if (!s) return 0;
  return parseFloat(String(s).replace(/,/g, '')) || 0;
}

const SIZE_ORDER = { 'XS': 0, 'S': 1, 'M': 2, 'L': 3, 'XL': 4, '1X': 5, '2X': 6, '3X': 7, '4X': 8 };
function sortSizes(sizes) {
  return [...new Set(sizes)].sort((a, b) => (SIZE_ORDER[a] ?? 9) - (SIZE_ORDER[b] ?? 9));
}

// -- Zoho WorkDrive Image Proxy ------------------------------
// Reads refresh_token from product catalog DB, then refreshes
// using Zoho OAuth to get a current access token.
let zohoAccessToken = null;
let tokenExpiry = 0;

async function getZohoAccessToken() {
  if (zohoAccessToken && Date.now() < tokenExpiry) return zohoAccessToken;

  try {
    // 1. Try reading refresh token from catalog DB
    let refreshToken = process.env.ZOHO_REFRESH_TOKEN;
    let clientId = process.env.ZOHO_CLIENT_ID;
    let clientSecret = process.env.ZOHO_CLIENT_SECRET;

    if (catalogPool && !refreshToken) {
      const result = await catalogPool.query(
        'SELECT refresh_token FROM zoho_tokens ORDER BY updated_at DESC LIMIT 1'
      );
      if (result.rows.length > 0) {
        refreshToken = result.rows[0].refresh_token;
      }
    }

    if (!refreshToken || !clientId || !clientSecret) {
      console.error('Missing Zoho credentials (refresh_token, client_id, or client_secret)');
      return null;
    }

    // 2. Do OAuth refresh
    const resp = await fetch('https://accounts.zoho.com/oauth/v2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    const data = await resp.json();
    if (data.access_token) {
      zohoAccessToken = data.access_token;
      tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
      console.log('Zoho token refreshed successfully');
      return zohoAccessToken;
    }
    console.error('Zoho token refresh failed:', data);
    return null;
  } catch (err) {
    console.error('Zoho token error:', err.message);
    return null;
  }
}

// Image proxy endpoint
app.get('/api/image-proxy', async (req, res) => {
  const { url } = req.query;
  if (!url || !url.includes('zoho.com')) {
    return res.status(400).send('Invalid URL');
  }

  try {
    const token = await getZohoAccessToken();
    const headers = {};
    if (token) headers['Authorization'] = `Zoho-oauthtoken ${token}`;

    const resp = await fetch(url, { headers, redirect: 'follow' });
    if (!resp.ok) throw new Error(`Zoho returned ${resp.status}`);

    const contentType = resp.headers.get('content-type') || 'image/jpeg';
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=86400'); // cache 24h
    const buffer = await resp.buffer();
    res.send(buffer);
  } catch (err) {
    console.error('Image proxy error:', err.message);
    res.status(502).send('Image unavailable');
  }
});

// -- CSV Import: Low Value Inventory -------------------------
app.post('/api/import/low-value', upload.single('file'), async (req, res) => {
  try {
    const csv = req.file
      ? req.file.buffer.toString('utf-8')
      : req.body?.csv;

    if (!csv) return res.status(400).json({ error: 'No CSV data' });

    const rows = parse(csv, { columns: true, skip_empty_lines: true, bom: true });

    // Get catalog images for fallback
    const imgResult = await pool.query('SELECT style, image_url FROM catalog_images');
    const catalogImages = {};
    imgResult.rows.forEach(r => { catalogImages[r.style] = r.image_url; });

    // Roll up to style+color
    const grouped = {};
    for (const r of rows) {
      const style = (r.Style || '').trim();
      const color = (r.Color || '').trim();
      if (!style) continue;
      const key = `${style}|${color}`;

      if (!grouped[key]) {
        grouped[key] = {
          style, color,
          commodity: '',
          sizes: [],
          total_remaining: 0, total_value: 0,
          total_current: 0, total_committed: 0,
          unit_cost_sum: 0, cost_count: 0,
          age_days: 0, age_bracket: '', trsc_date: '', po_no: '',
          image_url: '',
        };
      }
      const d = grouped[key];
      d.commodity = (r.Commodity || '').trim() || d.commodity;

      // Image priority: CAD link from this file, then catalog
      const cad = (r.CAD_Link || '').trim();
      if (cad) d.image_url = cad;
      else if (!d.image_url && catalogImages[style]) d.image_url = catalogImages[style];

      d.sizes.push((r.Size || '').trim());
      d.total_remaining += parseNum(r.Remaining_Stock);
      d.total_value += parseNum(r.Remaining_Asset_Value);
      d.total_current += parseNum(r.Current_Stock);
      d.total_committed += parseNum(r.Committed_Stock);

      const age = parseInt(parseNum(r.Inventory_Age)) || 0;
      if (age > d.age_days) {
        d.age_days = age;
        d.age_bracket = (r.Age_Bracket || '').trim();
        d.trsc_date = (r.Trsc_Date || '').trim();
      }
      d.po_no = (r.PO_No || '').trim() || d.po_no;
      d.unit_cost_sum += parseNum(r.Unit_Cost);
      d.cost_count += 1;
    }

    // Upsert into DB
    await pool.query('DELETE FROM aged_inventory');
    let count = 0;
    for (const d of Object.values(grouped)) {
      const sizes = sortSizes(d.sizes).join(', ');
      const unitCost = d.cost_count > 0 ? d.unit_cost_sum / d.cost_count : 0;
      await pool.query(`
        INSERT INTO aged_inventory
          (style, color, commodity, sizes, total_remaining, total_value,
           total_current, total_committed, unit_cost_avg, age_days,
           age_bracket, trsc_date, po_no, image_url, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
      `, [d.style, d.color, d.commodity, sizes,
          d.total_remaining, Math.round(d.total_value * 100) / 100,
          d.total_current, d.total_committed,
          Math.round(unitCost * 10000) / 10000,
          d.age_days, d.age_bracket, d.trsc_date, d.po_no, d.image_url]);
      count++;
    }

    console.log(`Imported ${rows.length} rows → ${count} style/color records`);
    res.json({ success: true, rows: rows.length, records: count });
  } catch (err) {
    console.error('Import error:', err);
    res.status(500).json({ error: err.message });
  }
});

// -- CSV Import: Catalog (Available Now / Left to Sell) ------
app.post('/api/import/catalog', upload.single('file'), async (req, res) => {
  try {
    const csv = req.file
      ? req.file.buffer.toString('utf-8')
      : req.body?.csv;

    if (!csv) return res.status(400).json({ error: 'No CSV data' });

    const rows = parse(csv, { columns: true, skip_empty_lines: true, bom: true });
    let count = 0;

    for (const r of rows) {
      const style = (r['Style Name'] || '').trim();
      const img = (r['Style Image'] || '').trim();
      if (!style || style.startsWith('Grand') || !img) continue;

      await pool.query(`
        INSERT INTO catalog_images (style, image_url, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (style) DO UPDATE SET image_url = $2, updated_at = NOW()
      `, [style, img]);
      count++;
    }

    // Also update any aged_inventory rows that are missing images
    await pool.query(`
      UPDATE aged_inventory ai
      SET image_url = ci.image_url
      FROM catalog_images ci
      WHERE ai.style = ci.style AND (ai.image_url IS NULL OR ai.image_url = '')
    `);

    console.log(`Catalog import: ${count} style images`);
    res.json({ success: true, images: count });
  } catch (err) {
    console.error('Catalog import error:', err);
    res.status(500).json({ error: err.message });
  }
});

// -- API: Sync images from Product Catalog DB -----------------
app.post('/api/sync-catalog-images', async (req, res) => {
  try {
    if (!catalogPool) {
      return res.status(400).json({ error: 'Product catalog database not configured' });
    }
    await syncCatalogImages();
    const countResult = await pool.query('SELECT COUNT(*) FROM catalog_images');
    res.json({ success: true, totalImages: parseInt(countResult.rows[0].count) });
  } catch (err) {
    console.error('Manual catalog sync error:', err);
    res.status(500).json({ error: err.message });
  }
});

// -- API: Debug catalog DB ------------------------------------
app.get('/api/debug-catalog', async (req, res) => {
  try {
    if (!catalogPool) return res.json({ error: 'No catalog DB configured' });
    const total = await catalogPool.query('SELECT COUNT(*) FROM products');
    const withImg = await catalogPool.query("SELECT COUNT(*) FROM products WHERE image_url IS NOT NULL AND image_url != ''");
    const sample = await catalogPool.query("SELECT id, style_id, base_style, name, image_url FROM products LIMIT 5");
    const cols = await catalogPool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'products' ORDER BY ordinal_position");
    res.json({
      totalProducts: total.rows[0].count,
      withImageUrl: withImg.rows[0].count,
      columns: cols.rows.map(r => r.column_name),
      sample: sample.rows
    });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// -- API: Report Data ----------------------------------------
app.get('/api/inventory', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT style, color, commodity, sizes, total_remaining, total_value,
             total_current, total_committed, unit_cost_avg, age_days,
             age_bracket, trsc_date, po_no, image_url, flagged
      FROM aged_inventory
      ORDER BY age_days DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -- API: Flag/unflag items for jobber -----------------------
app.post('/api/flag', express.json(), async (req, res) => {
  try {
    const { items, flagged } = req.body; // items = [{style, color}, ...]
    for (const item of items) {
      await pool.query(
        'UPDATE aged_inventory SET flagged = $1 WHERE style = $2 AND color = $3',
        [flagged, item.style, item.color]
      );
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -- API: Export flagged to CSV ------------------------------
app.get('/api/export-flagged', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT style, color, commodity, sizes, total_remaining, total_value,
             unit_cost_avg, age_days, age_bracket, trsc_date, image_url
      FROM aged_inventory WHERE flagged = true
      ORDER BY age_days DESC
    `);
    const header = 'Style,Color,Commodity,Sizes,Remaining Units,Asset Value,Unit Cost,Age Days,Age Bracket,Last Stock In,Image URL';
    const rows = result.rows.map(r =>
      `${r.style},"${r.color}",${r.commodity},"${r.sizes}",${r.total_remaining},${r.total_value},${r.unit_cost_avg},${r.age_days},"${r.age_bracket}",${r.trsc_date},${r.image_url || ''}`
    );
    res.set('Content-Type', 'text/csv');
    res.set('Content-Disposition', 'attachment; filename=jobber_flagged_inventory.csv');
    res.send([header, ...rows].join('\n'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -- API: Dashboard stats ------------------------------------
app.get('/api/stats', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(DISTINCT style) as total_styles,
        COUNT(*) as total_records,
        COALESCE(SUM(total_remaining), 0) as total_units,
        COALESCE(SUM(total_value), 0) as total_value,
        COUNT(*) FILTER (WHERE flagged = true) as flagged_count,
        COALESCE(SUM(total_remaining) FILTER (WHERE flagged = true), 0) as flagged_units,
        MAX(updated_at) as last_updated
      FROM aged_inventory
    `);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/age-brackets', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT age_bracket, COUNT(*) as count,
             SUM(total_remaining) as units, SUM(total_value) as value
      FROM aged_inventory
      WHERE age_bracket IS NOT NULL AND age_bracket != ''
      GROUP BY age_bracket
      ORDER BY MAX(age_days) DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -- Serve the Report (main page) ----------------------------
app.get('/', (req, res) => {
  res.send(REPORT_HTML);
});

// -- HTML Report ---------------------------------------------
const REPORT_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Aged Inventory &mdash; Jobber Review</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f6fa; color: #2d3436; }
  .header { background: linear-gradient(135deg, #2d3436 0%, #636e72 100%); color: white; padding: 28px 32px; }
  .header { position: relative; }
  .header h1 { font-size: 22px; font-weight: 600; }
  .header p { font-size: 13px; opacity: 0.7; margin-top: 4px; }
  .header .updated { font-size: 11px; opacity: 0.5; margin-top: 2px; }
  .header .settings-btn { position: absolute; top: 28px; right: 32px; background: rgba(255,255,255,0.15); border: 1px solid rgba(255,255,255,0.25); color: white; padding: 8px 16px; border-radius: 8px; font-size: 13px; cursor: pointer; display: flex; align-items: center; gap: 6px; transition: background 0.15s; }
  .header .settings-btn:hover { background: rgba(255,255,255,0.25); }
  .dashboard { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; padding: 24px 32px; }
  .card { background: white; border-radius: 10px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  .card .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #636e72; margin-bottom: 6px; }
  .card .value { font-size: 26px; font-weight: 700; }
  .card .sub { font-size: 12px; color: #636e72; margin-top: 4px; }
  .age-bar { padding: 0 32px 16px; }
  .age-bar h3 { font-size: 14px; font-weight: 600; margin-bottom: 12px; color: #2d3436; }
  .bar-row { display: flex; align-items: center; margin-bottom: 6px; gap: 8px; }
  .bar-label { font-size: 11px; width: 180px; text-align: right; color: #636e72; flex-shrink: 0; }
  .bar-track { flex: 1; height: 22px; background: #eee; border-radius: 4px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 4px; display: flex; align-items: center; padding-left: 8px; font-size: 10px; font-weight: 600; color: white; min-width: fit-content; }
  .bar-info { font-size: 11px; color: #636e72; width: 120px; flex-shrink: 0; }
  .controls { padding: 16px 32px; display: flex; flex-wrap: wrap; gap: 12px; align-items: center; background: white; border-top: 1px solid #eee; border-bottom: 1px solid #eee; position: sticky; top: 0; z-index: 100; }
  .controls input, .controls select { padding: 8px 12px; border: 1px solid #ddd; border-radius: 6px; font-size: 13px; background: #f5f6fa; }
  .controls input { width: 260px; }
  .controls select { min-width: 160px; }
  .controls .count { font-size: 12px; color: #636e72; margin-left: auto; }
  .btn { padding: 8px 16px; border: none; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer; transition: all 0.15s; }
  .btn-export { background: #0984e3; color: white; }
  .btn-export:hover { background: #0769b8; }
  .btn-upload { background: #00b894; color: white; }
  .btn-upload:hover { background: #00a381; }
  .table-wrap { padding: 16px 32px 48px; overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; background: white; border-radius: 10px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  thead th { background: #2d3436; color: white; padding: 10px 12px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.3px; text-align: left; cursor: pointer; white-space: nowrap; user-select: none; }
  thead th:hover { background: #636e72; }
  thead th .arrow { margin-left: 4px; opacity: 0.5; }
  thead th.sorted .arrow { opacity: 1; }
  tbody tr { border-bottom: 1px solid #f0f0f0; transition: background 0.1s; }
  tbody tr:hover { background: #f8f9fa; }
  tbody td { padding: 8px 12px; font-size: 13px; vertical-align: middle; }
  .img-cell { width: 56px; height: 56px; border-radius: 6px; overflow: hidden; background: #f0f0f0; display: flex; align-items: center; justify-content: center; cursor: pointer; }
  .img-cell img { width: 100%; height: 100%; object-fit: cover; }
  .img-cell .no-img { font-size: 10px; color: #b2bec3; text-align: center; }
  .age-badge { display: inline-block; padding: 3px 10px; border-radius: 12px; font-size: 11px; font-weight: 600; white-space: nowrap; }
  .age-4plus { background: #d63031; color: white; }
  .age-4 { background: #e17055; color: white; }
  .age-3 { background: #fdcb6e; color: #2d3436; }
  .age-2 { background: #ffeaa7; color: #2d3436; }
  .age-1 { background: #dfe6e9; color: #2d3436; }
  .age-under { background: #f0f0f0; color: #636e72; }
  .flagged { background: #fff3e0 !important; }
  .flag-check { width: 18px; height: 18px; cursor: pointer; accent-color: #e17055; }
  .size-pills { display: flex; gap: 3px; flex-wrap: wrap; }
  .size-pill { background: #f0f0f0; padding: 2px 6px; border-radius: 3px; font-size: 10px; }
  .modal-overlay { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.7); z-index: 1000; align-items: center; justify-content: center; }
  .modal-overlay.show { display: flex; }
  .modal-content { background: white; border-radius: 12px; padding: 24px; max-width: 600px; max-height: 80vh; overflow: auto; }
  .modal-content img { width: 100%; border-radius: 8px; }
  .modal-close { position: absolute; top: 16px; right: 20px; font-size: 28px; color: white; cursor: pointer; }
  .settings-overlay { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 2000; align-items: center; justify-content: center; }
  .settings-overlay.show { display: flex; }
  .settings-panel { background: white; border-radius: 14px; padding: 32px; width: 520px; max-width: 95vw; max-height: 90vh; overflow-y: auto; box-shadow: 0 20px 60px rgba(0,0,0,0.3); }
  .settings-panel h2 { font-size: 18px; font-weight: 700; margin-bottom: 6px; }
  .settings-panel .subtitle { font-size: 13px; color: #636e72; margin-bottom: 24px; }
  .settings-panel .close-settings { float: right; background: none; border: none; font-size: 22px; cursor: pointer; color: #636e72; margin-top: -4px; }
  .settings-panel .close-settings:hover { color: #2d3436; }
  .upload-section { background: #f8f9fa; border: 2px dashed #dfe6e9; border-radius: 10px; padding: 20px; margin-bottom: 16px; text-align: center; transition: border-color 0.2s, background 0.2s; }
  .upload-section.drag-over { border-color: #0984e3; background: #ebf5fb; }
  .upload-section h3 { font-size: 14px; font-weight: 600; margin-bottom: 4px; }
  .upload-section p { font-size: 12px; color: #636e72; margin-bottom: 12px; }
  .upload-section input[type=file] { display: none; }
  .upload-section .choose-btn { display: inline-block; padding: 8px 20px; background: #0984e3; color: white; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer; transition: background 0.15s; }
  .upload-section .choose-btn:hover { background: #0769b8; }
  .upload-section .file-name { font-size: 12px; color: #0984e3; margin-top: 8px; font-weight: 600; }
  .upload-status { padding: 10px 14px; border-radius: 8px; font-size: 13px; margin-top: 8px; display: none; }
  .upload-status.success { display: block; background: #e8f8f5; color: #00b894; border: 1px solid #b8e6d8; }
  .upload-status.error { display: block; background: #fdf0ed; color: #d63031; border: 1px solid #f5c6c6; }
  .upload-status.loading { display: block; background: #ebf5fb; color: #0984e3; border: 1px solid #b8d4e3; }
  .loading { text-align: center; padding: 60px; color: #636e72; font-size: 14px; }
</style>
</head>
<body>
<div class="header">
  <h1>Aged Inventory &mdash; Jobber Review</h1>
  <p>Low Value Inventory + Product Catalog</p>
  <div class="updated" id="lastUpdated"></div>
  <button class="settings-btn" onclick="document.getElementById('settingsPanel').classList.add('show')">&#9881; Settings</button>
</div>
<div class="dashboard">
  <div class="card"><div class="label">Style/Colors</div><div class="value" id="statRecords">—</div><div class="sub" id="statStyles">loading...</div></div>
  <div class="card"><div class="label">Remaining Units</div><div class="value" id="statUnits">—</div><div class="sub">after committed orders</div></div>
  <div class="card"><div class="label">Remaining Asset Value</div><div class="value" id="statValue">—</div><div class="sub">book value at cost</div></div>
  <div class="card"><div class="label">Flagged for Jobber</div><div class="value" id="statFlagged">0</div><div class="sub"><span id="statFlaggedUnits">0</span> units</div></div>
</div>
<div class="age-bar"><h3>Units by Age Bracket</h3><div id="ageBars"><div class="loading">Loading...</div></div></div>
<div class="controls">
  <input type="text" id="search" placeholder="Search style, color, commodity..." />
  <select id="filterBracket"><option value="">All Age Brackets</option></select>
  <select id="filterCommodity"><option value="">All Commodities</option></select>
  <select id="filterFlag"><option value="">All Items</option><option value="flagged">Flagged Only</option><option value="unflagged">Unflagged Only</option></select>
  <button class="btn btn-export" onclick="exportFlagged()">Export Flagged to CSV</button>
  <div class="count"><span id="showCount">0</span> shown</div>
</div>
<div class="table-wrap">
  <table>
    <thead><tr>
      <th style="width:40px;"><input type="checkbox" id="flagAll" class="flag-check" title="Flag all visible" /></th>
      <th>CAD</th>
      <th data-sort="style">Style <span class="arrow">&#9650;</span></th>
      <th data-sort="color">Color <span class="arrow">&#9650;</span></th>
      <th data-sort="commodity">Type <span class="arrow">&#9650;</span></th>
      <th>Sizes</th>
      <th data-sort="total_remaining">Remaining <span class="arrow">&#9650;</span></th>
      <th data-sort="total_value">Value <span class="arrow">&#9650;</span></th>
      <th data-sort="unit_cost_avg">Unit Cost <span class="arrow">&#9650;</span></th>
      <th data-sort="age_days">Age <span class="arrow">&#9650;</span></th>
      <th data-sort="age_bracket">Bracket <span class="arrow">&#9650;</span></th>
      <th data-sort="trsc_date">Last In <span class="arrow">&#9650;</span></th>
    </tr></thead>
    <tbody id="tableBody"><tr><td colspan="12" class="loading">Loading inventory data...</td></tr></tbody>
  </table>
</div>
<div class="modal-overlay" id="imgModal" onclick="this.classList.remove('show')">
  <span class="modal-close">&times;</span>
  <div class="modal-content" onclick="event.stopPropagation()"><img id="modalImg" src="" /></div>
</div>
<div class="settings-overlay" id="settingsPanel" onclick="this.classList.remove('show')">
  <div class="settings-panel" onclick="event.stopPropagation()">
    <button class="close-settings" onclick="document.getElementById('settingsPanel').classList.remove('show')">&times;</button>
    <h2>Settings</h2>
    <p class="subtitle">Manually import CSV data files</p>
    <div class="upload-section" id="dropLV">
      <h3>Low Value Inventory CSV</h3>
      <p>Main inventory data &mdash; replaces all current records on import</p>
      <label class="choose-btn" for="fileLV">Choose CSV File</label>
      <input type="file" id="fileLV" accept=".csv" onchange="handleUpload('low-value', this)" />
      <div class="file-name" id="nameLV"></div>
      <div class="upload-status" id="statusLV"></div>
    </div>
    <div class="upload-section" id="dropCatalog">
      <h3>Product Images</h3>
      <p>Sync images from the Grand Emotion product catalog database</p>
      <button class="choose-btn" onclick="syncCatalogImages()">Sync Product Images</button>
      <div class="upload-status" id="statusCatalog"></div>
    </div>
  </div>
</div>
<script>
let DATA = [];
const flaggedSet = new Set();
let sortCol = 'age_days', sortDir = -1;

// -- Load data from API ----------------------
async function loadData() {
  const [inventory, stats, brackets] = await Promise.all([
    fetch('/api/inventory').then(r => r.json()),
    fetch('/api/stats').then(r => r.json()),
    fetch('/api/age-brackets').then(r => r.json()),
  ]);

  DATA = inventory;
  DATA.forEach(r => {
    r.total_remaining = parseFloat(r.total_remaining) || 0;
    r.total_value = parseFloat(r.total_value) || 0;
    r.unit_cost_avg = parseFloat(r.unit_cost_avg) || 0;
    r.age_days = parseInt(r.age_days) || 0;
    if (r.flagged) flaggedSet.add(r.style + '|' + r.color);
  });

  // Stats
  document.getElementById('statRecords').textContent = stats.total_records;
  document.getElementById('statStyles').textContent = stats.total_styles + ' unique styles';
  document.getElementById('statUnits').textContent = Number(stats.total_units).toLocaleString();
  document.getElementById('statValue').textContent = '$' + Number(stats.total_value).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
  document.getElementById('statFlagged').textContent = stats.flagged_count;
  document.getElementById('statFlaggedUnits').textContent = Number(stats.flagged_units).toLocaleString();
  if (stats.last_updated) {
    document.getElementById('lastUpdated').textContent = 'Last updated: ' + new Date(stats.last_updated).toLocaleDateString('en-US', {month:'long', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit'});
  }

  // Populate filter dropdowns
  const bracketSel = document.getElementById('filterBracket');
  const commoditySel = document.getElementById('filterCommodity');
  [...new Set(DATA.map(r => r.age_bracket).filter(Boolean))].forEach(b => {
    bracketSel.innerHTML += '<option value="' + b + '">' + b + '</option>';
  });
  [...new Set(DATA.map(r => r.commodity).filter(Boolean))].sort().forEach(c => {
    commoditySel.innerHTML += '<option value="' + c + '">' + c + '</option>';
  });

  // Age bars
  buildAgeBars(brackets);
  render();
}

// -- Age bracket chart -----------------------
function ageBadgeClass(b) {
  if (!b) return 'age-under';
  if (b.includes('More than 4')) return 'age-4plus';
  if (b.includes('4 years')) return 'age-4';
  if (b.includes('3 years')) return 'age-3';
  if (b.includes('2 years')) return 'age-2';
  if (b.includes('1 year')) return 'age-1';
  return 'age-under';
}
const barColors = {'age-4plus':'#d63031','age-4':'#e17055','age-3':'#fdcb6e','age-2':'#ffeaa7','age-1':'#dfe6e9','age-under':'#b2bec3'};

function buildAgeBars(brackets) {
  const mx = Math.max(...brackets.map(b => parseFloat(b.units)));
  const order = ['More than 4','4 years','3 years','2 years','1 year','11 months','10 months'];
  brackets.sort((a,b) => {
    const ia = order.findIndex(o => a.age_bracket.includes(o));
    const ib = order.findIndex(o => b.age_bracket.includes(o));
    return (ia===-1?99:ia) - (ib===-1?99:ib);
  });
  document.getElementById('ageBars').innerHTML = brackets.map(b => {
    const pct = (parseFloat(b.units)/mx*100).toFixed(1);
    const cls = ageBadgeClass(b.age_bracket);
    const color = barColors[cls] || '#b2bec3';
    return '<div class="bar-row"><div class="bar-label">' + b.age_bracket + '</div><div class="bar-track"><div class="bar-fill" style="width:' + Math.max(pct,2) + '%;background:' + color + '">' + Number(b.units).toLocaleString() + '</div></div><div class="bar-info">' + b.count + ' items &bull; $' + parseFloat(b.value).toFixed(0) + '</div></div>';
  }).join('');
}

// -- Image URL (proxied through server) ------
function imgSrc(url) {
  if (!url) return '';
  if (url.includes('zoho.com')) return '/api/image-proxy?url=' + encodeURIComponent(url);
  return url;
}

// -- Filter & Render -------------------------
function getFiltered() {
  const q = document.getElementById('search').value.toLowerCase();
  const bracket = document.getElementById('filterBracket').value;
  const commodity = document.getElementById('filterCommodity').value;
  const ff = document.getElementById('filterFlag').value;
  return DATA.filter(r => {
    if (q && !(r.style + ' ' + r.color + ' ' + r.commodity).toLowerCase().includes(q)) return false;
    if (bracket && r.age_bracket !== bracket) return false;
    if (commodity && r.commodity !== commodity) return false;
    if (ff === 'flagged' && !flaggedSet.has(r.style + '|' + r.color)) return false;
    if (ff === 'unflagged' && flaggedSet.has(r.style + '|' + r.color)) return false;
    return true;
  }).sort((a,b) => {
    let va = a[sortCol], vb = b[sortCol];
    if (typeof va === 'number') return (va - vb) * sortDir;
    return String(va).localeCompare(String(vb)) * sortDir;
  });
}

function render() {
  const rows = getFiltered();
  document.getElementById('showCount').textContent = rows.length;
  document.getElementById('tableBody').innerHTML = rows.map(r => {
    const key = r.style + '|' + r.color;
    const isF = flaggedSet.has(key);
    const cls = ageBadgeClass(r.age_bracket);
    const sizes = (r.sizes || '').split(', ').map(s => '<span class="size-pill">' + s + '</span>').join('');
    const src = imgSrc(r.image_url);
    const imgH = src
      ? '<img src="' + src + '" onerror="this.parentElement.innerHTML=\\'<div class=no-img>No preview</div>\\'" loading="lazy" />'
      : '<div class="no-img">No CAD</div>';
    return '<tr class="' + (isF ? 'flagged' : '') + '" data-key="' + key + '"><td><input type="checkbox" class="flag-check row-flag" ' + (isF ? 'checked' : '') + ' data-key="' + key + '" /></td><td><div class="img-cell" onclick="showImg(\\'' + src + '\\')">' + imgH + '</div></td><td><strong>' + r.style + '</strong></td><td>' + r.color + '</td><td>' + r.commodity + '</td><td><div class="size-pills">' + sizes + '</div></td><td>' + r.total_remaining.toLocaleString() + '</td><td>$' + r.total_value.toFixed(2) + '</td><td>$' + r.unit_cost_avg.toFixed(3) + '</td><td>' + r.age_days + 'd</td><td><span class="age-badge ' + cls + '">' + r.age_bracket + '</span></td><td>' + r.trsc_date + '</td></tr>';
  }).join('');
  updateFlagStats();
}

function updateFlagStats() {
  const fr = DATA.filter(r => flaggedSet.has(r.style + '|' + r.color));
  document.getElementById('statFlagged').textContent = fr.length;
  document.getElementById('statFlaggedUnits').textContent = fr.reduce((s,r) => s + r.total_remaining, 0).toLocaleString();
}

function showImg(url) { if (!url) return; document.getElementById('modalImg').src = url; document.getElementById('imgModal').classList.add('show'); }

// -- Flag handling (persisted to server) -----
document.getElementById('tableBody').addEventListener('change', async e => {
  if (e.target.classList.contains('row-flag')) {
    const key = e.target.dataset.key;
    const [style, color] = key.split('|');
    const checked = e.target.checked;
    if (checked) flaggedSet.add(key); else flaggedSet.delete(key);
    e.target.closest('tr').classList.toggle('flagged', checked);
    updateFlagStats();
    await fetch('/api/flag', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ style, color }], flagged: checked })
    });
  }
});

document.getElementById('flagAll').addEventListener('change', async e => {
  const items = getFiltered().map(r => {
    const key = r.style + '|' + r.color;
    if (e.target.checked) flaggedSet.add(key); else flaggedSet.delete(key);
    return { style: r.style, color: r.color };
  });
  render();
  await fetch('/api/flag', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items, flagged: e.target.checked })
  });
});

// -- Sorting ---------------------------------
document.querySelectorAll('th[data-sort]').forEach(th => {
  th.addEventListener('click', () => {
    const col = th.dataset.sort;
    if (sortCol === col) sortDir *= -1;
    else { sortCol = col; sortDir = ['age_days','total_remaining','total_value'].includes(col) ? -1 : 1; }
    document.querySelectorAll('th').forEach(t => t.classList.remove('sorted'));
    th.classList.add('sorted');
    render();
  });
});

// -- Filtering -------------------------------
['search','filterBracket','filterCommodity','filterFlag'].forEach(id => {
  document.getElementById(id).addEventListener(id === 'search' ? 'input' : 'change', render);
});

// -- Export -----------------------------------
async function exportFlagged() {
  const count = flaggedSet.size;
  if (!count) { alert('No items flagged. Check items you want to send to jobber first.'); return; }
  window.location.href = '/api/export-flagged';
}

// -- CSV Upload (Settings) --------------------
async function syncCatalogImages() {
  const statusEl = document.getElementById('statusCatalog');
  statusEl.className = 'upload-status loading';
  statusEl.textContent = 'Syncing images from product catalog...';
  statusEl.style.display = 'block';
  try {
    const resp = await fetch('/api/sync-catalog-images', { method: 'POST' });
    const data = await resp.json();
    if (data.error) throw new Error(data.error);
    statusEl.className = 'upload-status success';
    statusEl.textContent = 'Synced! ' + data.totalImages + ' style images in library. Refreshing...';
    setTimeout(function(){ window.location.reload(); }, 1500);
  } catch (err) {
    statusEl.className = 'upload-status error';
    statusEl.textContent = 'Error: ' + err.message;
  }
}

async function handleUpload(type, input) {
  const file = input.files[0];
  if (!file) return;
  const prefix = type === 'low-value' ? 'LV' : 'Catalog';
  const nameEl = document.getElementById('name' + prefix);
  const statusEl = document.getElementById('status' + prefix);
  nameEl.textContent = file.name;
  statusEl.className = 'upload-status loading';
  statusEl.textContent = 'Uploading ' + file.name + '...';
  statusEl.style.display = 'block';
  try {
    const formData = new FormData();
    formData.append('file', file);
    const endpoint = type === 'low-value' ? '/api/import/low-value' : '/api/import/catalog';
    const resp = await fetch(endpoint, { method: 'POST', body: formData });
    const data = await resp.json();
    if (data.error) throw new Error(data.error);
    statusEl.className = 'upload-status success';
    if (type === 'low-value') {
      statusEl.textContent = 'Imported ' + data.rows + ' rows into ' + data.records + ' style/color records. Refreshing...';
    } else {
      statusEl.textContent = 'Updated ' + data.images + ' style images. Refreshing...';
    }
    input.value = '';
    setTimeout(function(){ window.location.reload(); }, 1500);
  } catch (err) {
    statusEl.className = 'upload-status error';
    statusEl.textContent = 'Error: ' + err.message;
  }
}
// Drag and drop support
['dropLV','dropCatalog'].forEach(function(id) {
  var el = document.getElementById(id);
  if (!el) return;
  var type = id === 'dropLV' ? 'low-value' : 'catalog';
  var inputId = id === 'dropLV' ? 'fileLV' : 'fileCatalog';
  el.addEventListener('dragover', function(e) { e.preventDefault(); el.classList.add('drag-over'); });
  el.addEventListener('dragleave', function() { el.classList.remove('drag-over'); });
  el.addEventListener('drop', function(e) {
    e.preventDefault();
    el.classList.remove('drag-over');
    var input = document.getElementById(inputId);
    input.files = e.dataTransfer.files;
    handleUpload(type, input);
  });
});

// -- Init ------------------------------------
loadData();
</script>
</body>
</html>`;

// -- Start ---------------------------------------------------
initDB().then(async () => {
  // Sync images from product catalog on startup
  await syncCatalogImages();
  // Re-sync every 6 hours
  setInterval(syncCatalogImages, 6 * 60 * 60 * 1000);

  app.listen(PORT, () => {
    console.log('Aged Inventory Report running on port ' + PORT);
  });
}).catch(err => {
  console.error('DB init failed:', err);
  process.exit(1);
});
