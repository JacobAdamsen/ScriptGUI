// SVG node editor: draws a pipeline's nodes and edges and handles pan, zoom, drag and connect.
// It edits the pipeline object in place and reports through callbacks:
//   onSelect(selection), onChange(), onRender(nodeCount), onMessage(text)

const SVGNS = "http://www.w3.org/2000/svg";
export const NODE_W = 220;
const HEAD_H = 44;
const ROW0 = HEAD_H + 6;   // y of the first port row
const ROW_H = 24;
const PARAM_H = 20;
const GRID = 10;

function svg(tag, attrs = {}, parent = null) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, v);
  if (parent) parent.appendChild(el);
  return el;
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const basename = (p) => p.split(/[\\/]/).pop();
const snap = (v) => Math.round(v / GRID) * GRID;

function curve(a, b) {
  const dx = Math.max(50, Math.abs(b.x - a.x) * 0.5);
  return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
}

function sameSelection(a, b) {
  return a?.type === b?.type && a?.node === b?.node && a?.edge === b?.edge;
}

export class Editor {
  constructor(svgEl, callbacks = {}) {
    this.svg = svgEl;
    this.viewport = svgEl.querySelector("#viewport");
    this.edgeLayer = svgEl.querySelector("#edges");
    this.nodeLayer = svgEl.querySelector("#nodes");
    this.dragEdge = svgEl.querySelector("#drag-edge");
    this.grid = svgEl.querySelector("#grid");
    this.cb = callbacks;
    this.view = { x: 40, y: 40, k: 1 };
    this.pipeline = { nodes: [], edges: [] };
    this.selection = null;      // {type: "node", node} | {type: "edge", edge} | null
    this.status = {};           // node id -> run state
    this.errorNodes = new Set();
    this.drag = null;
    this.hot = null;
    this._bind();
  }

  // ------------------------------------------------------------ public API

  setPipeline(p) {
    this.pipeline = p;
    this.selection = null;
    this.status = {};
    this.errorNodes = new Set();
    this.render();
  }

  nodeById(id) {
    return this.pipeline.nodes.find((n) => n.id === id);
  }

  render() {
    this._renderNodes();
    this._renderEdges();
    this._applyView();
    this.cb.onRender?.(this.pipeline.nodes.length);
  }

  select(sel) {
    if (sameSelection(sel, this.selection)) return;
    this.selection = sel;
    this._refreshClasses();
    this.cb.onSelect?.(sel);
  }

  setStatus(id, state) {
    if (state) this.status[id] = state;
    else delete this.status[id];
    this._refreshClasses();
  }

  clearStatus() {
    this.status = {};
    this._refreshClasses();
  }

  setErrors(ids) {
    this.errorNodes = new Set(ids);
    this._refreshClasses();
  }

  deleteSelection() {
    const sel = this.selection;
    if (!sel) return false;
    const p = this.pipeline;
    if (sel.type === "node") {
      const id = sel.node.id;
      p.nodes = p.nodes.filter((n) => n !== sel.node);
      p.edges = p.edges.filter((e) => e.source !== id && e.target !== id);
    } else {
      p.edges = p.edges.filter((e) => e !== sel.edge);
    }
    this.selection = null;
    this.render();
    this.cb.onSelect?.(null);
    this.cb.onChange?.();
    return true;
  }

  toWorld(clientX, clientY) {
    const r = this.svg.getBoundingClientRect();
    return {
      x: (clientX - r.left - this.view.x) / this.view.k,
      y: (clientY - r.top - this.view.y) / this.view.k,
    };
  }

  viewCenter() {
    const r = this.svg.getBoundingClientRect();
    return this.toWorld(r.left + r.width / 2, r.top + r.height / 2);
  }

