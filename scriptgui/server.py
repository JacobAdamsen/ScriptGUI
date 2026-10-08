"""FastAPI app: serves the editor, the REST API and the run WebSocket."""
from __future__ import annotations

import asyncio
import ipaddress
import json
import os
import re
import subprocess
import sys
import threading
from dataclasses import asdict
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ValidationError
from starlette.middleware.trustedhost import TrustedHostMiddleware

from . import runner
from .models import Pipeline
from .runner import PROJECT_ROOT, Runner, resolve

STATIC_DIR = PROJECT_ROOT / "static"
SAVED_DIR = PROJECT_ROOT / "pipelines"          # legacy save location, still listed under Open
EXAMPLES_DIR = PROJECT_ROOT / "examples" / "pipelines"
RECENT_FILE = Path.home() / ".scriptgui" / "recent.json"  # outside the repo on purpose
SKIP_DIRS = {"__pycache__", "venv", "env", "node_modules", "site-packages"}
NAME_RE = re.compile(r"^[\w\- .]+$")
MAX_SCRIPTS, MAX_DEPTH, MAX_RECENT = 500, 4, 10

app = FastAPI(title="ScriptGUI")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

# ---------------------------------------------------------------- security
# ScriptGUI runs programs on this PC, so only its own page may talk to it:
# - Client check: only connections from this PC, even if the server was started on a
#   network address (run.py never does that, but e.g. `uvicorn --host 0.0.0.0` would).
# - Host check: blocks DNS-rebinding pages that pretend to be 127.0.0.1.
# - Origin check: blocks other websites open in the browser (WebSockets are not
#   covered by the browser's same-origin protection, so /ws/run checks it itself).
LOCAL_HOSTS = ["127.0.0.1", "localhost"]
app.add_middleware(TrustedHostMiddleware, allowed_hosts=LOCAL_HOSTS)


def same_origin(headers) -> bool:
    """True unless a browser says the request comes from another site. Requests without an
    Origin header (same-page GETs, scripts, curl) can't be made by other websites' pages."""
    origin = headers.get("origin")
    if origin is None:
        return True
    o = urlsplit(origin)
    return o.scheme == "http" and o.hostname in LOCAL_HOSTS and o.netloc == headers.get("host")


def is_local_client(client) -> bool:
    """True if the connection comes from this PC (a loopback address)."""
    if client is None:
        return False
    try:
        addr = ipaddress.ip_address(client.host)
    except ValueError:
        return False
    if getattr(addr, "ipv4_mapped", None):   # ::ffff:127.0.0.1
        addr = addr.ipv4_mapped
    return addr.is_loopback


@app.middleware("http")
async def reject_cross_site(request, call_next):
    if not is_local_client(request.client):
        return JSONResponse({"detail": "Only connections from this PC are allowed"}, status_code=403)
    if not same_origin(request.headers):
        return JSONResponse({"detail": "Cross-site request blocked"}, status_code=403)
    return await call_next(request)


@app.middleware("http")
async def no_cache(request, call_next):
    """Always revalidate the frontend files so edits show up on reload."""
    response = await call_next(request)
    if request.url.path == "/" or request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


def pipeline_base(pipeline_file: str) -> Path:
    """Folder that relative paths are relative to: the pipeline file's folder (see runner.base_dir)."""
    return resolve(pipeline_file).parent if pipeline_file.strip() else PROJECT_ROOT


def display_path(path: Path, base: Path) -> str:
    """Paths inside the pipeline's folder are stored relative to it, so the folder stays portable."""
    try:
        return str(path.relative_to(base))
    except ValueError:
        return str(path)


@app.get("/api/scripts")
def list_scripts(dir: str = "examples/scripts", pipeline_file: str = ""):
    base = pipeline_base(pipeline_file)
    root = resolve(dir or ".", base)
    if not root.is_dir():
        raise HTTPException(404, f"Folder not found: {root}")
    scripts = []
    for current, dirs, files in os.walk(root):
        rel = Path(current).relative_to(root)
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS and not d.startswith("."))
        if len(rel.parts) >= MAX_DEPTH:
            dirs[:] = []
        for f in sorted(files):
            if f.endswith(".py"):
                scripts.append({"name": (rel / f).as_posix(), "path": display_path(Path(current) / f, base)})
        if len(scripts) >= MAX_SCRIPTS:
            break
    return {"dir": str(root), "scripts": scripts[:MAX_SCRIPTS]}


