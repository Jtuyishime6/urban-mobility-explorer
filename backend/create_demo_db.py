#!/usr/bin/env python3
"""Build a lightweight SQLite demo database from the full cleaned dataset."""

from __future__ import annotations

import argparse
import sqlite3
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DIMENSION_TABLES = (
    "boroughs",
    "service_zones",
    "taxi_zones",
    "rate_codes",
    "payment_types",
)


def create_demo_database(
    source: Path,
    destination: Path,
    max_trips: int,
    sample_stride: int,
) -> tuple[int, int]:
    if not source.is_file():
        raise FileNotFoundError(f"Source database not found: {source}")
    if max_trips < 1:
        raise ValueError("max_trips must be at least 1")
    if sample_stride < 1:
        raise ValueError("sample_stride must be at least 1")

    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        destination.unlink()

    with sqlite3.connect(destination) as demo:
        demo.execute("PRAGMA foreign_keys = ON")
        demo.execute(f"ATTACH DATABASE ? AS source", (str(source),))

        # Keep every dimension row so the map and filters still work.
        for table in DIMENSION_TABLES:
            demo.execute(f"CREATE TABLE {table} AS SELECT * FROM source.{table}")

        demo.execute(
            """
            CREATE TABLE trips AS
            SELECT *
            FROM source.trips
            WHERE (trip_id % ?) = 0
            ORDER BY trip_id
            LIMIT ?
            """,
            (sample_stride, max_trips),
        )

        # Keep a small audit sample so data-quality demos still have content.
        demo.execute(
            """
            CREATE TABLE data_quality_issues AS
            SELECT *
            FROM source.data_quality_issues
            WHERE (issue_id % 200) = 0
            LIMIT 5000
            """
        )

        demo.execute(
            "CREATE INDEX IF NOT EXISTS idx_trips_pickup_datetime ON trips (pickup_datetime)"
        )
        demo.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_trips_pickup_location_datetime
            ON trips (pickup_location_id, pickup_datetime)
            """
        )
        demo.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_trips_dropoff_location_datetime
            ON trips (dropoff_location_id, pickup_datetime)
            """
        )
        demo.execute("DETACH DATABASE source")
        demo.commit()
        demo.execute("VACUUM")

        trip_count = demo.execute("SELECT COUNT(*) FROM trips").fetchone()[0]
        zone_count = demo.execute("SELECT COUNT(*) FROM taxi_zones").fetchone()[0]
        return int(trip_count), int(zone_count)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source",
        type=Path,
        default=PROJECT_ROOT / "data" / "urban_mobility.sqlite",
        help="Full cleaned SQLite database",
    )
    parser.add_argument(
        "--destination",
        type=Path,
        default=PROJECT_ROOT / "data" / "urban_mobility_demo.sqlite",
        help="Lightweight demo database output path",
    )
    parser.add_argument(
        "--max-trips",
        type=int,
        default=80_000,
        help="Maximum trips to keep in the demo database (default: 80000)",
    )
    parser.add_argument(
        "--sample-stride",
        type=int,
        default=90,
        help="Keep every Nth trip_id so samples span the whole month (default: 90)",
    )
    args = parser.parse_args()

    trips, zones = create_demo_database(
        args.source,
        args.destination,
        args.max_trips,
        args.sample_stride,
    )
    size_mb = args.destination.stat().st_size / (1024 * 1024)
    print(
        f"Demo database ready: {trips:,} trips, {zones:,} zones, "
        f"{size_mb:.1f} MB → {args.destination}"
    )
    print(
        "Start the API with:\n"
        f"  DATABASE_PATH={args.destination} npm --prefix backend start"
    )


if __name__ == "__main__":
    main()
