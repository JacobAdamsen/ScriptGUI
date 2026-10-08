"""Graph validation, file-path resolution and sequential execution of pipelines."""
from __future__ import annotations

import asyncio
import os
import re
import signal
import subprocess
import sys
import threading
import time
from collections import Counter
from dataclasses import asdict, dataclass
from graphlib import CycleError, TopologicalSorter
from pathlib import Path
from typing import Awaitable, Callable

from .models import Node, Pipeline

PROJECT_ROOT = Path(__file__).resolve().parent.parent
FLAG_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_-]*$")

Emit = Callable[[dict], Awaitable[None]]
Paths = dict[str, dict[str, dict[str, Path]]]  # node id -> "inputs"/"outputs" -> port -> path


@dataclass
class Issue:
    level: str          # "error" | "warning"
    message: str
    node: str | None = None


class PlanError(Exception):
    def __init__(self, issues: list[Issue]):
        super().__init__("; ".join(i.message for i in issues))
        self.issues = issues


# ---------------------------------------------------------------- paths

def resolve(p: str) -> Path:
    """Resolve a user-entered path; relative paths are relative to the project root."""
    path = Path(os.path.expandvars(p.strip())).expanduser()
    return path if path.is_absolute() else PROJECT_ROOT / path


def safe_name(s: str) -> str:
    s = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", s).strip(" .")
    return s or "node"


def workdir(p: Pipeline) -> Path:
    """Output folder: as set, else the folder the pipeline file is saved in,
    else (unsaved pipeline) runs/<name> inside ScriptGUI."""
    if p.workdir.strip():
        return resolve(p.workdir)
    if p.file.strip():
        return resolve(p.file).parent
    return PROJECT_ROOT / "runs" / safe_name(p.name)


def python_exe(p: Pipeline) -> str:
    return p.python.strip() or sys.executable


def resolve_paths(p: Pipeline) -> Paths:
    """Output ports are <workdir>/<path> (an absolute path is used as is). Connected inputs
    take the upstream output path; unconnected inputs use the path entered by the user."""
    out: Paths = {}
    wd = workdir(p)
    for n in p.nodes:
        out[n.id] = {
            "inputs": {},
            "outputs": {pt.name: wd / (pt.path.strip() or pt.name) for pt in n.outputs},
        }
    incoming = {(e.target, e.target_port): e for e in p.edges}
    for n in p.nodes:
        for pt in n.inputs:
            e = incoming.get((n.id, pt.name))
            if e and e.source in out and e.source_port in out[e.source]["outputs"]:
                out[n.id]["inputs"][pt.name] = out[e.source]["outputs"][e.source_port]
            elif pt.path.strip():
                out[n.id]["inputs"][pt.name] = resolve(pt.path)
    return out


def build_command(p: Pipeline, node: Node, paths: Paths) -> list[str]:
    cmd = [python_exe(p), "-u", str(resolve(node.script))]
    np = paths[node.id]
    for pt in node.inputs:
        if pt.name in np["inputs"]:
            cmd += [f"--{pt.name}", str(np["inputs"][pt.name])]
    for pt in node.outputs:
        cmd += [f"--{pt.name}", str(np["outputs"][pt.name])]
    for prm in node.params:
        if prm.name:
            cmd.append(f"--{prm.name}")
            if prm.value != "":
                cmd.append(prm.value)
    return cmd


# ---------------------------------------------------------------- graph

def dependencies(p: Pipeline) -> dict[str, set[str]]:
    deps: dict[str, set[str]] = {n.id: set() for n in p.nodes}
    for e in p.edges:
        if e.target in deps and e.source in deps:
            deps[e.target].add(e.source)
    return deps


def topo_order(p: Pipeline) -> list[str]:
    """Dependency order; ties are broken by canvas position (left to right). Raises CycleError."""
    pos = {n.id: (n.x, n.y) for n in p.nodes}
    ts = TopologicalSorter(dependencies(p))
    ts.prepare()
    order: list[str] = []
    while ts.is_active():
        for nid in sorted(ts.get_ready(), key=lambda i: pos[i]):
            order.append(nid)
            ts.done(nid)
    return order


def descendants(p: Pipeline, start: str) -> set[str]:
    children: dict[str, set[str]] = {n.id: set() for n in p.nodes}
    for e in p.edges:
        if e.source in children:
            children[e.source].add(e.target)
    seen, stack = {start}, [start]
    while stack:
        for child in children.get(stack.pop(), ()):
            if child not in seen:
                seen.add(child)
                stack.append(child)
    return seen


