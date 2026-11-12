---
name: demo-data-requirements
description: Creates a complete requirements demo in Fusion Manage for one product and one industry: a Requirement Specification with a 2 to 4 level requirements structure (fully populated, including assessment and validation data), optional partial approvals, optional validation processes with results and repetitions, optional Implemented By links to the product's engineering BOM, and always the link from the top level requirement to the product. Use when the user wants requirements demo data for manufacturing PLM demos.
---

# Requirements demo data

Goal: one believable requirements specification for a product, built with the **real workflows**, that shows structured requirements, assessment, approval and validation in PLM for a manufacturing company.

What can end up in the tenant (the user chooses in step 2):

| Record | Result |
|---|---|
| Requirement Specification | one, with reference documents and decisions; its Top Level Requirement is created by the tenant |
| Requirements | 2 to 4 levels below the top level requirement, every field filled, including the assessment (priority, risk, difficulty, costs, effort) and the validation section (test procedure, expected result, success criteria) |
| Requirement Approvals | optional: each one releases **one level 1 node with everything below it**; other nodes stay unreleased |
| Requirement Validations | optional: steps per requirement, results, some **Completed** (failed ones with a **repetition**), some left in **Planning**, **Execution** or **Reporting** |
| Implemented By | optional: items of the product's engineering BOM linked to the requirements they drive |
| Product | **always**: the top level requirement is written into the product's Requirements field |

Work from the plm-assistant folder. Read [reference.md](reference.md) (story format, fields, picklists, workflows, troubleshooting) and start from [story-template.json](story-template.json).

## Why it works this way
Requirements are revision controlled: an approval releases them and creates new working versions. So the server first builds and validates everything that edits requirements (structure, fields, relationships, validation steps), and only then runs the approvals. Links between records (top level requirement, repeated validation, latest validation result) are set by workflow scripts: the server performs the real transitions and waits for them. You write the content (the "story"); the server executes it. Never try to write read-only fields.

## 1. Preconditions
`curl -s localhost:8090/api/status` must show `configured` and `loggedIn`. If not, run the **setup** skill first. The server must run the current code: restart `npm start` after updates (the endpoints `/api/requirements/...` must exist).

## 2. Ask the user
Ask first, before researching anything. Use AskUserQuestion where it fits (recommended option first); free text for the product.

1. **Product** (name, number or dmsId in the Products workspace) and **industry or type of product** (for example industrial machinery, HVAC and building products, automotive, high-tech electronics, medical devices, consumer products, aerospace). The industry decides which requirements you invent: terms, standards, test methods and numbers must fit it.
2. **Size of the structure**: 2, 3 (recommended) or 4 levels below the top level requirement, and roughly how many requirements (default about 12 to 20, at most about 40). Level 1 are the groups, the deepest level are the testable requirements.
3. **Partial approval**: should some requirements be approved? If yes, you propose which level 1 nodes (default: about half of them, at least one stays open) and the user may change it. Each approval covers exactly one level 1 node and everything below it.
4. **Validations**: should validation processes be created and processed? If yes: some completed with passed and failed requirements, failed ones repeated, some left in progress (Planning, Execution, Reporting).
5. **Implemented by**: should requirements be connected to the items of the product's engineering BOM that implement them? (Needs an engineering BOM on the product, see step 3.)
6. **Users and impersonation** (ask only if the tenant has other users): default is only the current user for approvers and assignees. To spread the validation assignees over other users, the steps must be performed as those users: the validation transitions are **restricted to the stage assignee** (Preparation = `ASSIGNEE_1`, Execution = `ASSIGNEE_2`, Reporting = `ASSIGNEE_3`). That needs impersonation (`"impersonation": true` in the story) with a Server-to-Server app: check `impersonationConfigured` in `/api/status`; if it is false, follow the setup skill, step 3. Say that each step then appears in the workflow history under the assignee, and get an explicit yes. Without impersonation, set all three assignees of every validation to `@me`. Approvals always run as the login user.

State at the end of the questions that **the top level requirement is connected to the product in every case**.

## 3. Collect the tenant context
`curl -s -m 120 "localhost:8090/api/requirements/context?ref=<product>" > work/<name>-context.json` (takes about 20 seconds; the file can be large, inspect it with `jq`).

- `ok:false` with `candidates`: show them and let the user pick.
- Use `product` (title, description, product line, category, `project`, `engineeringBom`, current `requirements`), `ebom` (items with level, path and description), `users`, `me`, `existingSpecifications` and `picklists`.
- If `product.requirements` is already set, tell the user that the new top level requirement **replaces** that link (the old structure stays in the tenant). Ask whether to continue.
- If the user wants "Implemented by" and `product.engineeringBom` is missing (or `ebom` is empty), say so and continue without it, or ask for another product.
- Give the specification a name that does not clash with `existingSpecifications`.

## 4. Design and write the story
First show the user the design in a compact table: level, key, title, type, source and priority, plus which level 1 nodes get an approval, which validations are planned (with the intended outcome of each) and, for implemented by, the BOM items you will use. Let them adjust. Then copy the template to `work/<name>-requirements.json` and replace **all** content. Keep the structure and the keys of the format (reference.md).

