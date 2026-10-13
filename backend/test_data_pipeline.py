import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import pandas as pd

import data_pipeline as pipeline
import db


def raw_trip(**changes):
    row = {
        'VendorID': 2, 'RatecodeID': 1, 'payment_type': 1,
        'tpep_pickup_datetime': '2019-01-01 08:00:00',
        'tpep_dropoff_datetime': '2019-01-01 08:10:00',
        'PULocationID': 1, 'DOLocationID': 2,
        'passenger_count': 1, 'trip_distance': 2.0,
        'fare_amount': 10.0, 'tip_amount': 2.0, 'total_amount': 12.0,
        'extra': 0.0, 'mta_tax': 0.0, 'tolls_amount': 0.0,
        'improvement_surcharge': 0.0, 'congestion_surcharge': None,
        'airport_fee': None, 'store_and_fwd_flag': 'N',
    }
    row.update(changes)
    return row


class NormalizedPipelineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.database = self.root / 'mobility.db'
        self.zones = self.root / 'zones.csv'
        pd.DataFrame([
            {'LocationID': 1, 'Borough': 'Manhattan', 'Zone': 'A', 'service_zone': 'Yellow'},
            {'LocationID': 2, 'Borough': 'Queens', 'Zone': 'B', 'service_zone': None},
        ]).to_csv(self.zones, index=False)
        self.zone_patch = patch.object(pipeline, 'ZONES_CSV', self.zones)
        self.zone_patch.start()
        self.addCleanup(self.zone_patch.stop)
        self.db_patch = patch.object(db, 'DB_PATH', str(self.database))
        self.db_patch.start()
        self.addCleanup(self.db_patch.stop)
        spatial_patch = patch.object(pipeline, 'load_spatial_metadata', return_value=None)
        spatial_patch.start()
        self.addCleanup(spatial_patch.stop)

    def parquet(self, rows, name='trips.parquet'):
        path = self.root / name
        pd.DataFrame(rows).to_parquet(path, index=False)
        return path

    def run_pipeline(self, paths, **kwargs):
        return pipeline.run_pipeline(paths, db_path=self.database, **kwargs)

    def connection(self):
        conn = db.get_db_connection()
        self.addCleanup(conn.close)
        return conn

    def test_related_rows_dimensions_nulls_and_short_duration(self):
        short = raw_trip(
            VendorID=4, RatecodeID=99, payment_type=2,
            tpep_pickup_datetime='2019-01-01 09:00:00',
            tpep_dropoff_datetime='2019-01-01 09:00:01',
            trip_distance=0.001, tip_amount=None, total_amount=10.0,
        )
        result = self.run_pipeline([self.parquet([raw_trip(), short])], batch_size=1)
        self.assertEqual(result, {'zones': 2, 'trips': 2, 'excluded': 0})
        conn = self.connection()
        for table in ['trips', 'trip_fares', 'trip_metrics', 'trip_details']:
            self.assertEqual(conn.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0], 2)
        self.assertEqual(conn.execute('PRAGMA foreign_key_check').fetchall(), [])
        self.assertEqual(conn.execute('PRAGMA foreign_keys').fetchone()[0], 1)
        fares = conn.execute('SELECT * FROM trip_fares WHERE trip_id=2').fetchone()
        self.assertIsNone(fares['tip_amount'])
        self.assertIsNone(fares['airport_fee'])
        self.assertEqual(conn.execute('SELECT vendor_name FROM vendors WHERE vendor_id=4')
                         .fetchone()[0], 'Unmapped TLC code 4')
        metrics = conn.execute('SELECT * FROM trip_metrics WHERE trip_id=2').fetchone()
        self.assertAlmostEqual(metrics['trip_duration_minutes'], 1 / 60)
        self.assertAlmostEqual(metrics['speed_mph'], 3.6)
        self.assertEqual(metrics['pickup_weekday'], 1)
        self.assertEqual(metrics['pickup_hour'], 9)
        with self.assertRaises(sqlite3.IntegrityError):
            conn.execute('UPDATE trips SET pickup_location_id=999')
        conn.rollback()
        with conn:
            conn.execute('DELETE FROM trips WHERE trip_id=2')
        self.assertEqual(conn.execute('SELECT COUNT(*) FROM trip_fares').fetchone()[0], 1)
        self.assertEqual(conn.execute('SELECT COUNT(*) FROM trip_metrics').fetchone()[0], 1)

    def test_thresholds_and_exclusion_reasons(self):
        cases = [
            (raw_trip(passenger_count=None), 'missing_values'),
            (raw_trip(passenger_count=0), 'outlier_passenger_count'),
            (raw_trip(passenger_count=1.5), 'invalid_identifier'),
            (raw_trip(trip_distance=float('inf')), 'invalid_numeric'),
            (raw_trip(fare_amount='bad'), 'invalid_numeric'),
            (raw_trip(fare_amount=501), 'outlier_fare_amount'),
            (raw_trip(trip_distance=100.01), 'outlier_trip_distance'),
            (raw_trip(PULocationID=999), 'unknown_zone'),
            (raw_trip(tip_amount=-1), 'negative_amount'),
            (raw_trip(total_amount=9), 'invalid_total_amount'),
            (raw_trip(tpep_dropoff_datetime='bad'), 'invalid_datetime'),
            (raw_trip(tpep_dropoff_datetime='2019-01-01 08:00:00'), 'outlier_duration'),
            (raw_trip(trip_distance=21), 'outlier_speed'),
            (raw_trip(store_and_fwd_flag='X'), 'invalid_category'),
        ]
        for row, reason in cases:
            with self.subTest(reason=reason):
                cleaned, log = pipeline.clean_and_validate(
                    pipeline.standardize_columns(pd.DataFrame([row])),
                    valid_zone_ids={1, 2},
                )
                self.assertTrue(cleaned.empty)
                self.assertEqual(log['reason'].tolist(), [reason])
        boundaries = [
            raw_trip(passenger_count=6, trip_distance=100, fare_amount=500,
                     total_amount=500, tpep_dropoff_datetime='2019-01-01 14:00:00'),
            raw_trip(tpep_dropoff_datetime='2019-01-01 08:01:00'),
        ]
        result = self.run_pipeline([self.parquet(boundaries)])
        self.assertEqual(result['trips'], 2)
        self.assertEqual(result['excluded'], 0)
        self.assertEqual(self.connection().execute('SELECT MAX(speed_mph) FROM trip_metrics')
                         .fetchone()[0], 120)

    def test_duplicates_across_batches_and_files_keep_distinct_payments(self):
        first = self.parquet([raw_trip(), raw_trip()], 'first.parquet')
        second = self.parquet([raw_trip(), raw_trip(payment_type=2)], 'second.parquet')
        result = self.run_pipeline([first, second], batch_size=1)
        self.assertEqual(result['trips'], 2)
        self.assertEqual(result['excluded'], 2)
        log = self.connection().execute(
            'SELECT filename, row_index, reason FROM exclusion_log ORDER BY id'
        ).fetchall()
        self.assertEqual([tuple(row) for row in log],
                         [('first.parquet', 1, 'duplicate'), ('second.parquet', 0, 'duplicate')])

    def test_failure_preserves_database_and_success_backs_it_up(self):
        good = self.parquet([raw_trip()])
        self.run_pipeline([good])
        original = self.database.read_bytes()
        bad = self.parquet([{'VendorID': 1}], 'bad.parquet')
        with self.assertRaisesRegex(ValueError, 'missing required columns'):
            self.run_pipeline([good, bad])
        self.assertEqual(self.database.read_bytes(), original)
        self.assertEqual(list(self.root.glob('mobility-build-*')), [])
        self.run_pipeline([good])
        backups = list(self.root.glob('mobility.db.*.bak'))
        self.assertEqual(len(backups), 1)
        with sqlite3.connect(backups[0]) as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM trips').fetchone()[0], 1)
        self.assertEqual(self.connection().execute('SELECT COUNT(*) FROM trips').fetchone()[0], 1)

    def test_legacy_database_requires_rebuild_and_is_backed_up(self):
        with sqlite3.connect(self.database) as conn:
            conn.execute('CREATE TABLE trips (id INTEGER PRIMARY KEY, fare_amount REAL)')
            conn.execute('INSERT INTO trips VALUES (42, 7)')
        self.assertFalse(db.is_db_ready())
        with self.assertRaisesRegex(RuntimeError, 'Legacy flat database'):
            db.init_db()
        self.run_pipeline([self.parquet([raw_trip()])])
        self.assertTrue(db.is_db_ready())
        with sqlite3.connect(next(self.root.glob('mobility.db.*.bak'))) as conn:
            self.assertEqual(conn.execute('SELECT id FROM trips').fetchone()[0], 42)
        db.init_db()
        self.assertEqual(self.connection().execute('SELECT COUNT(*) FROM trips').fetchone()[0], 1)

    def test_missing_input_and_all_excluded(self):
        with self.assertRaises(FileNotFoundError):
            self.run_pipeline([])
        self.assertFalse(self.database.exists())
        result = self.run_pipeline([self.parquet([raw_trip(passenger_count=0)])])
        self.assertEqual(result['trips'], 0)
        self.assertEqual(result['excluded'], 1)
        self.assertEqual(self.connection().execute('SELECT COUNT(*) FROM trips').fetchone()[0], 0)

    def test_official_na_zone_labels_are_not_missing_values(self):
        pd.DataFrame([
            {'LocationID': 264, 'Borough': 'Unknown', 'Zone': 'N/A', 'service_zone': 'N/A'},
            {'LocationID': 265, 'Borough': 'N/A', 'Zone': 'Outside of NYC', 'service_zone': 'N/A'},
        ]).to_csv(self.zones, index=False)
        result = self.run_pipeline([self.parquet([
            raw_trip(PULocationID=264, DOLocationID=265),
        ])])
        self.assertEqual(result['trips'], 1)
        conn = self.connection()
        self.assertEqual(conn.execute('SELECT zone FROM zones WHERE location_id=264')
                         .fetchone()[0], 'N/A')
        self.assertEqual(conn.execute('SELECT borough FROM zones WHERE location_id=265')
                         .fetchone()[0], 'N/A')

    def test_sampling_and_batch_size_do_not_change_cleaning(self):
        path = self.parquet([
            raw_trip(), raw_trip(), raw_trip(payment_type=2),
            raw_trip(passenger_count=0),
        ])
        small = self.run_pipeline([path], batch_size=1)
        large = self.run_pipeline([path], batch_size=100)
        self.assertEqual(small, large)
        sample = self.run_pipeline([path], nrows=2, batch_size=100)
        self.assertEqual(sample, {'zones': 2, 'trips': 1, 'excluded': 1})

    def test_joined_view_preserves_trip_fields_and_supports_filtering(self):
        second = raw_trip(
            tpep_pickup_datetime='2019-01-01 22:00:00',
            tpep_dropoff_datetime='2019-01-01 22:20:00',
            PULocationID=2, DOLocationID=1, fare_amount=20.0, total_amount=22.0,
        )
        self.run_pipeline([self.parquet([raw_trip(), second])])
        conn = self.connection()
        records = conn.execute(
            'SELECT t.* FROM trip_details t JOIN zones z '
            'ON z.location_id = t.pickup_location_id WHERE z.borough = ?',
            ('Manhattan',),
        ).fetchall()
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]['id'], 1)
        self.assertEqual(records[0]['fare_amount'], 10)
        self.assertEqual(records[0]['speed_mph'], 12)
        self.assertEqual(conn.execute('SELECT AVG(fare_amount) FROM trip_details')
                         .fetchone()[0], 15)
        self.assertEqual(conn.execute('SELECT SUM(fare_amount) FROM trip_details')
                         .fetchone()[0], 30)


if __name__ == '__main__':
    unittest.main()