def validate(p: Pipeline) -> list[Issue]:
    """Static checks that don't depend on files produced by a run."""
    issues: list[Issue] = []
    nodes = {n.id: n for n in p.nodes}
    for nid, count in Counter(n.id for n in p.nodes).items():
        if count > 1:
            issues.append(Issue("error", f"Duplicate node id '{nid}'", nid))

    for n in p.nodes:
        if not n.script.strip():
            issues.append(Issue("error", "No script set", n.id))
        elif not resolve(n.script).is_file():
            issues.append(Issue("error", f"Script not found: {n.script}", n.id))
        flags = [pt.name for pt in n.inputs + n.outputs] + [pr.name for pr in n.params]
        for f in flags:
            if not FLAG_RE.match(f):
                issues.append(Issue("error", f"Invalid argument name '{f}' (use letters, digits, _ or -)", n.id))
        for f, count in Counter(flags).items():
            if count > 1:
                issues.append(Issue("error", f"Argument '--{f}' is defined {count} times", n.id))

    incoming: Counter[tuple[str, str]] = Counter()
    for e in p.edges:
        src, dst = nodes.get(e.source), nodes.get(e.target)
        if not src or not dst:
            issues.append(Issue("error", "A connection points to a node that no longer exists"))
            continue
        if e.source_port not in {pt.name for pt in src.outputs}:
            issues.append(Issue("error", f"Connection from unknown output '{e.source_port}'", src.id))
        if e.target_port not in {pt.name for pt in dst.inputs}:
            issues.append(Issue("error", f"Connection to unknown input '{e.target_port}'", dst.id))
        incoming[(e.target, e.target_port)] += 1

    for (nid, port), count in incoming.items():
        if count > 1:
            issues.append(Issue("error", f"Input '{port}' has {count} connections (max 1)", nid))
    for n in p.nodes:
        for pt in n.inputs:
            if (n.id, pt.name) not in incoming and not pt.path.strip():
                issues.append(Issue("error", f"Input '{pt.name}' is not connected and has no file path", n.id))

    try:
        topo_order(p)
    except CycleError as ex:
        cycle = list(dict.fromkeys(ex.args[1]))
        names = " → ".join(nodes[i].label or i for i in ex.args[1])
        for nid in cycle:
            issues.append(Issue("error", f"Part of a cycle: {names}", nid))

    seen: dict[Path, str] = {}
    for nid, np in resolve_paths(p).items():
        for port, path in np["outputs"].items():
            key = Path(os.path.normcase(path))
            if key in seen and seen[key] != nid:
                issues.append(Issue("error", f"Output '{port}' writes to the same file as another node: {path}", nid))
            seen[key] = nid
    return issues


def plan(p: Pipeline, start_node: str | None = None) -> list[str]:
    """Return the node ids to run, in order. With `start_node`, only that node and
    everything downstream. Raises PlanError if the pipeline can't run."""
    errors = [i for i in validate(p) if i.level == "error"]
    if errors:
        raise PlanError(errors)
    nodes = {n.id: n for n in p.nodes}
    order = topo_order(p)
    if start_node:
        if start_node not in nodes:
            raise PlanError([Issue("error", "The selected node no longer exists")])
        keep = descendants(p, start_node)
        order = [i for i in order if i in keep]

    selected = set(order)
    paths = resolve_paths(p)
    incoming = {(e.target, e.target_port): e for e in p.edges}
    problems: list[Issue] = []
    for nid in order:
        for pt in nodes[nid].inputs:
            e = incoming.get((nid, pt.name))
            if e and e.source in selected:
                continue  # produced during this run
            f = paths[nid]["inputs"][pt.name]
            if f.exists():
                continue
            if e:
                src = nodes[e.source].label or e.source
                msg = f"Input '{pt.name}' needs {f.name} from '{src}', which doesn't exist yet. Run upstream first."
            else:
                msg = f"Input '{pt.name}': file not found: {f}"
            problems.append(Issue("error", msg, nid))
    if problems:
        raise PlanError(problems)
    return order


# ---------------------------------------------------------------- execution

OUTPUT_GRACE_SECONDS = 0.5   # after a script exits, stop reading once its output has been quiet this long


