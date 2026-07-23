# realm-google

Google Workspace (Sheets, Drive, Docs) via vendored OpenAPI 3 specs —
gives the LLM full request **and** response types for the
batchUpdate-heavy parts of the surface where flat tool descriptions
never get there.

> Realm authoring reference: see
> [`docs/realm-format.md`](https://github.com/embabel/assistant/blob/main/docs/realm-format.md)
> in the assistant repo for the full realm format spec — vendored
> OpenAPI specs, OAuth2, identity introspection, admin OAuth app
> registry, and per-world overrides are all documented there.

## Why

Google's REST APIs are described by **Discovery Documents**, not
OpenAPI. The community-maintained APIs Guru repository converts the
discovery docs to OpenAPI 3 and publishes them at stable URLs. Those
JSON files are vendored into `apis/` so the realm is self-contained and
doesn't fetch over the network at startup.

The vendored specs have leading namespace prefixes stripped from
operationIds (`sheets.spreadsheets.values.batchUpdate` →
`spreadsheets.values.batchUpdate`) so gateway method names don't
double-prefix once they pass through `apis.yml`'s `name:` field.

## Namespace

Three independent gateways:

- `gateway.sheets.<method>(args)`
- `gateway.drive.<method>(args)`
- `gateway.docs.<method>(args)`

Methods are the spec operationId camelCased on dot boundaries
(`spreadsheets.values.batchUpdate` → `spreadsheetsValuesBatchUpdate`).
E.g.:

- `gateway.sheets.spreadsheetsValuesBatchUpdate({ spreadsheetId, body: { ... } })`
- `gateway.drive.filesList({ q: "name contains 'invoice'" })`
- `gateway.docs.documentsBatchUpdate({ documentId, body: { requests: [...] } })`

If a call returns `gateway.X.foo is not a world tool`, the error
lists every valid method — pick from it. Never re-send the same call.

See `prompts/examples.md` for usage patterns and the three bundled
skills (`google-sheets-workflows`, `google-drive-workflows`,
`google-docs-workflows`) for the deeper request grammar.

## Auth — OAuth2

End users **never** paste API tokens, never know about client IDs, and
never set environment variables. They click **Authorize** in
Settings → Connected Services. That's it.

This works because the assistant deployment has ONE registered Google
Cloud OAuth client (provider id: `google-workspace`). Every end user
connects their own Google account against that single app — same as
how "Sign in with Google" works on every website.

### Provider id: `google-workspace` (NOT `google`)

The assistant's in-code Gmail/Calendar integration currently uses the
legacy provider id `google`. Sharing the slot would let the two scope
sets (Gmail+Calendar read-only vs. Sheets+Drive+Docs full) clobber
each other in the CredentialStore. So this realm registers under
`google-workspace`. Once the in-code Gmail/Calendar services migrate
to read from this slot, the legacy `google` provider can be retired
(one-time re-consent for existing users).

### For end users

1. Open **Settings → Connected Services**.
2. Click **Authorize** on the `google-workspace` row.
3. Consent on Google's page. Done — `gateway.{sheets,drive,docs}.*`
   are all live in chat (one consent screen covers all three).

If the row shows **"Not configured"**, the deployment operator hasn't
registered the Google Cloud app yet — show them the next section.

### For installation admins (one-time setup)

Done once per installation. Every world in the installation
inherits — end users just click Authorize.

**You can reuse the same Google Cloud OAuth client your assistant
already uses for the in-code Gmail/Calendar integration** (the
client-id/secret under `assistant.google.*`). The `google-workspace`
provider id is *local* to the assistant — Google doesn't see it. One
OAuth client can back any number of provider entries on the assistant
side, with any scope sets. So the steps below assume reuse; if you
don't yet have a Google Cloud OAuth client, create one first
(`console.cloud.google.com/apis/credentials` → **OAuth 2.0 Client ID**
→ Application type **Web application**).

1. **Enable the APIs** on the same Google Cloud project (the existing
   project probably only has Gmail and Calendar enabled):
   - Google Sheets API
   - Google Drive API
   - Google Docs API
2. **Extend the OAuth consent screen** to declare these scopes (in
   addition to whatever's already there for Gmail/Calendar — same
   scopes are declared in `apis/apis.yml`):
   ```
   openid email profile
   https://www.googleapis.com/auth/spreadsheets
   https://www.googleapis.com/auth/drive
   https://www.googleapis.com/auth/documents
   ```
   For an Internal-only World deployment, this is painless. For
   External users, adding `drive` and `documents` (sensitive /
   restricted scopes) triggers Google's verification process — plan
   for the review timeline.
3. **Authorized redirect URI** — should already be set to your
   assistant's public callback URL from the existing Gmail/Calendar
   setup; no change needed:
   `https://your-host/api/v1/auth/oauth2/callback`
   (or `http://localhost:8042/api/v1/auth/oauth2/callback` for local
   dev).
4. **Add a second `oauth-apps.yml` entry** pointing at the **same**
   client-id/secret as the existing Gmail/Calendar config — under
   `{worldBase}/admin/oauth-apps.yml` (the same admin directory
   that holds `realm-sources.yml`, `themes/`, `hints/`, etc.):

   ```yaml
   apps:
     google-workspace:
       client-id: 1234567890-abcdef.apps.googleusercontent.com   # same value as assistant.google.client-id
       client-secret: GOCSPX-...                                   # same value as assistant.google.client-secret
   ```

   Hot-reloaded — no restart needed. Every world in the
   installation will see "Authorize" appear in Settings.

   End users will see two Connected Services entries (the legacy
   Gmail/Calendar one, and Google Workspace) and consent twice.
   That's the price of the legacy split; once the in-code
   Gmail/Calendar services migrate to read from `google-workspace`,
   the legacy entry retires and there's just one consent.

A specific world can opt out of the installation default and
point at its own Google Cloud app by writing the same shape to
`<world>/config/oauth-apps.yml` — useful if one team needs a
different brand on the consent screen.

Token refresh is automatic. End users can disconnect from the same
Settings panel any time.

### Pare back the scopes for read-only deployments

Drop `documents` and replace `drive` with `drive.readonly` in
`apis/apis.yml`'s `scopes:` block (same in all three entries) and in
the Google Cloud OAuth consent screen. Removes write methods'
authorization without changing the realm code.

## What's covered

| Service | Operations exposed | What it lets you do |
|---|---|---|
| `sheets` | `spreadsheets.create / get / batchUpdate`, `values.get / batchGet / update / batchUpdate / append / clear` | Create spreadsheets, read/write ranges, append rows, modify structure (sheets, formatting, formulas) |
| `drive` | `files.list / get / create / update / copy / export`, `permissions.list / create` | Find files by query, read/write contents, export Google-native to PDF/DOCX/XLSX, share |
| `docs` | `documents.create / get / batchUpdate` | Create docs, read structured content, batch-edit (insert/replace text, formatting, tables) |

Total: ~20 operations. Comments, revisions, change-watching, shared
drives, and developer metadata are out of scope for v1 — add them
when a concrete workflow needs them.

## What's NOT in this realm

- **Gmail / Calendar** — handled in-code by the assistant repo's
  `integration/google/` services (signal contributors depend on the
  structured shapes). Will eventually migrate to the
  `google-workspace` provider but stays in-code for now.
- **Drive `comments`, `revisions`, `changes`, `drives` (shared
  drives)** — out of scope for v1.
- **Sheets `developerMetadata`, `getByDataFilter`** — niche,
  out of scope for v1.
- **Slides, Forms, Apps Script, Admin SDK, World Marketplace** —
  separate APIs, separate realms.
