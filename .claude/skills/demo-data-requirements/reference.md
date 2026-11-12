# Requirements demo: reference

## Story format
One JSON file in `work/`. Keys starting with `_` are ignored. [story-template.json](story-template.json) is a complete example.

```json
{
  "name": "bike-requirements",
  "impersonation": false,
  "vars": { "product": "/api/v3/workspaces/95/items/14384" },
  "spec":   { "fields": {...}, "topLevel": {...}, "decisions": [ {"DATE":"","DECISION":"","RATIONALE":""} ] },
  "requirements": [ <node>, ... ],
  "approvals":   [ <approval>, ... ],
  "validations": [ <validation>, ... ]
}
```

**Node** (a requirement; `children` makes a deeper level, at most 4 levels in total):
```json
{ "key": "perf-cap", "title": "Cooling capacity",
  "fields": { "DESCRIPTION": "...", "SOURCE": "Customer", "TYPE": "Functional", "PRIORITY": "1 / High", "...": "..." },
  "implementedBy": ["9411-004", "9411-012 - FAN ASSEMBLY"], "implementedByNote": "Heat exchanger and fan unit drive the capacity",
  "children": [ <node> ] }
```
- `key`: unique, letters, digits and dashes. Other parts of the story refer to requirements by key.
- A node with `children` and no `TYPE` becomes `Sub Level`.
- `DEPENDENT_REQUIREMENTS` and `CONFLICTING_REQUIREMENTS` take arrays of keys; they are written after all requirements exist.
- `implementedBy`: item number (`9411-004`), full descriptor or dmsId of an item **in the product's engineering BOM**. Must match exactly one item. Creates a bi-directional relationship (the "Implemented By" tab).

`impersonation: true` performs the validation steps as the stage assignees (needs the Server-to-Server app; checked in the dry run).

**Approval** (one per level 1 node, each node at most once):
```json
{ "id": "ra-perf", "node": "perf", "external": false, "end": "Released",
  "fields": { "TITLE": "", "DESCRIPTION": "", "CHANGE_REASON": "", "REMARKS": "", "INTERNAL_APPROVERS": ["@me"], "TARGET_DATE_INTERNAL_REVIEW": "@today+3", "EXTERNAL_APPROVERS": ["@me"], "TARGET_DATE_EXTERNAL_REVIEW": "@today+10" },
  "comments": { "submit": "", "approve": "", "external": "", "externalApprove": "" } }
```
The node and **all requirements below it** become the affected requirements; the utility selects the lifecycle option `Release` on each (`"lifecycle"` overrides the name), because the workflow refuses to leave Definition without it. Internal route: no external approvers in the fields. External route (`external: true`): `EXTERNAL_APPROVERS` required. `end`: `Definition`, `Internal Review`, `External Review` or `Released` (default). `external: true` goes Internal Review, External Review, Released.

