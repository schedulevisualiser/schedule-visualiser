# P6 Visualiser

Interactive network-diagram explorer for Primavera P6 schedules. Load a `.xer`
export, search for any activity, and trace its predecessor/successor chains —
with critical-path highlighting driven by P6's own total float values.

## Running it

No installation needed — it's a plain static web app:

- **Easiest:** double-click `index.html` (opens in your default browser), or
- Serve it locally: `python -m http.server 8642` in this folder, then open
  <http://localhost:8642>

When editing the CSS/JS, bump the `?v=` number on the `<link>`/`<script>`
tags in `index.html` so browsers pick up the new files instead of cached
copies.

Everything runs in the browser. **No schedule data ever leaves your machine** —
there is no server-side processing, which matters for confidential programmes.

## Using it

1. Click **Open .xer file** (or drag a `.xer` anywhere onto the page).
   Use **Load sample project** to try it without a real schedule.
2. Search by activity ID, name, or WBS in the sidebar — or use the
   **WBS / Disciplines tree** to browse every level of the schedule's WBS
   (top-level bands like Environmental down to individual work packages).
   Clicking any branch draws the network for that whole subtree. Searching a
   WBS name (e.g. "geotechnical") offers matching branches as top results,
   best match first.
3. Pick an activity result to trace that activity's logic network:
   - **Layout** — "Time order" (default) positions every activity by its
     start date, left → right through time, packed into lanes grouped by
     discipline, with a month ruler and gridlines. "Logic flow" instead lets
     the relationship structure dictate positions (classic PERT-style).
   - **Duration bars** (View options, off by default; time layout only) —
     each bar spans its real start → finish dates on the axis, Gantt-style.
     In time layouts nodes can only be dragged vertically, since horizontal
     position means dates.
   - **WBS mode** (toolbar toggle, ON by default when a file loads) — rolls
     the diagram up to
     WBS headings, starting at level 1 (the disciplines). Task links crossing
     between groups merge into single edges (labelled ×N when several), and
     groups containing critical work are flagged red — showing how the
     critical path flows across disciplines and work packages.
     Use the **+ chip** on a balloon (or double-click it) to drill into its
     next level down, repeating to reach individual tasks; the **− chip**
     (or right-click) collapses a branch back up. The **Level dropdown**
     resets the whole diagram to a uniform WBS depth. Click a group for its
     member activities. Works with every view and the critical-only filter.
   - **Filter chips** above the diagram show which filters are active
     (critical-only, milestones hidden, duration bars); click a chip's ✕ to
     turn that filter off. If a view comes back empty, an in-canvas message
     offers one-click undo.
   - **Direction** — predecessors, successors, or both
   - **Depth** — full chain or a limited number of levels
   - **Critical paths only** — hide activities with total float above the
     threshold (default 0 days). This filter also applies to discipline and
     full-network views, so you can see e.g. "the critical activities within
     Environmental".
   - **Exclude milestones** — hides milestone diamonds but *bridges* their
     logic: each milestone's predecessors connect straight to its successors
     with dashed edges, so chains never break apart.
   - In time layouts, a dashed blue **data-date line** marks where the
     schedule was last statused.
   - With **Duration bars** on, relationship arrows attach at the time-true
     point on each bar: FS leaves the predecessor's finish and lands on the
     successor's start, SS start-to-start, FF finish-to-finish.
   - The WBS-mode level dropdown ends with **"All tasks (no grouping)"**,
     which fully ungroups the view down to individual activities.
4. **Click any node** for a tooltip with its full WBS breadcrumb, status,
   float and dates (it dismisses as soon as the mouse moves) — essential
   context when many activities share generic names (e.g. several "Client
   Review" tasks under different report chapters). Search results likewise
   show each activity's parent WBS.
5. **Colours**: each level-1 WBS band (discipline) has its own colour, shown
   in the legend; deeper WBS levels use progressively lighter tints of the
   same hue, so depth is readable at a glance. A **red outline** (never a
   fill) marks critical — expanding a WBS group in WBS mode animates its
   children out of the parent bubble while the camera stays put.
6. Click any node for full details (dates, float, WBS, relationship list).
   **Double-click a node** to re-centre the trace on it.
7. **Undo** (toolbar button or **Ctrl+Z**) steps the visualisation back
   through your last 50 changes — traces, drill-downs, filters, layout and
   mode toggles — restoring the camera position along with the view. The
   history resets when you load a new file.

Every schedule opens as a **WBS level-1 overview in time order** — one
coloured balloon per discipline. Drill in from there, or press
**Full network** to see every individual activity with no grouping.

## How it works

| File | Purpose |
| --- | --- |
| `index.html` | App shell / layout |
| `js/xer-parser.js` | Parses the XER tables (TASK, TASKPRED, PROJECT, PROJWBS, CALENDAR) into a task/link model |
| `js/app.js` | Search, trace traversal, details panel, Cytoscape rendering |
| `js/sample-data.js` | Embedded demo schedule (auto-generated) |
| `js/vendor/` | Cytoscape.js + dagre layout libraries (vendored, works offline) |
| `css/style.css` | Dark theme styling |
| `tools/make_sample_xer.py` | Regenerates the sample schedule (`python tools/make_sample_xer.py`) — runs a real forward/backward CPM pass so the demo floats are consistent |
| `sample/Sample_Project.xer` | The generated sample, for testing file upload |

Design decision: the app **trusts P6's calculated dates and floats** from the
XER rather than re-running CPM itself. P6 remains the scheduling engine; this
tool visualises its output. (Criticality = total float ≤ threshold.)

## Roadmap ideas

- Driving-relationship / longest-path tracing (P6's `driving_path_flag` is
  already parsed)
- Colour-by WBS / status / float bands; group nodes by WBS
- Time-scaled layout (position nodes by date, like a logic-linked Gantt)
- Compare two XER updates (added/deleted logic, slippage)
- Handle `.xml` (P6 XML) exports as a second input format
- 3D view (three.js) once the 2D workflow is proven
- Package for sharing: host as a static site (GitHub Pages / Netlify) —
  no backend needed since parsing is client-side
