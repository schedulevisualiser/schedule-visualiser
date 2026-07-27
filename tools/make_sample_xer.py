"""Generate a sample .xer schedule file with internally consistent CPM dates.

Runs a simple forward/backward pass over a demo construction schedule
(Mon-Fri working calendar, 8h days) and writes:
  - sample/Sample_Project.xer   (a valid XER you can drag into the app)
  - js/sample-data.js           (same XER embedded as a JS string for the demo button)
"""

import datetime as dt
import json
import os

HOURS_PER_DAY = 8
PROJ_ID = 1000
CLNDR_ID = 100
PROJECT_START = dt.date(2026, 8, 3)  # a Monday

# WBS nodes: id -> (name, parent_id or None)
WBS = {
    2000: ("Pump Station Upgrade", None),
    2001: ("Design", 2000),
    2002: ("Procurement", 2000),
    2003: ("Civil Works", 2000),
    2004: ("Mechanical", 2000),
    2005: ("Electrical", 2000),
    2006: ("Commissioning", 2000),
    2007: ("Milestones", 2000),
}

# code: (name, duration_days, wbs_id, task_type)
ACTIVITIES = {
    "M010": ("Notice to Proceed", 0, 2007, "TT_Mile"),
    "D010": ("Concept Design", 10, 2001, "TT_Task"),
    "D020": ("Detailed Design", 15, 2001, "TT_Task"),
    "D030": ("Design Review & Approval", 5, 2001, "TT_Task"),
    "P010": ("Procure Pumps (Long Lead)", 40, 2002, "TT_Task"),
    "P020": ("Procure Pipework", 20, 2002, "TT_Task"),
    "P030": ("Procure Switchboard", 30, 2002, "TT_Task"),
    "C010": ("Site Establishment", 5, 2003, "TT_Task"),
    "C020": ("Demolition of Existing Structures", 8, 2003, "TT_Task"),
    "C030": ("Bulk Excavation", 6, 2003, "TT_Task"),
    "C040": ("Piling", 10, 2003, "TT_Task"),
    "C050": ("Foundations & Ground Slab", 12, 2003, "TT_Task"),
    "C060": ("Concrete Superstructure", 15, 2003, "TT_Task"),
    "C070": ("Building Envelope & Roof", 10, 2003, "TT_Task"),
    "M100": ("Install Pumps", 8, 2004, "TT_Task"),
    "M110": ("Install Pipework & Valves", 12, 2004, "TT_Task"),
    "M120": ("Hydrostatic Testing", 4, 2004, "TT_Task"),
    "E010": ("Install Switchboard", 5, 2005, "TT_Task"),
    "E020": ("Cable Installation", 10, 2005, "TT_Task"),
    "E030": ("Terminations & Point-to-Point", 5, 2005, "TT_Task"),
    "T010": ("Pre-Commissioning Checks", 5, 2006, "TT_Task"),
    "T020": ("Wet Commissioning", 8, 2006, "TT_Task"),
    "T030": ("Performance Trials", 10, 2006, "TT_Task"),
    "M900": ("Practical Completion", 0, 2007, "TT_FinMile"),
}

# (pred_code, succ_code, type, lag_days)
LINKS = [
    ("M010", "D010", "PR_FS", 0),
    ("D010", "D020", "PR_FS", 0),
    ("D020", "D030", "PR_FS", 0),
    ("D030", "P010", "PR_FS", 0),
    ("D030", "P020", "PR_FS", 0),
    ("D030", "P030", "PR_FS", 0),
    ("D030", "C010", "PR_FS", 0),
    ("C010", "C020", "PR_FS", 0),
    ("C020", "C030", "PR_FS", 0),
    ("C030", "C040", "PR_FS", 0),
    ("C040", "C050", "PR_FS", 0),
    ("C050", "C060", "PR_FS", 2),   # curing lag
    ("C060", "C070", "PR_FS", 0),
    ("P010", "M100", "PR_FS", 0),
    ("C060", "M100", "PR_FS", 0),
    ("P020", "M110", "PR_FS", 0),
    ("M100", "M110", "PR_SS", 3),   # pipework can start 3d after pump install starts
    ("M110", "M120", "PR_FS", 0),
    ("P030", "E010", "PR_FS", 0),
    ("C070", "E010", "PR_FS", 0),
    ("E010", "E020", "PR_FS", 0),
    ("E020", "E030", "PR_FS", 0),
    ("M120", "T010", "PR_FS", 0),
    ("E030", "T010", "PR_FS", 0),
    ("T010", "T020", "PR_FS", 0),
    ("T020", "T030", "PR_FS", 0),
    ("T030", "M900", "PR_FS", 0),
]