**Validation**:
```json
{ "key": "val-perf", "title": "Performance validation", "end": "Completed",
  "fields": { "TYPE": "Initial", "EQUIPMENT_REQUIRED": [...], "SPECIAL_INSTRUCTIONS": "", "ASSIGNEE_1": "@me", "TARGET_DATE_1": "@today-20", "ASSIGNEE_2": "", "TARGET_DATE_2": "", "ASSIGNEE_3": "", "TARGET_DATE_3": "", "IMAGE_1": {...}, "IMAGE_1_REMARKS": "" },
  "executionFields": { "TEST_RUN_IMAGE_1": {...}, "TEST_RUN_IMAGE_1_REMARKS": "" },
  "steps": [ { "requirement": "perf-cap", "RESULT": "Success", "COMMENTS": "..." } ],
  "comments": { "Assign": "", "Finish Preparation": "", "Finish Execution": "", "Close": "" },
  "closing": { "REPETITION_REQUIRED": "Yes", "REPETITION_DATE": "@today+14" },
  "repeat": { "end": "Completed", "fields": {...}, "steps": [ { "requirement": "perf-eff", "RESULT": "Success", "COMMENTS": "" } ], "comments": {...} } }
```
- `end` (default `Completed`): `Planning`, `Preparation`, `Execution`, `Reporting`, `Acknowledgement` or `Completed`. The path is Planning, Assign, Preparation, Finish Preparation, Execution, Finish Execution, Reporting, Close. `acknowledge: true` with `end: "Completed"` goes through Submit for acknowledgement, Acknowledge and Close (then set `closing.ACKNOWLEDGEMENT_REQUESTED`).
- `steps`: one grid row per requirement (`requirement` is a key). `TEST_PROCEDURE`, `EXPECTED_RESULT` and `SUCCESS_CRITERIA` default to the values of the requirement. `RESULT`: `Success`, `Failed`, `Conditional Success`, `Pending`. A validation that ends after Execution needs a result in every step; an `end` of `Execution` may leave some steps without `RESULT` (they stay Pending).
- `executionFields` are written in the Execution state, `closing` in the Reporting state (before Close).
- `repeat`: only for validations that end in `Completed`, with `closing.REPETITION_REQUIRED: "Yes"` and at least one `Failed` step. The tenant spawns the repetition with the failed requirements when the validation is closed; `repeat.steps` lists those requirements (each must have failed). `repeat.end` is how far the repetition is driven (default `Planning`). If the tenant does not spawn it, the utility creates the repetition itself and warns.
- The tenant copies **all** steps into the repetition. Requirements that passed before come back as Pending; the utility gives them their previous result again ("Carried over") so the repetition can finish. `repeat.steps` therefore only lists the requirements that were repeated.
- The tenant sets the validation as the requirement's current validation (`VALIDATION_PROCESS`); the utility only does it when the scripts did not.
- Transitions are restricted to the stage assignee: Finish Preparation = `ASSIGNEE_1`, Finish Execution = `ASSIGNEE_2`, Close and Submit for acknowledgement = `ASSIGNEE_3`. Use impersonation, or set all assignees to `@me`.

## Fields of the four workspaces (template "Requirements Management")
Writable fields (field ID: meaning). IDs and picklists can differ in another tenant: the dry run reports what does not exist.

**Requirement Specification** (142): `TITLE`, `DESCRIPTION`, `GROUP_NAME` (Product Management, Engineering, Quality, Sales & Marketing), `BUSINESS_UNIT`, `CUSTOMER`, `PROJECT` (link), `INTERNAL_APPROVERS`, `EXTERNAL_APPROVERS` (users), `FILENAME_1..5`, `FILE_VERSION_n`, `FILE_DESCRIPTION_n`, `FILE_DATE_n`, `FILE_SENT_BY_n`, `FILE_LINK_n` (URL). Grid "Decisions": `DATE`, `DECISION`, `RATIONALE`. Script owned: `ID`, `REQUIREMENTS_COUNTER`, `TOP_LEVEL_REQUIREMENT`.

**Requirement** (143):
- Basic: `TITLE`, `DESCRIPTION`, `SOURCE` (Marketing, Customer, Engineering, Quality, Manufacturing, Sales, Product Management), `TYPE` (Non-Functional, Safety, Functional, Process, Top Level, Sub Level)
- Graphics: `IMAGE_1..4`, `REMARKS_IMAGE_1..4`
- Details: `KEYWORDS`, `COMMENTS`, `IDEAS` (links to Ideas)
- Assessment: `PRIORITY`, `RISK`, `DIFFICULTY` (unknown, 1 / High, 2 / Med, 3 / Low) and `PRIORITY_COMMENTS`, `RISK_COMMENTS`, `DIFFICULTY_COMMENTS`
- Cost and effort: `LABOR_COST`, `MATERIAL_COST`, `TOOLING_COST` (integers), `EFFORT` (integer, hours); `TOTAL_COST` is calculated
- References: `DEPENDENT_REQUIREMENTS`, `CONFLICTING_REQUIREMENTS` (+ `_COMMENTS`)
- Validation: `TEST_PROCEDURE`, `EXPECTED_RESULT`, `SUCCESS_CRITERIA`
- Script owned: `ID`, `LATEST_VALIDATION_RESULT`, `LATEST_VALIDATION_PROCESS`, `LATEST_VALIDATION_DATE`, `VALIDATION_STATUS`, `ASSESSMENT`, `REFERENCE_ALERTS`. The "All Validation Test Results" grid fills itself from the validations.

