# plm-assistant

AI-driven maintenance utilities for an Autodesk Fusion Manage tenant. Independent project: do not depend on or modify plm-extensions (it is only a reference for API capabilities).

- **Architecture**: Claude Code skills in `.claude/skills/` do the reasoning and user dialog; the local Express server (`npm start`, port 8090) does APS login (3-legged, PKCE, no secret) and all tenant calls.
- **Layout**: `lib/` (config, auth, plm client, utility logic), `routes/` (HTTP API), `config/` (tenant.json, ppm-mapping.json; git-ignored), `.data/` (tokens), `work/` (generated plans, downloaded images).
- **New utility**: add `lib/<name>.js` + `routes/<name>.js`, mount in `server.js`, add a skill folder. Writes must default to dry run and require explicit approval.
- Tests: `npm test` (mocked API, no tenant needed).
- Copy style: sentence case headings (Autodesk editorial style).