  zoomAt(factor, clientX, clientY) {
    const r = this.svg.getBoundingClientRect();
    const sx = (clientX ?? r.left + r.width / 2) - r.left;
    const sy = (clientY ?? r.top + r.height / 2) - r.top;
    const k = Math.min(2.5, Math.max(0.2, this.view.k * factor));
    const wx = (sx - this.view.x) / this.view.k;
    const wy = (sy - this.view.y) / this.view.k;
    this.view = { k, x: sx - wx * k, y: sy - wy * k };
    this._applyView();
  }

  fit() {
    const nodes = this.pipeline.nodes;
    const r = this.svg.getBoundingClientRect();
    if (!nodes.length || !r.width) {
      this.view = { x: 40, y: 40, k: 1 };
      return this._applyView();
    }
    const minX = Math.min(...nodes.map((n) => n.x));
    const minY = Math.min(...nodes.map((n) => n.y));
    const maxX = Math.max(...nodes.map((n) => n.x + NODE_W));
    const maxY = Math.max(...nodes.map((n) => n.y + this.nodeHeight(n)));
    const pad = 60;
    const k = Math.min(1.2, Math.max(0.2,
      Math.min((r.width - 2 * pad) / (maxX - minX), (r.height - 2 * pad) / (maxY - minY))));
    this.view = {
      k,
      x: (r.width - (maxX - minX) * k) / 2 - minX * k,
      y: (r.height - (maxY - minY) * k) / 2 - minY * k,
    };
    this._applyView();
  }

  nodeHeight(n) {
    const rows = Math.max(n.inputs.length, n.outputs.length, 1);
    return ROW0 + rows * ROW_H + 6 + (n.params.length ? PARAM_H : 0);
  }

  portPos(node, kind, name) {
    const list = kind === "in" ? node.inputs : node.outputs;
    const i = list.findIndex((p) => p.name === name);
    if (i < 0) return null;
    return { x: node.x + (kind === "in" ? 0 : NODE_W), y: node.y + ROW0 + i * ROW_H + ROW_H / 2 };
  }

  // ------------------------------------------------------------ drawing

  _nodeClass(n) {
    const cls = ["node"];
    if (this.selection?.node === n) cls.push("selected");
    if (this.errorNodes.has(n.id)) cls.push("has-error");
    if (this.status[n.id]) cls.push(`status-${this.status[n.id]}`);
    return cls.join(" ");
  }

  _edgeClass(e) {
    const cls = ["edge-group"];
    if (this.selection?.edge === e) cls.push("selected");
    if (this.status[e.target] === "running") cls.push("active");
    return cls.join(" ");
  }

  _refreshClasses() {
    for (const g of this.nodeLayer.children) {
      const n = this.nodeById(g.dataset.id);
      if (n) g.setAttribute("class", this._nodeClass(n));
    }
    for (const g of this.edgeLayer.children) g.setAttribute("class", this._edgeClass(g._edge));
  }

