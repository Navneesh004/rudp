"""Turn benchmark output into charts for the README.

    pip install -r bench/requirements.txt
    python bench/plot.py

Reads  results/results.csv, results/cwnd.csv (from bench/run.sh)
       results/sim_results.csv, results/sim_cwnd.csv (from npm run bench:sim -- --out results)
Writes throughput.png, cwnd.png, sim_throughput.png, sim_cwnd.png in results/
"""

from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import pandas as pd  # noqa: E402

RESULTS = Path(__file__).resolve().parent.parent / "results"
COLORS = {"rudp": "#2563eb", "tcp": "#9ca3af"}


def plot_throughput() -> None:
    path = RESULTS / "results.csv"
    if not path.exists():
        print(f"skipping throughput chart: {path} not found (run bench/run.sh first)")
        return
    df = pd.read_csv(path)
    fig, ax = plt.subplots(figsize=(7, 4.2), dpi=150)
    for proto, group in df.groupby("protocol"):
        group = group.sort_values("loss_pct")
        mode = group["mode"].dropna().iloc[0] if group["mode"].notna().any() else ""
        label = f"RUDP ({mode})" if proto == "rudp" else "TCP (Linux kernel)"
        ax.errorbar(
            group["loss_pct"],
            group["throughput_mbps"],
            yerr=group.get("throughput_std"),
            marker="o",
            capsize=3,
            linewidth=2,
            color=COLORS.get(proto),
            label=label,
        )
    delay = int(df["delay_ms"].iloc[0])
    size = int(df["size_mb"].iloc[0])
    ax.set_title(f"Throughput vs packet loss ({delay} ms delay, {size} MB file)")
    ax.set_xlabel("Packet loss (%)")
    ax.set_ylabel("Throughput (MB/s)")
    ax.set_ylim(bottom=0)
    ax.grid(alpha=0.3)
    ax.legend(frameon=False)
    fig.tight_layout()
    out = RESULTS / "throughput.png"
    fig.savefig(out)
    print(f"wrote {out}")


def plot_sim_throughput() -> None:
    path = RESULTS / "sim_results.csv"
    if not path.exists():
        print(f"skipping simulator chart: {path} not found (run `npm run bench:sim -- --out results`)")
        return
    df = pd.read_csv(path)
    styles = {
        "sr": ("Selective repeat", "#2563eb"),
        "gbn": ("Go-Back-N", "#f59e0b"),
        "saw": ("Stop-and-wait", "#9ca3af"),
    }
    fig, ax = plt.subplots(figsize=(7, 4.2), dpi=150)
    for mode, (label, color) in styles.items():
        group = df[df["mode"] == mode].sort_values("loss_pct")
        ax.plot(group["loss_pct"], group["throughput_mbps"], marker="o", linewidth=2, color=color, label=label)
    rtt = int(df["rtt_ms"].iloc[0])
    ax.set_yscale("log")
    ax.set_title(f"Simulated throughput vs packet loss ({rtt} ms RTT, 1 MiB, NewReno)")
    ax.set_xlabel("Packet loss on the data path (%)")
    ax.set_ylabel("Throughput (MB/s, log scale)")
    ax.grid(alpha=0.3, which="both")
    ax.legend(frameon=False)
    fig.tight_layout()
    out = RESULTS / "sim_throughput.png"
    fig.savefig(out)
    print(f"wrote {out}")


def plot_cwnd(csv_name: str = "cwnd.csv", png_name: str = "cwnd.png", subtitle: str = "") -> None:
    path = RESULTS / csv_name
    if not path.exists():
        print(f"skipping cwnd chart: {path} not found")
        return
    df = pd.read_csv(path)
    t = df["t_ms"] / 1000
    fig, ax = plt.subplots(figsize=(7, 4.2), dpi=150)
    ax.step(t, df["cwnd"], where="post", color=COLORS["rudp"], linewidth=1.5, label="cwnd")
    # ssthresh starts "infinite" (the window cap); only draw it once a loss has set it.
    cap = df["ssthresh"].iloc[0]
    ss = df["ssthresh"].where(df["ssthresh"] < cap)
    ax.step(t, ss, where="post", color="#dc2626", linestyle="--", linewidth=1, label="ssthresh")
    ax.set_title(f"Congestion window over time{subtitle}")
    ax.set_xlabel("Time (s)")
    ax.set_ylabel("Segments")
    ax.set_ylim(bottom=0)
    ax.grid(alpha=0.3)
    ax.legend(frameon=False)
    fig.tight_layout()
    out = RESULTS / png_name
    fig.savefig(out)
    print(f"wrote {out}")


if __name__ == "__main__":
    plot_throughput()
    plot_cwnd()
    plot_sim_throughput()
    plot_cwnd("sim_cwnd.csv", "sim_cwnd.png", " (simulated 1 MB/s bottleneck, 50 ms RTT)")
