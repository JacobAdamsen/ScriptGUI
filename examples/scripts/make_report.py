"""Write a short text report with summary statistics of a CSV with an y column."""
import argparse
import csv
import statistics


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--in_csv", required=True)
    ap.add_argument("--out_txt", required=True)
    args = ap.parse_args()

    with open(args.in_csv, newline="") as f:
        ys = [float(r["y"]) for r in csv.DictReader(f)]
    if not ys:
        raise SystemExit("No rows to report on")

    lines = [
        "Summary report",
        "==============",
        f"rows : {len(ys)}",
        f"mean : {statistics.mean(ys):.4f}",
        f"stdev: {statistics.pstdev(ys):.4f}",
        f"min  : {min(ys):.4f}",
        f"max  : {max(ys):.4f}",
    ]
    with open(args.out_txt, "w") as f:
        f.write("\n".join(lines) + "\n")
    print("\n".join(lines))
    print(f"Wrote {args.out_txt}")


if __name__ == "__main__":
    main()
