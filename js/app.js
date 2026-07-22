/*
 * app.js - P6 Visualiser
 * Wires together: file loading -> XER parsing -> search -> trace/discipline views
 * -> Cytoscape rendering.
 */

(function () {
  "use strict";

  // ---------- State ----------
  let model = null;        // parsed XER: { projects, tasks, links, disciplines, warnings }
  let cy = null;           // Cytoscape instance
  let focusTaskId = null;  // activity the trace is centred on
  let selectedProjId = ""; // "" = all projects
  let wbsTree = null;      // { children:Map, subCount:Map, roots:[] }
  let wbsMode = false;     // roll the diagram up to WBS groups
  // WBS groups the user has drilled into: their children (or tasks) are shown
  // instead of the group itself. Drives the top-down drill-down in WBS mode.
  let wbsExpanded = new Set();
  // set for one render to keep the camera where it is (expand/collapse in
  // place) instead of re-fitting to the whole diagram
  let keepViewportOnce = false;
  // set for one render to animate nodes from their previous positions
  // ("bubbles opening"); new nodes grow out of morphOrigin (the clicked node)
  let animateNext = false;
  let morphOrigin = null;

  // ---------- Discipline colours ----------
  // Categorical palette (validated, light surface), assigned to level-1 WBS
  // bands in fixed order. Red is deliberately absent: red = critical outline.
  const DISCIPLINE_PALETTE = [
    "#2a78d6", // blue
    "#1baf7a", // aqua
    "#eda100", // yellow
    "#008300", // green
    "#4a3aa7", // violet
    "#e87ba4", // magenta
    "#eb6834", // orange
  ];
  const NEUTRAL_SERIES = "#64748b"; // disciplines beyond the palette
  const CRITICAL_RED = "#d03b3b";   // status red - reserved, never a discipline
  let disciplineColour = new Map(); // discipline name -> base hex

  function assignDisciplineColours() {
    disciplineColour = new Map();
    model.disciplines.forEach((d, i) => {
      disciplineColour.set(d.name, DISCIPLINE_PALETTE[i] || NEUTRAL_SERIES);
    });
  }

  /** Mix a hex colour towards white; frac = colour share (0..1). */
  function tint(hex, frac) {
    const n = parseInt(hex.slice(1), 16);
    const mix = (c) => Math.round(c * frac + 255 * (1 - frac));
    return (
      "rgb(" + mix((n >> 16) & 255) + "," + mix((n >> 8) & 255) + "," + mix(n & 255) + ")"
    );
  }

  // Fill lightness encodes WBS depth: level 1 strongest, deeper = lighter.
  const DEPTH_FRACS = [0.34, 0.25, 0.18, 0.13, 0.09];

  function colourFor(discipline, depth) {
    const base = disciplineColour.get(discipline) || NEUTRAL_SERIES;
    const f = DEPTH_FRACS[Math.min(Math.max(depth || 1, 1), DEPTH_FRACS.length) - 1];
    return { bg: tint(base, f), bd: base };
  }

  function buildLegend() {
    const swatches = model.disciplines
      .map((d) => {
        const base = disciplineColour.get(d.name) || NEUTRAL_SERIES;
        return (
          '<span><span class="legend-swatch disc" style="background:' +
          tint(base, 0.34) + ";border-color:" + base + '"></span>' +
          escapeHtml(d.name) + "</span>"
        );
      })
      .join("");
    $("legend").innerHTML =
      swatches +
      '<span><span class="legend-swatch crit-outline"></span>Critical</span>' +
      '<span><span class="legend-swatch diamond"></span>Milestone</span>' +
      '<span><span class="legend-swatch focus-ring"></span>Traced</span>' +
      "<span>+ / double-click: expand group · − / right-click: collapse · double-click activity: trace</span>";
  }
  // what is currently drawn, so option changes can re-render the same view
  let lastView = { type: null, wbsId: null }; // type: full | trace | wbs

  const $ = (id) => document.getElementById(id);

  // ---------- Helpers ----------
  function fmtDate(d) {
    if (!d) return "—";
    return d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
  }

  function fmtDays(n) {
    if (n === null || n === undefined) return "—";
    const r = Math.round(n * 10) / 10;
    return r + "d";
  }

  function floatThreshold() {
    const v = parseFloat($("floatThreshold").value);
    return Number.isFinite(v) ? v : 0;
  }

  function isCriticalTask(task) {
    return task.totalFloatDays !== null && task.totalFloatDays <= floatThreshold();
  }

  function criticalOnly() {
    return $("criticalOnly").checked;
  }

  function excludeMilestones() {
    return $("excludeMilestones").checked;
  }

  function durationBarsOn() {
    return $("durScale").checked && !$("durScale").disabled;
  }

  // duration bars only make sense when x = time
  function syncDurControl() {
    $("durScale").disabled = !model || layoutMode() !== "time";
  }

  /**
   * "Exclude milestones" filter: drop milestone nodes from the view, but
   * bridge their logic so chains stay intact - each milestone's predecessors
   * connect straight through to its successors (shown as dashed edges).
   * Runs of consecutive milestones are bridged transitively. The traced
   * (focus) activity is never dropped, even if it is a milestone.
   * Returns { nodeIds, linkIds, bridges:[{predId,succId,critical}] }.
   */
  function applyMilestoneFilter(nodeIds, linkIds) {
    if (!excludeMilestones()) return { nodeIds, linkIds, bridges: [] };
    const dropped = (id) => {
      const t = model.tasks.get(id);
      return t.isMilestone && id !== focusTaskId;
    };
    if (![...nodeIds].some(dropped)) return { nodeIds, linkIds, bridges: [] };

    const keep = new Set([...nodeIds].filter((id) => !dropped(id)));

    // adjacency restricted to the links in this view
    const outAdj = new Map();
    const keptLinkIds = new Set();
    const directPairs = new Set();
    for (const link of model.links) {
      if (!linkIds.has(link.id)) continue;
      if (!outAdj.has(link.predId)) outAdj.set(link.predId, []);
      outAdj.get(link.predId).push(link.succId);
      if (keep.has(link.predId) && keep.has(link.succId)) {
        keptLinkIds.add(link.id);
        directPairs.add(link.predId + ">" + link.succId);
      }
    }

    // from each kept node, walk through dropped-milestone chains to find the
    // kept nodes they eventually lead to
    const bridges = [];
    const seenPair = new Set();
    for (const a of keep) {
      const firstHops = (outAdj.get(a) || []).filter((id) => nodeIds.has(id) && dropped(id));
      if (!firstHops.length) continue;
      const visited = new Set();
      const stack = firstHops.map((id) => ({
        id,
        allCrit: isCriticalTask(model.tasks.get(id)),
      }));
      while (stack.length) {
        const cur = stack.pop();
        if (visited.has(cur.id)) continue;
        visited.add(cur.id);
        for (const nxt of outAdj.get(cur.id) || []) {
          if (!nodeIds.has(nxt)) continue;
          if (dropped(nxt)) {
            stack.push({
              id: nxt,
              allCrit: cur.allCrit && isCriticalTask(model.tasks.get(nxt)),
            });
          } else if (keep.has(nxt) && nxt !== a) {
            const pair = a + ">" + nxt;
            if (!seenPair.has(pair) && !directPairs.has(pair)) {
              seenPair.add(pair);
              bridges.push({
                predId: a,
                succId: nxt,
                critical:
                  cur.allCrit &&
                  isCriticalTask(model.tasks.get(a)) &&
                  isCriticalTask(model.tasks.get(nxt)),
              });
            }
          }
        }
      }
    }
    return { nodeIds: keep, linkIds: keptLinkIds, bridges };
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function setStatus(msg, isError) {
    const el = $("statusBar");
    el.textContent = msg;
    el.classList.toggle("error", !!isError);
  }

  // ---------- Loading spinner ----------
  // Parsing and layout are synchronous, so we show the spinner, give the
  // browser one frame to paint it, then run the heavy work.
  let spinnerDepth = 0;
  function busy(message, work) {
    spinnerDepth++;
    $("spinnerMsg").textContent = message;
    $("spinner").style.display = "flex";
    const run = () => {
      try {
        work();
      } finally {
        spinnerDepth--;
        if (spinnerDepth <= 0) {
          spinnerDepth = 0;
          $("spinner").style.display = "none";
        }
        commitState(); // record the state this action produced (for undo)
      }
    };
    if (document.visibilityState === "visible") {
      // double-rAF: spinner paints on the first frame, work runs on the next
      requestAnimationFrame(() => requestAnimationFrame(run));
    } else {
      setTimeout(run, 0); // rAF never fires in hidden tabs
    }
  }

  // ---------- Undo ----------
  // Every user action that changes the visualisation calls pushUndo() first,
  // snapshotting the whole view state. Undo (button / Ctrl+Z) pops one back.
  const undoStack = [];
  const UNDO_LIMIT = 50;

  function captureState() {
    return {
      lastView: { ...lastView },
      focusTaskId,
      selectedProjId,
      wbsMode,
      wbsExpanded: [...wbsExpanded],
      wbsLevel: $("wbsLevelSelect").value,
      durScale: $("durScale").checked,
      layout: $("layoutSelect").value,
      direction: $("directionSelect").value,
      depth: $("depthSelect").value,
      criticalOnly: $("criticalOnly").checked,
      floatThreshold: $("floatThreshold").value,
      excludeMs: $("excludeMilestones").checked,
      viewport: cy ? { zoom: cy.zoom(), pan: { x: cy.pan().x, y: cy.pan().y } } : null,
    };
  }

  // State as of the end of the last completed action. pushUndo() pushes THIS
  // rather than reading the live controls, because change events fire after
  // a control's value has already flipped - reading live would snapshot the
  // new value and undo couldn't revert it.
  let lastCommitted = null;

  function commitState() {
    if (model) lastCommitted = captureState();
    updateFilterChips();
  }

  // Dismissible chips above the diagram showing which filters are active,
  // so a forgotten filter never silently empties the view.
  function updateFilterChips() {
    const wrap = $("filterChips");
    if (!model) {
      wrap.innerHTML = "";
      return;
    }
    const chips = [];
    if (criticalOnly()) {
      chips.push({ label: "Critical only (float ≤ " + floatThreshold() + "d)", control: "criticalOnly" });
    }
    if (excludeMilestones()) {
      chips.push({ label: "Milestones hidden", control: "excludeMilestones" });
    }
    if (durationBarsOn()) {
      chips.push({ label: "Duration bars", control: "durScale" });
    }
    let html = chips
      .map(
        (c) =>
          '<span class="filter-chip">' + escapeHtml(c.label) +
          '<span class="chip-x" data-x="' + c.control + '" title="Turn this off">✕</span></span>'
      )
      .join("");
    if (wbsMode) {
      const lv = $("wbsLevelSelect").value;
      html +=
        '<span class="filter-chip info">WBS roll-up · ' +
        (lv === "99" ? "all tasks" : "level " + lv) + "</span>";
    }
    wrap.innerHTML = html;
    for (const x of wrap.querySelectorAll("[data-x]")) {
      x.addEventListener("click", () => $(x.getAttribute("data-x")).click());
    }
  }

  function pushUndo() {
    if (!model || !lastCommitted) return;
    const s = { ...lastCommitted };
    // camera, however, should be wherever the user has panned it right now
    if (cy) s.viewport = { zoom: cy.zoom(), pan: { x: cy.pan().x, y: cy.pan().y } };
    // ignore camera position when deciding whether anything changed
    s._key = JSON.stringify({ ...s, viewport: null });
    const top = undoStack[undoStack.length - 1];
    if (top && top._key === s._key) return; // nothing changed since last push
    undoStack.push(s);
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    updateUndoBtn();
  }

  function updateUndoBtn() {
    $("undoBtn").disabled = undoStack.length === 0;
  }

  function applyState(s) {
    // restore controls without firing their change handlers
    $("layoutSelect").value = s.layout;
    $("directionSelect").value = s.direction;
    $("depthSelect").value = s.depth;
    $("criticalOnly").checked = s.criticalOnly;
    $("floatThreshold").value = s.floatThreshold;
    $("excludeMilestones").checked = !!s.excludeMs;
    selectedProjId = s.selectedProjId;
    if ($("projectSelect").options.length) $("projectSelect").value = s.selectedProjId;
    $("wbsLevelSelect").value = s.wbsLevel;
    toggleWbsMode(s.wbsMode);          // also shows/hides the level dropdown
    wbsExpanded = new Set(s.wbsExpanded); // after toggle, which resets it
    $("durScale").checked = !!s.durScale;
    syncDurControl();
    focusTaskId = s.focusTaskId;
    lastView = { ...s.lastView };

    busy("Undoing…", () => {
      if (lastView.type) {
        rerenderLastView();
        if (lastView.type === "wbs") selectWbsRow(lastView.wbsId);
      } else {
        cy.elements().remove();
        timeScale = null;
        setStatus("Undone — nothing displayed. Pick a WBS branch, search, or use 'Full network'.");
      }
      if (s.viewport) cy.viewport(s.viewport);
      updateRuler();
      if (activeTab === "gantt") renderGantt(); // filters may have changed
    });
  }

  function undo() {
    if (!undoStack.length || !model) return;
    applyState(undoStack.pop());
    updateUndoBtn();
  }

  // ---------- File loading ----------
  function loadXerText(text, fileName) {
    busy("Reading " + fileName + "…", () => {
      try {
        model = XerParser.parseXer(text);
      } catch (err) {
        setStatus("Could not read " + fileName + ": " + err.message, true);
        return;
      }
      focusTaskId = null;
      selectedProjId = "";
      lastView = { type: null, wbsId: null };
      undoStack.length = 0; // undo history belongs to the previous file
      lastCommitted = null;
      updateUndoBtn();

      const nTasks = model.tasks.size;
      const nCrit = [...model.tasks.values()].filter((t) => t.isCritical).length;
      setStatus(
        fileName + " — " + nTasks + " activities, " + model.links.length +
        " relationships, " + nCrit + " critical" +
        (model.warnings.length ? " ⚠ " + model.warnings.join(" ") : "")
      );

      // Project selector (only shown for multi-project files)
      const sel = $("projectSelect");
      sel.innerHTML = "";
      if (model.projects.length > 1) {
        sel.appendChild(new Option("All projects", ""));
        for (const p of model.projects) sel.appendChild(new Option(p.name, p.id));
        sel.style.display = "";
      } else {
        sel.style.display = "none";
      }

      // WBS tree in the sidebar
      buildWbsTree();
      buildWbsTreeDom();
      assignDisciplineColours();
      buildLegend();

      // WBS-mode roll-up level selector (level 1 = disciplines)
      const lvl = $("wbsLevelSelect");
      lvl.innerHTML = "";
      for (let n = 1; n <= Math.min(wbsTree.maxTaskDepth, 9); n++) {
        lvl.appendChild(new Option("Level " + n, n));
      }
      lvl.appendChild(new Option("All tasks (no grouping)", 99));
      lvl.value = "1";
      const glvl = $("ganttLevelSelect");
      glvl.innerHTML = lvl.innerHTML; // same levels in the Gantt toolbar
      glvl.value = "1";
      wbsExpanded.clear();
      if (wbsMode) setUniformWbsLevel(1);

      $("searchInput").value = "";
      $("searchInput").disabled = false;
      $("dropHint").style.display = "none";
      for (const id of ["layoutSelect", "directionSelect", "depthSelect", "criticalOnly",
                        "floatThreshold", "excludeMilestones", "wbsModeBtn",
                        "fullNetworkBtn", "fitBtn"]) {
        $(id).disabled = false;
      }
      syncDurControl();
      $("detailsPanel").innerHTML =
        '<p class="hint">Search for an activity above, or click a node in the diagram.</p>';

      // Default view: whole schedule rolled up to WBS level 1 (disciplines),
      // in time order - a readable overview no matter the schedule size.
      $("layoutSelect").value = "time";
      $("durScale").checked = true; // time order defaults to duration bars
      $("wbsLevelSelect").value = "1";
      toggleWbsMode(true);
      renderFullNetwork();
      ganttSel = null;
      networkStale = false;
      if (activeTab === "gantt") renderGantt();
    });
  }

  function loadFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      // XER files are usually Windows-1252 encoded, not UTF-8.
      let text;
      try {
        text = new TextDecoder("windows-1252").decode(reader.result);
      } catch (e) {
        text = new TextDecoder().decode(reader.result);
      }
      loadXerText(text, file.name);
    };
    reader.readAsArrayBuffer(file);
  }

  // ---------- WBS tree ----------
  function buildWbsTree() {
    const children = new Map();
    const directCounts = new Map();
    for (const t of model.tasks.values()) {
      directCounts.set(t.wbsId, (directCounts.get(t.wbsId) || 0) + 1);
    }
    const roots = [];
    for (const [id, node] of model.wbs) {
      if (node.parentId && model.wbs.has(node.parentId)) {
        if (!children.has(node.parentId)) children.set(node.parentId, []);
        children.get(node.parentId).push(id);
      } else {
        roots.push(id);
      }
    }
    const subCount = new Map();
    function calc(id) {
      let c = directCounts.get(id) || 0;
      for (const k of children.get(id) || []) c += calc(k);
      subCount.set(id, c);
      return c;
    }
    for (const r of roots) calc(r);

    // depth of every WBS node (root = 0, disciplines = 1, ...) and the
    // deepest level that directly holds activities
    const depths = new Map();
    let maxTaskDepth = 1;
    const queue = roots.map((r) => [r, 0]);
    while (queue.length) {
      const [id, d] = queue.shift();
      depths.set(id, d);
      if (directCounts.get(id) && d > maxTaskDepth) maxTaskDepth = d;
      for (const k of children.get(id) || []) queue.push([k, d + 1]);
    }

    wbsTree = { children, subCount, roots, depths, maxTaskDepth };
  }

  /** Expand every group above `level`, so the diagram shows WBS level N. */
  function setUniformWbsLevel(level) {
    wbsExpanded.clear();
    for (const id of model.wbs.keys()) {
      const d = wbsTree.depths.get(id);
      if (d >= 1 && d < level && (wbsTree.subCount.get(id) || 0) > 0) {
        wbsExpanded.add(id);
      }
    }
  }

  /**
   * The WBS group a task rolls up into, honouring drill-down: walk from the
   * discipline level towards the task's own WBS; stop at the first group
   * that hasn't been expanded. Returns null when the task itself should be
   * shown (its whole chain is expanded).
   */
  function groupWbsFor(t) {
    const chain = [];
    let node = model.wbs.get(t.wbsId);
    let guard = 0;
    while (node && guard++ < 60) {
      chain.unshift(node);
      node = node.parentId ? model.wbs.get(node.parentId) : null;
    }
    for (let i = 1; i < chain.length; i++) { // chain[0] is the project root
      if (!wbsExpanded.has(chain[i].id)) return chain[i];
    }
    return null;
  }

  function wbsDescendants(wbsId) {
    const set = new Set([wbsId]);
    const stack = [wbsId];
    while (stack.length) {
      const cur = stack.pop();
      for (const k of wbsTree.children.get(cur) || []) {
        set.add(k);
        stack.push(k);
      }
    }
    return set;
  }

  function buildWbsTreeDom() {
    const container = $("wbsTree");
    container.innerHTML = "";
    if (!wbsTree || !wbsTree.roots.length) {
      container.innerHTML = '<p class="hint">No WBS found in this file.</p>';
      return;
    }

    function makeNode(id, depth) {
      const w = model.wbs.get(id);
      const kids = (wbsTree.children.get(id) || []).filter(
        (k) => wbsTree.subCount.get(k) > 0
      );
      const wrap = document.createElement("div");

      const row = document.createElement("div");
      row.className = "wbs-row";
      row.style.paddingLeft = depth * 14 + "px";
      row.dataset.wbs = id;

      const expanded = depth < 1; // root level starts open, deeper collapsed
      const tog = document.createElement("span");
      tog.className = "wbs-toggle";
      tog.textContent = kids.length ? (expanded ? "▾" : "▸") : "";

      const lbl = document.createElement("span");
      lbl.className = "wbs-label";
      lbl.textContent = w.name;
      lbl.title = w.name;

      const cnt = document.createElement("span");
      cnt.className = "wbs-count";
      cnt.textContent = wbsTree.subCount.get(id);

      row.append(tog, lbl, cnt);
      wrap.appendChild(row);

      const kidsWrap = document.createElement("div");
      if (!expanded) kidsWrap.style.display = "none";
      for (const k of kids) kidsWrap.appendChild(makeNode(k, depth + 1));
      wrap.appendChild(kidsWrap);

      tog.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!kids.length) return;
        const open = kidsWrap.style.display !== "none";
        kidsWrap.style.display = open ? "none" : "";
        tog.textContent = open ? "▸" : "▾";
      });
      row.addEventListener("click", () => {
        if (activeTab === "gantt") {
          selectWbsRow(id);
          ganttScrollToWbs(id);
          return;
        }
        pushUndo();
        selectWbsRow(id);
        busy("Drawing " + w.name + "…", () => renderWbsView(id));
      });
      return wrap;
    }

    for (const r of wbsTree.roots) {
      if (wbsTree.subCount.get(r) > 0) container.appendChild(makeNode(r, 0));
    }
  }

  function selectWbsRow(wbsId) {
    const container = $("wbsTree");
    for (const r of container.querySelectorAll(".wbs-row.sel")) r.classList.remove("sel");
    const row = container.querySelector('[data-wbs="' + CSS.escape(wbsId) + '"]');
    if (row) row.classList.add("sel");
  }

  // ---------- Trace logic ----------
  function visibleTasks() {
    const out = [];
    for (const t of model.tasks.values()) {
      if (!selectedProjId || t.projId === selectedProjId) out.push(t);
    }
    return out;
  }

  /**
   * From the focus task, walk predecessor and/or successor links.
   * Returns { nodeIds:Set, linkIds:Set }
   */
  function trace(focusId) {
    const direction = $("directionSelect").value; // both | pred | succ
    const depthVal = $("depthSelect").value;      // "all" or a number
    const maxDepth = depthVal === "all" ? Infinity : parseInt(depthVal, 10);
    const critOnly = criticalOnly();

    const nodeIds = new Set([focusId]);

    function walk(startId, dir) {
      let frontier = [startId];
      let depth = 0;
      while (frontier.length && depth < maxDepth) {
        const next = [];
        for (const id of frontier) {
          const task = model.tasks.get(id);
          const edges = dir === "up" ? task.predecessors : task.successors;
          for (const link of edges) {
            const otherId = dir === "up" ? link.predId : link.succId;
            const other = model.tasks.get(otherId);
            if (critOnly && !isCriticalTask(other)) continue;
            if (!nodeIds.has(otherId)) {
              nodeIds.add(otherId);
              next.push(otherId);
            }
          }
        }
        frontier = next;
        depth++;
      }
    }

    if (direction === "both" || direction === "pred") walk(focusId, "up");
    if (direction === "both" || direction === "succ") walk(focusId, "down");

    // include every link whose two ends are both in the set
    const linkIds = new Set();
    for (const link of model.links) {
      if (nodeIds.has(link.predId) && nodeIds.has(link.succId)) linkIds.add(link.id);
    }
    return { nodeIds, linkIds };
  }

  // ---------- Rendering ----------
  function taskToNode(task, widths) {
    const label = task.name; // activity IDs live in the details panel, not the diagram
    const classes = [];
    if (isCriticalTask(task)) classes.push("critical");
    if (task.isMilestone) classes.push("milestone");
    if (task.status === "TK_Complete") classes.push("complete");
    if (task.id === focusTaskId) classes.push("focus");
    const w = widths && widths[task.id] ? widths[task.id] : NODE_W;
    const col = colourFor(task.discipline, wbsTree.depths.get(task.wbsId) || 3);
    const data = {
      id: task.id, label, w, tmw: Math.max(w - 15, 90),
      bg: col.bg, bd: col.bd,
    };
    return { data, classes: classes.join(" ") };
  }

  /**
   * With duration bars on (time layout), anchor each relationship to the
   * time-true point on the bar: FS leaves the predecessor's finish (right
   * end) and lands on the successor's start (left end), SS start->start,
   * FF finish->finish, SF start->finish. Offsets are px from node centre.
   */
  function timeEndpointStyle(typeLabel, predId, succId, widths) {
    if (!widths) return null;
    const halfW = (id) => {
      const t = model.tasks.get(id);
      if (!t) return NODE_W / 2;
      if (t.isMilestone) return 35;
      return (widths[id] || NODE_W) / 2;
    };
    const wp = halfW(predId);
    const ws = halfW(succId);
    const srcAtFinish = typeLabel === "FS" || typeLabel === "FF";
    const tgtAtFinish = typeLabel === "FF" || typeLabel === "SF";
    return {
      "source-endpoint": (srcAtFinish ? wp : -wp) + " 0",
      "target-endpoint": (tgtAtFinish ? ws : -ws) + " 0",
    };
  }

  function linkToEdge(link, widths) {
    const pred = model.tasks.get(link.predId);
    const succ = model.tasks.get(link.succId);
    let label = "";
    if (link.typeLabel !== "FS" || link.lagDays !== 0) {
      label = link.typeLabel;
      if (link.lagDays) label += (link.lagDays > 0 ? "+" : "") + fmtDays(link.lagDays);
    }
    const classes = [];
    if (isCriticalTask(pred) && isCriticalTask(succ)) classes.push("critical-edge");
    const el = {
      data: { id: "e" + link.id, source: link.predId, target: link.succId, label },
      classes: classes.join(" "),
    };
    const ep = timeEndpointStyle(link.typeLabel, link.predId, link.succId, widths);
    if (ep) el.style = ep;
    return el;
  }

  function bridgeToEdge(b, widths) {
    const el = {
      data: {
        id: "br" + b.predId + ">" + b.succId,
        source: b.predId,
        target: b.succId,
        label: "",
      },
      classes: "bridge" + (b.critical ? " critical-edge" : ""),
    };
    const ep = timeEndpointStyle("FS", b.predId, b.succId, widths);
    if (ep) el.style = ep;
    return el;
  }

  // ---------- Time-scaled layout ----------
  const NODE_W = 175;   // must match the node width in the Cytoscape style
  const LANE_H = 78;    // vertical spacing between lanes
  const GROUP_GAP = 55; // extra gap between discipline groups
  let timeScale = null; // { min: epoch-ms of schedule start, pxPerDay }

  function layoutMode() {
    return $("layoutSelect").value; // time | logic
  }

  /**
   * x = start date (left -> right through time); y = packed lanes, grouped
   * by discipline. When durScale is on, each node's width spans its duration.
   * `items` are tasks or WBS-group aggregates - anything with
   * { id, start, finish, durationDays, isMilestone, discipline }.
   * Returns { positions: {id:{x,y}}, widths: {id:px}|null } or null when no
   * item has dates.
   */
  function computeTimePositions(items) {
    const tasks = items;
    const dated = tasks.filter((t) => t.start);
    if (!dated.length) return null;

    const min = Math.min(...dated.map((t) => t.start.getTime()));
    const max = Math.max(...dated.map((t) => (t.finish || t.start).getTime()));
    const days = Math.max(1, (max - min) / 86400000);
    // sensible default density, clamped so tiny/huge schedules stay usable
    let pxPerDay = 8;
    if (days * pxPerDay > 30000) pxPerDay = 30000 / days;
    if (days * pxPerDay < 1200) pxPerDay = 1200 / days;
    timeScale = { min, pxPerDay };

    // node width: fixed box, or a bar spanning start -> finish when
    // duration bars are on (real dates, so bar ends line up with the axis)
    const durOn = durationBarsOn();
    const widths = durOn ? {} : null;
    const nodeWidth = (t) => {
      if (t.isMilestone) return 70;
      if (!durOn) return NODE_W;
      let calDays;
      if (t.start && t.finish) {
        calDays = (t.finish.getTime() - t.start.getTime()) / 86400000;
      } else {
        calDays = (t.durationDays || 0) * 1.4; // no dates: rough estimate
      }
      return Math.max(46, calDays * pxPerDay);
    };

    // group tasks by discipline, keeping the schedule's WBS order
    const groups = new Map();
    for (const t of tasks) {
      const g = t.discipline || "";
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(t);
    }
    const wbsOrder = model.disciplines.map((d) => d.name);
    const groupNames = [...groups.keys()].sort((a, b) => {
      const ia = wbsOrder.indexOf(a), ib = wbsOrder.indexOf(b);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    });

    const positions = {};
    let yBase = 40;
    for (const gname of groupNames) {
      // pack this group's activities into lanes: sort by start, drop each
      // into the first lane whose previous node has cleared its x range
      const items = groups.get(gname)
        .map((t) => ({
          t,
          x: t.start ? ((t.start.getTime() - min) / 86400000) * pxPerDay : 0,
        }))
        .sort((a, b) => a.x - b.x);
      const laneEnds = []; // rightmost occupied pixel per lane
      for (const it of items) {
        const w = nodeWidth(it.t);
        if (widths && !it.t.isMilestone) widths[it.t.id] = Math.round(w);
        let lane = laneEnds.findIndex((end) => end <= it.x - 6);
        if (lane < 0) {
          lane = laneEnds.length;
          laneEnds.push(0);
        }
        laneEnds[lane] = it.x + w + 22;
        positions[it.t.id] = {
          x: it.x + w / 2,
          y: yBase + lane * LANE_H,
        };
      }
      yBase += laneEnds.length * LANE_H + GROUP_GAP;
    }
    return { positions, widths };
  }

  function updateRuler() {
    const ruler = $("timeRuler");
    const grid = $("gridlines");
    const active = layoutMode() === "time" && timeScale && cy.nodes().length > 0;
    ruler.style.display = active ? "" : "none";
    if (!active) {
      ruler.innerHTML = "";
      grid.innerHTML = "";
      return;
    }
    const zoom = cy.zoom();
    const panX = cy.pan().x;
    const width = $("graphWrap").clientWidth;
    // label every Nth month so labels never collide when zoomed out
    const pxPerMonthScreen = timeScale.pxPerDay * 30.4 * zoom;
    const step = Math.max(1, Math.ceil(56 / pxPerMonthScreen));

    // data-date position first, so month labels can step aside for it
    let ddX = null;
    if (model && model.dataDate) {
      const x =
        ((model.dataDate.getTime() - timeScale.min) / 86400000) *
          timeScale.pxPerDay * zoom + panX;
      if (x >= -60 && x <= width + 60) ddX = x;
    }

    let ticks = "";
    let lines = "";
    const d = new Date(timeScale.min);
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    for (let i = 0; i < 400; i++) {
      const x = ((d.getTime() - timeScale.min) / 86400000) * timeScale.pxPerDay * zoom + panX;
      if (x > width) break;
      if (x >= -100 && i % step === 0) {
        lines += '<div class="gridline" style="left:' + x + 'px"></div>';
        // keep month labels clear of the data-date label
        if (ddX === null || x < ddX - 40 || x > ddX + 150) {
          const label =
            d.toLocaleDateString(undefined, { month: "short" }) +
            " '" + String(d.getFullYear()).slice(2);
          ticks += '<div class="ruler-tick" style="left:' + x + 'px">' + label + "</div>";
        }
      }
      d.setMonth(d.getMonth() + 1);
    }
    if (ddX !== null) {
      ticks += '<div class="dd-label" style="left:' + ddX + 'px">Data date ' +
        fmtDate(model.dataDate) + "</div>";
      lines += '<div class="dd-line" style="left:' + ddX + 'px"></div>';
    }
    ruler.innerHTML = ticks;
    grid.innerHTML = lines;
  }

  /**
   * Roll the current view up to one node per WBS group: aggregate dates,
   * counts and criticality, and merge task links that cross group
   * boundaries into single edges.
   */
  function aggregateByWbs(nodeIds, linkIds, bridges) {
    const groups = new Map();   // wbsId -> group item
    const taskItems = [];       // tasks shown individually (fully drilled)
    const entityOf = new Map(); // taskId -> element id it appears as

    for (const id of nodeIds) {
      const t = model.tasks.get(id);
      const gw = groupWbsFor(t);
      if (!gw) {
        taskItems.push(t);
        entityOf.set(id, id);
        continue;
      }
      entityOf.set(id, "g-" + gw.id);
      let g = groups.get(gw.id);
      if (!g) {
        g = {
          id: "g-" + gw.id,
          wbsId: gw.id,
          name: gw.name || "(unnamed WBS)",
          discipline: t.discipline,
          count: 0,
          critCount: 0,
          start: null,
          finish: null,
          durationDays: 0,
          isMilestone: false,
        };
        groups.set(gw.id, g);
      }
      g.count++;
      if (isCriticalTask(t)) g.critCount++;
      if (t.start && (!g.start || t.start < g.start)) g.start = t.start;
      const f = t.finish || t.start;
      if (f && (!g.finish || f > g.finish)) g.finish = f;
    }
    for (const g of groups.values()) {
      // calendar span; bar widths use start/finish directly
      if (g.start && g.finish) {
        g.durationDays = (g.finish.getTime() - g.start.getTime()) / 86400000;
      }
    }

    const edgeMap = new Map();
    for (const link of model.links) {
      if (!linkIds.has(link.id)) continue;
      const pe = entityOf.get(link.predId);
      const se = entityOf.get(link.succId);
      if (!pe || !se || pe === se) continue; // internal logic stays inside its node
      const key = pe + ">" + se;
      let e = edgeMap.get(key);
      if (!e) {
        e = { pred: pe, succ: se, count: 0, critical: false, links: [] };
        edgeMap.set(key, e);
      }
      e.count++;
      e.links.push(link);
      const p = model.tasks.get(link.predId);
      const s = model.tasks.get(link.succId);
      if (isCriticalTask(p) && isCriticalTask(s)) e.critical = true;
    }
    // milestone-bridge connections merge into the same entity edges
    for (const b of bridges || []) {
      const pe = entityOf.get(b.predId);
      const se = entityOf.get(b.succId);
      if (!pe || !se || pe === se) continue;
      const key = pe + ">" + se;
      let e = edgeMap.get(key);
      if (!e) {
        e = { pred: pe, succ: se, count: 0, critical: false, links: [] };
        edgeMap.set(key, e);
      }
      e.count++;
      if (b.critical) e.critical = true;
    }
    return { groupItems: [...groups.values()], taskItems, edges: [...edgeMap.values()] };
  }

  function groupToNode(g, widths) {
    const label =
      g.name + "\n" + g.count + (g.count === 1 ? " activity" : " activities") +
      (g.critCount ? " · " + g.critCount + " critical" : "");
    const classes = ["wbsnode"];
    if (g.critCount > 0) classes.push("critical");
    if (
      focusTaskId &&
      model.tasks.has(focusTaskId) &&
      model.tasks.get(focusTaskId).wbsId === g.wbsId
    ) {
      classes.push("focus");
    }
    const w = widths && widths[g.id] ? widths[g.id] : NODE_W;
    const col = colourFor(g.discipline, wbsTree.depths.get(g.wbsId) || 1);
    return {
      data: {
        id: g.id, label, w, tmw: Math.max(w - 15, 130),
        bg: col.bg, bd: col.bd,
      },
      classes: classes.join(" "),
    };
  }

  function aggEdgeToElement(e, widths) {
    // a single task-to-task link keeps its real relationship label (FS+lag etc.)
    if (
      e.count === 1 && e.links.length === 1 &&
      !e.pred.startsWith("g-") && !e.succ.startsWith("g-")
    ) {
      return linkToEdge(e.links[0], widths);
    }
    const classes = [];
    if (e.critical) classes.push("critical-edge");
    if (e.links.length === 0) classes.push("bridge"); // milestone bridges only
    return {
      data: {
        id: "ge-" + e.pred + "-" + e.succ,
        source: e.pred,
        target: e.succ,
        label: e.count > 1 ? "×" + e.count : "",
      },
      classes: classes.join(" "),
    };
  }

  function renderElements(nodeIds, linkIds) {
    const elements = [];
    let timeLayout = null;

    // milestone filter applies to every view; bridges keep the logic joined
    const filtered = applyMilestoneFilter(nodeIds, linkIds);
    nodeIds = filtered.nodeIds;
    linkIds = filtered.linkIds;
    const bridges = filtered.bridges;

    if (wbsMode) {
      const agg = aggregateByWbs(nodeIds, linkIds, bridges);
      const layoutItems = [...agg.groupItems, ...agg.taskItems];
      if (layoutMode() === "time") timeLayout = computeTimePositions(layoutItems);
      for (const g of agg.groupItems) {
        elements.push(groupToNode(g, timeLayout && timeLayout.widths));
      }
      for (const t of agg.taskItems) {
        elements.push(taskToNode(t, timeLayout && timeLayout.widths));
      }
      for (const e of agg.edges) {
        elements.push(aggEdgeToElement(e, timeLayout && timeLayout.widths));
      }
    } else {
      const tasks = [...nodeIds].map((id) => model.tasks.get(id));
      if (layoutMode() === "time") timeLayout = computeTimePositions(tasks);
      for (const t of tasks) {
        elements.push(taskToNode(t, timeLayout && timeLayout.widths));
      }
      for (const link of model.links) {
        if (linkIds.has(link.id)) {
          elements.push(linkToEdge(link, timeLayout && timeLayout.widths));
        }
      }
      for (const b of bridges) {
        elements.push(bridgeToEdge(b, timeLayout && timeLayout.widths));
      }
    }

    hideTooltip();
    const hadElements = cy.nodes().length > 0;
    const viewport = { zoom: cy.zoom(), pan: { x: cy.pan().x, y: cy.pan().y } };
    // remember where everything was, so expand/collapse can animate from there
    const oldPositions = new Map();
    if (animateNext) {
      cy.nodes().forEach((n) => {
        if (!n.isParent()) oldPositions.set(n.id(), { x: n.position("x"), y: n.position("y") });
      });
    }
    cy.startBatch();
    cy.elements().remove();
    cy.add(elements);
    cy.endBatch();

    if (timeLayout) {
      cy.layout({
        name: "preset",
        positions: (node) => timeLayout.positions[node.id()],
        fit: false,
      }).run();
    } else {
      timeScale = null;
      cy.layout({
        name: "dagre",
        rankDir: "LR",
        nodeSep: 18,
        rankSep: 90,
        edgeSep: 10,
        padding: 30,
      }).run();
    }
    if (keepViewportOnce && hadElements) {
      // expanding/collapsing in place: stay where the user was looking
      cy.viewport(viewport);
    } else {
      cy.fit(undefined, 40);
    }
    keepViewportOnce = false;

    // "bubbles opening": every node animates from where it was; brand-new
    // nodes (an expanded group's children) grow out of the clicked node
    if (animateNext && hadElements) {
      cy.nodes().forEach((n) => {
        if (n.isParent()) return;
        const target = { x: n.position("x"), y: n.position("y") };
        const from = oldPositions.get(n.id()) || morphOrigin;
        if (!from || (from.x === target.x && from.y === target.y)) return;
        n.position(from);
        n.animate({ position: target }, { duration: 380, easing: "ease-in-out-quad" });
      });
    }
    animateNext = false;
    morphOrigin = null;
    updateRuler();
    updateNodeChips();
    $("emptyMsg").style.display = cy.nodes().length ? "none" : "flex";
  }

  function linksAmong(nodeIds) {
    const linkIds = new Set();
    for (const link of model.links) {
      if (nodeIds.has(link.predId) && nodeIds.has(link.succId)) linkIds.add(link.id);
    }
    return linkIds;
  }

  function renderTrace() {
    if (!model || !focusTaskId) return;
    lastView = { type: "trace", discipline: null };
    const { nodeIds, linkIds } = trace(focusTaskId);
    renderElements(nodeIds, linkIds);
    const t = model.tasks.get(focusTaskId);
    let note = "";
    if (criticalOnly()) {
      note = isCriticalTask(t)
        ? " (critical only)"
        : " (critical only — note: this activity itself is not critical, TF " +
          fmtDays(t.totalFloatDays) + ")";
    }
    setStatus(
      "Tracing " + t.code + " — showing " + nodeIds.size + " activities, " +
      linkIds.size + " relationships" + note +
      (wbsMode ? " · rolled up to WBS groups" : "")
    );
  }

  function renderFullNetwork() {
    if (!model) return;
    lastView = { type: "full", discipline: null };
    let tasks = visibleTasks();
    if (criticalOnly()) tasks = tasks.filter(isCriticalTask);
    if (!wbsMode && tasks.length > 2500) {
      if (!confirm(
        "This will draw " + tasks.length +
        " activities, which may take a while. Continue?"
      )) return;
    }
    const nodeIds = new Set(tasks.map((t) => t.id));
    const linkIds = linksAmong(nodeIds);
    renderElements(nodeIds, linkIds);
    setStatus(
      "Full network — " + nodeIds.size + " activities, " + linkIds.size +
      " relationships" + (criticalOnly() ? " (critical only)" : "") +
      (wbsMode ? " · rolled up to WBS groups" : "")
    );
  }

  function renderWbsView(wbsId) {
    if (!model || !wbsId || !model.wbs.has(wbsId)) return;
    lastView = { type: "wbs", wbsId };
    focusTaskId = null;
    const name = model.wbs.get(wbsId).name;
    const inSubtree = wbsDescendants(wbsId);
    let tasks = visibleTasks().filter((t) => inSubtree.has(t.wbsId));
    if (criticalOnly()) tasks = tasks.filter(isCriticalTask);
    const nodeIds = new Set(tasks.map((t) => t.id));
    const linkIds = linksAmong(nodeIds);
    renderElements(nodeIds, linkIds);
    setStatus(
      name + " — " + nodeIds.size + " activities, " + linkIds.size +
      " relationships" + (criticalOnly() ? " (critical only)" : "") +
      (wbsMode ? " · rolled up to WBS groups" : "")
    );
  }

  function toggleWbsMode(on) {
    wbsMode = on;
    $("wbsModeBtn").classList.toggle("active", wbsMode);
    $("wbsLevelSelect").style.display = wbsMode ? "" : "none";
    if (wbsMode && model) {
      setUniformWbsLevel(parseInt($("wbsLevelSelect").value, 10) || 1);
    }
  }

  function rerenderLastView() {
    if (lastView.type === "trace" && focusTaskId) renderTrace();
    else if (lastView.type === "wbs") renderWbsView(lastView.wbsId);
    else if (lastView.type === "full") renderFullNetwork();
  }

  // ---------- WBS drill-down (shared by chips, double-click, right-click) ----------
  function expandGroup(wbsId, origin) {
    if (!model || wbsExpanded.has(wbsId)) return;
    pushUndo();
    wbsExpanded.add(wbsId);
    keepViewportOnce = true;
    animateNext = true;
    morphOrigin = origin || null;
    busy("Expanding…", rerenderLastView);
  }

  function collapseGroup(parentWbsId, origin) {
    if (!model || !parentWbsId || !wbsExpanded.has(parentWbsId)) return;
    pushUndo();
    wbsExpanded.delete(parentWbsId);
    keepViewportOnce = true;
    animateNext = true;
    morphOrigin = origin || null;
    busy("Collapsing…", rerenderLastView);
  }

  /**
   * Small + / − buttons on each WBS balloon, so drilling doesn't rely on
   * knowing the double-click / right-click gestures. HTML overlay kept in
   * sync with the balloons' rendered positions.
   */
  function updateNodeChips() {
    const wrap = $("nodeChips");
    if (!model || !wbsMode || !cy) {
      wrap.innerHTML = "";
      return;
    }
    const groups = cy.nodes(".wbsnode");
    const wrapW = $("graphWrap").clientWidth;
    const wrapH = $("graphWrap").clientHeight;
    // chips scale with the diagram so they always stay in proportion to the
    // boxes; below ~7px they are unclickable dust, so hide them entirely
    const zoom = cy.zoom();
    const s = Math.round(19 * zoom * 10) / 10;
    if (s < 7) {
      wrap.innerHTML = "";
      return;
    }
    const chipStyle =
      "width:" + s + "px;height:" + s + "px;font-size:" + (13 * zoom).toFixed(1) +
      "px;line-height:" + (s - 3).toFixed(1) + "px;";
    let html = "";
    groups.forEach((n) => {
      const rp = n.renderedPosition();
      if (rp.x < -40 || rp.x > wrapW + 40 || rp.y < -40 || rp.y > wrapH + 40) {
        return; // off-screen
      }
      const rw = n.renderedWidth();
      const rh = n.renderedHeight();
      const topY = rp.y - rh / 2 - s / 2;
      const wbsId = n.id().slice(2);
      html +=
        '<button class="node-chip expand" data-exp="' + escapeHtml(wbsId) +
        '" title="Expand into the next WBS level" style="' + chipStyle + "left:" +
        (rp.x + rw / 2 - s * 0.55) + "px;top:" + topY + 'px">+</button>';
      const parent = (model.wbs.get(wbsId) || {}).parentId;
      if (parent && wbsExpanded.has(parent)) {
        html +=
          '<button class="node-chip collapse" data-col="' + escapeHtml(parent) +
          '" data-node="' + escapeHtml(n.id()) +
          '" title="Collapse back up a level" style="' + chipStyle + "left:" +
          (rp.x + rw / 2 - s * 0.55 - s - 2 * zoom) + "px;top:" + topY + 'px">−</button>';
      }
    });
    wrap.innerHTML = html;
    for (const b of wrap.querySelectorAll("[data-exp]")) {
      b.addEventListener("click", () => {
        const n = cy.getElementById("g-" + b.getAttribute("data-exp"));
        expandGroup(b.getAttribute("data-exp"), n.nonempty() ? { x: n.position("x"), y: n.position("y") } : null);
      });
    }
    for (const b of wrap.querySelectorAll("[data-col]")) {
      b.addEventListener("click", () => {
        const n = cy.getElementById(b.getAttribute("data-node"));
        collapseGroup(b.getAttribute("data-col"), n.nonempty() ? { x: n.position("x"), y: n.position("y") } : null);
      });
    }
  }

  let chipRaf = null;
  function scheduleNodeChips() {
    if (chipRaf) return;
    chipRaf = requestAnimationFrame(() => {
      chipRaf = null;
      updateNodeChips();
    });
  }

  // ---------- Details panel ----------
  function relListHtml(task, links, dir) {
    if (!links.length) return '<p class="hint">None</p>';
    const rows = links.map((link) => {
      const otherId = dir === "up" ? link.predId : link.succId;
      const other = model.tasks.get(otherId);
      const crit = isCriticalTask(other) ? " crit" : "";
      let rel = link.typeLabel;
      if (link.lagDays) rel += (link.lagDays > 0 ? "+" : "") + fmtDays(link.lagDays);
      return (
        '<li class="rel-item' + crit + '" data-task="' + escapeHtml(otherId) + '">' +
        '<span class="rel-type">' + rel + "</span>" +
        "<strong>" + escapeHtml(other.code) + "</strong> " +
        escapeHtml(other.name) + "</li>"
      );
    });
    return "<ul class='rel-list'>" + rows.join("") + "</ul>";
  }

  function showDetails(taskId) {
    const t = model.tasks.get(taskId);
    if (!t) return;
    const crit = isCriticalTask(t);
    $("detailsPanel").innerHTML =
      '<div class="detail-head' + (crit ? " crit" : "") + '">' +
      "<h3>" + escapeHtml(t.code) + "</h3>" +
      "<p>" + escapeHtml(t.name) + "</p>" +
      (crit ? '<span class="badge">CRITICAL</span>' : "") +
      "</div>" +
      '<table class="detail-table">' +
      "<tr><td>Discipline</td><td>" + escapeHtml(t.discipline || "—") + "</td></tr>" +
      "<tr><td>Type</td><td>" + escapeHtml(t.typeLabel) + "</td></tr>" +
      "<tr><td>Status</td><td>" + escapeHtml(t.statusLabel) + "</td></tr>" +
      "<tr><td>Duration</td><td>" + fmtDays(t.durationDays) + "</td></tr>" +
      "<tr><td>Total float</td><td>" + fmtDays(t.totalFloatDays) + "</td></tr>" +
      "<tr><td>Start</td><td>" + fmtDate(t.start) + "</td></tr>" +
      "<tr><td>Finish</td><td>" + fmtDate(t.finish) + "</td></tr>" +
      "<tr><td>Late start</td><td>" + fmtDate(t.lateStart) + "</td></tr>" +
      "<tr><td>Late finish</td><td>" + fmtDate(t.lateFinish) + "</td></tr>" +
      "<tr><td>WBS</td><td>" + escapeHtml(t.wbsPath || "—") + "</td></tr>" +
      "</table>" +
      '<button id="focusBtn" class="btn primary full-width">Trace from this activity</button>' +
      "<h4>Predecessors (" + t.predecessors.length + ")</h4>" +
      relListHtml(t, t.predecessors, "up") +
      "<h4>Successors (" + t.successors.length + ")</h4>" +
      relListHtml(t, t.successors, "down");

    $("focusBtn").addEventListener("click", () => focusOn(taskId));
    for (const li of $("detailsPanel").querySelectorAll(".rel-item")) {
      li.addEventListener("click", () => {
        const id = li.getAttribute("data-task");
        if (activeTab === "gantt") {
          ganttSelect(id, true); // step through the logic chain in the Gantt
          return;
        }
        showDetails(id);
        const node = cy.getElementById(id);
        if (node.nonempty()) {
          cy.animate({ center: { eles: node } }, { duration: 250 });
          highlightNode(id);
        }
      });
    }
  }

  function highlightNode(taskId) {
    cy.nodes().removeClass("selected");
    const node = cy.getElementById(taskId);
    if (node.nonempty()) node.addClass("selected");
  }

  function focusOn(taskId) {
    if (activeTab === "gantt") switchTab("network"); // traces live on the network
    pushUndo();
    focusTaskId = taskId;
    busy("Tracing…", () => {
      renderTrace();
      showDetails(taskId);
      highlightNode(taskId);
    });
  }

  // ---------- Search ----------
  function runSearch(query) {
    const box = $("searchResults");
    if (!model || !query.trim()) {
      box.style.display = "none";
      box.innerHTML = "";
      return;
    }
    const q = query.trim().toLowerCase();

    // WBS branches (any level) that match go on top, best matches first:
    // exact name, then names starting with the query, then shortest names
    let wbsMatches = [];
    if (wbsTree) {
      for (const [id, node] of model.wbs) {
        const name = node.name.toLowerCase();
        if (name.includes(q) && (wbsTree.subCount.get(id) || 0) > 0) {
          const rank = name === q ? 0 : name.startsWith(q) ? 1 : 2;
          wbsMatches.push({ id, name: node.name, count: wbsTree.subCount.get(id), rank });
        }
      }
      wbsMatches.sort((a, b) => a.rank - b.rank || a.name.length - b.name.length);
      wbsMatches = wbsMatches.slice(0, 8);
    }

    const matches = [];
    for (const t of visibleTasks()) {
      if (
        t.code.toLowerCase().includes(q) ||
        t.name.toLowerCase().includes(q) ||
        (t.wbsPath && t.wbsPath.toLowerCase().includes(q))
      ) {
        matches.push(t);
        if (matches.length >= 50) break;
      }
    }

    if (!wbsMatches.length && !matches.length) {
      box.innerHTML = '<div class="search-empty">No matching activities</div>';
      box.style.display = "";
      return;
    }

    box.innerHTML =
      wbsMatches
        .map(
          (d) =>
            '<div class="search-item discipline" data-wbs="' +
            escapeHtml(d.id) + '">' +
            '<span class="disc-tag">WBS</span><strong>' +
            escapeHtml(d.name) + "</strong>" +
            '<span class="search-meta">' + d.count +
            " activities — show network</span></div>"
        )
        .join("") +
      matches
        .map(
          (t) =>
            '<div class="search-item' + (isCriticalTask(t) ? " crit" : "") +
            '" data-task="' + escapeHtml(t.id) + '">' +
            "<strong>" + escapeHtml(t.code) + "</strong> " + escapeHtml(t.name) +
            '<span class="search-meta">' +
            escapeHtml(t.wbsName || t.discipline || "") +
            " · " + fmtDate(t.start) + " · TF " + fmtDays(t.totalFloatDays) +
            "</span></div>"
        )
        .join("");
    box.style.display = "";

    for (const item of box.querySelectorAll(".search-item")) {
      item.addEventListener("click", () => {
        box.style.display = "none";
        $("searchInput").value = "";
        const wbsId = item.getAttribute("data-wbs");
        if (wbsId) {
          if (activeTab === "gantt") {
            selectWbsRow(wbsId);
            ganttScrollToWbs(wbsId);
          } else {
            pushUndo();
            selectWbsRow(wbsId);
            busy("Drawing…", () => renderWbsView(wbsId));
          }
        } else if (activeTab === "gantt") {
          ganttSelect(item.getAttribute("data-task"), true);
        } else {
          focusOn(item.getAttribute("data-task"));
        }
      });
    }
  }

  // ---------- Gantt chart tab ----------
  let activeTab = "network"; // network | gantt
  let networkStale = false;  // filters changed while the Gantt tab was active
  let ganttZoomMult = 1;
  let ganttSel = null;       // selected activity id in the Gantt
  let ganttGeom = null;      // { geom:Map(id->{x,w,y}), min, px, trackW, height, grid }
  const G_LABEL_W = 300;
  const G_DATE_W = 68;
  const G_FROZEN_W = G_LABEL_W + 2 * G_DATE_W; // label + start + finish columns
  const G_ROW_H = 24;
  const G_SCALE_H = 30;

  function fmtShort(d) {
    if (!d) return "—";
    return d.toLocaleDateString(undefined, { day: "2-digit", month: "2-digit", year: "2-digit" });
  }

  function ganttTasks() {
    let list = visibleTasks().filter((t) => t.start);
    if (criticalOnly()) list = list.filter(isCriticalTask);
    if (excludeMilestones()) list = list.filter((t) => !t.isMilestone);
    return list;
  }

  function renderGantt() {
    if (!model) return;
    const list = ganttTasks();
    $("ganttEmpty").style.display = list.length ? "none" : "flex";
    const host = $("ganttRows");
    if (!list.length) {
      host.innerHTML = "";
      $("ganttSvg").innerHTML = "";
      $("ganttDD").style.display = "none";
      ganttGeom = null;
      return;
    }

    const min = Math.min(...list.map((t) => t.start.getTime()));
    const max = Math.max(...list.map((t) => (t.finish || t.start).getTime()));
    const days = Math.max(1, (max - min) / 86400000);
    const px = Math.min(8, Math.max(0.4, 1300 / days)) * ganttZoomMult;
    const trackW = Math.ceil(days * px) + 120;

    // hierarchical WBS rows, sharing wbsExpanded with the network view so
    // groups opened in one view are open in the other
    const tasksByWbs = new Map();
    for (const t of list) {
      if (!tasksByWbs.has(t.wbsId)) tasksByWbs.set(t.wbsId, []);
      tasksByWbs.get(t.wbsId).push(t);
    }
    // per-WBS subtree aggregates (filtered): count, critical count, date span
    const agg = new Map();
    const calcAgg = (id) => {
      let c = 0, cr = 0, mn = Infinity, mx = -Infinity;
      for (const t of tasksByWbs.get(id) || []) {
        c++;
        if (isCriticalTask(t)) cr++;
        const s = t.start.getTime();
        const f = (t.finish || t.start).getTime();
        if (s < mn) mn = s;
        if (f > mx) mx = f;
      }
      for (const k of wbsTree.children.get(id) || []) {
        const a = calcAgg(k);
        c += a.c;
        cr += a.cr;
        if (a.mn < mn) mn = a.mn;
        if (a.mx > mx) mx = a.mx;
      }
      const a = { c, cr, mn, mx };
      agg.set(id, a);
      return a;
    };
    for (const r of wbsTree.roots) calcAgg(r);

    const wbsDisc = (id) => { // level-1 ancestor's name (for colour)
      let cur = id, guard = 0;
      while (cur && model.wbs.has(cur) && guard++ < 60) {
        if (wbsTree.depths.get(cur) === 1) return model.wbs.get(cur).name;
        cur = model.wbs.get(cur).parentId;
      }
      return "";
    };

    const geom = new Map();
    let html = "";
    let y = 0;

    const emitTask = (t, depth) => {
      const x = ((t.start.getTime() - min) / 86400000) * px;
      const w = Math.max((((t.finish || t.start).getTime() - t.start.getTime()) / 86400000) * px, 2);
      const col = colourFor(t.discipline, wbsTree.depths.get(t.wbsId) || 3);
      const crit = isCriticalTask(t);
      let bar;
      if (t.isMilestone) {
        bar =
          '<div class="g-ms' + (crit ? " crit" : "") + '" style="left:' +
          (x - 5).toFixed(1) + "px;background:" + col.bd + '"></div>';
        geom.set(t.id, { x, w: 0, y: y + G_ROW_H / 2 });
      } else {
        bar =
          '<div class="g-bar' + (crit ? " crit" : "") +
          (t.status === "TK_Complete" ? " done" : "") + '" style="left:' +
          x.toFixed(1) + "px;width:" + w.toFixed(1) + "px;background:" + col.bg +
          ";border-color:" + (crit ? CRITICAL_RED : col.bd) + '"></div>';
        geom.set(t.id, { x, w, y: y + G_ROW_H / 2 });
      }
      html +=
        '<div class="g-row g-task" data-task="' + escapeHtml(t.id) +
        '"><div class="g-label" style="padding-left:' + (8 + depth * 14) +
        'px" title="' + escapeHtml(t.code + " " + t.name) + '">' +
        escapeHtml(t.name) +
        '</div><div class="g-date">' + fmtShort(t.start) +
        '</div><div class="g-date">' + fmtShort(t.finish) +
        '</div><div class="g-track" style="width:' +
        trackW + 'px">' + bar + "</div></div>";
      y += G_ROW_H;
    };

    const emitGroup = (id, depth) => {
      const a = agg.get(id);
      if (!a || !a.c) return; // nothing beneath after filtering
      const w = model.wbs.get(id);
      const expanded = wbsExpanded.has(id);
      const col = colourFor(wbsDisc(id), depth);
      const x = ((a.mn - min) / 86400000) * px;
      const bw = Math.max(((a.mx - a.mn) / 86400000) * px, 2);
      html +=
        '<div class="g-row g-group" data-wbs="' + escapeHtml(id) +
        '"><div class="g-label" style="padding-left:' + (8 + (depth - 1) * 14) + "px" +
        (depth === 1
          ? ";box-shadow: inset 4px 0 0 " + (disciplineColour.get(w.name) || NEUTRAL_SERIES)
          : "") +
        '"><span class="g-arrow">' + (expanded ? "▾" : "▸") + "</span>" +
        escapeHtml(w.name) + ' <span class="g-count">' + a.c +
        (a.cr ? " · " + a.cr + " crit" : "") + "</span></div>" +
        '<div class="g-date">' + fmtShort(new Date(a.mn)) +
        '</div><div class="g-date">' + fmtShort(new Date(a.mx)) + "</div>" +
        '<div class="g-track" style="width:' + trackW + 'px">' +
        '<div class="g-sum' + (a.cr ? " crit" : "") + '" style="left:' + x.toFixed(1) +
        "px;width:" + bw.toFixed(1) + "px;background:" + col.bd + '"></div></div></div>';
      y += G_ROW_H;
      if (expanded) {
        for (const k of wbsTree.children.get(id) || []) emitGroup(k, depth + 1);
        const own = (tasksByWbs.get(id) || []).slice().sort((t1, t2) => t1.start - t2.start);
        for (const t of own) emitTask(t, depth);
      }
    };

    for (const r of wbsTree.roots) {
      for (const k of wbsTree.children.get(r) || []) emitGroup(k, 1);
      const rootTasks = (tasksByWbs.get(r) || []).slice().sort((t1, t2) => t1.start - t2.start);
      for (const t of rootTasks) emitTask(t, 1);
    }
    host.innerHTML = html;
    ganttGeom = { geom, min, px, trackW, height: y, grid: "" };
    buildGanttScale();
    if (ganttSel && !geom.has(ganttSel)) ganttSel = null; // filtered away
    ganttApplySelection();
    drawGanttLinks();
  }

  function buildGanttScale() {
    const trk = $("ganttScaleTrack");
    const { min, px, trackW, height } = ganttGeom;
    trk.style.width = trackW + "px";
    const stepMonths = Math.max(1, Math.ceil(60 / (30.4 * px)));
    let ticks = "";
    let grid = "";
    const d = new Date(min);
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    for (let i = 0; i < 500; i++) {
      const x = ((d.getTime() - min) / 86400000) * px;
      if (x > trackW) break;
      if (x >= -80 && i % stepMonths === 0) {
        ticks +=
          '<div class="g-tick" style="left:' + x.toFixed(1) + 'px">' +
          d.toLocaleDateString(undefined, { month: "short" }) +
          " '" + String(d.getFullYear()).slice(2) + "</div>";
        grid +=
          '<line x1="' + x.toFixed(1) + '" y1="0" x2="' + x.toFixed(1) +
          '" y2="' + height + '" stroke="rgba(11,11,11,0.05)" stroke-width="1"/>';
      }
      d.setMonth(d.getMonth() + 1);
    }
    trk.innerHTML = ticks;
    ganttGeom.grid = grid;

    const svg = $("ganttSvg");
    svg.style.left = G_FROZEN_W + "px";
    svg.style.top = G_SCALE_H + "px";
    svg.setAttribute("width", trackW);
    svg.setAttribute("height", height);

    const dd = $("ganttDD");
    if (model.dataDate) {
      const x = ((model.dataDate.getTime() - min) / 86400000) * px;
      dd.style.display = "";
      dd.style.left = (G_FROZEN_W + x).toFixed(1) + "px";
      dd.style.height = G_SCALE_H + height + "px";
    } else {
      dd.style.display = "none";
    }
  }

  function drawGanttLinks() {
    const svg = $("ganttSvg");
    if (!ganttGeom) {
      svg.innerHTML = "";
      return;
    }
    let out = "";
    if (ganttSel && model.tasks.has(ganttSel)) {
      const me = ganttGeom.geom.get(ganttSel);
      if (me) {
        const draw = (link, incoming) => {
          const otherId = incoming ? link.predId : link.succId;
          const o = ganttGeom.geom.get(otherId);
          if (!o) return;
          const predG = incoming ? o : me;
          const succG = incoming ? me : o;
          const tl = link.typeLabel;
          const x1 = predG.x + (tl === "FS" || tl === "FF" ? predG.w : 0);
          const x2 = succG.x + (tl === "FF" || tl === "SF" ? succG.w : 0);
          const colr = incoming ? "#2a78d6" : "#7c3aed";
          out +=
            '<path d="M ' + x1.toFixed(1) + " " + predG.y + " L " +
            (x1 + 9).toFixed(1) + " " + predG.y + " L " + (x1 + 9).toFixed(1) +
            " " + succG.y + " L " + x2.toFixed(1) + " " + succG.y +
            '" fill="none" stroke="' + colr +
            '" stroke-width="1.7" marker-end="url(#gArrow' +
            (incoming ? "P" : "S") + ')"/>';
        };
        const t = model.tasks.get(ganttSel);
        for (const l of t.predecessors) draw(l, true);
        for (const l of t.successors) draw(l, false);
      }
    }
    svg.innerHTML =
      ganttGeom.grid +
      '<defs><marker id="gArrowP" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#2a78d6"/></marker>' +
      '<marker id="gArrowS" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#7c3aed"/></marker></defs>' +
      out;
  }

  function ganttApplySelection() {
    const host = $("ganttRows");
    for (const r of host.querySelectorAll(".g-row.sel, .g-row.pred, .g-row.succ")) {
      r.classList.remove("sel", "pred", "succ");
    }
    if (!ganttSel || !model.tasks.has(ganttSel)) return;
    const mark = (id, cls) => {
      const row = host.querySelector('[data-task="' + CSS.escape(id) + '"]');
      if (row) row.classList.add(cls);
    };
    const t = model.tasks.get(ganttSel);
    for (const l of t.predecessors) mark(l.predId, "pred");
    for (const l of t.successors) mark(l.succId, "succ");
    mark(ganttSel, "sel");
  }

  /** Add every WBS ancestor of `wbsId` (and itself) to the expanded set. */
  function ganttOpenPath(wbsId) {
    let changed = false;
    let cur = wbsId;
    let guard = 0;
    while (cur && model.wbs.has(cur) && guard++ < 60) {
      if ((wbsTree.depths.get(cur) || 0) >= 1 && !wbsExpanded.has(cur)) {
        wbsExpanded.add(cur);
        changed = true;
      }
      cur = model.wbs.get(cur).parentId;
    }
    return changed;
  }

  function ganttSelect(id, scrollTo) {
    if (!model || !model.tasks.has(id)) return;
    ganttSel = id;
    // target hidden inside a collapsed group? open the path down to it
    if (scrollTo && ganttGeom && !ganttGeom.geom.has(id)) {
      pushUndo();
      if (ganttOpenPath(model.tasks.get(id).wbsId)) {
        networkStale = true;
        renderGantt();
      }
    }
    ganttApplySelection();
    drawGanttLinks();
    showDetails(id);
    if (scrollTo && ganttGeom && ganttGeom.geom.has(id)) {
      const row = $("ganttRows").querySelector('[data-task="' + CSS.escape(id) + '"]');
      if (row) row.scrollIntoView({ block: "center" });
      const sc = $("ganttScroll");
      const g = ganttGeom.geom.get(id);
      sc.scrollLeft = Math.max(0, g.x - (sc.clientWidth - G_FROZEN_W) / 2 + 60);
    }
  }

  function ganttScrollToWbs(wbsId) {
    if (!ganttGeom || !model.wbs.has(wbsId)) return;
    // open this branch (and the way to it), then scroll to its group row
    pushUndo();
    if (ganttOpenPath(wbsId)) {
      networkStale = true;
      renderGantt();
    }
    const row = $("ganttRows").querySelector('.g-group[data-wbs="' + CSS.escape(wbsId) + '"]');
    if (row) row.scrollIntoView({ block: "center" });
  }

  function switchTab(tab) {
    if (tab === activeTab) return;
    activeTab = tab;
    for (const b of document.querySelectorAll("#tabBar .tab")) {
      b.classList.toggle("active", b.dataset.tab === tab);
    }
    $("graphWrap").style.display = tab === "network" ? "" : "none";
    $("ganttWrap").style.display = tab === "gantt" ? "flex" : "none";
    // the WBS tree is network-only (the Gantt has its own WBS rows); the
    // View options panel stays, minus the controls that don't apply there
    $("wbsSection").style.display = tab === "network" ? "" : "none";
    for (const el of document.querySelectorAll(".net-only")) {
      el.style.display = tab === "network" ? "" : "none";
    }
    if (tab === "gantt") {
      if (model) busy("Building Gantt chart…", renderGantt);
    } else if (networkStale && model && lastView.type) {
      networkStale = false;
      busy("Updating view…", rerenderLastView);
    }
  }

  // ---------- Cytoscape setup ----------
  function initCy() {
    cy = cytoscape({
      container: $("graph"),
      wheelSensitivity: 0.25,
      style: [
        {
          selector: "node",
          style: {
            shape: "round-rectangle",
            width: "data(w)",
            height: 52,
            "background-color": "data(bg)",
            "border-width": 1.5,
            "border-color": "data(bd)",
            label: "data(label)",
            color: "#0b0b0b",
            "font-size": 11,
            "text-wrap": "wrap",
            "text-max-width": "data(tmw)",
            "text-valign": "center",
            "text-halign": "center",
          },
        },
        {
          selector: "node.wbsnode",
          style: {
            height: 58,
            "border-width": 2.2,
            "font-size": 10.5,
          },
        },
        {
          selector: "node.milestone",
          style: { shape: "diamond", width: 70, height: 70, "text-max-width": 64, "font-size": 9 },
        },
        {
          selector: "node.critical",
          style: { "border-color": CRITICAL_RED, "border-width": 3 },
        },
        { selector: "node.complete", style: { opacity: 0.5 } },
        {
          selector: "node.focus",
          style: { "border-color": "#c77d00", "border-width": 4 },
        },
        {
          selector: "node.selected",
          style: { "overlay-color": "#c77d00", "overlay-opacity": 0.15, "overlay-padding": 6 },
        },
        {
          selector: "edge",
          style: {
            width: 1.6,
            "curve-style": "bezier",
            "line-color": "#9aa7b4",
            "target-arrow-shape": "triangle",
            "target-arrow-color": "#9aa7b4",
            "arrow-scale": 1.1,
            label: "data(label)",
            "font-size": 9,
            color: "#52514e",
            "text-background-color": "#fcfcfb",
            "text-background-opacity": 0.9,
            "text-background-padding": 2,
          },
        },
        {
          selector: "edge.bridge",
          style: { "line-style": "dashed" },
        },
        {
          selector: "edge.critical-edge",
          style: { "line-color": CRITICAL_RED, "target-arrow-color": CRITICAL_RED, width: 2.4 },
        },
      ],
    });

    window._cy = cy; // debugging handle

    cy.on("tap", "node", (evt) => {
      const id = evt.target.id();
      if (!model) return;
      if (model.tasks.has(id)) {
        showDetails(id);
        highlightNode(id);
        showTooltip(evt); // context tooltip on click; hides as soon as the mouse moves
      } else if (id.startsWith("g-")) {
        // rolled-up WBS node
        const wbsId = id.slice(2);
        showGroupDetails(wbsId);
        highlightNode(id);
        showGroupTooltip(evt, wbsId);
      }
    });
    cy.on("tap", (evt) => {
      // click on empty canvas: deselect
      if (evt.target === cy) {
        hideTooltip();
        cy.nodes().removeClass("selected");
      }
    });
    cy.on("dbltap", "node", (evt) => {
      const id = evt.target.id();
      if (!model) return;
      if (model.tasks.has(id)) {
        focusOn(id);
      } else if (id.startsWith("g-")) {
        // drill down: expand this group into its next level (or its tasks)
        expandGroup(id.slice(2), { x: evt.target.position("x"), y: evt.target.position("y") });
      }
    });
    cy.on("cxttap", "node", (evt) => {
      // right-click: collapse this branch back up one level
      if (!model || !wbsMode) return;
      const id = evt.target.id();
      let parentWbs = null;
      if (id.startsWith("g-")) {
        parentWbs = (model.wbs.get(id.slice(2)) || {}).parentId;
      } else if (model.tasks.has(id)) {
        parentWbs = model.tasks.get(id).wbsId;
      }
      collapseGroup(parentWbs, { x: evt.target.position("x"), y: evt.target.position("y") });
    });
    cy.on("pan zoom", () => {
      updateRuler();
      hideTooltip();
      scheduleNodeChips();
    });
    window.addEventListener("resize", () => {
      updateRuler();
      scheduleNodeChips();
    });

    // in time layouts x = date, so nodes may only be dragged vertically
    cy.on("grab", "node", (evt) => {
      if (timeScale) evt.target.scratch("_lockX", evt.target.position("x"));
    });
    cy.on("drag", "node", (evt) => {
      const lockX = evt.target.scratch("_lockX");
      if (timeScale && lockX !== undefined) {
        const p = evt.target.position();
        if (p.x !== lockX) evt.target.position({ x: lockX, y: p.y });
      }
    });
    cy.on("free", "node", (evt) => {
      evt.target.removeScratch("_lockX");
      scheduleNodeChips();
    });
  }

  // ---------- Node tooltip (shown on click, dismissed by mouse movement) ----------
  let tipAnchor = null; // cursor position when the tooltip was shown

  function tipMouseMove(e) {
    if (!tipAnchor) return;
    if (Math.hypot(e.clientX - tipAnchor.x, e.clientY - tipAnchor.y) > 12) {
      hideTooltip();
    }
  }

  function hideTooltip() {
    $("nodeTooltip").style.display = "none";
    tipAnchor = null;
    document.removeEventListener("mousemove", tipMouseMove);
  }

  function positionTooltip(evt) {
    const tip = $("nodeTooltip");
    if (tip.style.display === "none") return;
    const wrap = $("graphWrap");
    const pos = evt.renderedPosition || evt.target.renderedPosition();
    let x = pos.x + 16;
    let y = pos.y + 16;
    // keep the tooltip inside the graph area
    x = Math.min(x, wrap.clientWidth - tip.offsetWidth - 10);
    y = Math.min(y, wrap.clientHeight - tip.offsetHeight - 10);
    tip.style.left = Math.max(6, x) + "px";
    tip.style.top = Math.max(30, y) + "px";
  }

  function displayTooltip(html, evt) {
    const tip = $("nodeTooltip");
    tip.innerHTML = html;
    tip.style.display = "block";
    positionTooltip(evt);
    // dismiss as soon as the mouse moves away from where it was clicked
    const oe = evt.originalEvent || {};
    tipAnchor = { x: oe.clientX || 0, y: oe.clientY || 0 };
    document.addEventListener("mousemove", tipMouseMove);
  }

  function showTooltip(evt) {
    const t = model && model.tasks.get(evt.target.id());
    if (!t) return;
    displayTooltip(
      "<strong>" + escapeHtml(t.code) + "</strong> " + escapeHtml(t.name) +
      '<div class="tip-wbs">' + escapeHtml(t.wbsPath || "—") + "</div>" +
      '<div class="tip-meta">' + escapeHtml(t.statusLabel) +
      " · TF " + fmtDays(t.totalFloatDays) +
      " · " + fmtDate(t.start) + " → " + fmtDate(t.finish) + "</div>",
      evt
    );
  }

  function wbsPathOf(wbsId) {
    const parts = [];
    let node = model.wbs.get(wbsId);
    let guard = 0;
    while (node && guard++ < 50) {
      parts.unshift(node.name);
      node = node.parentId ? model.wbs.get(node.parentId) : null;
    }
    return parts.join(" / ");
  }

  function groupMembers(wbsId) {
    const inSubtree = wbsDescendants(wbsId);
    return visibleTasks()
      .filter((t) => inSubtree.has(t.wbsId))
      .sort((a, b) => (a.start || 0) - (b.start || 0));
  }

  function showGroupTooltip(evt, wbsId) {
    const members = groupMembers(wbsId);
    if (!members.length) return;
    const crit = members.filter(isCriticalTask).length;
    const starts = members.filter((t) => t.start).map((t) => t.start);
    const ends = members.filter((t) => t.finish || t.start).map((t) => t.finish || t.start);
    const min = starts.length ? new Date(Math.min(...starts)) : null;
    const max = ends.length ? new Date(Math.max(...ends)) : null;
    displayTooltip(
      "<strong>" + escapeHtml(model.wbs.get(wbsId).name) + "</strong>" +
      '<div class="tip-wbs">' + escapeHtml(wbsPathOf(wbsId)) + "</div>" +
      '<div class="tip-meta">' + members.length + " activities · " + crit +
      " critical · " + fmtDate(min) + " → " + fmtDate(max) + "</div>",
      evt
    );
  }

  function showGroupDetails(wbsId) {
    const w = model.wbs.get(wbsId);
    if (!w) return;
    const members = groupMembers(wbsId);
    const crit = members.filter(isCriticalTask).length;
    const rows = members
      .slice(0, 100)
      .map((t) => {
        const c = isCriticalTask(t) ? " crit" : "";
        return (
          '<li class="rel-item' + c + '" data-task="' + escapeHtml(t.id) + '">' +
          '<span class="rel-type">TF ' + fmtDays(t.totalFloatDays) + "</span>" +
          "<strong>" + escapeHtml(t.code) + "</strong> " + escapeHtml(t.name) + "</li>"
        );
      })
      .join("");
    $("detailsPanel").innerHTML =
      '<div class="detail-head' + (crit ? " crit" : "") + '">' +
      "<h3>" + escapeHtml(w.name) + "</h3>" +
      "<p>" + escapeHtml(wbsPathOf(wbsId)) + "</p>" +
      (crit ? '<span class="badge">' + crit + " CRITICAL</span>" : "") +
      "</div>" +
      '<button id="openGroupBtn" class="btn primary full-width">Show activities in this group</button>' +
      "<h4>Activities (" + members.length + ")" +
      (members.length > 100 ? " — first 100 shown" : "") + "</h4>" +
      "<ul class='rel-list'>" + rows + "</ul>";
    $("openGroupBtn").addEventListener("click", () => {
      pushUndo();
      if (wbsMode) toggleWbsMode(false);
      selectWbsRow(wbsId);
      busy("Drawing…", () => renderWbsView(wbsId));
    });
    for (const li of $("detailsPanel").querySelectorAll(".rel-item")) {
      li.addEventListener("click", () => showDetails(li.getAttribute("data-task")));
    }
  }

  // ---------- Event wiring ----------
  function init() {
    initCy();

    $("fileInput").addEventListener("change", (e) => {
      if (e.target.files.length) loadFile(e.target.files[0]);
      e.target.value = "";
    });

    $("loadSampleBtn").addEventListener("click", () => {
      if (window.SAMPLE_XER) loadXerText(window.SAMPLE_XER, "Sample_Project.xer");
    });

    $("searchInput").addEventListener("input", (e) => runSearch(e.target.value));
    $("searchInput").addEventListener("keydown", (e) => {
      if (e.key === "Escape") $("searchResults").style.display = "none";
      if (e.key === "Enter") {
        const first = $("searchResults").querySelector(".search-item");
        if (first) first.click();
      }
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".search-wrap")) $("searchResults").style.display = "none";
    });

    // Escape anywhere: dismiss tooltip, node highlight and search dropdown
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        hideTooltip();
        if (cy) cy.nodes().removeClass("selected");
        $("searchResults").style.display = "none";
        if (activeTab === "gantt" && ganttSel) {
          ganttSel = null;
          ganttApplySelection();
          drawGanttLinks();
        }
      }
      // Ctrl+Z: undo the last view change (unless typing in a field)
      const inField =
        e.target instanceof Element && e.target.closest("input, select, textarea");
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "z" && !inField) {
        e.preventDefault();
        undo();
      }
    });

    $("undoBtn").addEventListener("click", undo);
    $("emptyUndoBtn").addEventListener("click", undo);

    // bottom tabs: network diagram <-> gantt chart
    for (const b of document.querySelectorAll("#tabBar .tab")) {
      b.addEventListener("click", () => switchTab(b.dataset.tab));
    }

    // gantt interactions: click a WBS row to open/close it, a bar to select
    $("ganttRows").addEventListener("click", (e) => {
      const grp = e.target.closest(".g-row.g-group");
      if (grp) {
        const id = grp.getAttribute("data-wbs");
        pushUndo();
        const opening = !wbsExpanded.has(id);
        if (opening) wbsExpanded.add(id);
        else wbsExpanded.delete(id);
        networkStale = true; // network WBS roll-up shares this state
        busy(opening ? "Expanding…" : "Collapsing…", renderGantt);
        return;
      }
      const row = e.target.closest(".g-row.g-task");
      if (row) ganttSelect(row.getAttribute("data-task"), false);
    });
    $("ganttZoomIn").addEventListener("click", () => {
      ganttZoomMult = Math.min(10, ganttZoomMult * 1.5);
      if (model) busy("Zooming…", renderGantt);
    });
    $("ganttZoomOut").addEventListener("click", () => {
      ganttZoomMult = Math.max(0.2, ganttZoomMult / 1.5);
      if (model) busy("Zooming…", renderGantt);
    });

    for (const id of ["layoutSelect", "directionSelect", "depthSelect", "criticalOnly",
                      "floatThreshold", "excludeMilestones", "durScale"]) {
      $(id).addEventListener("change", () => {
        if (!model) return;
        pushUndo();
        syncDurControl(); // duration bars grey out in logic-flow layout
        if (id === "layoutSelect" && layoutMode() === "time") {
          $("durScale").checked = true; // time order defaults to duration bars
        }
        if (activeTab === "gantt") {
          networkStale = true; // network re-renders when tabbed back
          busy("Updating Gantt…", renderGantt);
        } else if (lastView.type) {
          busy("Updating view…", rerenderLastView);
        } else {
          commitState();
        }
      });
    }

    $("wbsModeBtn").addEventListener("click", () => {
      pushUndo();
      toggleWbsMode(!wbsMode);
      if (model && lastView.type) busy("Updating view…", rerenderLastView);
      else commitState();
    });

    $("wbsLevelSelect").addEventListener("change", (e) => {
      if (!model) return;
      pushUndo();
      setUniformWbsLevel(parseInt(e.target.value, 10) || 1);
      $("ganttLevelSelect").value = e.target.value; // keep the two in step
      if (wbsMode && lastView.type) busy("Updating view…", rerenderLastView);
      else commitState();
    });

    // Gantt toolbar: WBS level + filters (shared state with the network view)
    $("ganttLevelSelect").addEventListener("change", (e) => {
      if (!model) return;
      pushUndo();
      setUniformWbsLevel(parseInt(e.target.value, 10) || 1);
      $("wbsLevelSelect").value = e.target.value;
      networkStale = true;
      busy("Updating Gantt…", renderGantt);
    });

    $("projectSelect").addEventListener("change", (e) => {
      if (!model) return;
      pushUndo();
      selectedProjId = e.target.value;
      focusTaskId = null;
      busy("Updating view…", renderFullNetwork);
    });

    $("fullNetworkBtn").addEventListener("click", () => {
      if (!model) return;
      pushUndo();
      focusTaskId = null;
      toggleWbsMode(false); // full network = every activity, no WBS grouping
      busy("Drawing full network…", renderFullNetwork);
    });
    $("fitBtn").addEventListener("click", () => cy.fit(undefined, 40));

    // Drag & drop anywhere on the page
    document.addEventListener("dragover", (e) => {
      e.preventDefault();
      document.body.classList.add("dragging");
    });
    document.addEventListener("dragleave", (e) => {
      if (e.target === document.body || !e.relatedTarget) {
        document.body.classList.remove("dragging");
      }
    });
    document.addEventListener("drop", (e) => {
      e.preventDefault();
      document.body.classList.remove("dragging");
      if (e.dataTransfer.files.length) loadFile(e.dataTransfer.files[0]);
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
