// App shell: toolbar, script library, inspector, run controls and log panel.
import { Editor, NODE_W } from "./editor.js";

const $ = (sel) => document.querySelector(sel);
const STORAGE_KEY = "scriptgui.current";
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const MAX_LOG_LINES = 5000;

const state = {
  pipeline: null,
  file: null,       // full path of the .json this pipeline is saved in (null = not saved yet)
  dirty: false,
  issues: [],
  commands: {},
  library: [],      // scripts in the current library folder
  logs: {},         // node id -> [{stream, line}]
  logTab: "issues",
  ws: null,
  running: false,
  runOrder: [],
};

// ---------------------------------------------------------------- helpers

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "value") el.value = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c !== null && c !== undefined && c !== false) el.append(c);
  }
  return el;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const d = data.detail;
    throw new Error(typeof d === "string" ? d : d ? JSON.stringify(d) : res.statusText);
  }
  return data;
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3500);
}

const labelOf = (id) => state.pipeline.nodes.find((n) => n.id === id)?.label || id;
const basename = (p) => p.split(/[\\/]/).pop();

function blankPipeline(name = "untitled") {
  return { name, python: "", workdir: "", file: "", scripts_dir: "examples/scripts", nodes: [], edges: [] };
}

function normalize(p) {
  const out = { ...blankPipeline(), ...p };
  out.nodes = (out.nodes || []).map((n) => ({
    label: "", script: "", x: 0, y: 0, ...n,
    inputs: n.inputs || [], outputs: n.outputs || [], params: n.params || [],
  }));
  out.edges = out.edges || [];
  return out;
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ pipeline: state.pipeline, dirty: state.dirty, file: state.file }));
  } catch { /* storage unavailable: not critical */ }
}

function setDirty(on) {
  state.dirty = on;
  $("#dirty").classList.toggle("on", on);
}

function setFile(path) {
  state.file = path || null;
  const label = $("#file-label");
  label.textContent = state.file ? basename(state.file) : "not saved yet";
  label.title = state.file || "Use Save as… to choose where this pipeline is saved";
  // The server needs it too: an empty Output dir means "the folder of the pipeline file".
  if (state.pipeline) state.pipeline.file = state.file || "";
}

// ---------------------------------------------------------------- editor

const editor = new Editor($("#canvas"), {
  onSelect: () => { renderInspector(); updateButtons(); },
  onChange: () => { renderInspector(); changed(); },
  onMessage: toast,
  onRender: (count) => {
    $("#empty-hint").hidden = count > 0;
    renderLogTabs();
  },
});

/** The model changed (from the editor or a form). */
function changed() {
  setDirty(true);
  persist();
  scheduleAnalyze();
}

/** A form changed the model: redraw the canvas too. */
function modelChanged() {
  editor.render();
  changed();
}

function setPipeline(p, dirty = false, file = null) {
  state.pipeline = normalize(p);
  setFile(file);
  state.logs = {};
  state.logTab = "issues";
  state.issues = [];
  state.commands = {};
  $("#pipe-name").value = state.pipeline.name;
  $("#pipe-python").value = state.pipeline.python;
  $("#pipe-workdir").value = state.pipeline.workdir;
  $("#scripts-dir").value = state.pipeline.scripts_dir;
  editor.setPipeline(state.pipeline);
  requestAnimationFrame(() => editor.fit());
  setDirty(dirty);
  renderInspector();
  renderLogs();
  updateButtons();
  loadScripts();
  analyze();
  persist();
}

/** Show where outputs will actually go (from the server's last analysis). */
function showWorkdir(resolved) {
  const input = $("#pipe-workdir");
  input.placeholder = resolved;
  input.title = state.pipeline.workdir
    ? `Outputs are saved in: ${resolved}`
    : `Empty = the folder of the saved pipeline file. Outputs are saved in: ${resolved}`;
}

// ---------------------------------------------------------------- validation + command preview

let analyzeTimer;
let analyzeSeq = 0;
function scheduleAnalyze() {
  clearTimeout(analyzeTimer);
  analyzeTimer = setTimeout(analyze, 250);
}

