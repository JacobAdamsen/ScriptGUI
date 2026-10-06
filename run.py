"""Start the ScriptGUI server and open it in the browser."""
import argparse
import sys
import threading
import webbrowser

try:
    import uvicorn
except ImportError:
    sys.exit(
        "Missing packages for this Python interpreter:\n"
        f"  {sys.executable}\n\n"
        "Install them with:\n"
        "  python -m pip install -r requirements.txt"
    )


def main() -> None:
    ap = argparse.ArgumentParser(description="Start the ScriptGUI pipeline editor.")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true", help="don't open a browser tab")
    args = ap.parse_args()

    url = f"http://{args.host}:{args.port}"
    if not args.no_browser:
        threading.Timer(1.0, webbrowser.open, args=(url,)).start()
    print(f"ScriptGUI running at {url}  (Ctrl+C to stop)")
    uvicorn.run("scriptgui.server:app", host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
