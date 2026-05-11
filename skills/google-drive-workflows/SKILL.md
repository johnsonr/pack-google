---
name: google-drive-workflows
description: Google Drive workflows — finding files via the search query language (q parameter), reading and writing file metadata and content, exporting Google-native files (Docs/Sheets/Slides) to PDF/DOCX/XLSX/CSV, copying, and sharing via permissions. Activate this skill BEFORE making any Drive call when the user asks about finding, listing, sharing, copying, downloading, or exporting Google Drive files.
---

# Google Drive Workflows

## Namespace

Calls go through `gateway.drive.<method>(args)` from inside
`execute_javascript` or `execute_python`.

| Need | Method |
|---|---|
| Search / list files | `filesList` |
| Get a single file's metadata or content | `filesGet` |
| Create a new file (upload or empty) | `filesCreate` |
| Update metadata or replace content | `filesUpdate` |
| Make a copy | `filesCopy` |
| Convert Google-native file → PDF/DOCX/XLSX/CSV | `filesExport` |
| List sharing on a file | `permissionsList` |
| Add a sharer | `permissionsCreate` |

If a call returns `gateway.drive.foo is not a workspace tool`, the
error lists every valid method — pick from it. Never re-send the same
call.

## Cardinal rules

1. **Search uses the `q` parameter, not flags.** `q` is a string in
   Drive's own query language: `name contains 'invoice' and trashed=false`.
   See the query-language section below.
2. **`fields` controls what comes back.** Default is a sparse subset
   (id, name, mimeType). For anything else — `modifiedTime`, `owners`,
   `webViewLink`, `parents` — pass `fields: "files(id,name,modifiedTime,owners(emailAddress))"`.
   The same applies to single-file `filesGet` (`fields: "id,name,..."`,
   no `files(...)` wrapper).
3. **Google-native files need `filesExport`, not `filesGet`.** Asking
   `filesGet` for the contents of a Google Doc returns metadata, not
   the document body. Use `filesExport` with a target mime type.
4. **`mimeType` on create = the type you want it to be.** To make a
   Google Sheet, pass `mimeType: "application/vnd.google-apps.spreadsheet"`
   on `filesCreate`. To upload a CSV that gets imported as a Sheet,
   create with `mimeType: "application/vnd.google-apps.spreadsheet"`
   and source body `text/csv`.
5. **Permissions are additive.** `permissionsCreate` adds a sharer;
   it doesn't replace existing ones. Repeated calls with the same email
   produce duplicate permission rows.
6. **For analytical questions about a Google Sheet, switch to
   `gateway.sheets.*`, not `filesExport`.** "Average of column B,"
   "count of rows where X," "sum total" — those need structured rows,
   not a CSV blob. `filesExport` is for *delivering* a file (download,
   share, convert). Reading a Sheet to compute over it is a Sheets job;
   exporting to CSV and parsing it is the slow, error-prone path.

## Drive search query language (the `q` parameter)

The most powerful — and most underused — parameter on `filesList`.

| Predicate | Example |
|---|---|
| Name | `name = 'Q2 Forecast'`  /  `name contains 'invoice'` |
| MIME type | `mimeType = 'application/vnd.google-apps.spreadsheet'` |
| Folder membership | `'<folder-id>' in parents` |
| Ownership | `'alice@acme.com' in owners` |
| Sharing | `'bob@acme.com' in writers`  /  `'bob@acme.com' in readers` |
| Trash | `trashed = false` (almost always include this) |
| Time | `modifiedTime > '2026-01-01T00:00:00'`  /  `createdTime` |
| Full-text | `fullText contains 'pricing'` |
| Starred | `starred = true` |
| Combined | `mimeType='...sheet' and 'alice@acme.com' in owners and trashed=false` |

Common Google MIME types:

| Type | mimeType |
|---|---|
| Google Sheet | `application/vnd.google-apps.spreadsheet` |
| Google Doc | `application/vnd.google-apps.document` |
| Google Slides | `application/vnd.google-apps.presentation` |
| Folder | `application/vnd.google-apps.folder` |
| Form | `application/vnd.google-apps.form` |
| Shortcut | `application/vnd.google-apps.shortcut` |

```javascript
const r = await gateway.drive.filesList({
  q: "mimeType='application/vnd.google-apps.spreadsheet' and name contains 'Q2' and trashed=false",
  fields: "files(id, name, modifiedTime, owners(emailAddress), webViewLink), nextPageToken",
  pageSize: 50,
  orderBy: "modifiedTime desc",
});
for (const f of r.files) console.log(f.modifiedTime, f.name, f.webViewLink);
```

## Pagination

```javascript
let pageToken, all = [];
for (let p = 0; p < 5; p++) {                 // hard cap
  const r = await gateway.drive.filesList({
    q: "trashed=false and 'me' in owners",
    fields: "files(id, name, mimeType, modifiedTime), nextPageToken",
    pageSize: 100,
    pageToken,
  });
  all.push(...r.files);
  pageToken = r.nextPageToken;
  if (!pageToken) break;
}
```

## Get file metadata or content

```javascript
const meta = await gateway.drive.filesGet({
  fileId: "abc123",
  fields: "id, name, mimeType, size, owners(emailAddress), webViewLink, parents",
});
```

