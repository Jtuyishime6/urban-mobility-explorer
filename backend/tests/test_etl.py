import csv
import json
import sqlite3
import tempfile
import unittest
import zipfile
from pathlib import Path

import pyarrow as arrow
import pyarrow.parquet as parquet
import shapefile
from pyproj import CRS

from backend.etl import (
    SCHEMA_PATH,
    RejectedRecord,
    _seed_dimensions,
    _read_zone_geometries,
    clean_record,
    load_trips,
    load_zones,
)


VALID_ZONE_IDS = {1, 2}


def make_record(**overrides):
    record = {
        "tpep_pickup_datetime": "2019-01-01 00:00:00",
        "tpep_dropoff_datetime": "2019-01-01 00:15:00",
        "passenger_count": 1,
        "trip_distance": 3.0,
        "RatecodeID": 1,
        "store_and_fwd_flag": "N",
        "PULocationID": 1,
        "DOLocationID": 2,
        "payment_type": 1,
        "fare_amount": 12.0,
        "extra": 0.5,
        "mta_tax": 0.5,
        "tip_amount": 2.0,
        "tolls_amount": 0.0,
        "improvement_surcharge": 0.3,
        "total_amount": 15.3,
        "congestion_surcharge": 0.0,
        "airport_fee": 0.0,
        "cbd_congestion_fee": 0.0,
    }
    record.update(overrides)
    return record


class CleanRecordTests(unittest.TestCase):
    def test_normalizes_timestamps_and_computes_features(self):
        cleaned, flags = clean_record(make_record(), VALID_ZONE_IDS)
        self.assertEqual(cleaned["pickup_datetime"], "2019-01-01T05:00:00+00:00")
        self.assertEqual(cleaned["duration_seconds"], 900)
        self.assertAlmostEqual(cleaned["average_speed_mph"], 12.0)
        self.assertAlmostEqual(cleaned["fare_per_mile"], 4.0)
        self.assertEqual(flags, [])

    def test_imputes_missing_optional_amount_and_audits_it(self):
        record = make_record()
        record["airport_fee"] = None
        cleaned, flags = clean_record(record, VALID_ZONE_IDS)
        self.assertEqual(cleaned["airport_fee"], 0.0)
        self.assertIn("missing_airport_fee_set_to_zero", flags)

    def test_rejects_outlier_speed(self):
        with self.assertRaisesRegex(RejectedRecord, "average_speed_over_100_mph"):
            clean_record(
                make_record(tpep_dropoff_datetime="2019-01-01 00:00:30"),
                VALID_ZONE_IDS,
            )

    def test_rejects_unknown_zone(self):
        with self.assertRaisesRegex(RejectedRecord, "unknown_pickup_location_id"):
            clean_record(make_record(PULocationID=999), VALID_ZONE_IDS)

    def test_database_schema_has_foreign_keys_and_query_indexes(self):
        connection = sqlite3.connect(":memory:")
        connection.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        indexes = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'index'")}
        self.assertIn("taxi_zones", tables)
        self.assertIn("trips", tables)
        self.assertIn("data_quality_issues", tables)
        self.assertIn("idx_trips_pickup_location_datetime", indexes)
        trip_foreign_keys = {
            row[2]
            for row in connection.execute("PRAGMA foreign_key_list(trips)")
        }
        self.assertEqual(
            trip_foreign_keys,
            {"rate_codes", "taxi_zones", "payment_types"},
        )
        connection.close()

    def test_parquet_ingestion_loads_trips_and_audits_duplicates_and_rejections(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            lookup_path = root / "taxi_zone_lookup.csv"
            geojson_path = root / "taxi_zones.geojson"
            parquet_path = root / "trips.parquet"
            with lookup_path.open("w", newline="", encoding="utf-8") as output:
                writer = csv.DictWriter(
                    output,
                    fieldnames=["LocationID", "Borough", "Zone", "service_zone"],
                )
                writer.writeheader()
                writer.writerows(
                    [
                        {
                            "LocationID": 1,
                            "Borough": "Manhattan",
                            "Zone": "Zone A",
                            "service_zone": "Yellow Zone",
                        },
                        {
                            "LocationID": 2,
                            "Borough": "Manhattan",
                            "Zone": "Zone A",
                            "service_zone": "Boro Zone",
                        },
                    ]
                )
            geojson_path.write_text(
                json.dumps(
                    {
                        "type": "FeatureCollection",
                        "features": [
                            {
                                "type": "Feature",
                                "properties": {"LocationID": zone_id},
                                "geometry": {
                                    "type": "Polygon",
                                    "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 0]]],
                                },
                            }
                            for zone_id in (1, 2)
                        ],
                    }
                ),
                encoding="utf-8",
            )
            valid = make_record(airport_fee=None)
            duplicate = make_record(airport_fee=None)
            outlier = make_record(tpep_dropoff_datetime="2019-01-01 00:00:30")
            parquet.write_table(
                arrow.Table.from_pylist([valid, duplicate, outlier]),
                parquet_path,
            )

            connection = sqlite3.connect(":memory:")
            connection.execute("PRAGMA foreign_keys = ON")
            connection.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
            _seed_dimensions(connection)
            zone_ids = load_zones(connection, lookup_path, geojson_path)
            accepted, rejected = load_trips(connection, parquet_path, zone_ids, batch_size=1)

            self.assertEqual(zone_ids, VALID_ZONE_IDS)
            self.assertEqual((accepted, rejected), (1, 2))
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM trips").fetchone()[0], 1)
            issues = connection.execute(
                "SELECT source_row, status, reason FROM data_quality_issues ORDER BY source_row"
            ).fetchall()
            self.assertEqual(
                issues,
                [
                    (0, "flagged", "missing_airport_fee_set_to_zero (records=1)"),
                    (2, "excluded", "duplicate_trip"),
                    (3, "excluded", "average_speed_over_100_mph"),
                ],
            )
            connection.close()

    def test_shapefile_zip_is_reprojected_to_wgs84(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            shape_dir = root / "shapefiles"
            shape_dir.mkdir()
            shape_path = shape_dir / "taxi_zones.shp"
            writer = shapefile.Writer(str(shape_path), shapeType=shapefile.POLYGON)
            writer.field("LocationID", "N")
            writer.poly(
                [
                    [
                        [990000, 210000],
                        [990000, 210100],
                        [990100, 210100],
                        [990000, 210000],
                    ]
                ]
            )
            writer.record(1)
            writer.close()
            shape_path.with_suffix(".prj").write_text(
                CRS.from_epsg(2263).to_wkt(), encoding="utf-8"
            )
            archive_path = root / "taxi_zones.zip"
            with zipfile.ZipFile(archive_path, "w") as archive:
                for path in shape_dir.iterdir():
                    archive.write(path, f"taxi_zones/{path.name}")

            geometry = _read_zone_geometries(archive_path)[1]
            longitude, latitude = geometry["coordinates"][0][0]
            self.assertGreater(longitude, -75)
            self.assertLess(longitude, -73)
            self.assertGreater(latitude, 40)
            self.assertLess(latitude, 42)


if __name__ == "__main__":
    unittest.main()