def pipeline_file(source: str, name: str) -> Path:
    if not NAME_RE.match(name):
        raise HTTPException(400, "Pipeline names may only contain letters, digits, spaces, '-', '_' and '.'")
    base = {"saved": SAVED_DIR, "example": EXAMPLES_DIR}.get(source)
    if base is None:
        raise HTTPException(404, f"Unknown source '{source}'")
    return base / f"{name}.json"


@app.get("/api/pipelines")
def list_pipelines():
    items = []
    for source, base in (("saved", SAVED_DIR), ("example", EXAMPLES_DIR)):
        if base.is_dir():
            items += [{"source": source, "name": f.stem} for f in sorted(base.glob("*.json"))]
    return items


@app.get("/api/pipelines/{source}/{name}")
def load_pipeline(source: str, name: str) -> Pipeline:
    f = pipeline_file(source, name)
    if not f.is_file():
        raise HTTPException(404, f"Pipeline not found: {name}")
    return Pipeline.model_validate_json(f.read_text("utf-8"))


# ---------------------------------------------------------------- pipelines saved anywhere

def read_recent() -> list[str]:
    try:
        data = json.loads(RECENT_FILE.read_text("utf-8"))
    except (OSError, ValueError):
        return []
    return [p for p in data if isinstance(p, str)] if isinstance(data, list) else []


def remember(path: Path) -> None:
    key = os.path.normcase(str(path))
    items = [str(path)] + [p for p in read_recent() if os.path.normcase(p) != key]
    try:
        RECENT_FILE.parent.mkdir(parents=True, exist_ok=True)
        RECENT_FILE.write_text(json.dumps(items[:MAX_RECENT], indent=2), "utf-8")
    except OSError:
        pass  # the recent list is a convenience only


def json_path(p: str) -> Path:
    if not p.strip():
        raise HTTPException(400, "No file path given")
    path = resolve(p.strip().strip('"'))
    if path.suffix.lower() != ".json":
        raise HTTPException(400, f"Pipeline files must end with .json: {path}")
    return path


@app.get("/api/recent")
def recent_pipelines():
    return [
        {"path": p, "name": Path(p).name, "folder": Path(p).parent.name, "exists": Path(p).is_file()}
        for p in read_recent()
    ]


@app.get("/api/pipeline-file")
def load_pipeline_file(path: str):
    f = json_path(path)
    if not f.is_file():
        raise HTTPException(404, f"File not found: {f}")
    try:
        pipeline = Pipeline.model_validate_json(f.read_text("utf-8"))
    except ValidationError as e:
        raise HTTPException(400, f"Not a valid pipeline file: {f}\n{e}")
    remember(f)
    return {"path": str(f), "pipeline": pipeline}


class DialogRequest(BaseModel):
    initial_dir: str = ""     # a folder, or a file whose folder is used
    initial_file: str = ""
    title: str = ""
    pipeline_file: str = ""   # relative initial_dir is relative to this file's folder
    relative: bool = False    # return the choice relative to that folder when it is inside it


# Runs in a separate process: Tk must not live in the server's worker threads
# (it can crash the server with "Tcl_AsyncDelete: async handler deleted by the wrong thread").
# Kinds: save / open (pipeline .json files), file (any file), folder.
DIALOG_SCRIPT = r'''
import sys
import tkinter as tk
from tkinter import filedialog

kind, initial_dir, initial_file, title = sys.argv[1:5]
root = tk.Tk()
root.withdraw()
root.attributes("-topmost", True)  # don't open behind the browser
root.update()
opts = {"parent": root}
if initial_dir:
    opts["initialdir"] = initial_dir
types = [("Pipeline files", "*.json"), ("All files", "*.*")]
if kind == "save":
    path = filedialog.asksaveasfilename(title=title or "Save pipeline as", initialfile=initial_file,
                                        filetypes=types, defaultextension=".json", **opts)
elif kind == "folder":
    path = filedialog.askdirectory(title=title or "Choose folder", mustexist=False, **opts)
elif kind == "file":
    path = filedialog.askopenfilename(title=title or "Choose file", initialfile=initial_file,
                                      filetypes=[("All files", "*.*")], **opts)
else:
    path = filedialog.askopenfilename(title=title or "Open pipeline", filetypes=types, **opts)
root.destroy()
sys.stdout.write(path or "")
'''

