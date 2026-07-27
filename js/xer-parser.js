/*
 * xer-parser.js
 * Parses an .xer schedule export into a JavaScript object model.
 *
 * XER format: tab-delimited text. Lines start with a token:
 *   ERMHDR  file header
 *   %T      table name        (e.g. TASK)
 *   %F      field names for the current table
 *   %R      one row of values for the current table
 *   %E      end of file
 */

(function () {
  "use strict";

  const REL_LABELS = { PR_FS: "FS", PR_SS: "SS", PR_FF: "FF", PR_SF: "SF" };
  const STATUS_LABELS = {
    TK_NotStart: "Not Started",
    TK_Active: "In Progress",
    TK_Complete: "Completed",
  };
  // Keyed by UPPERCASE because some exports write TT_TASK, others TT_Task.
  const TYPE_LABELS = {
    TT_TASK: "Task",
    TT_MILE: "Start Milestone",
    TT_FINMILE: "Finish Milestone",
    TT_LOE: "Level of Effort",
    TT_RSRC: "Resource Dependent",
    TT_WBS: "WBS Summary",
  };

  /** Split raw XER text into { tableName: [rowObject, ...] } */
  function parseTables(text) {
    const tables = {};
    let currentName = null;
    let currentFields = null;

    const lines = text.split(/\r\n|\n|\r/);
    for (const line of lines) {
      if (line.startsWith("%T")) {
        currentName = line.split("\t")[1]?.trim();
        currentFields = null;
        tables[currentName] = tables[currentName] || [];
      } else if (line.startsWith("%F")) {
        currentFields = line.split("\t").slice(1).map((f) => f.trim());
      } else if (line.startsWith("%R")) {
        if (!currentName || !currentFields) continue;
        const values = line.split("\t").slice(1);
        const row = {};
        for (let i = 0; i < currentFields.length; i++) {
          row[currentFields[i]] = values[i] !== undefined ? values[i] : "";
        }
        tables[currentName].push(row);
      }
    }
    return tables;
  }

  function num(v) {
    if (v === undefined || v === null || v === "") return null;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }

  function parseDate(v) {
    if (!v) return null;
    // XER dates look like "2026-08-03 08:00"
    const d = new Date(v.replace(" ", "T"));
    return isNaN(d.getTime()) ? null : d;
  }

  /**
   * Parse XER text into a project model.
   * Returns { projects, tasks (Map by task_id), links, wbs (Map), warnings }
   */
  function parseXer(text) {
    const tables = parseTables(text);
    const warnings = [];

    if (!tables.TASK || tables.TASK.length === 0) {
      throw new Error(
        "No TASK table found - this does not look like a valid .xer schedule export."
      );
    }

    // Calendars: hours-per-day so we can convert hour counts to days
    const calendars = new Map();
    for (const row of tables.CALENDAR || []) {
      const hrs = num(row.day_hr_cnt);
      calendars.set(row.clndr_id, hrs && hrs > 0 ? hrs : 8);
    }

    const projects = (tables.PROJECT || []).map((row) => ({
      id: row.proj_id,
      name: row.proj_short_name || row.proj_id,
      lastRecalc: parseDate(row.last_recalc_date),
    }));
    // schedule data date = when the programme was last statused/recalculated
    const dataDate = (projects.find((p) => p.lastRecalc) || {}).lastRecalc || null;

    const wbs = new Map();
    for (const row of tables.PROJWBS || []) {
      wbs.set(row.wbs_id, {
        id: row.wbs_id,
        name: row.wbs_name || row.wbs_short_name || "",
        parentId: row.parent_wbs_id || null,
      });
    }

    function wbsPath(wbsId) {
      const parts = [];
      let node = wbs.get(wbsId);
      let guard = 0;
      while (node && guard++ < 50) {
        parts.unshift(node.name);
        node = node.parentId ? wbs.get(node.parentId) : null;
      }
      return parts.join(" / ");
    }

    // Discipline = the top-level WBS band an activity sits under, i.e. the
    // ancestor that is a direct child of the project root WBS node.
    function disciplineOf(wbsId) {
      let node = wbs.get(wbsId);
      let child = null;
      let guard = 0;
      while (node && guard++ < 60) {
        const parent = node.parentId ? wbs.get(node.parentId) : null;
        if (!parent) return child ? child.name : node.name; // node is the root
        child = node;
        node = parent;
      }
      return child ? child.name : "";
    }

    const tasks = new Map();
    for (const row of tables.TASK || []) {
      const hpd = calendars.get(row.clndr_id) || 8;
      const toDays = (v) => {
        const n = num(v);
        return n === null ? null : n / hpd;
      };

      // Status-aware dates. Exports fill a completed activity's early
      // dates with the DATA DATE (not its real dates), so actuals must win:
      //   completed   -> actual start / actual finish
      //   in progress -> actual start / forecast (early) finish
      //   not started -> early start / early finish
      const actS = parseDate(row.act_start_date);
      const actE = parseDate(row.act_end_date);
      const earlyS = parseDate(row.early_start_date);
      const earlyE = parseDate(row.early_end_date);
      const tgtS = parseDate(row.target_start_date);
      const tgtE = parseDate(row.target_end_date);
      const statusCode = row.status_code || "";
      let start, finish;
      if (statusCode === "TK_Complete") {
        start = actS || earlyS || tgtS;
        finish = actE || earlyE || tgtE;
      } else if (statusCode === "TK_Active") {
        start = actS || earlyS || tgtS;
        finish = earlyE || tgtE || actE;
      } else {
        start = earlyS || tgtS || actS;
        finish = earlyE || tgtE || actE;
      }

      const totalFloat = toDays(row.total_float_hr_cnt);
      const typeUpper = (row.task_type || "TT_Task").toUpperCase();
      const task = {
        id: row.task_id,
        projId: row.proj_id,
        code: row.task_code || row.task_id,
        name: row.task_name || "",
        type: row.task_type || "TT_Task",
        typeLabel: TYPE_LABELS[typeUpper] || row.task_type || "Task",
        status: row.status_code || "",
        statusLabel: STATUS_LABELS[row.status_code] || row.status_code || "",
        durationDays: toDays(row.target_drtn_hr_cnt),
        remainingDays: toDays(row.remain_drtn_hr_cnt),
        totalFloatDays: totalFloat,
        freeFloatDays: toDays(row.free_float_hr_cnt),
        start,
        finish,
        // late dates are meaningless once an activity is complete (exports fill
        // them with junk), so blank them rather than mislead
        lateStart: statusCode === "TK_Complete" ? null : parseDate(row.late_start_date),
        lateFinish: statusCode === "TK_Complete" ? null : parseDate(row.late_end_date),
        actualStart: actS,
        actualFinish: actE,
        drivingPathFlag: row.driving_path_flag === "Y",
        isCritical: totalFloat !== null && totalFloat <= 0,
        isMilestone: typeUpper === "TT_MILE" || typeUpper === "TT_FINMILE",
        wbsId: row.wbs_id,
        wbsName: (wbs.get(row.wbs_id) || {}).name || "",
        wbsPath: wbsPath(row.wbs_id),
        discipline: disciplineOf(row.wbs_id),
        predecessors: [], // filled in below: { taskId, type, lagDays }
        successors: [],
      };
      tasks.set(task.id, task);
    }

    const links = [];
    let skipped = 0;
    for (const row of tables.TASKPRED || []) {
      const succ = tasks.get(row.task_id);
      const pred = tasks.get(row.pred_task_id);
      if (!succ || !pred) {
        skipped++; // external/inter-project link whose other end isn't in this file
        continue;
      }
      const hpd = calendars.get("" + row.clndr_id) || 8;
      const lagHours = num(row.lag_hr_cnt);
      const link = {
        id: row.task_pred_id || pred.id + ">" + succ.id,
        predId: pred.id,
        succId: succ.id,
        type: row.pred_type || "PR_FS",
        typeLabel: REL_LABELS[row.pred_type] || row.pred_type || "FS",
        lagDays: lagHours === null ? 0 : lagHours / hpd,
      };
      links.push(link);
      pred.successors.push(link);
      succ.predecessors.push(link);
    }
    if (skipped > 0) {
      warnings.push(
        skipped +
          " relationship(s) reference activities outside this file (external links) and were ignored."
      );
    }

    // Discipline list in WBS file order, with activity counts
    const counts = new Map();
    for (const t of tasks.values()) {
      if (t.discipline) counts.set(t.discipline, (counts.get(t.discipline) || 0) + 1);
    }
    const disciplines = [];
    const seen = new Set();
    for (const node of wbs.values()) {
      const parent = node.parentId ? wbs.get(node.parentId) : null;
      const isTopLevel = parent && !(parent.parentId && wbs.has(parent.parentId));
      if (isTopLevel && counts.has(node.name) && !seen.has(node.name)) {
        seen.add(node.name);
        disciplines.push({ name: node.name, count: counts.get(node.name) });
      }
    }
    // catch any discipline names not found via the tree walk (defensive)
    for (const [name, count] of counts) {
      if (!seen.has(name)) disciplines.push({ name, count });
    }

    return { projects, tasks, links, wbs, disciplines, dataDate, warnings };
  }

  window.XerParser = { parseXer };
})();
