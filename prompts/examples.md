# pack-google — usage examples

Three independent gateways: `gateway.sheets.*`, `gateway.drive.*`,
`gateway.docs.*`. Methods are the operationId from the spec with dots
replaced by underscores (e.g. `spreadsheets.values.batchUpdate` →
`spreadsheets_values_batchUpdate`). The bundled per-service skills
have the deeper request grammar.

## Read a sheet, then update one cell

```javascript
const ssId = "1abc...XYZ";
const r = await gateway.sheets.spreadsheets_values_get({
  spreadsheetId: ssId,
  range: "Sheet1!A1:D100",
});
// r.values is rows of strings/numbers; first row is whatever was there,
// not necessarily a header — don't assume.
console.log(`Got ${r.values?.length ?? 0} rows`);

await gateway.sheets.spreadsheets_values_update({
  spreadsheetId: ssId,
  range: "Sheet1!E1",
  valueInputOption: "USER_ENTERED",          // parses formulas, dates
  body: { values: [["=SUM(A1:D1)"]] },
});
```

## Append rows to a sheet

```javascript
await gateway.sheets.spreadsheets_values_append({
  spreadsheetId: ssId,
  range: "Sheet1",                            // bare sheet name → append below last row
  valueInputOption: "USER_ENTERED",
  insertDataOption: "INSERT_ROWS",
  body: {
    values: [
      ["2026-05-06", "Acme Corp", "Hardware", 25000],
      ["2026-05-06", "Globex",    "Services", 12000],
    ],
  },
});
```

## Create a sheet and seed it

```javascript
const ss = await gateway.sheets.spreadsheets_create({
  body: {
    properties: { title: "Q2 Forecast" },
    sheets: [{ properties: { title: "Pipeline" } }],
  },
});
const id = ss.spreadsheetId;
await gateway.sheets.spreadsheets_values_update({
  spreadsheetId: id,
  range: "Pipeline!A1:D1",
  valueInputOption: "RAW",
  body: { values: [["Date", "Account", "Stage", "Amount"]] },
});
console.log(`Created ${ss.spreadsheetUrl}`);
```

## Find a Google Sheet by name

```javascript
const r = await gateway.drive.files_list({
  q: "mimeType='application/vnd.google-apps.spreadsheet' and name='Q2 Forecast' and trashed=false",
  fields: "files(id, name, modifiedTime, webViewLink)",
  pageSize: 10,
});
const sheet = r.files[0];
if (!sheet) { console.log("Not found"); return; }
console.log(`${sheet.name} → ${sheet.webViewLink}`);
```

## Search Drive by content / owner

```javascript
const r = await gateway.drive.files_list({
  q: "fullText contains 'pricing' and 'alice@acme.com' in owners and trashed=false",
  fields: "files(id, name, mimeType, owners(emailAddress), modifiedTime)",
  pageSize: 50,
});
for (const f of r.files) console.log(f.modifiedTime, f.name);
```

## Export a Google Doc to PDF

```javascript
const r = await gateway.drive.files_export({
  fileId: "doc-id-here",
  mimeType: "application/pdf",
});
// r is the file bytes (binary). For text-only export:
const txt = await gateway.drive.files_export({
  fileId: "doc-id-here",
  mimeType: "text/plain",
});
console.log(typeof txt === "string" ? txt.slice(0, 500) : "(binary)");
```

## Share a file

```javascript
await gateway.drive.permissions_create({
  fileId: "abc123",
  sendNotificationEmail: false,
  body: {
    type: "user",
    role: "writer",
    emailAddress: "alice@acme.com",
  },
});
```

## Read a Google Doc as structured content

```javascript
const d = await gateway.docs.documents_get({ documentId: "doc-id-here" });
// d.body.content is a list of StructuralElement.
// Each can be paragraph | sectionBreak | table | tableOfContents.
const text = (d.body?.content ?? [])
  .flatMap(e => e.paragraph?.elements ?? [])
  .map(el => el.textRun?.content ?? "")
  .join("");
console.log(text.slice(0, 500));
```

## Insert text into a Google Doc

```javascript
await gateway.docs.documents_batchUpdate({
  documentId: "doc-id-here",
  body: {
    requests: [
      { insertText: { location: { index: 1 }, text: "Executive summary\n\n" } },
      { updateParagraphStyle: {
          range: { startIndex: 1, endIndex: 19 },
          paragraphStyle: { namedStyleType: "HEADING_1" },
          fields: "namedStyleType",
      }},
    ],
  },
});
```

## End-to-end: pull deals from a sheet, summarize, write back

```javascript
const ssId = "1abc...XYZ";
const r = await gateway.sheets.spreadsheets_values_get({
  spreadsheetId: ssId,
  range: "Pipeline!A2:D",
});
const rows = r.values ?? [];
const total = rows.reduce((sum, row) => sum + parseFloat(row[3] || "0"), 0);
const open  = rows.filter(row => (row[2] || "").toLowerCase() !== "closed-won").length;

await gateway.sheets.spreadsheets_values_update({
  spreadsheetId: ssId,
  range: "Pipeline!F1:G2",
  valueInputOption: "RAW",
  body: {
    values: [
      ["Total ($)", "Open"],
      [total, open],
    ],
  },
});
```
