# Closed-loop demo: reference

## Workflow cheat sheet (standard Fusion Manage quality and change setup)

| Process | Transitions used, in order | Script effect |
|---|---|---|
| Quality Inspection Plan | New (on create) → **Approve for Use** | – |
| Quality Inspection | New (on create) → **Close** | copies plan data and measurement grid on create; on Close, if failures > allowed, **spawns the Non Conformance** (`SPAWNED_NON_CONFORMANCE`) |
| Non Conformance | **Submit For Review** → **Approve for Disposition** → **Initiate CAPA** | needs `INITIATE_CAPA` = Yes; **spawns the CAPA** (`RELATED_CAPA`) |
| CAPA | **Submit** → Proceed to Measurement → Proceed to Analysis → Proceed to Improvement → **Proceed to Control** | needs `CREATE_CHANGE_REQUEST` = Yes; **spawns the Change Request** (`RELATED_CR`) |
| Change Request | **Submit for review** → **Initiate Tasks** → (tasks) → **Submit to CCB** → **Approve** | Initiate Tasks spawns the CR tasks from the template; when all are complete a script moves the CR back to *Review & Impact Analysis*; after approval a script **spawns the Change Order** and moves the CR to *Change Order in progress* |
| Change Order | **Initiate Tasks** | spawns the CO tasks from the template (dependencies apply: a task becomes workable when the task it depends on is complete) |
| Change Task | Acknowledge → Complete Task (no reviewer) or Submit for review → Approve & Finish Task (task has a reviewer, as in the story's task plan) | – |

Stages in the story: `fields` are written first, then `taskPlan` (replace the Task Planning grid, CR and CO only), then the stop check (`stopBefore` = the stage `id`), then `transition`, then `runTasks` (drive `tasks` of that process), then `await` (wait until a script moved the record to the given state). Fields can only be written when the field is editable; fields owned by scripts (links, dates, computed values) are skipped with a warning.

## Scenarios

| | In-house defect (default) | Supplier-caused | Field issue | Preventative (trend) |
|---|---|---|---|---|
| Inspection type (QIP, QI, NC) | Final Inspection, Mid Process | Incoming Materials, Parts Received | Field | Mid Process, First Article |
| Performed / originated by | Internal QA | Vendor QA or Internal QA | Internal QA | Internal QA |
| Supplier fields (QI, NC, CAPA, CR, CO) | optional | **always** the supplier, PO number | optional | optional |
| NC severity | Level 1 or 2 | Level 2 | Level 1 | Level 3 |
| NC disposition | 2 - Repair, 3 - Rework | 4 - Reject (return to supplier) | 2 - Repair or replace | 1 - Use As Is with monitoring |
| CAPA type | Corrective | Corrective (with supplier) | Corrective | **Preventative** |
| CR source / reason code | Quality or Manufacturing / Quality Issue, DFM / DFA Issue | **Supplier** / Supplier Change, DFM / DFA Issue | **Customer** / Customer Usability, Functional Fix, Safety Issue | Quality / Mfg Yield Improvement, Performance Enhancement |
| Customer impact fields | none yet | none | filled (returns, installed base) | none |
| Failing measurements | 2 or more clearly out | 2 or more, one systemic | 2 or more, found in a returned unit | 2 slightly out or capability drift, **trend chart is the hero image** |
| Extra CO tasks | supplier tooling | supplier drawing release, PPAP / first article | field retrofit plan, service bulletin | process capability study |
| Hero images | marked defect, result chart | supplier lot label card, result chart | field photo callout, returns bar chart | trend chart, comparison |

All scenarios end in a **design change**; the story explains why a design fix beats a process fix.

## Change task ideas (write story-specific tasks, do not copy the template)
- **Engineering**: root cause analysis and tolerance stack-up; update the design and release the drawing; update the EBOM; update the simulation or test report.
- **Production planning**: update the MBOM, routing and work instructions; decide rework or scrap of quarantined and in-process stock; plan the cutover lot and update the line schedule; train operators; check material availability and open purchase orders; release the new revision and effectivity date to ERP.
- **Supplier and sourcing**: share the released drawing; qualify tooling; first article inspection or PPAP; update the supplier quality agreement.
- **Quality**: update the quality inspection plan and the gauges (closes the loop); update the control plan; define the effectiveness check of the CAPA.

## Image types (`{"generate": {"type": ..., ...}}`)
All images are 1280 x 720 PNG, uppercase technical lettering, with an "illustrative" footer. They are diagrams, not photographs.

| type | needed keys | notes |
|---|---|---|
| `measurement-chart` | `title`, `source: "inspection"` (rows from `qip.grid` + `qi.results`) or `rows: [{label, nominal, lo, hi, actual, unit}]` | tolerance band and measured value per characteristic, PASS/FAIL |
| `trend-chart` | `title`, `points: [numbers]`, optional `labels`, `usl`, `lsl`, `nominal`, `unit`, `xLabel` | drift over lots; points outside the limits turn red |
| `bar-chart` | `title`, `bars: [{label, value}]`, optional `prefix`, `suffix`, `total` | cost, returns, scrap |
| `comparison` | `title`, `rows: [{label, before, after, unit}]`, optional `beforeLabel`, `afterLabel` | current versus proposed |
| `callout` | `title`, `callouts: [{x, y, label, color}]` (x, y 0 to 1 on the photo), optional `legendTitle`, `accent` | marks areas on the component's photo (PNG, or JPEG on macOS) |
| `card` | `title`, `lines: ["## heading", "bullet", ...]`, optional `subtitle`, `badge: {text, color}`, `accent` | quarantine tag, sampling plan, root cause summary |
| `closed-loop` | optional `highlight: "qip" \| "qi" \| "nc" \| "capa" \| "cr" \| "co"` | shows the real record numbers and states created so far |

Image fields: QIP `IMAGE_1..3`, QI `IMAGE`, NC `IMAGE_1..4`, CR `IMAGE_1..4`, change task `IMAGE_1..4` (set inside `tasks[].fields`). Each has a comment field for the caption.

## Picklist values (match by visible name)

- Inspection type: Final Inspection, Field, Parts Received, Mid Process, Incoming Materials, First Article, Other
- Inspection level: General Inspection I / II / III, Special Inspection 1 to 4. Sampling method: Single Sampling, Sequential Sampling, Double Sampling. AQL examples: 0.015, 0.065, 0.10, 0.25, 0.65, 1.0, 1.5, 2.5, 4.0, 6.5
- Performed by (QI) and Originated by (NC): Internal QA, Vendor QA
- Measurement device (grid): Caliper, Micrometer, Tape Measure, Multi-Meter, CMM, Feeler Gauge, Dial Gauge, Radius Gauge, Thread Guage (sic), Optical Inspection, Optical, Visual, Inclinometer
- NC severity: Level 1, Level 2, Level 3. NC disposition: 1 - Use As Is, 2 - Repair, 3 - Rework, 4 - Reject, 5 - Scrap, X - Other. Yes/No fields: Yes, No
- CAPA type of action: Corrective, Preventative. CAPA root cause code: Information Visibility, Manufacturing Process, Process Documentation Incomplete, Packaging Design, Human Error, Customer Misuse, Harsh Environment, Normal Wear, Other
- CR/CO priority: 1 / High, 2 / Medium, 3 / Low. CR source: Product Management, Manufacturing, Other, Supplier, Customer, Quality, Sales, Services, Engineering
- Change reason code: DFM / DFA Issue, Performance Enhancement, Functional Fix, Customer Usability, Quality Issue, Safety Issue, Cosmetic Quality, Mfg Yield Improvement, Initial Release, Documentation Update, Supplier Change
- CR/CO root cause code: Use Outside of Design Spec, Normal Wear, Operator Training Issue, Improper Installation, Packaging Design Issue, Design Issue, Process Documentation Incomplete, Process Documentation Not Followed, Customer Misuse, Manufacturing Process Issue
- Customer approval required: Yes, No

Another tenant may have different values. The dry run lists the valid options for any value it cannot match.

## Field notes
- Rich text fields accept plain text, newline-separated text (paragraphs) or arrays (bullets).
- Money: numbers. Integer: whole numbers. Date: `YYYY-MM-DD` or `@today`, `@today-14`, `@today+7`.
- Links: `$var` (from `vars` or a record created earlier), a `/api/v3/...` link, or `@me` for user fields. Multi-select fields take arrays.
- `qi.results` keys are the grid row `ID` (or reference). Each value sets `ACTUAL` and optionally `COMMENTS`. PASS/FAIL is computed by Fusion Manage from nominal and tolerances.

## Troubleshooting
- *Transition not available*: the record is not in the expected state, or a precondition (required field, approver) is not met. The error lists the available transitions. Compare with the story stages.
- *Timed out waiting for the X spawned by ...*: the script did not fire. Check the trigger field (Initiate CAPA, Create Change Request), and for the QI that at least one more measurement fails than the plan allows.
- *Field is read-only*: it is owned by a script in this tenant. Remove it from the story or accept the warning.
- *Timed out waiting for change tasks*: the change template has no tasks for that process, or the template link in `vars.template` is wrong.
- *Change Request does not return to Review & Impact Analysis*: not all CR tasks are completed. Make sure every CR task of the template is in `cr.tasks` with a completing transition.
- *Approve does not create the Change Order*: the CCB needs further approvers. Check the CR's required approvers (from the template) and the Approve transition in the UI.

## Impersonation and tenant quirks (learned the hard way)
- Impersonation uses a 2-legged token of the Server-to-Server app plus the header `X-user-id` with the user's **login e-mail** (not the internal id such as `q5sxx`). The server resolves the e-mail from the user record. *Mapped user is either not present or not valid* means the user has no valid e-mail or the app is not whitelisted.
- *Submit to CCB is not available* (only Cancel, Initiate CO (skip CCB Review), Return, ...): the Change Request has no approvers because the change template has none. The story sets `ADDITIONAL_APPROVERS` on the CR in the `submit-ccb` stage.
- *Initiate Tasks is not available* right after "Submit for review": the coordinator of the change template must be the user who performs the transition (set the coordinator in the Change Approval Template, then submit the CR again or use a fresh run).
- Money fields (`COST_*`) are only accepted as **strings**; the server converts them. If a bulk write returns 400, the server retries field by field and names the rejected fields.
- Change task descriptors can look like `CT-CR-000167 - 10 - Title`; the server accepts the `CT-` prefix.
- *Timed out waiting for the inspection to copy the plan measurements*: the on-create script of the Quality Inspection sometimes does not copy the plan rows when the record is created through the API. Create the inspection in the UI from the plan, then write its link to `created.qi` in `work/closedloop-<name>-state.json`; the story's Close stage should then carry the inspection fields (deadline, serial numbers, notes, image) so they are still filled.
- *Approve for Disposition* needs `DISPOSITION` and `INITIATE_CAPA` already set, so put them in that stage too.
- A CAPA can only be edited and moved by team members: add the acting users and the login user to `TEAM`.
