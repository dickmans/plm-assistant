---
name: demo-data-closed-loop-change-management
description: Creates a complete, connected demo story for closed-loop change management in Fusion Manage (Quality Inspection Plan, Quality Inspection, Non Conformance, CAPA, Change Request, Change Order and Change Tasks) for one component and one customer industry, with scenario variants, generated evidence images, a story-specific task plan and an optional stop point for live demos. Use when the user wants demo data that shows how a failed inspection drives corrective action and a design change.
---

# Closed-loop change management demo data

Goal: one believable story, built with the **real workflows**, that shows how a quality inspection in manufacturing drives corrective action all the way to a design change of the product.

Full-story end state (a stop point can end the story earlier, see step 2):

| Record | Ends in state | Why |
|---|---|---|
| Quality Inspection Plan | In Use | approved plan with measurements |
| Quality Inspection | Closed (FAIL) | spawned the Non Conformance |
| Non Conformance | CAPA In Progress | spawned the CAPA |
| CAPA | Control | spawned the Change Request, waits for the change |
| Change Request | Change Order in progress | engineering tasks (root cause analysis) **completed**; CCB approved |
| Change Order | Perform Change | **several** story-specific change tasks, only **one completed** |

Work from the plm-assistant folder. Read [reference.md](reference.md) (workflow cheat sheet, picklists, scenarios, image types, task ideas) and start from [story-template.json](story-template.json).

## Why it works this way
The links between the records (Spawned NC, Related CAPA, Related CR, Change Order, task parents) are **read-only**. Workflow scripts set them when a transition fires. The server therefore creates the plan and the inspection, then fills fields and performs the real transitions stage by stage, waits for each spawned record, and continues with it. You write the content (the "story"); the server executes it. Never try to write read-only link fields.

## 1. Preconditions
`curl -s localhost:8090/api/status` must show `configured` and `loggedIn`. If not, run the **setup** skill first. The server must run the current code (restart `npm start` after updates).