def add_workdays(day, n):
    """Return the date n whole workdays after `day` (n may be 0)."""
    d, step = day, 1 if n >= 0 else -1
    remaining = abs(n)
    while remaining > 0:
        d += dt.timedelta(days=step)
        if d.weekday() < 5:
            remaining -= 1
    return d


def next_workday(day):
    while day.weekday() >= 5:
        day += dt.timedelta(days=1)
    return day


def cpm():
    """Forward/backward pass in workday units (day 0 = PROJECT_START)."""
    codes = list(ACTIVITIES)
    dur = {c: ACTIVITIES[c][1] for c in codes}
    preds = {c: [] for c in codes}
    succs = {c: [] for c in codes}
    for p, s, t, lag in LINKS:
        preds[s].append((p, t, lag))
        succs[p].append((s, t, lag))

    # topological order via repeated relaxation (graph is small)
    es = {c: 0 for c in codes}
    for _ in range(len(codes)):
        for p, s, t, lag in LINKS:
            if t == "PR_FS":
                es[s] = max(es[s], es[p] + dur[p] + lag)
            elif t == "PR_SS":
                es[s] = max(es[s], es[p] + lag)
            elif t == "PR_FF":
                es[s] = max(es[s], es[p] + dur[p] + lag - dur[s])
            elif t == "PR_SF":
                es[s] = max(es[s], es[p] + lag - dur[s])
    ef = {c: es[c] + dur[c] for c in codes}

    finish = max(ef.values())
    lf = {c: finish for c in codes}
    for _ in range(len(codes)):
        for p, s, t, lag in LINKS:
            if t == "PR_FS":
                lf[p] = min(lf[p], lf[s] - dur[s] - lag + dur[p] - dur[p])  # LS(s) - lag
                lf[p] = min(lf[p], (lf[s] - dur[s]) - lag)
            elif t == "PR_SS":
                lf[p] = min(lf[p], (lf[s] - dur[s]) - lag + dur[p])
            elif t == "PR_FF":
                lf[p] = min(lf[p], lf[s] - lag)
            elif t == "PR_SF":
                lf[p] = min(lf[p], lf[s] - lag + dur[p])
    ls = {c: lf[c] - dur[c] for c in codes}
    tf = {c: ls[c] - es[c] for c in codes}
    return es, ef, ls, lf, tf


def fmt_start(day_offset):
    return next_workday(add_workdays(PROJECT_START, day_offset)).strftime("%Y-%m-%d") + " 08:00"


def fmt_end(day_offset, duration):
    if duration == 0:
        return fmt_start(day_offset)
    # end of the last working day: start offset + duration - 1 days, 16:00
    d = next_workday(add_workdays(PROJECT_START, day_offset))
    d = add_workdays(d, duration - 1)
    return d.strftime("%Y-%m-%d") + " 16:00"