  _renderNodes() {
    this.nodeLayer.replaceChildren();
    const connected = new Set(this.pipeline.edges.map((e) => `${e.target}\u0000${e.target_port}`));
    for (const n of this.pipeline.nodes) {
      const h = this.nodeHeight(n);
      const g = svg("g", { class: this._nodeClass(n), "data-id": n.id, transform: `translate(${n.x},${n.y})` }, this.nodeLayer);
      svg("title", {}, g).textContent = n.script || "No script set";
      svg("rect", { class: "node-body", width: NODE_W, height: h, rx: 8 }, g);
      svg("path", {
        class: "node-head",
        d: `M0,8 a8,8 0 0 1 8,-8 h${NODE_W - 16} a8,8 0 0 1 8,8 v${HEAD_H - 8} h${-NODE_W} z`,
      }, g);
      svg("text", { class: "node-title", x: 12, y: 19 }, g).textContent = clip(n.label || n.id, 24);
      svg("text", { class: "node-sub", x: 12, y: 35 }, g).textContent = clip(basename(n.script) || "no script", 30);
      svg("circle", { class: "status-dot", cx: NODE_W - 14, cy: 15, r: 5 }, g);

      n.inputs.forEach((p, i) => {
        const y = ROW0 + i * ROW_H + ROW_H / 2;
        const missing = !connected.has(`${n.id}\u0000${p.name}`) && !p.path;
        svg("circle", {
          class: `port port-in${missing ? " missing" : ""}`, cx: 0, cy: y, r: 6,
          "data-node": n.id, "data-port": p.name, "data-kind": "in",
        }, g);
        svg("text", { class: "port-label", x: 13, y: y + 4 }, g).textContent = clip(p.name, 15);
      });
      n.outputs.forEach((p, i) => {
        const y = ROW0 + i * ROW_H + ROW_H / 2;
        svg("circle", {
          class: "port port-out", cx: NODE_W, cy: y, r: 6,
          "data-node": n.id, "data-port": p.name, "data-kind": "out",
        }, g);
        svg("text", { class: "port-label", x: NODE_W - 13, y: y + 4, "text-anchor": "end" }, g).textContent = clip(p.name, 15);
      });
      if (n.params.length) {
        const txt = n.params.map((p) => (p.value === "" ? p.name : `${p.name}=${p.value}`)).join(" · ");
        svg("text", { class: "node-params", x: 12, y: h - 10 }, g).textContent = clip("⚙ " + txt, 34);
      }
    }
  }

  _renderEdges() {
    this.edgeLayer.replaceChildren();
    for (const e of this.pipeline.edges) {
      const s = this.nodeById(e.source);
      const t = this.nodeById(e.target);
      const a = s && this.portPos(s, "out", e.source_port);
      const b = t && this.portPos(t, "in", e.target_port);
      if (!a || !b) continue;
      const g = svg("g", { class: this._edgeClass(e) }, this.edgeLayer);
      g._edge = e;
      const d = curve(a, b);
      svg("path", { class: "edge-hit", d }, g);
      svg("path", { class: "edge", d }, g);
    }
  }

  _applyView() {
    const { x, y, k } = this.view;
    const t = `translate(${x},${y}) scale(${k})`;
    this.viewport.setAttribute("transform", t);
    this.grid.setAttribute("patternTransform", t);
  }

  // ------------------------------------------------------------ interaction

  _bind() {
    this.svg.addEventListener("pointerdown", (ev) => this._down(ev));
    window.addEventListener("pointermove", (ev) => this._move(ev));
    window.addEventListener("pointerup", (ev) => this._up(ev));
    this.svg.addEventListener("wheel", (ev) => {
      ev.preventDefault();
      this.zoomAt(Math.exp(-ev.deltaY * 0.0015), ev.clientX, ev.clientY);
    }, { passive: false });
  }

  _startPan(ev) {
    this.drag = { mode: "pan", sx: ev.clientX, sy: ev.clientY, vx: this.view.x, vy: this.view.y };
    this.svg.classList.add("panning");
  }

  _down(ev) {
    if (ev.button === 1) {               // middle mouse always pans
      ev.preventDefault();
      return this._startPan(ev);
    }
    if (ev.button !== 0) return;
    const t = ev.target;
    const w = this.toWorld(ev.clientX, ev.clientY);

    if (t.classList.contains("port")) {
      ev.preventDefault();
      return this._startConnect(t, w);
    }
    const nodeEl = t.closest(".node");
    if (nodeEl) {
      const node = this.nodeById(nodeEl.dataset.id);
      this.select({ type: "node", node });
      this.drag = { mode: "node", node, el: nodeEl, ox: node.x - w.x, oy: node.y - w.y, moved: false };
      return;
    }
    const edgeEl = t.closest(".edge-group");
    if (edgeEl) return this.select({ type: "edge", edge: edgeEl._edge });

    this.select(null);
    this._startPan(ev);
  }