DIALOG_KINDS = ("save", "open", "file", "folder")
_dialog_lock = threading.Lock()


def file_dialog(kind: str, initial_dir: str, initial_file: str, title: str = "",
                base: Path = PROJECT_ROOT) -> str | None:
    """Show the native Windows Open / Save As / folder dialog on this PC (the server runs locally)."""
    start = ""
    if initial_dir.strip():
        folder = resolve(initial_dir, base)
        if folder.is_file():
            folder = folder.parent
        if folder.is_dir():
            start = str(folder)
    env = {**os.environ, "PYTHONIOENCODING": "utf-8"}  # paths with æ/ø/å
    with _dialog_lock:
        r = subprocess.run([sys.executable, "-c", DIALOG_SCRIPT, kind, start, initial_file, title],
                           capture_output=True, text=True, encoding="utf-8", env=env)
    if r.returncode != 0:
        lines = r.stderr.strip().splitlines()
        raise RuntimeError(lines[-1] if lines else "the file dialog failed")
    path = r.stdout.strip()
    return str(Path(path)) if path else None


@app.post("/api/dialog/{kind}")
async def open_file_dialog(kind: str, req: DialogRequest):
    """Returns {"path": chosen path} or {"path": null} if the dialog was cancelled."""
    if kind not in DIALOG_KINDS:
        raise HTTPException(404, f"Unknown dialog '{kind}'")
    base = pipeline_base(req.pipeline_file)
    try:
        path = await asyncio.to_thread(file_dialog, kind, req.initial_dir, req.initial_file, req.title, base)
    except RuntimeError as e:
        raise HTTPException(501, f"Can't show the file dialog: {e}")
    if path and req.relative and req.pipeline_file.strip():
        path = display_path(Path(path), base)
    return {"path": path}


class SaveRequest(BaseModel):
    path: str
    pipeline: Pipeline


@app.put("/api/pipeline-file")
def save_pipeline_file(req: SaveRequest):
    """Save; when saved to another folder, relative paths are rewritten to keep pointing at
    the same files, and the rewritten pipeline is returned so the editor can update."""
    f = json_path(req.path)
    if not f.parent.is_dir():
        raise HTTPException(400, f"Folder not found: {f.parent}")
    rebased = runner.rebase(req.pipeline, f)
    f.write_text(req.pipeline.model_dump_json(indent=2, exclude={"file"}), "utf-8")
    remember(f)
    return {"path": str(f), "pipeline": req.pipeline if rebased else None}


@app.post("/api/validate")
def validate_pipeline(pipeline: Pipeline):
    """Static issues plus the exact command each node would run."""
    paths = runner.resolve_paths(pipeline)
    commands = {
        n.id: subprocess.list2cmdline(runner.build_command(pipeline, n, paths)) for n in pipeline.nodes
    }
    return {
        "issues": [asdict(i) for i in runner.validate(pipeline)],
        "commands": commands,
        "workdir": str(runner.workdir(pipeline)),
    }


@app.websocket("/ws/run")
async def ws_run(ws: WebSocket):
    """Client sends {"action": "run", "pipeline": {...}, "start_node": id|null} or
    {"action": "cancel"}; the server streams runner events back as JSON."""
    if not is_local_client(ws.client) or not same_origin(ws.headers):
        await ws.close(code=1008)  # policy violation: another computer or website tried to connect
        return
    await ws.accept()
    run = Runner()
    task: asyncio.Task | None = None

    async def emit(msg: dict) -> None:
        try:
            await ws.send_json(msg)
        except Exception:
            run.cancel()  # client went away

    try:
        while True:
            msg = await ws.receive_json()
            action = msg.get("action")
            if action == "run":
                if task and not task.done():
                    await emit({"type": "busy"})
                    continue
                try:
                    pipeline = Pipeline.model_validate(msg.get("pipeline") or {})
                except ValidationError as e:
                    issue = {"level": "error", "message": f"Invalid pipeline: {e}", "node": None}
                    await emit({"type": "error", "issues": [issue]})
                    continue
                task = asyncio.create_task(run.run(pipeline, emit, msg.get("start_node")))
            elif action == "cancel":
                run.cancel()
    except WebSocketDisconnect:
        pass
    finally:
        if task and not task.done():
            run.cancel()
            await asyncio.gather(task, return_exceptions=True)
