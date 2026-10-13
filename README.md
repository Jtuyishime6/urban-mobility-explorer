# Urban Mobility Data Explorer

NYC Taxi & Limousine Commission (TLC) data preparation and normalized relational
storage, alongside the team's existing frontend.

## Aimable Bancunguye's contribution

This branch implements the data-download, cleaning, and database tasks:

- [Downloader](./backend/download_tlc_data.py) for yellow taxi trip Parquet,
  zone lookup CSV, and spatial metadata ZIP.
- [Pipeline](./backend/data_pipeline.py) that processes Parquet in batches,
  cleans missing values, duplicates, and outliers, and records exclusions.
- [Normalized SQLite schema](./database/schema_sqlite_normalized.sql), relational
  loading, enforced foreign keys, indexes, and derived metrics.
- [PostgreSQL schema reference](./database/schema_postgres_normalized.sql).
  PostgreSQL loading is not implemented.
- Atomic database rebuilds: validation before replacement, backups of existing
  databases, and preservation of the previous database if a run fails.
- [Tests](./backend/test_data_pipeline.py) for cleaning, relationships,
  thresholds, duplicate handling, backups, and query output.

**Scope:** This branch does not implement a Flask API, authentication, or DSA
algorithms. The existing frontend is unchanged and is not yet connected to this
database. Its offline/mock displays are not evidence of real database results.
Backend integration is a separate team task.

## Setup

Python 3.9 or newer is required. Python 3.12 was used for validation.
Run commands from the repository root.

```bash
git clone https://github.com/Jtuyishime6/urban-mobility-explorer.git
cd urban-mobility-explorer
```

Before this branch is merged, check it out after it has been published:

```bash
git switch feat/tlc-data-normalized-schema
```

### macOS / Linux

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r backend/requirements.txt
```

### Windows PowerShell

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r backend/requirements.txt
```

If `.venv` already exists, activate it rather than recreate it.

## 1. Download the raw data

```bash
python backend/download_tlc_data.py --year 2019 --month 1
```

Files are saved in [data/](./data/):

- `yellow_tripdata_2019-01.parquet`
- `taxi_zone_lookup.csv`
- `taxi_zones.zip`

Existing files are skipped. The CSV is the official zone lookup dimension,
not a CSV copy of the trip Parquet data. Raw files and generated databases are
ignored by Git, so a fresh clone must download and build them locally.

Official source: https://www.nyc.gov/site/tlc/about/tlc-trip-record-data.page

Spatial polygons are not stored in the relational tables. The pipeline can
inspect local GeoJSON or an extracted shapefile when available, but shapefile
reading requires optional `geopandas`, which is not installed by the basic
setup. Without it, the pipeline prints a notice and still loads all zone
lookup relationships. Map/API integration is outside this contribution.

## 2. Clean and load normalized SQLite tables

For a safe sample without replacing the main database:

```bash
python backend/data_pipeline.py --nrows 10000 --db-path database/sample.db
```

To build the full main database:

```bash
python backend/data_pipeline.py
```

The default output is `database/mobility.db`. `--nrows` limits raw rows **per
file**; omit it to process all available yellow taxi Parquet files. The default
batch size is 100,000 rows and can be changed with `--batch-size`.
The full January 2019 run takes several minutes and produces a database of
approximately 2.3 GB.

Existing databases are backed up beside the target as
`mobility.db.<timestamp>.bak`. The pipeline builds a temporary database, verifies
relationships and foreign keys, then replaces the target only on success.
Close database viewers and stop any future API server before rebuilding.
Do not run SQL schema files manually; the SQLite pipeline initializes its schema.

## Cleaning decisions

- Required missing values, malformed/non-finite numbers, fractional IDs, and
  pickup/dropoff IDs absent from the zone lookup are excluded.
- Valid base fares are `(0, 500]` dollars, distances `(0, 100]` miles, and
  integer passenger counts `[1, 6]`.
- Valid durations are `(0, 360]` minutes; speeds above 120 mph are excluded,
  not clipped.
- Negative monetary amounts, totals below the base fare, invalid timestamps,
  and invalid store-and-forward flags are excluded.
- Missing optional fare components and categorical IDs remain SQL NULL.
- Official `N/A` labels for zones 264 and 265 are preserved as categorical text.
- Duplicate detection uses all normalized trip and fare fields, within and
  across batches/files. Each excluded source row gets one reason, filename,
  and zero-based row index in `exclusion_log`.
- Timestamps are standardized as New York local, timezone-naive values.
  Cleaning thresholds do not depend on the batch size.

## Database structure

| Table | Purpose |
|-------|---------|
| `zones` | Official pickup/dropoff zone lookup |
| `vendors`, `rate_codes`, `payment_types` | Observed categorical IDs and labels |
| `trips` | Core trip data and dimension foreign keys |
| `trip_fares` | Itemized fares; primary key references a trip |
| `trip_metrics` | Derived metrics; primary key references a trip |
| `exclusion_log` | Cleaning audit trail |

Every loaded trip has one fare row and one metrics row. Cascading deletes
remove these related rows when a trip is deleted. The read-only `trip_details`
view joins the three trip tables for future API queries.
Unmapped TLC categorical codes are retained with an explicit
`Unmapped TLC code <id>` label rather than a guessed description.

| Derived feature | Calculation / justification |
|-----------------|-----------------------------|
| `trip_duration_minutes` | Dropoff minus pickup; travel time analysis |
| `fare_per_mile` | Base fare divided by distance; pricing comparison |
| `speed_mph` | Distance divided by duration in hours; congestion proxy |
| `pickup_hour` | Local pickup hour; demand by hour |
| `pickup_weekday` | Monday = 0 through Sunday = 6; weekly demand patterns |

The PostgreSQL SQL file is a design reference only and includes destructive
table drops. Do not execute it against a database containing valuable data.

## 3. Inspect database results

Open `database/mobility.db` with a SQLite viewer, or, if the `sqlite3` command
is installed:

```bash
sqlite3 database/mobility.db
```

Then run:

```sql
SELECT COUNT(*) FROM trips;
SELECT COUNT(*) FROM trip_fares;
SELECT COUNT(*) FROM trip_metrics;
SELECT reason, COUNT(*) FROM exclusion_log GROUP BY reason;
PRAGMA foreign_key_check;
SELECT * FROM trip_details LIMIT 5;
```

The first three counts should match. `PRAGMA foreign_key_check` should return
no rows. Use `.quit` to leave the SQLite shell.

### Full January 2019 results

| Measure | Count |
|---------|------:|
| Raw records processed | 7,696,617 |
| Cleaned trips loaded | 7,465,435 |
| Excluded records logged | 231,182 |
| Zone lookup records | 265 |

These results come from the migrated pipeline's completed January 2019 run.
Raw count equals cleaned trips plus logged exclusions. No foreign-key
violations were found. Results can differ for another month or a sample run.

## 4. Run tests

```bash
python -m unittest discover -s backend -p 'test_*.py'
```

Tests use temporary databases, not the main local database. Expect `OK`.

## 5. Preview the team's existing frontend

From the project root, with the Python environment activated:

```bash
python -m http.server 8000 --bind 127.0.0.1 --directory frontend
```

Open http://127.0.0.1:8000/dashboard.html in your browser. The landing page is
http://127.0.0.1:8000/. Keep the terminal running and use Control+C to stop it.

**Port 8000 is the static frontend server.** The frontend expects a backend on
port 5000, but this repository does not yet implement that backend. There is
no `backend/app.py` to run on this branch. Some frontend modules use mock data
when requests fail; inspect SQLite directly to verify this contribution.
