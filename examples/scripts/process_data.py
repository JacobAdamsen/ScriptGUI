"""Keep only the rows whose y value is at least --threshold."""
import argparse
import csv
import time


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--in_csv", required=True)
    ap.add_argument("--out_csv", required=True)
    ap.add_argument("--threshold", type=float, default=0.0)
    args = ap.parse_args()

    with open(args.in_csv, newline="") as f:
        rows = list(csv.DictReader(f))
    print(f"Read {len(rows)} rows from {args.in_csv}")
    time.sleep(0.5)

    kept = [r for r in rows if float(r["y"]) >= args.threshold]
    with open(args.out_csv, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["x", "y"])
        w.writeheader()
        w.writerows(kept)
    print(f"Kept {len(kept)} rows with y >= {args.threshold}")
    print(f"Wrote {args.out_csv}")


if __name__ == "__main__":
    main()
