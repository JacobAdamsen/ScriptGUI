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
The demo pipeline (`examples/pipelines/demo.json`) loads on first start.

## How it works

1. **Script library** (left): set a folder and drag `.py` files onto the canvas, or double-click
   one. Browsers can't see the full path of files dragged from Explorer, so use the library or
   *Add by path*.
2. **Inspector** (right): select a node and add
   - **Inputs**: files the script reads. Connect one from another node, or type a file path.
   - **Outputs**: files the script writes. The value is the file name.
   - **Parameters**: other arguments (`--threshold 0.5`; leave the value empty for a bare flag).
3. **Connect**: drag from an orange output dot to a blue input dot (either direction works).
   Drag an edge off an input to re-route it, or click it and press `Del`.
4. **Run all**, or select a node and **Run from selected** to re-run it and everything downstream.
   Upstream outputs must already exist from an earlier run.

Each node runs as:

```
<python> -u <script> --<input> <path> ... --<output> <path> ... --<param> <value> ...
```

- Outputs are written to `<output dir>/<node label>/<file name>`. The output dir defaults to `runs/<pipeline name>`.
- Scripts run with their own folder as the working directory.
- Relative paths are relative to this project folder.
- The **Python** field lets you use another interpreter, e.g. a project venv's `python.exe`.

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
| `examples/` | Three demo scripts and the demo pipeline |

## Saving pipelines

A pipeline is a `.json` file that you keep **in your own project folder**, next to your scripts:

- **Save as…** asks for a full path to a `.json` file. It suggests `<script library folder>\<pipeline name>.json`.
- **Save** (Ctrl+S) writes back to the same file. The toolbar shows which file is open; hover over it to see the full path.
- **Open…** lists recently used files, the examples, and *Open file by path…*.

The recent list is stored in `~/.scriptgui/recent.json`, outside this repository. The editor also keeps the current pipeline in the browser's local storage, so a page reload doesn't lose work.
Pipelines from older versions saved in `pipelines/` still appear under *Open…*. That folder is git-ignored.