def build_xer():
    es, ef, ls, lf, tf = cpm()
    L = []
    L.append("ERMHDR\t19.12\t2026-07-12\tProject\tadmin\tAPEX\tdbxDatabaseNoName\tProject Management\tAUD")

    L.append("%T\tCALENDAR")
    L.append("%F\tclndr_id\tdefault_flag\tclndr_name\tproj_id\tbase_clndr_id\tclndr_type\tday_hr_cnt\tweek_hr_cnt\tmonth_hr_cnt\tyear_hr_cnt")
    L.append(f"%R\t{CLNDR_ID}\tY\tStandard 5 Day Workweek\t\t\tCA_Base\t{HOURS_PER_DAY}\t40\t172\t2000")

    L.append("%T\tPROJECT")
    L.append("%F\tproj_id\tproj_short_name\tclndr_id\tplan_start_date\tplan_end_date\tlast_recalc_date")
    finish = max(ef.values())
    L.append(f"%R\t{PROJ_ID}\tPS-UPG\t{CLNDR_ID}\t{fmt_start(0)}\t{fmt_end(0, finish)}\t{fmt_start(0)}")

    L.append("%T\tPROJWBS")
    L.append("%F\twbs_id\tproj_id\twbs_short_name\twbs_name\tparent_wbs_id")
    for wid, (name, parent) in WBS.items():
        L.append(f"%R\t{wid}\t{PROJ_ID}\tWBS-{wid}\t{name}\t{parent if parent else ''}")

    L.append("%T\tTASK")
    L.append("%F\ttask_id\tproj_id\twbs_id\tclndr_id\ttask_code\ttask_name\ttask_type\tstatus_code"
             "\ttarget_drtn_hr_cnt\tremain_drtn_hr_cnt\ttotal_float_hr_cnt\tfree_float_hr_cnt"
             "\tearly_start_date\tearly_end_date\tlate_start_date\tlate_end_date"
             "\ttarget_start_date\ttarget_end_date\tdriving_path_flag")
    task_ids = {}
    for i, (code, (name, d, wbs, ttype)) in enumerate(ACTIVITIES.items()):
        tid = 5000 + i
        task_ids[code] = tid
        drive = "Y" if tf[code] <= 0 else "N"
        L.append("%R\t" + "\t".join(str(x) for x in [
            tid, PROJ_ID, wbs, CLNDR_ID, code, name, ttype, "TK_NotStart",
            d * HOURS_PER_DAY, d * HOURS_PER_DAY, tf[code] * HOURS_PER_DAY, 0,
            fmt_start(es[code]), fmt_end(es[code], d),
            fmt_start(ls[code]), fmt_end(ls[code], d),
            fmt_start(es[code]), fmt_end(es[code], d), drive,
        ]))

    L.append("%T\tTASKPRED")
    L.append("%F\ttask_pred_id\ttask_id\tpred_task_id\tproj_id\tpred_proj_id\tpred_type\tlag_hr_cnt")
    for i, (p, s, t, lag) in enumerate(LINKS):
        L.append(f"%R\t{7000 + i}\t{task_ids[s]}\t{task_ids[p]}\t{PROJ_ID}\t{PROJ_ID}\t{t}\t{lag * HOURS_PER_DAY}")

    L.append("%E")
    return "\r\n".join(L) + "\r\n"


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    xer = build_xer()

    os.makedirs(os.path.join(root, "sample"), exist_ok=True)
    with open(os.path.join(root, "sample", "Sample_Project.xer"), "w", newline="") as f:
        f.write(xer)

    os.makedirs(os.path.join(root, "js"), exist_ok=True)
    with open(os.path.join(root, "js", "sample-data.js"), "w", newline="") as f:
        f.write("// Auto-generated by tools/make_sample_xer.py - do not edit by hand\n")
        f.write("window.SAMPLE_XER = " + json.dumps(xer) + ";\n")

    print("Wrote sample/Sample_Project.xer and js/sample-data.js")
    es, ef, ls, lf, tf = cpm()
    crit = [c for c in ACTIVITIES if tf[c] <= 0]
    print(f"Project finish: day {max(ef.values())}; critical activities: {', '.join(crit)}")


if __name__ == "__main__":
    main()
