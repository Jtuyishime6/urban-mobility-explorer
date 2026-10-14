# Urban Mobility Data Explorer

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