async function analyze() {
  const seq = ++analyzeSeq;
  try {
    const res = await api("POST", "/api/validate", state.pipeline);
    if (seq !== analyzeSeq) return res;   // a newer request is on its way
    state.issues = res.issues;
    state.commands = res.commands;
    showWorkdir(res.workdir);
    editor.setErrors(res.issues.filter((i) => i.level === "error" && i.node).map((i) => i.node));
    const pre = $("#cmd-preview");
    const sel = editor.selection;
    if (pre && sel?.type === "node") pre.textContent = state.commands[sel.node.id] ?? "";
    renderLogTabs();
    if (state.logTab === "issues") renderLogs();
    return res;
  } catch (e) {
    console.error(e);
    return null;
  }
}

// ---------------------------------------------------------------- script library

async function loadScripts() {
  const list = $("#script-list");
  list.replaceChildren();
  try {
    const res = await api("GET", "/api/scripts?dir=" + encodeURIComponent($("#scripts-dir").value.trim()));
    state.library = res.scripts;
    if (!res.scripts.length) list.append(h("li", { class: "empty" }, "No .py files in this folder"));
    for (const s of res.scripts) {
      list.append(h("li", {
        draggable: "true",
        title: s.path,
        ondragstart: (ev) => {
          ev.dataTransfer.setData("application/x-scriptgui", s.path);
          ev.dataTransfer.effectAllowed = "copy";
        },
        ondblclick: () => addScriptNode(s.path),
      }, s.name));
    }
  } catch (e) {
    state.library = [];
    list.append(h("li", { class: "empty error" }, e.message));
  }
}

function uniqueId() {
  const ids = new Set(state.pipeline.nodes.map((n) => n.id));
  let i = 1;
  while (ids.has(`n${i}`)) i++;
  return `n${i}`;
}

function uniqueLabel(base) {
  const labels = new Set(state.pipeline.nodes.map((n) => n.label));
  if (!labels.has(base)) return base;
  let i = 2;
  while (labels.has(`${base}_${i}`)) i++;
  return `${base}_${i}`;
}

function addScriptNode(path, x, y) {
  if (x === undefined) {
    const c = editor.viewCenter();
    const offset = (state.pipeline.nodes.length % 5) * 20;
    x = c.x - NODE_W / 2 + offset;
    y = c.y - 50 + offset;
  }
  const node = {
    id: uniqueId(),
    label: uniqueLabel(basename(path).replace(/\.py$/i, "")),
    script: path,
    x: Math.round(x / 10) * 10,
    y: Math.round(y / 10) * 10,
    inputs: [],
    outputs: [],
    params: [],
  };
  state.pipeline.nodes.push(node);
  editor.render();
  editor.select({ type: "node", node });
  changed();
}

