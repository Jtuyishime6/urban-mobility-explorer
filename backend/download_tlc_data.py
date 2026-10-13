"""
Download required NYC TLC datasets for this project.

Downloads:
1. yellow_tripdata_<YYYY-MM>.parquet
2. taxi_zone_lookup.csv
3. taxi_zones.zip (optional convenience copy)
"""

from __future__ import annotations

import argparse
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import urlretrieve


TRIPDATA_BASE_URL = "https://d37ci6vzurychx.cloudfront.net/trip-data"
MISC_BASE_URL = "https://d37ci6vzurychx.cloudfront.net/misc"


def download_file(url: str, destination: Path) -> bool:
    """Download a file to destination. Returns True if downloaded in this run."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        print(f"[skip] {destination.name} already exists")
        return False

    print(f"[downloading] {destination.name}")
    try:
        urlretrieve(url, destination)
    except (HTTPError, URLError) as exc:
        print(f"[error] Could not download {url}: {exc}")
        raise
    print(f"[ok] Saved to {destination}")
    return True


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Download NYC TLC trip and lookup data for this project."
    )
    parser.add_argument(
        "--year",
        type=int,
        default=2019,
        help="Trip data year (default: 2019).",
    )
    parser.add_argument(
        "--month",
        type=int,
        default=1,
        choices=range(1, 13),
        metavar="[1-12]",
        help="Trip data month (default: 1).",
    )
    parser.add_argument(
        "--data-dir",
        default=str(Path(__file__).resolve().parent.parent / "data"),
        help="Directory where files are downloaded (default: project data/).",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    data_dir = Path(args.data_dir).resolve()
    month_str = f"{args.month:02d}"
    trip_filename = f"yellow_tripdata_{args.year}-{month_str}.parquet"

    trip_url = f"{TRIPDATA_BASE_URL}/{trip_filename}"
    zone_lookup_url = f"{MISC_BASE_URL}/taxi_zone_lookup.csv"
    taxi_zones_zip_url = f"{MISC_BASE_URL}/taxi_zones.zip"

    download_file(trip_url, data_dir / trip_filename)
    download_file(zone_lookup_url, data_dir / "taxi_zone_lookup.csv")
    download_file(taxi_zones_zip_url, data_dir / "taxi_zones.zip")

    print("\nDownload step complete.")


if __name__ == "__main__":
    main()