**Requirement Validation** (144): `TITLE`, `TYPE` (Initial, Final), `EQUIPMENT_REQUIRED`, `SPECIAL_INSTRUCTIONS`, `IMAGE_1..4` + `IMAGE_n_REMARKS`, `ASSIGNEE_1..3` (Preparation, Execution, Reporting) with `TARGET_DATE_1..3`, `TEST_RUN_IMAGE_1..4` + `TEST_RUN_IMAGE_n_REMARKS`, `CHANGE_REQUEST` (link to a Change Request), `REPETITION_REQUIRED` (Yes, No), `REPETITION_DATE`, `ACKNOWLEDGEMENT_REQUESTED` (users). Script owned: `RESULT`, `FINAL_RESULT`, `REPETITION`, `PREVIOUS_VALIDATION`, `NEXT_VALIDATION`, actual dates. Steps grid: `STEP`, `TEST_PROCEDURE`, `EXPECTED_RESULT`, `SUCCESS_CRITERIA`, `BASE_REQUIREMENT`, `RELATED_REQUIREMENTS`, `RESULT`, `COMMENTS`.

**Requirement Approval** (145): `TITLE`, `DESCRIPTION`, `CHANGE_REASON`, `REMARKS`, `INTERNAL_APPROVERS`, `TARGET_DATE_INTERNAL_REVIEW`, `EXTERNAL_APPROVERS`, `TARGET_DATE_EXTERNAL_REVIEW`. The approval dates, approver and comments are set by the workflow.

**Product** (95): `REQUIREMENTS` (the top level requirement; written by the utility), `ENGINEERING_BOM` (read), `NPI_PROJECT` (read).

## Workflows (standard template)
| Process | Path |
|---|---|
| Requirement Validation | Start (Planning), **Assign**, **Finish Preparation**, **Finish Execution**, **Close** (or Submit for acknowledgement, Acknowledge, Close). Also available but unused: Return, Set all test results Success / Failed / Pending |
| Requirement Approval | Start (Definition), **Submit for review** (Internal Review), **Approve** (Released), or Request External Review, External Approval. Also: Reject, Return to Definition, Cancel |
| Requirement, Specification | no workflow; requirements are revision controlled (Unreleased until an approval releases them) |

Closing a validation with `REPETITION_REQUIRED = Yes` makes a script create the next validation (`NEXT_VALIDATION`, repetition number 2, only the failed requirements). Closing a validation updates the latest validation result, process and date of its requirements.

## Why the order is fixed
1. Specification, then the Top Level Requirement (created by the tenant).
2. Requirements, each added to its parent's BOM (Sub Requirements tab).
3. Implemented By relationships.
4. Validations (steps, results, repetitions).
5. Approvals: a release locks the requirement and creates a new working version, so nothing may edit or link the old version afterwards.
6. Product link.

## Tenant quirks and troubleshooting
- *The Top Level Requirement did not appear*: the specification's creation script did not run (check the template installation). Nothing else can be built without it.
- *Requirement IDs*: normally generated (`<spec id>.<nnn>`). If the tenant does not do it, the utility numbers them and warns.
- *Validation step rows are rejected* (`BASE_REQUIREMENT` read-only): the tenant does not allow API writes of the base requirement. Create the validation in the UI from the Requirements Validation Dashboard, or ask for the template's permissions to be relaxed.
- *Transition not available*: the record is not in the expected state or a required field is missing. The error lists the available transitions. Typical: the Internal Approvers of an approval must include the user who approves (use `@me`); validation `Assign` needs the assignee fields.
- *The repetition was not spawned*: the utility creates it directly and warns; the "previous validation" link is then missing.
- *Product update 403*: add the permission **Admin Override Workflow Locks** for the Products workspace, then run the same command again.
- *Read-only field warnings*: a script owns the field (for example TOTAL_COST), the value is skipped.
- Dry run `errors` mention the valid options of any picklist value that cannot be matched; user fields accept `@me`, a login e-mail or the display name.
- After a failed real run nothing is rolled back; delete the created records in the tenant if you want to start clean and then run with `"reset": true`.
- *Derived field rejected on create* (`SPECIFICATION_ID`): the tenant reports the expected value and the utility resends it automatically.
- *Test result is not set for all steps*: every step needs a result before Finish Execution (carried over steps in repetitions are handled automatically).
- *All managed items must have a Lifecycle option selected*: handled by the utility (lifecycle option on every affected requirement).
- *Approve is not available in Internal Review* (only Reject, Request External Review): external approvers are set; use the external route or leave them empty. A record in review is locked (403 on edits), so fix the story and start a new approval.
- Impersonation: validation steps run as the assignee when `impersonation` is true; approvals, field writes of requirements and the product update run as the login user.