function bindCanvasDrop() {
  const wrap = $("#canvas-wrap");
  const accepts = (ev) => ev.dataTransfer.types.includes("application/x-scriptgui") || ev.dataTransfer.types.includes("Files");
  wrap.addEventListener("dragover", (ev) => {
    if (!accepts(ev)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "copy";
    wrap.classList.add("drop-target");
  });
  wrap.addEventListener("dragleave", (ev) => {
    if (!wrap.contains(ev.relatedTarget)) wrap.classList.remove("drop-target");
  });
  wrap.addEventListener("drop", (ev) => {
    wrap.classList.remove("drop-target");
    if (!accepts(ev)) return;
    ev.preventDefault();
    const w = editor.toWorld(ev.clientX, ev.clientY);
    let path = ev.dataTransfer.getData("application/x-scriptgui");
    if (!path && ev.dataTransfer.files.length) {
      // Browsers hide the full path of files dragged from Explorer; match by name in the library.
      const name = ev.dataTransfer.files[0].name;
      const matches = state.library.filter((s) => basename(s.path) === name);
      if (matches.length === 1) path = matches[0].path;
      else {
        toast(`Can't see where "${name}" lives. Point the Script library at its folder, or use "Add by path".`);
        return;
      }
    }
    if (path) addScriptNode(path, w.x - NODE_W / 2, w.y - 20);
  });
}

// ---------------------------------------------------------------- inspector

function renderInspector() {
  const box = $("#inspector");
  box.replaceChildren();
  const sel = editor.selection;
  if (sel?.type === "node") box.append(...nodeInspector(sel.node));
  else if (sel?.type === "edge") box.append(...edgeInspector(sel.edge));
  else box.append(...pipelineInfo());
}

function textField(label, value, oninput, attrs = {}) {
  return h("div", { class: "field" },
    h("label", {}, label),
    h("input", { value, spellcheck: "false", oninput: (ev) => oninput(ev.target.value), ...attrs }));
}

function nodeInspector(node) {
  const p = state.pipeline;
  const incoming = (port) => p.edges.find((e) => e.target === node.id && e.target_port === port);

  const inputCol = (port) => {
    const e = incoming(port.name);
    if (e) {
      const text = `← ${labelOf(e.source)} · ${e.source_port}`;
      return h("span", { class: "linked", title: `${text} (drag the edge off the input to disconnect)` }, text);
    }
    return h("input", {
      value: port.path, placeholder: "file path (required)", spellcheck: "false",
      oninput: (ev) => { port.path = ev.target.value; modelChanged(); },
    });
  };
  const outputCol = (port) => h("input", {
    value: port.path, placeholder: port.name, spellcheck: "false",
    title: "File or folder name inside the Output dir, e.g. predicted.ply or Meshes\\torso.stl (a full C:\\... path also works)",
    oninput: (ev) => { port.path = ev.target.value; modelChanged(); },
  });
  const paramCol = (prm) => h("input", {
    value: prm.value, placeholder: "(flag only)", spellcheck: "false",
    oninput: (ev) => { prm.value = ev.target.value; modelChanged(); },
  });

  return [
    h("h2", {}, "Node"),
    textField("Label", node.label, (v) => { node.label = v; modelChanged(); }),
    textField("Script", node.script, (v) => { node.script = v; modelChanged(); }),
    itemSection(node, "in", "Inputs", ["argument", "source / file path"], inputCol),
    itemSection(node, "out", "Outputs", ["argument", "path in output dir"], outputCol),
    itemSection(node, "param", "Parameters", ["argument", "value"], paramCol),
    h("h2", {}, "Command"),
    h("pre", { class: "cmd", id: "cmd-preview" }, state.commands[node.id] ?? "…"),
    h("div", { class: "actions" },
      h("button", { onclick: () => runPipeline(node.id), disabled: state.running }, "▶ Run from here"),
      h("button", { class: "danger", onclick: () => editor.deleteSelection() }, "Delete node")),
  ];
}

const listOf = (node, kind) => (kind === "in" ? node.inputs : kind === "out" ? node.outputs : node.params);

function itemSection(node, kind, title, heads, secondCol) {
  const list = listOf(node, kind);
  const noun = { in: "input", out: "output", param: "parameter" }[kind];
  const sec = h("div", { class: "section", "data-kind": kind },
    h("h2", {}, h("span", { class: `swatch ${kind}` }), title));
  if (list.length) sec.append(h("div", { class: "prow head" }, h("span", {}, heads[0]), h("span", {}, heads[1])));
  list.forEach((item, idx) => {
    sec.append(h("div", { class: "prow" },
      h("input", {
        value: item.name, spellcheck: "false", class: NAME_RE.test(item.name) ? "" : "invalid",
        title: `Passed to the script as --${item.name}`,
        oninput: (ev) => renameItem(node, kind, item, ev.target),
      }),
      secondCol(item),
      h("button", { class: "icon-btn", title: `Remove ${noun}`, onclick: () => removeItem(node, kind, idx) }, "×")));
  });
  sec.append(h("button", { class: "add-btn", onclick: () => addItem(node, kind) }, `+ Add ${noun}`));
  return sec;
}

function renameItem(node, kind, item, input) {
  const old = item.name;
  item.name = input.value.trim();
  input.classList.toggle("invalid", !NAME_RE.test(item.name));
  for (const e of state.pipeline.edges) {
    if (kind === "in" && e.target === node.id && e.target_port === old) e.target_port = item.name;
    if (kind === "out" && e.source === node.id && e.source_port === old) e.source_port = item.name;
  }
  modelChanged();
}

function addItem(node, kind) {
  const base = { in: "input", out: "output", param: "param" }[kind];
  const used = new Set([...node.inputs, ...node.outputs, ...node.params].map((i) => i.name));
  let i = 1;
  while (used.has(`${base}${i}`)) i++;
  const name = `${base}${i}`;
  listOf(node, kind).push(kind === "param" ? { name, value: "" } : { name, path: "" });
  modelChanged();
  renderInspector();
  const rows = document.querySelectorAll(`.section[data-kind="${kind}"] .prow:not(.head)`);
  const input = rows[rows.length - 1]?.querySelector("input");
  input?.focus();
  input?.select();
}

function removeItem(node, kind, idx) {
  const [item] = listOf(node, kind).splice(idx, 1);
  const p = state.pipeline;
  if (kind === "in") p.edges = p.edges.filter((e) => !(e.target === node.id && e.target_port === item.name));
  if (kind === "out") p.edges = p.edges.filter((e) => !(e.source === node.id && e.source_port === item.name));
  modelChanged();
  renderInspector();
}

function edgeInspector(edge) {
  return [
    h("h2", {}, "Connection"),
    h("p", { class: "stat" }, h("b", {}, `${labelOf(edge.source)} · ${edge.source_port}`)),
    h("p", { class: "stat" }, "feeds into"),
    h("p", { class: "stat" }, h("b", {}, `${labelOf(edge.target)} · ${edge.target_port}`)),
    h("p", { class: "hint" }, "The output file of the first node is passed as the input argument of the second."),
    h("div", { class: "actions" },
      h("button", { class: "danger", onclick: () => editor.deleteSelection() }, "Delete connection")),
  ];
}

function pipelineInfo() {
  const p = state.pipeline;
  return [
    h("h2", {}, "Pipeline"),
    h("p", { class: "stat" }, h("b", {}, p.nodes.length), " scripts, ", h("b", {}, p.edges.length), " connections"),
    h("h2", {}, "How it works"),
    h("ol", { class: "help" },
      h("li", {}, "Point the ", h("b", {}, "Script library"), " at your scripts folder and drag scripts onto the canvas."),
      h("li", {}, "Select a node and add its ", h("b", {}, "inputs, outputs and parameters"),
        ". Each name becomes a command-line flag, e.g. ", h("code", {}, "--in_csv path"), "."),
      h("li", {}, "Drag from an ", h("b", {}, "orange output"), " dot to a ", h("b", {}, "blue input"),
        " dot to pass that file along. A red hollow input still needs a source."),
      h("li", {}, h("b", {}, "Run all"), ", or select a node and ", h("b", {}, "Run from selected"),
        " to re-run it and everything downstream.")),
    h("h2", {}, "Script contract"),
    h("pre", { class: "cmd" },
      "import argparse\n" +
      "ap = argparse.ArgumentParser()\n" +
      "ap.add_argument(\"--in_csv\")\n" +
      "ap.add_argument(\"--out_csv\")\n" +
      "ap.add_argument(\"--threshold\", type=float)\n" +
      "args = ap.parse_args()"),
    h("p", { class: "hint" }, "Outputs are written to ", h("code", {}, "<output dir>\\<path>"),
      ". An empty Output dir means the folder the pipeline file is saved in. ",
      "Scripts run with their own folder as the working directory."),
    h("h2", {}, "Shortcuts"),
    h("p", { class: "hint" },
      h("span", { class: "kbd" }, "Del"), " delete selection  ·  ",
      h("span", { class: "kbd" }, "Ctrl+S"), " save  ·  ",
      h("span", { class: "kbd" }, "wheel"), " zoom  ·  drag background to pan"),
  ];
}

// ---------------------------------------------------------------- log panel

function renderLogTabs() {
  if (!state.pipeline) return;
  const tabs = $("#log-tabs");
  tabs.replaceChildren();
  const errs = state.issues.filter((i) => i.level === "error").length;
  const warns = state.issues.length - errs;
  const badge = h("span", { class: `badge ${errs ? "error" : warns ? "warning" : ""}` }, errs + warns || "✓");
  tabs.append(logTab("issues", badge, "Issues"));
  const nodes = [...state.pipeline.nodes].sort((a, b) => a.x - b.x || a.y - b.y);
  for (const n of nodes) {
    tabs.append(logTab(n.id, h("span", { class: `sdot ${editor.status[n.id] || ""}` }), n.label || n.id));
  }
}

function logTab(id, icon, text) {
  return h("button", {
    class: `log-tab${state.logTab === id ? " active" : ""}`,
    onclick: () => { state.logTab = id; renderLogTabs(); renderLogs(); },
  }, icon, text);
}

const logLine = (l) => h("div", { class: `log-line ${l.stream}` }, l.line);

function renderLogs() {
  const body = $("#log-body");
  body.replaceChildren();
  if (state.logTab === "issues") {
    if (!state.issues.length) body.append(h("div", { class: "log-line info" }, "No problems found."));
    for (const i of state.issues) {
      body.append(h("div", { class: "issue", onclick: () => i.node && selectNode(i.node) },
        h("span", { class: `lvl ${i.level}` }, i.level),
        h("span", {}, i.node ? h("b", {}, labelOf(i.node) + ": ") : null, i.message)));
    }
    return;
  }
  const lines = state.logs[state.logTab] || [];
  if (!lines.length) body.append(h("div", { class: "log-line info" }, "No output yet. Run the pipeline to see this script's output."));
  body.append(...lines.map(logLine));
  body.scrollTop = body.scrollHeight;
}

function appendLog(nodeId, stream, line) {
  const lines = (state.logs[nodeId] ??= []);
  lines.push({ stream, line });
  if (lines.length > MAX_LOG_LINES) lines.splice(0, lines.length - MAX_LOG_LINES);
  if (state.logTab !== nodeId) return;
  if (lines.length === 1) return renderLogs();   // replace the placeholder
  const body = $("#log-body");
  const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  body.append(logLine({ stream, line }));
  if (atBottom) body.scrollTop = body.scrollHeight;
}

function selectNode(id) {
  const node = state.pipeline.nodes.find((n) => n.id === id);
  if (node) editor.select({ type: "node", node });
}

// ---------------------------------------------------------------- running

function setRunStatus(text, cls = "") {
  const el = $("#run-status");
  el.textContent = text;
  el.className = `run-status ${cls}`;
}

function updateButtons() {
  $("#btn-run").disabled = state.running;
  $("#btn-run-from").disabled = state.running || editor.selection?.type !== "node";
  $("#btn-cancel").disabled = !state.running;
}

function setRunning(on) {
  state.running = on;
  updateButtons();
  if (editor.selection?.type === "node") renderInspector();
}

function runPipeline(startNode = null) {
  if (state.running) return;
  if (!state.pipeline.nodes.length) return toast("Add some scripts first.");
  if (!startNode) editor.clearStatus();
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws/run`);
  state.ws = ws;
  setRunning(true);
  setRunStatus("Starting…", "running");
  ws.onopen = () => ws.send(JSON.stringify({ action: "run", pipeline: state.pipeline, start_node: startNode }));
  ws.onmessage = (ev) => handleRunEvent(JSON.parse(ev.data));
  ws.onerror = () => setRunStatus("Could not reach the server", "fail");
  ws.onclose = () => {
    state.ws = null;
    if (state.running) {
      setRunning(false);
      setRunStatus("Connection to server lost", "fail");
    }
  };
}

function handleRunEvent(msg) {
  switch (msg.type) {
    case "error":
      state.issues = msg.issues;
      editor.setErrors(msg.issues.filter((i) => i.node).map((i) => i.node));
      state.logTab = "issues";
      renderLogTabs();
      renderLogs();
      setRunStatus(`✖ ${msg.issues.length} problem${msg.issues.length > 1 ? "s" : ""}, nothing was run`, "fail");
      finishRun();
      break;
    case "start":
      state.runOrder = msg.order;
      for (const id of msg.order) state.logs[id] = [];
      break;
    case "status":
      editor.setStatus(msg.node, msg.state);
      if (msg.state === "running") {
        const i = state.runOrder.indexOf(msg.node) + 1;
        setRunStatus(`Running ${labelOf(msg.node)} (${i}/${state.runOrder.length})…`, "running");
        state.logTab = msg.node;
        renderLogs();
      }
      renderLogTabs();
      break;
    case "log":
      appendLog(msg.node, msg.stream, msg.line);
      break;
    case "done":
      if (msg.ok) setRunStatus(`✔ Ran ${state.runOrder.length} script${state.runOrder.length > 1 ? "s" : ""} in ${msg.seconds}s`, "ok");
      else if (msg.cancelled) setRunStatus("■ Cancelled", "fail");
      else setRunStatus(`✖ Failed at ${labelOf(msg.failed)}`, "fail");
      finishRun();
      break;
    case "busy":
      toast("A run is already in progress.");
      break;
  }
}

function finishRun() {
  setRunning(false);
  state.ws?.close();
}

// ---------------------------------------------------------------- open / save

// Open… values: "file:<full path>", "example:<name>", "saved:<name>" (old ScriptGUI/pipelines) or "browse".
async function loadPipelineList() {
  const sel = $("#sel-open");
  const [items, recent] = await Promise.all([api("GET", "/api/pipelines"), api("GET", "/api/recent")]);
  sel.replaceChildren(h("option", { value: "" }, "Open…"), h("option", { value: "browse" }, "Browse…"));
  if (recent.length) {
    sel.append(h("optgroup", { label: "Recent" }, recent.map((r) =>
      h("option", { value: `file:${r.path}`, title: r.path, disabled: !r.exists },
        `${r.name}  (${r.folder})${r.exists ? "" : "  missing"}`))));
  }
  const groups = [["example", "Examples"], ["saved", "In the ScriptGUI folder"]];
  for (const [source, title] of groups) {
    const group = items.filter((i) => i.source === source);
    if (group.length) {
      sel.append(h("optgroup", { label: title }, group.map((i) => h("option", { value: `${source}:${i.name}` }, i.name))));
    }
  }
  sel.value = "";
}

async function openPipeline(source, name) {
  try {
    // Examples and old ScriptGUI-folder files open without a file, so Save asks where to save.
    setPipeline(await api("GET", `/api/pipelines/${source}/${encodeURIComponent(name)}`));
    setRunStatus("");
  } catch (e) {
    toast(`Could not open ${name}: ${e.message}`);
  }
}

async function openFile(path) {
  try {
    const res = await api("GET", "/api/pipeline-file?path=" + encodeURIComponent(path));
    setPipeline(res.pipeline, false, res.path);
    setRunStatus("");
    loadPipelineList();
  } catch (e) {
    toast(`Could not open: ${e.message}`);
  }
}

const cleanPath = (p) => p.trim().replace(/^"|"$/g, "");
const isAbsolute = (p) => /^([A-Za-z]:[\\/]|\\\\|\/)/.test(p);

const dirname = (p) => p.replace(/[\\/][^\\/]*$/, "");

/** Folder and file name the dialogs start in: the open file, else the script library folder. */
function dialogStart() {
  if (state.file) return { dir: dirname(state.file), file: basename(state.file) };
  const file = (state.pipeline.name || "untitled").replace(/[<>:"/\\|?*]/g, "_") + ".json";
  const dir = state.pipeline.scripts_dir.replace(/[\\/]+$/, "");
  // Relative script folders live inside ScriptGUI, so start in its git-ignored pipelines folder.
  return { dir: isAbsolute(dir) ? dir : "pipelines", file };
}

/** Show the Windows Save As / Open dialog (via the local server). Returns a path or null. */
async function chooseFile(kind) {
  const { dir, file } = dialogStart();
  toast(kind === "save" ? "Choose where to save in the Windows dialog…" : "Choose a pipeline in the Windows dialog…");
  try {
    const res = await api("POST", `/api/dialog/${kind}`, { initial_dir: dir, initial_file: file });
    $("#toast").classList.remove("show");
    return res.path;
  } catch (e) {
    // No dialog available: fall back to typing the path.
    const p = prompt(`${e.message}\n\nType the full path to a .json file:`, `${dir}\\${file}`);
    return p ? cleanPath(p) : null;
  }
}

async function writeFile(path) {
  state.pipeline.name = $("#pipe-name").value.trim() || "untitled";
  try {
    const res = await api("PUT", "/api/pipeline-file", { path, pipeline: state.pipeline });
    setFile(res.path);
    setDirty(false);
    persist();
    loadPipelineList();
    analyze();   // the default output folder may have changed with the file location
    toast(`Saved to ${res.path}`);
  } catch (e) {
    toast(`Save failed: ${e.message}`);
  }
}

async function saveAs() {
  const path = await chooseFile("save");
  if (path) writeFile(path);
}

async function browseAndOpen() {
  const path = await chooseFile("open");
  if (path) openFile(path);
}

function save() {
  if (state.file) writeFile(state.file);
  else saveAs();
}

const confirmDiscard = () => !state.dirty || confirm("Discard unsaved changes to this pipeline?");

// ---------------------------------------------------------------- resizable panels

const LAYOUT_KEY = "scriptgui.layout";
const PANEL_DEFAULTS = { sidebar: 240, inspector: 340, log: 220 };
const PANEL_MIN = { sidebar: 160, inspector: 240, log: 80 };
const MIN_CANVAS = 240;   // keep at least this much canvas visible
const SPLITTER_PX = 6;    // matches --splitter in style.css

function applyPanelSize(key, px) {
  document.documentElement.style.setProperty(`--${key}-size`, `${px}px`);
}

function bindSplitters() {
  const sizes = { ...PANEL_DEFAULTS };
  try {
    Object.assign(sizes, JSON.parse(localStorage.getItem(LAYOUT_KEY)) || {});
  } catch { /* no saved layout */ }
  const saveSizes = () => {
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(sizes)); } catch { /* not critical */ }
  };
  const maxSize = (key) => key === "log"
    ? window.innerHeight - 200
    : window.innerWidth - MIN_CANVAS - 2 * SPLITTER_PX - sizes[key === "sidebar" ? "inspector" : "sidebar"];
  const clamp = (key, px) => Math.round(Math.max(PANEL_MIN[key], Math.min(maxSize(key), px)));
  const fitAll = () => {
    for (const key of Object.keys(sizes)) applyPanelSize(key, (sizes[key] = clamp(key, sizes[key])));
  };

  fitAll();
  window.addEventListener("resize", fitAll);   // a smaller window shrinks panels, not the canvas

  for (const el of document.querySelectorAll(".splitter")) {
    const key = el.dataset.split;
    const horizontal = key === "log";
    el.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      el.setPointerCapture(ev.pointerId);
      el.classList.add("active");
      document.body.classList.add("resizing", horizontal ? "resizing-row" : "resizing-col");
      const start = { x: ev.clientX, y: ev.clientY, size: sizes[key] };
      const move = (e) => {
        // Panels grow away from the canvas: sidebar to the right, inspector to the left, log upwards.
        const delta = key === "sidebar" ? e.clientX - start.x : key === "inspector" ? start.x - e.clientX : start.y - e.clientY;
        sizes[key] = clamp(key, start.size + delta);
        applyPanelSize(key, sizes[key]);
      };
      const up = () => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        el.removeEventListener("pointercancel", up);
        el.classList.remove("active");
        document.body.classList.remove("resizing", "resizing-row", "resizing-col");
        saveSizes();
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
    });
    el.addEventListener("dblclick", () => {
      sizes[key] = clamp(key, PANEL_DEFAULTS[key]);
      applyPanelSize(key, sizes[key]);
      saveSizes();
    });
  }
}

// ---------------------------------------------------------------- wiring

function bindUI() {
  $("#btn-new").onclick = () => { if (confirmDiscard()) { setPipeline(blankPipeline()); setRunStatus(""); } };
  $("#sel-open").onchange = (ev) => {
    const v = ev.target.value;
    ev.target.value = "";
    if (!v || !confirmDiscard()) return;
    if (v === "browse") {
      browseAndOpen();
    } else if (v.startsWith("file:")) {
      openFile(v.slice(5));
    } else {
      const i = v.indexOf(":");
      openPipeline(v.slice(0, i), v.slice(i + 1));
    }
  };
  $("#btn-save").onclick = save;
  $("#btn-save-as").onclick = saveAs;
  $("#pipe-name").oninput = (ev) => { state.pipeline.name = ev.target.value; changed(); };
  $("#pipe-python").oninput = (ev) => { state.pipeline.python = ev.target.value; changed(); };
  $("#pipe-workdir").oninput = (ev) => { state.pipeline.workdir = ev.target.value; changed(); };
  $("#btn-workdir").onclick = async () => {
    try {
      const res = await api("POST", "/api/dialog/folder", { initial_dir: $("#pipe-workdir").value || $("#pipe-workdir").placeholder });
      if (!res.path) return;
      $("#pipe-workdir").value = state.pipeline.workdir = res.path;
      changed();
    } catch (e) {
      toast(`Could not open the folder dialog: ${e.message}`);
    }
  };

  $("#scripts-dir").onchange = (ev) => { state.pipeline.scripts_dir = ev.target.value; changed(); loadScripts(); };
  $("#btn-refresh").onclick = () => { state.pipeline.scripts_dir = $("#scripts-dir").value; loadScripts(); };
  const addByPath = () => {
    const path = $("#add-path").value.trim().replace(/^"|"$/g, "");
    if (!path) return;
    addScriptNode(path);
    $("#add-path").value = "";
  };
  $("#btn-add-path").onclick = addByPath;
  $("#add-path").onkeydown = (ev) => { if (ev.key === "Enter") addByPath(); };

  $("#btn-validate").onclick = async () => {
    const res = await analyze();
    if (!res) return;
    const n = res.issues.length;
    setRunStatus(n ? `${n} problem${n > 1 ? "s" : ""} found` : "✔ No problems found", n ? "fail" : "ok");
    state.logTab = "issues";
    renderLogTabs();
    renderLogs();
  };
  $("#btn-run").onclick = () => runPipeline(null);
  $("#btn-run-from").onclick = () => {
    if (editor.selection?.type === "node") runPipeline(editor.selection.node.id);
  };
  $("#btn-cancel").onclick = () => state.ws?.send(JSON.stringify({ action: "cancel" }));

  for (const b of document.querySelectorAll("[data-zoom]")) {
    b.onclick = () => {
      const z = b.dataset.zoom;
      if (z === "fit") editor.fit();
      else editor.zoomAt(z === "in" ? 1.2 : 1 / 1.2);
    };
  }

  document.addEventListener("keydown", (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "s") {
      ev.preventDefault();
      save();
      return;
    }
    if (ev.target.matches("input, textarea, select")) return;
    if (ev.key === "Delete" || ev.key === "Backspace") {
      if (editor.deleteSelection()) ev.preventDefault();
    } else if (ev.key === "Escape") {
      editor.select(null);
    }
  });

  bindCanvasDrop();
  bindSplitters();
}

async function init() {
  bindUI();
  loadPipelineList().catch((e) => toast(`Could not list pipelines: ${e.message}`));
  let restored = null;
  try {
    restored = JSON.parse(localStorage.getItem(STORAGE_KEY));
  } catch { /* ignore */ }
  if (restored?.pipeline) return setPipeline(restored.pipeline, restored.dirty, restored.file);
  try {
    setPipeline(await api("GET", "/api/pipelines/example/demo"));
  } catch {
    setPipeline(blankPipeline());
  }
}

init();
