---
name: demo-data-ppm
description: Wizard that prepares demo data in Fusion Manage for a customer meeting. Reads the customer's website and creates matching Product Categories, Product Lines and Products (name, description, image) in the tenant. Use when the user wants to tailor PPM data to a customer before a demo.
---

# PPM demo data wizard

Goal: make the tenant's Product Categories, Product Lines and Products look like the customer's own portfolio. Products matter most: each needs the right **name, description and image**; add further fields where the tenant has them.

Work from the plm-assistant folder. The local server (`npm start`) does all tenant access; you do the web research. Never write to the tenant before the user approved the plan.

## 1. Preconditions
Run `curl -s localhost:8090/api/status`. If not `configured` and `loggedIn`, run the **setup** skill first.

## 2. Ask the user
- Customer website URL (required).
- Optional: product focus (for example "only the pump range"), target size (default: 3 categories, 2–3 lines each, 3–5 products per line, max about 30 products), language.

## 3. Map the tenant
`curl -s localhost:8090/api/ppm/discover`. Show the user, per level, the workspace found, and the proposed field mapping (title, description, image, parent link). Inspect `fields` to propose extra fields worth filling (for example product number, URL, features). Ask about anything ambiguous: missing workspace, several candidates, no parent field. Once confirmed, save with `PUT /api/ppm/mapping` (body: `{categories:{workspaceId,titleField,descriptionField,imageField},lines:{...,parentField},products:{...,parentField}}`).

## 4. Research the website
Use WebFetch/WebSearch. Start at the homepage and follow navigation to product category, series and product pages. Build the hierarchy as the customer presents it. For each product collect:
- **name**: as shown on the site
- **description**: one or two factual sentences, written in your own words, not pasted marketing copy
- **image**: a direct, absolute URL of the product photo (look for og:image and the main product image; prefer PNG/JPEG, avoid SVG/WebP and logos or banners). Verify it with `curl -sI` when unsure
- **fields**: extra values keyed by field ID from the mapping, only where the data really exists on the site. Never invent specifications.

Categories and lines also get a description and, if a good image exists, an image.

## 5. Write and review the plan
Save to `work/<customer>-plan.json`:
```json
{ "categories": [{"name":"","description":"","image":"https://..."}],
  "lines":      [{"name":"","category":"<category name>","description":"","image":""}],
  "products":   [{"name":"","line":"<line name>","description":"","image":"","fields":{"FIELD_ID":"value"}}] }
```
Show the user a compact table (category > line > product, with image yes/no). Let them remove or change entries. Mention that logos and product photos belong to the customer and are for demo use only.

## 6. Dry run, then create
1. Dry run (default, writes nothing): `curl -s -X POST localhost:8090/api/ppm/apply -H 'Content-Type: application/json' -d @<(jq '{plan: .}' work/<customer>-plan.json)`. Review `existing`, `warnings` and `errors`.
2. After explicit user approval, repeat with `"dryRun": false` added to the body.

Records are matched by name, so re-running is safe: existing records are skipped, not duplicated.

## 7. Report
Summarize created / already existing / failed records and image warnings, and offer to fix failures (for example replace an image URL) and re-run. Suggest the user open the Products workspace to check the result.