def kill_tree(proc: subprocess.Popen) -> None:
    """Kill a script and every process it started (subprocesses, multiprocessing workers, tools)."""
    if sys.platform == "win32":
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                       capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
    else:
        try:
            os.killpg(proc.pid, signal.SIGKILL)   # the script was started in its own process group
        except ProcessLookupError:
            pass
    if proc.poll() is None:
        proc.kill()


class Runner:
    """Runs one pipeline at a time, streaming events through `emit`."""

    def __init__(self) -> None:
        self._proc: subprocess.Popen | None = None
        self._cancelled = False

    def cancel(self) -> None:
        self._cancelled = True
        proc = self._proc
        if proc and proc.poll() is None:
            kill_tree(proc)

    async def run(self, p: Pipeline, emit: Emit, start_node: str | None = None) -> None:
        self._cancelled = False
        try:
            order = plan(p, start_node)
        except PlanError as e:
            await emit({"type": "error", "issues": [asdict(i) for i in e.issues]})
            return

        nodes = {n.id: n for n in p.nodes}
        paths = resolve_paths(p)
        await emit({"type": "start", "order": order, "workdir": str(workdir(p))})
        for nid in order:
            await emit({"type": "status", "node": nid, "state": "queued"})

        t0 = time.monotonic()
        failed: str | None = None
        for nid in order:
            if failed or self._cancelled:
                await emit({"type": "status", "node": nid, "state": "skipped"})
                continue
            if not await self._run_node(p, nodes[nid], paths, emit):
                failed = nid
        await emit({
            "type": "done",
            "ok": failed is None and not self._cancelled,
            "cancelled": self._cancelled,
            "failed": failed,
            "seconds": round(time.monotonic() - t0, 2),
        })

    async def _run_node(self, p: Pipeline, node: Node, paths: Paths, emit: Emit) -> bool:
        async def log(stream: str, line: str) -> None:
            await emit({"type": "log", "node": node.id, "stream": stream, "line": line})

        async def status(state: str) -> None:
            await emit({"type": "status", "node": node.id, "state": state})

        for f in paths[node.id]["outputs"].values():
            f.parent.mkdir(parents=True, exist_ok=True)
        cmd = build_command(p, node, paths)
        await status("running")
        await log("info", "$ " + subprocess.list2cmdline(cmd))

        env = {**os.environ, "PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8"}
        flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
        t0 = time.monotonic()
        try:
            proc = subprocess.Popen(
                cmd, cwd=resolve(node.script).parent, env=env, creationflags=flags,
                start_new_session=sys.platform != "win32",   # own process group, so kill_tree gets children
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, encoding="utf-8", errors="replace", bufsize=1,
            )
        except OSError as e:
            await log("stderr", f"Could not start process: {e}")
            await status("failed")
            return False
        self._proc = proc
        if self._cancelled:   # Cancel arrived while this step was being set up
            kill_tree(proc)

        # Read both pipes in threads (works with any event loop) and forward lines here.
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[tuple[str, str | None]] = asyncio.Queue()

        def pump(stream, name: str) -> None:
            for line in stream:
                loop.call_soon_threadsafe(queue.put_nowait, (name, line.rstrip("\r\n")))
            stream.close()
            loop.call_soon_threadsafe(queue.put_nowait, (name, None))

        for stream, name in ((proc.stdout, "stdout"), (proc.stderr, "stderr")):
            threading.Thread(target=pump, args=(stream, name), daemon=True).start()
        open_streams = 2
        while open_streams:
            try:
                name, line = await asyncio.wait_for(queue.get(), timeout=OUTPUT_GRACE_SECONDS)
            except asyncio.TimeoutError:
                # A program started by the script can keep the output open after the script
                # itself has ended; don't let that keep the step "running" forever.
                if proc.poll() is not None:
                    break
                continue
            if line is None:
                open_streams -= 1
            else:
                await log(name, line)

        rc = await asyncio.to_thread(proc.wait)
        self._proc = None
        secs = round(time.monotonic() - t0, 2)
        if self._cancelled:
            await log("info", "Cancelled.")
            await status("cancelled")
            return False
        if rc != 0:
            await log("info", f"Exited with code {rc} after {secs}s")
            await status("failed")
            return False
        for f in paths[node.id]["outputs"].values():
            if not f.exists():
                await log("stderr", f"Warning: expected output was not created: {f}")
        await log("info", f"Finished in {secs}s")
        await status("success")
        return True
