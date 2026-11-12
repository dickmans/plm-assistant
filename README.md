# plm-assistant

AI-driven utilities for maintaining an Autodesk Fusion Manage tenant for demo and testing purposes, built as Claude Code skills on top of a small local Express server. The skills do the reasoning and the dialog with you. The server handles the APS login and all tenant calls. Run the utilities as is or extend this set of skills to better meet your needs.

## Setup
1. Create an APS app at https://aps.autodesk.com (type "Desktop, Mobile, Single-Page App", callback `http://localhost:8090/callback`) and whitelist its Client ID in the tenant's General Settings. Login uses PKCE, so no secret is needed.
2. Install node.js
3. Run `npm install` in a terminal from the downloaded folder
3. In Claude Code, from this folder run the skill **setup**. It shows the current connection if there is one, asks for tenant name and Client ID, starts the server and guides the login.

### Impersonation (optional)
Demo stories with several people (closed-loop change management, requirements) can perform workflow steps as other users. This needs a second app of type "Server-to-Server App", whitelisted in the tenant, with its Client ID and secret saved through the **setup** skill. Without it, every action runs as the logged-in user. The secret is stored only in `config/tenant.json`, is never returned by any endpoint and can be overridden with `APS_SSA_CLIENT_ID` and `APS_SSA_CLIENT_SECRET`. Saving the credentials does not test them. The story runs verify impersonation before they write.

## Utilities
| Skill | Purpose |
|---|---|
| demo-data-closed-loop-change-management | Connected quality-to-change story for one component (Quality Inspection Plan, Quality Inspection, Non Conformance, CAPA, Change Request, Change Order, Change Tasks): scenario variants, generated evidence images, story-specific task plan, optional stop point for live demos |
| demo-data-ppm | Create Product Categories, Product Lines and Products matching a customer's website |
| demo-data-requirements | Requirement Specification for a product and industry: 2 to 4 level requirements structure with assessment and validation data, optional partial approvals, validations (with results, repetitions and some left in progress) and Implemented By links to the engineering BOM; always connects the top level requirement to the product |
| setup | Tenant name, Client ID, optional Server-to-Server app, login |
| update-empty-user-selections | Set the logged-in user in empty Coordinator (Change Approval Templates), Approver (Products) and Users Team (Engineering Project Templates) picklists; existing values are never overwritten |
| update-timelines | Shift outdated dates of projects, changes, supplier packages, ideas, inspections and audits by whole weeks so the earliest pending activity falls in this or the previous week and durations stay intact |

### Product Portfolio demo data
The skill reads the customer's website and writes a plan (Product Categories, Product Lines and Products with name, description, image and optional extra fields) in their own hierarchy. You review the mapping of the tenant's workspaces and fields and the plan before anything is written. The server then creates the records, matched by name, so re-running skips existing records instead of duplicating them. Logos and product photos belong to the customer and are for demo use only. See `.claude/skills/demo-data-ppm/`.

### Closed-Loop Change Management demo data
The skill writes a story (field values, comments, measurements) from the component and the customer industry. The server executes it with the real workflow transitions, because the links between the records are set by workflow scripts. See `.claude/skills/demo-data-closed-loop-change-management/`. Restart `npm start` after pulling this utility.

### Requirements demo data
The skill writes a story (specification, requirements tree, approvals, validations) from the product and the industry. The server executes it with the real workflow transitions, in an order that avoids editing released requirements. See `.claude/skills/demo-data-requirements/`. Restart `npm start` after pulling this utility.

## Troubleshooting
If updates to Products fail with a 403 (for example in update-empty-user-selections or the requirements demo, which updates the product), add the permission "Admin Override Workflow Locks" for the Products workspace to your role and run again.

## Project layout
| Folder | Content |
|---|---|
| `.claude/skills/` | One folder per skill (`SKILL.md`, plus `reference.md` and `story-template.json` for the demo stories) |
| `lib/` | Config, auth, PLM client and the logic of each utility |
| `routes/` | HTTP API, one file per utility |
| `config/` | `tenant.json` and `ppm-mapping.json` (git-ignored); `tenant.example.json` shows the format |
| `.data/` | Tokens (git-ignored) |
| `work/` | Generated plans, stories, run results and downloaded or generated images (git-ignored) |
| `test/` | Tests with a mocked API |

To add a utility: create `lib/<name>.js` and `routes/<name>.js`, mount the route in `server.js` and add a skill folder.