  _startConnect(portEl, w) {
    let from = { node: portEl.dataset.node, port: portEl.dataset.port, kind: portEl.dataset.kind };
    let detached = false;
    if (from.kind === "in") {
      // Dragging from a connected input picks the edge up so it can be re-routed.
      const existing = this.pipeline.edges.find((e) => e.target === from.node && e.target_port === from.port);
      if (existing) {
        this.pipeline.edges = this.pipeline.edges.filter((e) => e !== existing);
        from = { node: existing.source, port: existing.source_port, kind: "out" };
        detached = true;
        this._renderEdges();
      }
    }
    const anchor = this.portPos(this.nodeById(from.node), from.kind, from.port);
    this.drag = { mode: "connect", from, anchor, detached };
    this._drawDragEdge(w);
  }

  _drawDragEdge(w) {
    const { from, anchor } = this.drag;
    this.dragEdge.setAttribute("d", from.kind === "out" ? curve(anchor, w) : curve(w, anchor));
  }

  _connectTarget(ev) {
    const t = document.elementFromPoint(ev.clientX, ev.clientY);
    if (!t?.classList?.contains("port")) return null;
    const to = { node: t.dataset.node, port: t.dataset.port, kind: t.dataset.kind, el: t };
    const from = this.drag.from;
    return to.kind !== from.kind && to.node !== from.node ? to : null;
  }

  _move(ev) {
    const d = this.drag;
    if (!d) return;
    if (d.mode === "pan") {
      this.view.x = d.vx + ev.clientX - d.sx;
      this.view.y = d.vy + ev.clientY - d.sy;
      this._applyView();
    } else if (d.mode === "node") {
      const w = this.toWorld(ev.clientX, ev.clientY);
      const x = snap(w.x + d.ox);
      const y = snap(w.y + d.oy);
      if (x !== d.node.x || y !== d.node.y) {
        d.node.x = x;
        d.node.y = y;
        d.moved = true;
        d.el.setAttribute("transform", `translate(${x},${y})`);
        this._renderEdges();
      }
    } else if (d.mode === "connect") {
      this._drawDragEdge(this.toWorld(ev.clientX, ev.clientY));
      const target = this._connectTarget(ev);
      if (this.hot !== target?.el) {
        this.hot?.classList.remove("hot");
        this.hot = target?.el ?? null;
        this.hot?.classList.add("hot");
      }
    }
  }

  _up(ev) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.svg.classList.remove("panning");
    if (d.mode === "node" && d.moved) this.cb.onChange?.();
    if (d.mode !== "connect") return;

    this.dragEdge.setAttribute("d", "");
    this.hot?.classList.remove("hot");
    this.hot = null;
    this.drag = d;   // _connectTarget reads drag.from
    const to = this._connectTarget(ev);
    this.drag = null;

    let changed = d.detached;
    if (to) {
      const [out, inp] = d.from.kind === "out" ? [d.from, to] : [to, d.from];
      if (this._createsCycle(out.node, inp.node)) {
        this.cb.onMessage?.("That connection would create a cycle.");
      } else {
        const edges = this.pipeline.edges.filter((e) => !(e.target === inp.node && e.target_port === inp.port));
        edges.push({ source: out.node, source_port: out.port, target: inp.node, target_port: inp.port });
        this.pipeline.edges = edges;
        changed = true;
      }
    }
    if (changed) {
      this.render();
      this.cb.onChange?.();
    }
  }

  _createsCycle(src, dst) {
    // Adding src -> dst creates a cycle if src is reachable from dst.
    const children = new Map();
    for (const e of this.pipeline.edges) {
      if (!children.has(e.source)) children.set(e.source, []);
      children.get(e.source).push(e.target);
    }
    const seen = new Set();
    const stack = [dst];
    while (stack.length) {
      const cur = stack.pop();
      if (cur === src) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      stack.push(...(children.get(cur) || []));
    }
    return false;
  }
}
