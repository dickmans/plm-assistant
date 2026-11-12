---
name: update-empty-user-selections
description: Puts the logged-in user into all empty user picklists of Change Approval Templates (Coordinator fields), Products (Approver fields in Milestones & Checklists) and Engineering Project Templates (Users Team fields in Project Team Members). Never overwrites existing values. Use when the user wants to be set as coordinator, approver or team member on template and demo data.
---

# Fill empty with me

Sets the current user (the one who logged in via **setup**) in empty user picklists only. Fields that already have a value are never changed.

| Workspace | Fields filled |
|---|---|
| Change Approval Templates | every Coordinator field (CR Coordinator, CO Coordinator) |
| Products | every user picklist in section Milestones & Checklists (Approver 1–5) |
| Engineering Project Templates | every user picklist in section Project Team Members (Users Team 1–5; the Team 1–5 team pickers are not user fields and stay untouched) |

Work from the plm-assistant folder. The local server (`npm start`) does all tenant access. Restart it after pulling this utility.

## 1. Preconditions
`curl -s localhost:8090/api/status` must show `configured` and `loggedIn`. If not, run the **setup** skill first.

## 2. Dry run (default, writes nothing)
`curl -s -X POST localhost:8090/api/fill-empty/run -H 'Content-Type: application/json' -d '{}'`

Optional: `{"only":["changeTemplates","products","projectTemplates"]}` limits the run to some workspaces.

Show the user: the user name, per workspace the fields and item count, how many records would change (`filled`), how many fields already had a value (`skipped`), plus `warnings` and `errors`. A warning like "not offered by its picklist" means the user is missing from that picklist's lookup; tell the user instead of working around it.

## 3. Apply
Only after explicit approval, repeat the call with `"dryRun": false`. Re-running is safe: filled fields are skipped the second time.

## 4. Report
Summarize records changed, fields skipped and failures. Offer to retry failed records (for example records locked by a workflow state).

## Troubleshooting failed records
- **403 on Products (or "denied EDIT_ITEMS")**: the workflow state locks the record and no transition is offered. Remind the user to give themselves the permission **Admin Override Workflow Locks** for the Products workspace (Admin > Roles/Permissions), then re-run. Do not try to demote Products.
- **403 on Engineering Project Templates**: the template is locked in state Active. Demote it with the transition "Disable to enable updates" (state Definition), run the utility, then return it with "Set Active". Always restore the original state.
- **400 "Derived value does not match the source field value"**: the product's Product Category is empty while its Product Line implies one. Needs a data repair (set the category the tenant expects) and the user's approval; it is not a permission problem.
