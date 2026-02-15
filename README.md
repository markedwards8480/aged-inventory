# Aged Inventory — Jobber Review Dashboard

Interactive dashboard for identifying old inventory to sell to jobbers.
Built to match the same stack as the Product Catalog and Open Orders apps.

## Stack
- **Node.js / Express** — same as product-catalog and open-order
- **PostgreSQL** — Railway managed database
- **Zoho WorkDrive** — image proxy for CAD/style images

## Deploy to Railway

1. Create a new project on Railway
2. Add a PostgreSQL plugin
3. Connect this GitHub repo
4. Set environment variables (see `.env.example`):
   - `ZOHO_REFRESH_TOKEN` — same token as your other Zoho apps
   - `ZOHO_CLIENT_ID` / `ZOHO_CLIENT_SECRET` — same OAuth credentials
5. Railway auto-deploys on push

## Data Import

### Webhook / Scheduled Import
Set up Zoho scheduled workflows to POST CSV data to:

| Endpoint | CSV Source | Frequency |
|----------|-----------|-----------|
| `POST /api/import/low-value` | Felix's Low Value Inventory Query | Daily/Weekly |
| `POST /api/import/catalog` | Available Now report | Daily |
| `POST /api/import/catalog` | Left to Sell report | Daily |

Each endpoint accepts either:
- **Multipart file upload** (`file` field) — for manual uploads
- **Raw CSV in body** (`csv` field) — for webhook payloads

### Manual Upload
Upload CSVs via curl:
```bash
curl -X POST https://your-app.railway.app/api/import/low-value -F file=@Low_Value_Inventory_Query.csv
curl -X POST https://your-app.railway.app/api/import/catalog -F file=@Available_Now.csv
curl -X POST https://your-app.railway.app/api/import/catalog -F file=@Left_to_Sell.csv
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Main dashboard |
| GET | `/api/inventory` | All inventory data (JSON) |
| GET | `/api/stats` | Dashboard summary stats |
| GET | `/api/age-brackets` | Age bracket breakdown |
| GET | `/api/image-proxy?url=` | Proxied Zoho image |
| POST | `/api/import/low-value` | Import Low Value Inventory CSV |
| POST | `/api/import/catalog` | Import catalog CSV (Available Now or Left to Sell) |
| POST | `/api/flag` | Flag/unflag items for jobber |
| GET | `/api/export-flagged` | Download flagged items as CSV |