**Ask about impersonation first, before anything else** (use AskUserQuestion, offer "No" as the first option unless the user already said otherwise):
*"Should the steps be performed in the context of the involved users (impersonation)? Each action then appears in the workflow history under the user who does it (quality, engineer, planner), and the users must be real tenant users. Without it, everything runs as you."*
- **No:** every role in `vars` is set to `"@me"` or kept as chosen, and the story has `"impersonation": false`.
- **Yes:** needs a Server-to-Server app. Check `impersonationConfigured` in `/api/status`. If it is **false, ask the user for the Client ID and Client Secret** of an APS app of type "Server-to-Server App" (whitelisted in the tenant's General Settings) and save them with `curl -s -X POST localhost:8090/api/config -H 'Content-Type: application/json' -d '{"ssaClientId":"...","ssaClientSecret":"..."}'` (this keeps the current login). Treat the secret as private: never repeat it back and never send it anywhere else. Then continue; the dry run proves that the app can act as each user.
- Impersonation only makes sense with other users in the roles, so with "Yes" go on to question 4 (users) and make sure at least one role is another user.

## 2. Ask the user
Ask in one go (use AskUserQuestion where it fits; offer the recommended option first):

1. **Component**: dmsId or item number in the Items workspace. **Description**: what it is and does. **Customer industry**.
2. **Scenario** (see reference.md for what each changes):
   - *In-house production defect* (recommended)
   - *Supplier-caused defect found at incoming inspection*
   - *Field issue reported by a customer*
   - *Preventative action from a quality trend* (near miss, caught early)
3. **Optional**: details about the **issue** and the **resolution** (the design change). If skipped, invent both so they fit the component, the industry and the scenario.
4. **Users to involve**: after step 3 you can list the tenant users. Default is only the current user for every role (quality, engineer, planner, approver). Ask whether other users should take roles; unassigned roles use the current user. Put the user **id** (the `email` value of the context, for example `q5sxx`) into `vars`; the server looks up the login e-mail it needs for impersonation. Keep the current user as `approver` and as coordinator of the change template: the Change Request and Change Order transitions (Initiate Tasks, Submit to CCB, Approve) belong to the coordinator, so these stages run as the login user. Non-coordinator users must be able to edit the records of their stage (for example be on the CAPA team).
5. **Change template**: offer "Mechanical Change Template" as the standard and list the others from the context. The template only seeds the Task Planning grid; step 5 replaces the tasks with story-specific ones, so the template does not constrain the process.
6. **Where to stop** (see below).
7. **Images**: default is to generate evidence images (charts, annotated component photo, record cards) for the image fields. Ask only if the user may want none, or wants to supply own photos (files in `work/` or URLs work in any image field).

### Stop points
Offer these, recommend the first for a customer meeting where the presenter wants to click through live, and explain that the prepared record waits with all its fields filled:

| Stop before stage id | Live demo moment |
|---|---|
| *(none)* | full story, everything done |
| `close-inspection` | close the failed inspection, the Non Conformance appears |
| `initiate-capa` | start the CAPA from the Non Conformance |
| `to-control` | CAPA to Control, the Change Request appears |
| `ccb-approve` | approve in the CCB, the Change Order appears |
| `initiate-co-tasks` | start the Change Order, the story-specific tasks appear |

A stopped run can be continued later by running the same story again without `stopBefore`.

## 3. Collect tenant context
`curl -s "localhost:8090/api/closedloop/context?ref=<dmsId or number>"` (takes about 10 seconds)

- `ok:false` with `candidates`: show them and let the user pick.
- Use `component` (title, description, `hasImage`), `products`, `suppliers`, `templates`, `users`, `me`.
- Choose and **tell the user**: the affected **product** (the one matching the component and industry; ask if none fits) and a plausible **supplier** (required for the supplier scenario).
- Set the role variables in `vars` (`quality`, `engineer`, `planner`, `approver`) to `"@me"` or to the chosen users' email.

## 4. Write the story
First tell the user the storyline in 4 to 6 sentences: scenario, what is measured, what fails and by how much, the root cause, the design change, the production planning consequences. Let them adjust it. Then copy the template to `work/<name>-story.json` and replace **all** content. Keep keys, stage ids, transition names and the structure.

Content rules:
- **Match component, industry and scenario**: real-sounding dimensions, units, devices, terminology, failure modes. Apply the scenario settings from reference.md (inspection type, originated by, supplier fields, CR source, reason code, CAPA type, severity). Never invent real customers, people or part numbers; use `$component`, `$product`, `$supplier`, `$quality`, `$engineer`, `$planner`, `$approver`.
- **The root cause must justify a design change** (CR root cause "Design Issue"). The CAPA root cause list has no design entry: use "Other" and say it in the text.
- **Inspection**: 5 to 8 rows in `qip.grid`; in `qi.results` at least **two** rows out of tolerance (the plan usually allows 0 failures; for the preventative scenario keep deviations small). Row `ID` matches results to rows.
- **Fill every field** whenever sensible; the dry run prints `coverage` with the unfilled field IDs.
- **Text**: plain text or arrays (bullets). Limits: CR/CO risks and root cause and CAPA analysis notes max 1000 characters. Option values are matched by visible name.
- **Dates**: tokens such as `"@today-14"`, `"@today+7"`. Records get the real creation time, so keep dates plausible.
- **Transition comments** are recorded in the workflow history: short, realistic, written by the persona doing the step.
- **Task plan** (`cr.taskPlan`, `co.taskPlan`): replaces the template tasks in the Task Planning grid before "Initiate Tasks". Write tasks that match this change, with `ID`, `TITLE`, `DESCRIPTION`, `PRIORITY`, `ASSIGNEE` (role variable), `DEPENDS_ON` (another task `ID`), `TARGET_START_DATE`, `TARGET_COMPLETION_DATE`, `TARGET_EFFORT`, and for the CO `ITEMS_TO_CHANGE`. Do not copy the template tasks. The CR gets the engineering root cause analysis (and optionally a production impact task); every CR task must be completed through `cr.tasks`. The CO needs 6 to 8 tasks that cover design, BOM, **production planning** (MBOM, routing and work instructions, stock rework or scrap, cutover schedule and operator training, ERP release), **supplier** and **quality** (tooling and first article, update of the inspection plan and gauges, which closes the loop). Dependencies should form a sensible order, with one or two tasks that can start at once.
- **Driving tasks** (`cr.tasks`, `co.tasks`): `match` is text from the task title. In the CO complete **exactly one** task (the first), acknowledge the second, only assign the rest. Tasks with a reviewer finish as *Acknowledge*, *Submit for review* (assignee) and *Approve & Finish Task* (reviewer, set `"as"` on that transition); *Complete Task* only exists on tasks without a reviewer. The dry run checks the transition names.
- **Impersonation** (`"impersonation": true`): `as` names who performs the actions, on a process (`qip`, `qi`, `nc`, `capa`, `cr`, `co`), on one stage (overrides the process), on a task (default is its `ASSIGNEE`) or on one task transition (for example the reviewer). Use role variables (`"$quality"`) or `"@me"`. The task assignment itself is always made by the login user (coordinator), the rest of the task by the assignee. Typical mapping: QIP, QI, NC, CAPA as `$quality`; "Approve for Disposition", CR and CO stages as `$approver` (the login user); task steps as assignee and reviewer. Roles that resolve to the login user run without impersonation.
- **Images**: any image field accepts `"@component"` (the component's own picture), a file in `work/`, a URL, or `{"generate": {...}}` (types in reference.md). Use them to tell the story: marked defect on the component photo, inspection result chart, drift trend, quarantine tag card, current-versus-proposed comparison, cost bars, a closed-loop diagram. Make chart values match the story fields (for example cost bars equal the COST fields). `callout` positions `x`/`y` are 0 to 1 on the photo: check them in the preview and adjust.

## 5. Dry run (writes nothing)
```
curl -s -X POST localhost:8090/api/closedloop/run -H 'Content-Type: application/json' \
  -d '{"storyFile":"<name>-story.json","stopBefore":"<stage id or omit>"}' \
  | jq '{ok, errors, warnings, stopped, next, steps: [.steps[] | "\(.process): \(.step)"], images, coverage: (.coverage | map_values({filled, total, unfilled}))}'
```
Pass `"impersonate": true` or `false` in the body to override the story. With impersonation the dry run also reports `impersonation` (login user and acting users) and fails when the Server-to-Server app is missing, a user does not exist or the app cannot act as a user (not whitelisted, user without valid e-mail). Fix every error and re-run until `ok` is true. The dry run renders all generated images to `work/closedloop-<name>-images/`: **look at them** (Read the PNG files, at least the annotated photo and the charts), fix coordinates, texts or values, and show the user a few. Present a compact table of what will be created, the end state of each record and the planned change tasks.

## 6. Create the data
Get **explicit approval**. Say that the run creates about 6 records plus tasks and images, takes 2 to 4 minutes, and is not rolled back automatically. Then add `"dryRun": false` (keep `stopBefore` if chosen):
```
curl -s -m 900 -X POST localhost:8090/api/closedloop/run -H 'Content-Type: application/json' \
  -d '{"storyFile":"<name>-story.json","dryRun":false}' | jq '{ok, errors, hint, stopped, next, items, tasks, warnings}'
```
The server validates again and refuses to write if anything is wrong. Finished steps are remembered individually (stages, transitions, task steps), so after a failure the run continues exactly where it stopped.

If it stops with an error (`stoppedWith`): fix the story or the cause (reference.md, troubleshooting) and run the same command again. Finished stages are skipped using `work/closedloop-<name>-state.json`, so nothing is duplicated. Only add `"reset": true` to deliberately start over; that creates a second set of records.

## 7. Report
Show a table: record, number, title, state, link (`items[].url`), and the change tasks with states. List warnings (for example skipped read-only fields). If the run stopped on purpose, give `next` as the first live step: which record, which transition, and what the audience will see. Otherwise give a 5-step demo walkthrough: failed inspection and its marked measurements, the Non Conformance with evidence images, the CAPA stages, the Change Request with completed analysis tasks and the cost and effort impact, the Change Order with its production planning tasks. Say that the generated images are illustrative charts and diagrams, not photographs.