For **non-Google files** (PDFs, images, plain text uploaded to Drive),
fetch the body with `alt: "media"`:

```javascript
const bytes = await gateway.drive.filesGet({
  fileId: "pdf-id",
  alt: "media",
});
// bytes is the binary body (or text for text/* mime types)
```

For **Google-native files**, use `filesExport` instead.

## Export Google-native files

`filesExport` is for **delivering** a file (download, share, attach,
convert) — not for reading one to compute over. If the user wants an
average / count / sum / lookup from a Google Sheet, switch to
`google-sheets-workflows` and use `gateway.sheets.spreadsheetsValuesGet`
on a range. The Sheets API returns structured rows; CSV export returns
a blob you have to parse, which goes wrong on quoted fields, headerless
sheets, and trailing blanks. Same for Docs: if the user wants you to
*answer questions about* a Doc body, prefer `text/plain` export (cheap),
but if they want to *edit* it, switch to the Docs API.

```javascript
// Doc → PDF (deliverable)
const pdf = await gateway.drive.filesExport({
  fileId: "doc-id",
  mimeType: "application/pdf",
});

// Doc → plain text (for reading the body in-script — small docs only)
const txt = await gateway.drive.filesExport({
  fileId: "doc-id",
  mimeType: "text/plain",
});

// Sheet → XLSX (deliverable; multi-tab unlike CSV which is first tab only)
const xlsx = await gateway.drive.filesExport({
  fileId: "sheet-id",
  mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
});

// Slides → PDF (deliverable)
const slidesPdf = await gateway.drive.filesExport({
  fileId: "slides-id",
  mimeType: "application/pdf",
});
```

For non-text exports the result is binary bytes — pass it on to
`scratch_run` or another binary-aware sink, don't `console.log` it.

## Create files

**Empty Google Sheet inside a specific folder:**

```javascript
const f = await gateway.drive.filesCreate({
  body: {
    name: "Q3 Forecast",
    mimeType: "application/vnd.google-apps.spreadsheet",
    parents: ["folder-id"],
  },
});
console.log(`Created sheet ${f.id}`);
```

**Upload a CSV and convert to Sheet on import:**

```javascript
const csv = "Date,Account,Amount\n2026-05-06,Acme,25000\n";
const f = await gateway.drive.filesCreate({
  body: {
    name: "Imported Forecast",
    mimeType: "application/vnd.google-apps.spreadsheet",       // the desired type
    parents: ["folder-id"],
  },
  // Source mime type (what we're sending) is set on the upload, not the metadata.
  // The OpenAPI shape is split: metadata via `body`, content via `media`/`uploadType`.
  // For text uploads pass content as a string; for binary, base64-encode.
  media: { mimeType: "text/csv", body: csv },
  uploadType: "multipart",
});
```

## Copy and rename

```javascript
const f = await gateway.drive.filesCopy({
  fileId: "template-id",
  body: { name: "Q3 — copy of template", parents: ["folder-id"] },
});
```

## Move (= update parents)

```javascript
await gateway.drive.filesUpdate({
  fileId: "abc123",
  addParents: "new-folder-id",
  removeParents: "old-folder-id",
});
```

## Sharing — list and add

```javascript
const r = await gateway.drive.permissionsList({
  fileId: "abc123",
  fields: "permissions(id, emailAddress, role, type)",
});
for (const p of r.permissions) console.log(p.emailAddress, p.role);

await gateway.drive.permissionsCreate({
  fileId: "abc123",
  sendNotificationEmail: false,                 // true sends Gmail notification with optional message
  body: {
    type: "user",                               // "user" | "group" | "domain" | "anyone"
    role: "writer",                             // "owner" | "writer" | "commenter" | "reader"
    emailAddress: "alice@acme.com",
  },
});
```

For **link sharing**, type=`anyone`:

```javascript
await gateway.drive.permissionsCreate({
  fileId: "abc123",
  body: { type: "anyone", role: "reader" },
});
```

To **transfer ownership**, role=`owner` plus `transferOwnership: true`
(only works inside the same Workspace domain).

## Pitfalls

- **Default `fields` is sparse.** If your script reads `f.modifiedTime`
  and gets `undefined`, you forgot to ask for it.
- **`q` strings need escaping.** Single quote inside a value:
  `q: \`name = '${name.replace(/'/g, \"\\\\'\")}'\``. Don't
  string-interpolate untrusted values without escaping.
- **`'me' in owners` is the literal string `'me'`** — Drive's reserved
  word for the authenticated user. Same for `'me' in writers`,
  `'me' in readers`.
- **Trash is sneaky.** Drive never auto-deletes; "deleted" files sit
  in trash forever unless permanently removed. Always include
  `trashed = false` in queries unless you're explicitly looking in
  trash.
- **`filesExport` only works on Google-native files.** PDFs, images,
  and uploaded Office files use `filesGet` with `alt: "media"`.
- **Permissions don't deduplicate.** Calling `permissionsCreate`
  twice for the same email creates two permission rows. Check via
  `permissionsList` before adding.
- **Rate limits:** ~10,000 queries per 100 sec per user (per
  project). Reasonable, but tight loops over 1k+ files will hit
  it — page in 100s and use `fields` to keep responses small.
