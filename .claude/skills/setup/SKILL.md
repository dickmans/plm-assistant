---
name: setup
description: Connect plm-assistant to a Fusion Manage tenant. Use first, or whenever a utility reports "not configured" or "not logged in". Shows the current connection if one exists and asks whether to change it, then collects the tenant name and APS Client ID, optionally the Client ID and secret of a Server-to-Server app (only needed for impersonation), starts the local server and guides the browser login.
---

# Connect to a Fusion Manage tenant

All plm-assistant utilities need the **tenant name** and the **APS Client ID** before they can act. Follow these steps in order and stop at the first failure.

1. **Check state.** Run `curl -s localhost:8090/api/status`. If the server is not running, start it from the plm-assistant folder with `npm start` as a background command and retry. `configured` tells whether a connection is already defined; `impersonationConfigured` shows whether the optional Server-to-Server app is saved.
2. **Existing connection.** If `configured` is true, always show the current settings first and ask whether they should be changed. Never skip this, even if the user only said "run setup".
   - Read `config/tenant.json` and show: tenant name, APS Client ID, login state (`loggedIn`), and whether a Server-to-Server app is saved (show its Client ID, but only say "secret saved", never display the secret).
   - Ask: *"Do you want to change these settings (for example to connect to another tenant)?"*
   - **No**: if `loggedIn` is false, continue with step 6 (log in); otherwise run step 7 to verify and stop.
   - **Yes**: go through every parameter in step 3 and step 4 again. For each one, show the current value and offer to keep it (for example: "Tenant: adsk2504demo. Keep it or enter a new one?"). Do not assume a value is unchanged, and do not skip a parameter. If the tenant changes, point out that the Server-to-Server app is dropped, because whitelisting is per tenant, so it must be entered again if still wanted, and that the Client ID must be whitelisted in the new tenant.
   If `configured` is false, there is nothing to keep: ask for every parameter.
3. **Collect the required values** (ask the user for each, offering to keep the current value when one exists):
   - Tenant name: the part before `.autodeskplm360.net` (for example `adsk2504demo`).
   - APS Client ID: from an app at https://aps.autodesk.com of type "Desktop, Mobile, Single-Page App" with callback URL `http://localhost:8090/callback`. The ID must also be whitelisted in the tenant's General Settings (needs a tenant admin).
   Never ask for a client secret for this app; the login uses PKCE and does not need one.
4. **Ask about impersonation (optional).** Say this explicitly: *"A second app is only needed if workflow steps should be performed as other users, for example when a demo story involves several people. Without it, every action runs as the user who logs in. Do you want to set it up now?"* If one is already saved for the same tenant, instead ask whether to keep it, replace it or remove it. Skip the rest of this step if the answer is no or keep.
   - The app must be of type **"Server-to-Server App"** at https://aps.autodesk.com, and its Client ID must be **whitelisted in the tenant's General Settings** (needs a tenant admin), like the first app.
   - Ask for its **Client ID** and **Client Secret**. This is the only place a secret is requested. Treat it as private: never echo it back, never put it in a URL, a log, a commit or an outside service. It is stored only in `config/tenant.json` (git-ignored, file mode 600) and is never returned by any endpoint.
5. **Save.** Without impersonation:
   `curl -s -X POST localhost:8090/api/config -H 'Content-Type: application/json' -d '{"tenant":"...","clientId":"..."}'`
   With impersonation, add the two fields:
   `-d '{"tenant":"...","clientId":"...","ssaClientId":"...","ssaClientSecret":"..."}'`
   This writes `config/tenant.json`. When the tenant stays the same and the Server-to-Server fields are left out, the saved ones are kept. To remove them, send `"removeSsa":true`. Switching to another tenant drops them, because the whitelisting is per tenant. Environment variables `APS_SSA_CLIENT_ID` and `APS_SSA_CLIENT_SECRET` override the file.
6. **Log in.** Run `open http://localhost:8090/login`, tell the user to sign in with their Autodesk account in the browser, then poll `/api/status` until `loggedIn` is true.
7. **Verify.** `curl -s localhost:8090/api/workspaces` should list the tenant's workspaces. Report the count. A 403 usually means the Client ID is not whitelisted in the tenant. If impersonation was configured, report that `impersonationConfigured` is true; saving the credentials does not test them.

Tokens are stored in `.data/tokens.json` and refreshed automatically. To switch tenants, run this skill again and answer yes in step 2.
