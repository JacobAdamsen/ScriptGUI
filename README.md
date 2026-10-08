# ScriptGUI

A local visual editor for chaining Python scripts. Drop scripts onto a canvas, give them named
input/output files and parameters, connect outputs to inputs, and run the whole chain in
dependency order with live status and logs.

## Start

```bash
python -m pip install -r requirements.txt
python run.py
```

The editor opens at http://127.0.0.1:8765. Options: `--port 9000`, `--no-browser`.

**Security:** ScriptGUI runs programs on your PC, so it only listens on `127.0.0.1` (there is no `--host` option),
accepts connections from this PC only, and refuses requests from other websites open in your browser.
Only open pipeline files you trust: running a pipeline runs the scripts and Python interpreter it names.
The demo pipeline (`examples/pipelines/demo.json`) loads on first start.

## How it works

1. **Script library** (left): set a folder and drag `.py` files onto the canvas, or double-click
   one. Browsers can't see the full path of files dragged from Explorer, so use the library or
   *Add by path*.
2. **Inspector** (right): select a node and add
   - **Inputs**: files or folders the script reads. Connect one from another node, or set a path:
     type it, or use 📄 / 📁 to pick a file or folder in the Windows dialog.
   - **Outputs**: files the script writes. The value is the file name.
   - **Parameters**: other arguments (`--threshold 0.5`; leave the value empty for a bare flag).
3. **Connect**: drag from an orange output dot to a blue input dot (either direction works).
   Drag an edge off an input to re-route it, or click it and press `Del`.
4. **Run all**, or select a node and **Run from selected** to re-run it and everything downstream.
   Upstream outputs must already exist from an earlier run.
5. **Logs** (bottom): one tab per script. As in CI logs, stdout and stderr look the same and lines are
   highlighted by content: tracebacks, `ERROR`/`CRITICAL` and `…Error:` lines in red, `WARNING` and
   Python `…Warning:` lines in yellow. Each tab shows its ✖ error / ⚠ warning count. Whether a step
   failed is decided only by its exit code. Problems found when you click Run stay in the Issues tab
   until the next run.

Each node runs as:

```
<python> -u <script> --<input> <path> ... --<output> <path> ... --<param> <value> ...
```

- Outputs are written to `<output dir>\<path>`, e.g. `predicted.ply` or `Meshes\torso.stl`. A full path (`C:\...`) is used as is.
- **Output dir** (toolbar, 📁 to browse): when empty, outputs go to the folder the pipeline `.json` is saved in.
  For a pipeline that hasn't been saved yet, they go to `runs\<pipeline name>` inside ScriptGUI. Hover over the field to see the folder in use.
- Scripts run with their own folder as the working directory.
- **Relative paths** (inputs, scripts, Output dir, Script library, Python) are relative to the folder the
  pipeline `.json` is saved in, so a project folder can be moved or shared as a whole. Outputs are relative
  to the Output dir. Unsaved pipelines and the built-in examples use the ScriptGUI folder instead.
  Scripts from the library and paths picked with 📄 / 📁 are stored relative when they're inside that folder.
  *Save as…* to another folder rewrites relative paths so they keep pointing at the same files.
- The **Python** field lets you use another interpreter, e.g. a project venv's `python.exe`
  (a plain command like `python` is looked up on PATH).

### Script contract

Your script only needs to accept the flags you define, e.g. with argparse:

```python
import argparse
ap = argparse.ArgumentParser()
ap.add_argument("--in_csv", required=True)
ap.add_argument("--out_csv", required=True)
ap.add_argument("--threshold", type=float, default=0.0)
args = ap.parse_args()
```

## Files

| Path | What |
|---|---|
| `run.py` | Starts the server and opens the browser |
| `scriptgui/server.py` | FastAPI app: static files, REST API, `/ws/run` WebSocket |
| `scriptgui/runner.py` | Validation, path resolution, topological ordering, subprocess execution |
| `scriptgui/models.py` | Pipeline / Node / Port / Param / Edge models (the saved JSON format) |
| `static/editor.js` | SVG node editor (pan, zoom, drag, connect) |
| `static/app.js` | Toolbar, library, inspector, run controls, log panel |
| `static/loglevels.js` | Log-line highlighting (error / warning levels, tracebacks) |
| `examples/` | Three demo scripts and the demo pipeline |

## Saving pipelines

A pipeline is a `.json` file that you keep **in your own project folder**, next to your scripts:

- **Save as…** opens the normal Windows *Save As* window, starting in the script library folder.
- **Save** (Ctrl+S) writes back to the same file. The toolbar shows which file is open; hover over it to see the full path.
- **Open…** lists recently used files and the examples. *Browse…* opens the normal Windows *Open* window.

The dialogs are shown by the local server with Python's built-in tkinter, so they appear on the PC running ScriptGUI.
If tkinter is missing, ScriptGUI asks you to type the path instead.

The recent list is stored in `~/.scriptgui/recent.json`, outside this repository. The editor also keeps the current pipeline in the browser's local storage, so a page reload doesn't lose work.
Pipelines from older versions saved in `pipelines/` still appear under *Open…*. That folder is git-ignored.