Content rules:
- **Match product and industry**: realistic requirement texts with numbers, units, standards and test methods of that industry. Never invent real customers, people or part numbers. Use real, generic standards only where you are sure they exist; the specification's reference documents (`FILENAME_n`) need links: use the public landing page of the standards body or leave the link out.
- **Structure**: level 1 = groups (type `Sub Level`), middle levels = sub groups, deepest level = testable requirements (types Functional, Non-Functional, Safety or Process). Each group has 2 to 5 children. Keys are unique, short, lowercase with dashes.
- **Fill every field** that makes sense, for every requirement: description, source, type, keywords, comments, **assessment** (priority, risk, difficulty each with a comment that explains it), costs (labor, material, tooling) and effort for the testable requirements, **validation section** (test procedure, expected result, success criteria: measurable and consistent with the description), references to other requirements (`DEPENDENT_REQUIREMENTS`, `CONFLICTING_REQUIREMENTS` with comments, a few of each in the whole structure, using keys) and an image on the groups and the most important requirements. Groups need no costs. The dry run prints `coverage` with the field IDs nobody fills.
- **Consistency**: priority, risk and difficulty fit the description (a safety requirement is high priority); costs and efforts differ plausibly; dependent and conflicting pairs make technical sense (more fan speed means more noise).
- **Specification**: description, group, business unit, customer (a neutral wording such as "Internal platform product" or an industry segment), project (`product.project.link` when present), approvers, 3 to 5 reference documents (name, version, description, date, sent by, link) and 3 to 4 decisions with rationale. `topLevel` describes the top level requirement.
- **Text**: plain text or arrays (bullets). Dates: tokens such as `"@today-14"`, `"@today+7"`. Users: `"@me"`, a user name from `context.users`.
- **Approvals**: one entry per approved level 1 node: title, description, change reason, remarks, approvers with target dates and short realistic transition `comments`. `external: true` routes it through the external review and needs `EXTERNAL_APPROVERS`; an internal-only approval must have **no** external approvers (otherwise the template offers no "Approve"). `end` can stop an approval early (`Definition`, `Internal Review`, `External Review`) to leave one open for a live demo; default is `Released`.
- **Validations**: group related requirements into 3 to 5 validation processes; each has `steps` (one per requirement, with `RESULT` and a `COMMENTS` text that explains the measurement). Mix the outcomes:
  - completed with all steps passed;
  - completed with at least one `Failed` step, `closing.REPETITION_REQUIRED: "Yes"` and a `repeat` block for the failed requirements (the repetition may be completed with `Success`, or left in `Execution` or `Planning` with a pending step);
  - left in progress: `end` of `Planning`, `Preparation`, `Execution` (some steps with results, others without `RESULT`) or `Reporting`.
  Add `executionFields` with test run images (for example a `measurement-chart` whose values match the step results) and the setup image in `fields.IMAGE_1`. Fill `EQUIPMENT_REQUIRED`, `SPECIAL_INSTRUCTIONS`, the three assignees and target dates.
- **Implemented by**: put `implementedBy: ["<item number or descriptor>"]` on the testable requirements, using **only items from `context.ebom`** that really drive that requirement (the fan drives noise, the heat exchanger drives capacity). One to three items each, with a short `implementedByNote`.
- **Images**: any image field accepts `{"generate": {...}}` (types `card`, `bar-chart`, `comparison`, `trend-chart`, `measurement-chart`; see the closed-loop skill's reference for their keys), a file in `work/` or a URL. Values in charts must match the story texts.
- **Do not include** blocks the user declined: no `approvals`, no `validations`, no `implementedBy`.

## 5. Dry run (writes nothing)
```
curl -s -m 300 -X POST localhost:8090/api/requirements/run -H 'Content-Type: application/json' \
  -d '{"storyFile":"<name>-requirements.json"}' \
  | jq '{ok, errors, warnings, productHadRequirements, steps: [.steps[] | "\(.process): \(.step)"], images, coverage: (.coverage | del(.requirementFieldCounts))}'
```
Fix every error and run again until `ok` is true. The dry run checks fields, picklists, users, links, EBOM items, the validation and approval rules and the workflow transitions against the tenant. Render the generated images to `work/requirements-<name>-images/`: **look at a few** (Read the PNG files) and fix texts and values. Warnings about read-only fields mean the tenant fills them itself; they can stay.

Present: the tree, the approvals with their covered nodes, the validations with their intended end states, the implemented-by links, and the `coverage` result.

## 6. Create the data
Get **explicit approval**. Say what will be created (counts: requirements, approvals, validations, relationships), that the run takes several minutes, that nothing is rolled back automatically, and that the top level requirement replaces the product's current requirements link (if it had one). Then:
```
curl -s -m 1800 -X POST localhost:8090/api/requirements/run -H 'Content-Type: application/json' \
  -d '{"storyFile":"<name>-requirements.json","dryRun":false}' | jq '{ok, errors, hint, items, warnings}'
```
The server validates again and refuses to write when anything is wrong. Finished steps are remembered in `work/requirements-<name>-state.json`, so after a failure the same command continues where it stopped and creates nothing twice. Add `"reset": true` only to deliberately start over (this creates a second set of records).

If the product update fails with 403, remind the user to give themselves the permission **Admin Override Workflow Locks** for the Products workspace, then run the same command again.

## 7. Report
Show a table: record type, ID, title, state and link (`items[].url`). List warnings (for example fields the tenant set itself, a repetition that had to be created directly). Then give a short demo walkthrough: the specification and its structure, one requirement with its assessment and validation data, the approval of a level 1 node, the validation matrix with passed, failed, repeated and in-progress validations, a requirement's Implemented By tab and the product's link to the top level requirement. Say that generated images are illustrative charts, not photographs.
