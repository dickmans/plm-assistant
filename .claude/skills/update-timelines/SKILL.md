---
name: update-timelines
description: Moves outdated timelines of the demo tenant to the present. Shifts all dates of each project, change, supplier package, idea, inspection or audit by the same whole number of weeks so durations stay intact and the earliest pending activity falls in this or the previous week. Covers Engineering Projects, Projects (PPM), Innovation Projects, Change Requests and Tasks, Change Orders, Problem Reports, Supplier Collaboration, Product Ideation, Quality Inspections and Audits. Use when demo data looks outdated or overdue.
---

# Update timelines

Brings the standard demo datasets back to the present without changing how long anything takes.

## How it works
- A **timeline** is a root record plus its children (Engineering Project + Activities, Project + Phases + Tasks, Innovation Project + Sprint Activities, Change Request + Change Tasks, Supplier Package + Deliverables). Workspaces without children (Change Orders, Problem Reports, Lean Change Orders, Ideas, Quality Inspections, Audits) treat each record as its own timeline.
- **Anchor**: the earliest date that is still pending (a target, planned, due, expected or follow-up date on a record that is not completed or closed). If nothing is pending, the latest date is used.
- **Shift**: a multiple of 7 days, so weekdays are preserved, that puts the anchor in the current week (`"week":"previous"` for the week before). Every date of the timeline, including actual and completed dates, moves by that same amount, so durations never change.
- **Cap**: dates of things that already happened (actual starts, completions, submittals) must not move into the future. If needed the shift is reduced so they stay in the past, as long as the anchor still lands in the previous or current week. Pending dates that end up before today are fine: missed dates make a good demo story.
- Timelines whose anchor is already in the previous week or later are left alone. Template records are ignored.

Work from the plm-assistant folder. The local server (`npm start`) does all tenant access. Restart it after pulling this utility.

## 1. Preconditions
`curl -s localhost:8090/api/status` must show `configured` and `loggedIn`. If not, run the **setup** skill first.

## 2. Dry run (default, writes nothing)
`curl -s -X POST localhost:8090/api/timelines/run -H 'Content-Type: application/json' -d '{}'` (reads every record of the covered workspaces, so it takes a few minutes)

Optional: `{"only":["engineering","ppm","innovation","changeRequests","changeOrders","leanChangeOrders","problemReports","supplier","ideas","quality","audits"],"week":"this"}`. The full plan is also saved to `work/timelines-plan.json`.

Show the user per workspace group: timelines shifted vs. already current, the shift in weeks, and a few before/after examples (anchor and span). Call out `warnings` (capped shifts, completed records whose planned dates land after today) and `errors`.

## 3. Check what the API accepts (needs approval)
Many date fields are system-managed (editability `NEVER` or `CREATE_ONLY`, set by workflow scripts or the project plan). Whether the API accepts writes to them is tenant-specific. `POST /api/timelines/probe` with `{}` lists one candidate per workspace and editability type; with `"dryRun": false` it writes each candidate's **current value back unchanged** and reports `writable` true or false. Only run it after the user approves.

If key fields are not writable, tell the user which workspaces cannot be shifted: a half-shifted timeline has distorted durations. Typical alternatives are a temporary workflow script or the project plan (Gantt) in the UI, which needs the permission VIEW_MILESTONES/edit rights. Do not work around it silently.

## 4. Apply
Only after explicit approval, repeat the run with `"dryRun": false`, preferably per group (`only`) starting with a small one. Records are patched one at a time; a record that fails is retried field by field and reported in `errors` with the field and its editability. Re-running is safe: shifted timelines are no longer outdated and are skipped.

## 5. Report
Summarize timelines shifted, left alone, and failures (`work/timelines-result.json`). Mention that capped timelines have pending dates a bit in the past on purpose.

## Troubleshooting
- **403 on a record**: the workflow state locks it. Give the user the permission **Admin Override Workflow Locks** (Admin > Roles/Permissions) for that workspace and re-run; do not demote records.
- **Partially shifted timeline** (errors with `failedFields`): durations are inconsistent until the remaining fields are fixed. Fix the cause (permission, locked state), then re-run: the anchor is recomputed from the current values.
