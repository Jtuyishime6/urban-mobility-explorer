# Urban Mobility Data Explorer

## 📌 Deliverables & Project Links

- **Team Participation Sheet:** [Urban Mobility Analytics - Team Sheet](https://docs.google.com/spreadsheets/d/170hJX_mlW1NxFpZ7_HElOrk321vrqa3xFlHXSUc20IA/edit?usp=sharing)
- **Video Walkthrough (5-Minute Demo):** _[Insert Video Link Here]_
- **Database Schema:** [`database/schema.sql`](database/schema.sql)
- **Algorithm Analysis:** [`backend/algorithms/ALGORITHM.md`](backend/algorithms/ALGORITHM.md)
- **CodeVibe Integrity Reports:** [`codevibe-reports/`](codevibe-reports/)

## Issue 1: Data cleaning and database setup

The Issue 1 pipeline loads a NYC TLC Yellow Taxi Parquet file together with the
taxi zone lookup CSV and spatial boundaries into a normalized SQLite database.
Download the [January 2019 Yellow Taxi Parquet](https://d37ci6vzurychx.cloudfront.net/trip-data/yellow_tripdata_2019-01.parquet),
[taxi zone lookup CSV](https://d37ci6vzurychx.cloudfront.net/misc/taxi_zone_lookup.csv),
and [taxi zone boundary ZIP](https://d37ci6vzurychx.cloudfront.net/misc/taxi_zones.zip)
and place them in `data/raw/`. The boundary loader accepts the provided
`taxi_zones.zip` shapefile or a WGS84 GeoJSON file. Raw datasets and generated
databases are intentionally excluded from Git.

### Setup and run

From the repository root, create an isolated environment and install the
ETL dependencies:

```sh
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r backend/requirements.txt
```

Then run the loader, using the actual filenames you downloaded:

```sh
python backend/etl.py \
  --trips data/raw/yellow_tripdata_2019-01.parquet \
  --zone-lookup data/raw/taxi_zone_lookup.csv \
  --zones data/raw/taxi_zones.zip
```

The default output is `data/urban_mobility.sqlite`. Override it with
`--database /path/to/output.sqlite` if needed. Run
`python -m unittest discover -s backend/tests -v` to test the cleaning rules
and schema without downloading the full dataset.

### Cleaning rules and audit trail

- Naive TLC timestamps are interpreted as New York local time and stored in UTC.
- Trips are excluded when timestamps are invalid, duration is nonpositive or
  exceeds four hours, passenger count is outside 1–8, distance is outside
  `(0, 200]` miles, average speed exceeds 100 mph, fare is outside `(0, 1000]`,
  total is outside `(0, 1500]`, or either location is absent from the zone table.
- Missing optional tax/fee components are set to zero; a missing total is
  calculated from the fare and available components. Invalid optional category
  IDs are stored as `NULL`. These accepted-but-adjusted rows are flagged. A
  field absent from an older source file is treated as not reported, not as a
  per-row error.
- Exact duplicate source rows are detected by a SHA-256 fingerprint. Every
  excluded row is recorded in `data_quality_issues`, including the source
  filename, one-based row number, reason, and a compact summary of relevant
  source fields as JSON. Accepted-row imputations are summarized per reason
  (using source row `0`) so routine missing optional fees do not create
  millions of repetitive audit records.

The relational schema separates boroughs, service zones, taxi zones, rate
codes, and payment types from the trip fact table. It includes zone geometry,
foreign-key constraints, and indexes for date- and location-based trip queries.
Shapefile boundaries are transformed from their declared source projection
into WGS84 before storage.
The trip table also stores derived `duration_seconds`, `average_speed_mph`, and
`fare_per_mile` metrics.

## Issue 2: Backend API

After the ETL has created `data/urban_mobility.sqlite`, start the read-only
Express API from the repository root:

```sh
npm --prefix backend install
npm --prefix backend start
```

The server listens on `http://127.0.0.1:5000` by default. Set `PORT`, `HOST`,
or `DATABASE_PATH` to override the defaults. Startup fails with an explicit
message if the cleaned database is missing; build it using the Issue 1 command
above first.

All routes are read-only JSON endpoints under `/api`:

| Route | Response |
| --- | --- |
| `GET /health` | API/database status |
| `GET /zones` | Taxi zone identifiers, boroughs, names, and GeoJSON geometry |
| `GET /trips/summary` | Filtered trip/passenger/revenue/speed metrics, anomaly counts, and sorted top zones |
| `GET /trips/hourly` | Trip volume and average speed for each New York local hour |
| `GET /trips/revenue` | Average mobility speed by pickup borough (used by the congestion chart) |
| `GET /trips/fare-distance` | Trip counts and average fares across distance buckets |
| `GET /trips/gaps` | Pickup/drop-off imbalances for underserved zones |
| `GET /routes/optimal` | Custom Dijkstra corridor between two zones (binary min-heap) |
| `GET /zones/:zoneId/stats` | Pickup/drop-off and speed comparison metrics for one zone |
| `GET /boroughs/:borough/stats` | Zone count and mobility metrics for one borough |
| `GET /report` | Combined summary, top zones, rush-hour trend, and coverage gaps |

Analytics routes accept `start_date` and `end_date` as `YYYY-MM-DD`; date
boundaries follow the New York calendar (including daylight-saving changes).
`borough` and `zone_id` narrow the analysis, while summary also accepts
`max_distance`, `max_fare`, `sort_by` (`volume`, `speed`, `distance`, `fare`),
and `sort_order` (`asc` or `desc`). The fare-versus-distance dashboard chart
uses the API when available and retains its existing fallback for offline
development.

## Issue 3: Custom algorithm (Dijkstra mobility corridor)

The API includes a **manual** graph algorithm (not library shortest-path helpers):

1. Aggregate cleaned trips into a directed **zone → zone** graph.
2. Weight each edge by average trip duration (seconds).
3. Run **Dijkstra** with a custom **binary min-heap** (decrease-key) to find the
   lowest expected-travel-time corridor between two taxi zones.

Documentation with pseudo-code and Big-O analysis lives in
[`backend/algorithms/ALGORITHM.md`](backend/algorithms/ALGORITHM.md).

Example (API must be running; replace zone IDs with real TLC location IDs):

```sh
curl "http://127.0.0.1:5000/api/routes/optimal?from=161&to=237&start_date=2019-01-01&end_date=2019-01-07"
```

Required query params: `from`, `to`. Optional: `start_date`, `end_date`,
`borough`, `min_trips` (minimum observed trips for an edge to be included).

Run algorithm unit tests (no full Parquet download required):

```sh
npm --prefix backend test
```
