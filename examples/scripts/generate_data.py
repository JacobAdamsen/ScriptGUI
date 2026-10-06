"""Generate a noisy sine-wave dataset as CSV."""
import argparse
import csv
import math
import random
import time


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out_csv", required=True, help="where to write the generated data")
    ap.add_argument("--n", type=int, default=100, help="number of rows")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    rng = random.Random(args.seed)
    print(f"Generating {args.n} rows (seed={args.seed})")
    step = max(args.n // 4, 1)
    with open(args.out_csv, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["x", "y"])
        for i in range(args.n):
            x = i / max(args.n - 1, 1) * 4 * math.pi
            w.writerow([round(x, 4), round(math.sin(x) + rng.gauss(0, 0.3), 4)])
            if (i + 1) % step == 0:
                print(f"  {i + 1}/{args.n} rows")
                time.sleep(0.2)  # slow down a bit so the live status is visible
    print(f"Wrote {args.out_csv}")


if __name__ == "__main__":
    main()
