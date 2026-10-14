# Urban Mobility Data Explorer

Interactive explorer for **NYC TLC Yellow Taxi** trips (January 2019): clean the data into SQLite, serve analytics through a read-only Express API, and visualize hotspots, rush hour, coverage gaps, and optimal mobility corridors in a browser dashboard.

## 📌 Deliverables & Project Links

- **Team Participation Sheet:** [Urban Mobility Analytics - Team Sheet](https://docs.google.com/spreadsheets/d/170hJX_mlW1NxFpZ7_HElOrk321vrqa3xFlHXSUc20IA/edit?usp=sharing)
- **Video Walkthrough (5-Minute Demo):** [https://youtu.be/V09Ui8sU7YY](https://youtu.be/V09Ui8sU7YY)
- **Database Schema:** [`database/schema.sql`](database/schema.sql)
- **Algorithm Analysis:** [`backend/algorithms/ALGORITHM.md`](backend/algorithms/ALGORITHM.md)
- **CodeVibe Integrity Reports:** [`codevibe-reports/`](codevibe-reports/)

This README is meant to be **fully runnable** on its own: prerequisites, install, environment, data load, and how to start **both** the backend and the frontend.

## Demo video

Project walkthrough (UI, architecture, custom algorithm, and technical report):

[https://youtu.be/V09Ui8sU7YY](https://youtu.be/V09Ui8sU7YY)

---

## Prerequisites

| Tool | Version | Why |
| --- | --- | --- |
| Python | 3.10+ recommended | ETL / demo DB scripts |
| Node.js | **≥ 20** | Express API (`better-sqlite3`) |
| npm | comes with Node | Backend dependencies |
| Disk | ~4 GB free for full load | Parquet + full SQLite (~3 GB) |

Optional: a modern browser (Chrome/Firefox/Safari) for the dashboard.

---

## Quick start (demo database)

If a teammate already produced `data/urban_mobility_demo.sqlite` (or you create it below), you can skip the full Parquet download.

**Terminal 1 — backend**

```sh
cd /path/to/urban-mobility-explorer
npm --prefix backend install
DATABASE_PATH=data/urban_mobility_demo.sqlite npm --prefix backend start
```

API: `http://127.0.0.1:5000` · health check: `http://127.0.0.1:5000/api/health`

**Terminal 2 — frontend**

```sh
cd /path/to/urban-mobility-explorer/frontend
python3 -m http.server 8000
```

Open: [http://127.0.0.1:8000/dashboard.html](http://127.0.0.1:8000/dashboard.html)

The dashboard calls the API at `http://127.0.0.1:5000/api` (CORS is enabled for GET). Keep both processes running.

---

## 1. Clone and install

From the repository root:

```sh
# Python environment (ETL)
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
python -m pip install -r backend/requirements.txt

# Node API
npm --prefix backend install
```

---

## 2. Environment setup

No `.env` file is required. The API reads optional environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_PATH` | `data/urban_mobility.sqlite` | Path to the cleaned SQLite DB (relative paths resolve from the **repo root**) |
| `PORT` | `5000` | API listen port |
| `HOST` | `127.0.0.1` | API bind address |

Examples:

```sh
PORT=5000 HOST=127.0.0.1 DATABASE_PATH=data/urban_mobility_demo.sqlite npm --prefix backend start
```

The frontend API base URL is set in `frontend/js/api.js` (`http://127.0.0.1:5000/api`). Change that constant if you alter `HOST`/`PORT`.

---

## 3. Data: download and ETL (Issue 1)

Raw datasets are **not** in Git. Download and place them in `data/raw/`:

1. [January 2019 Yellow Taxi Parquet](https://d37ci6vzurychx.cloudfront.net/trip-data/yellow_tripdata_2019-01.parquet)
2. [Taxi zone lookup CSV](https://d37ci6vzurychx.cloudfront.net/misc/taxi_zone_lookup.csv)
3. [Taxi zone boundaries ZIP](https://d37ci6vzurychx.cloudfront.net/misc/taxi_zones.zip)

Then load (from repo root, venv activated):

```sh
python backend/etl.py \
  --trips data/raw/yellow_tripdata_2019-01.parquet \
  --zone-lookup data/raw/taxi_zone_lookup.csv \
  --zones data/raw/taxi_zones.zip
```

Default output: `data/urban_mobility.sqlite`. Override with `--database /path/to/output.sqlite`.

**Cleaning rules (summary):** New York local timestamps → UTC; reject invalid duration, passenger, distance, speed, fare, total, or unknown zones; impute missing optional fees; fingerprint exact duplicates; write exclusions/flags to `data_quality_issues`. Schema: `database/schema.sql`.

ETL unit tests (no full Parquet required):

```sh
python -m unittest discover -s backend/tests -v
```

### Lightweight demo database

Full January load is ~7.5M trips and several GB. For a laptop demo:

```sh
source .venv/bin/activate
python backend/create_demo_db.py
# → data/urban_mobility_demo.sqlite (~80k trips, all zones kept)
```

Or rebuild a capped DB directly from Parquet:

```sh
python backend/etl.py \
  --trips data/raw/yellow_tripdata_2019-01.parquet \
  --zone-lookup data/raw/taxi_zone_lookup.csv \
  --zones data/raw/taxi_zones.zip \
  --database data/urban_mobility_demo.sqlite \
  --max-trips 80000
```

---

## 4. Launch the backend (Issue 2)

```sh
# Full database (default path)
npm --prefix backend start

# Or demo database
DATABASE_PATH=data/urban_mobility_demo.sqlite npm --prefix backend start
```

Startup fails with a clear message if the SQLite file is missing—run the ETL (or demo script) first.

### API routes (read-only JSON under `/api`)

| Route | Response |
| --- | --- |
| `GET /api/health` | API / database status |
| `GET /api/zones` | Zone IDs, boroughs, names, GeoJSON |
| `GET /api/trips/summary` | KPIs, anomaly counts, top zones |
| `GET /api/trips/hourly` | Volume and speed by New York local hour |
| `GET /api/trips/revenue` | Average mobility speed by pickup borough |
| `GET /api/trips/fare-distance` | Counts / avg fares by distance bucket |
| `GET /api/trips/gaps` | Pickup / drop-off imbalances |
| `GET /api/routes/optimal` | Custom Dijkstra corridor between two zones |
| `GET /api/zones/:zoneId/stats` | Per-zone comparison metrics |
| `GET /api/boroughs/:borough/stats` | Per-borough metrics |
| `GET /api/report` | Combined summary for the report modal |

Common query params: `start_date`, `end_date` (`YYYY-MM-DD`, New York calendar), `borough`, `zone_id`. Summary also accepts `max_distance`, `max_fare`, `sort_by` (`volume` \| `speed` \| `distance` \| `fare`), `sort_order` (`asc` \| `desc`).

Backend tests:

```sh
npm --prefix backend test
```

---

## 5. Launch the frontend

The UI is static HTML/CSS/JS (no bundler). From a **second terminal**:

```sh
cd frontend
python3 -m http.server 8000
```

Then open:

- Landing / auth-style entry: [http://127.0.0.1:8000/index.html](http://127.0.0.1:8000/index.html)
- Main dashboard: [http://127.0.0.1:8000/dashboard.html](http://127.0.0.1:8000/dashboard.html)

Alternative static servers (any one is fine):

```sh
npx --yes serve -l 8000 frontend
# or
npx --yes http-server frontend -p 8000 -c-1
```

**Do not** open `dashboard.html` via `file://` if the browser blocks cross-origin requests to the API; use the local HTTP server above.

---

## Issue 3: Custom algorithm (Dijkstra mobility corridor)

Manual graph algorithm (not library shortest-path helpers):

1. Aggregate cleaned trips into a directed **zone → zone** graph.
2. Weight each edge by average trip duration (seconds).
3. Run **Dijkstra** with a custom **binary min-heap** (decrease-key).

Docs (pseudo-code + Big-O): [`backend/algorithms/ALGORITHM.md`](backend/algorithms/ALGORITHM.md).

```sh
curl "http://127.0.0.1:5000/api/routes/optimal?from=161&to=237&start_date=2019-01-01&end_date=2019-01-07"
```

Required: `from`, `to`. Optional: `start_date`, `end_date`, `borough`, `min_trips`.

---

## Project layout

```
urban-mobility-explorer/
├── README.md
├── docs/technical-report.pdf   # Course documentation (2–3 pages)
├── backend/
│   ├── etl.py                  # Clean + load Parquet → SQLite
│   ├── create_demo_db.py       # Sample DB for demos
│   ├── server.js / app.js      # Express API
│   ├── algorithms/             # Binary heap + Dijkstra
│   └── requirements.txt / package.json
├── frontend/                   # Static dashboard (Leaflet + Chart.js)
├── database/schema.sql
└── data/                       # raw/ + sqlite (gitignored content)
```

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `SQLite database not found` | Run `etl.py` or `create_demo_db.py`; set `DATABASE_PATH` correctly from repo root |
| Dashboard KPIs stay empty / network errors | Confirm API is up (`/api/health`) and frontend uses port `5000` |
| CORS / blocked fetch with `file://` | Serve `frontend/` over HTTP (step 5) |
| `better-sqlite3` build errors | Use Node ≥ 20; re-run `npm --prefix backend install` |
| Out of disk during ETL | Use `--max-trips` or `create_demo_db.py` |

---

## Documentation

Course technical write-up (problem framing, architecture, algorithm, insights, reflection):

- HTML source: [`docs/technical-report.html`](docs/technical-report.html)
- PDF: [`docs/technical-report.pdf`](docs/technical-report.pdf)
