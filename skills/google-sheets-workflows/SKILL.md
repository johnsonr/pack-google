---
name: google-sheets-workflows
description: Google Sheets workflows — reading and writing ranges in A1 notation, appending rows, batching reads/writes, evaluating formulas, and modifying spreadsheet structure (adding sheets, formatting, conditional formatting) via `spreadsheets.batchUpdate`. Activate this skill BEFORE making any Sheets call when the user asks anything involving spreadsheets, cells, ranges, rows, columns, formulas, charts, or anything in Google Sheets.
---

# Google Sheets Workflows

## Namespace

Calls go through `gateway.sheets.<method>(args)` from inside
`execute_javascript` or `execute_python`. Never as top-level tools.

Methods are the operationId from the OpenAPI spec with dots replaced
by underscores:

| Need | Method |
|---|---|
| Create a spreadsheet | `spreadsheetsCreate` |
| Read spreadsheet metadata (sheets list, properties) | `spreadsheetsGet` |
| Modify structure (add/remove sheets, formatting, cond. formatting) | `spreadsheetsBatchUpdate` |
| Read one range | `spreadsheetsValuesGet` |
| Read several ranges in one call | `spreadsheetsValuesBatchGet` |
| Write one range (overwrite) | `spreadsheetsValuesUpdate` |
| Write several ranges | `spreadsheetsValuesBatchUpdate` |
| Append rows after the last data row | `spreadsheetsValuesAppend` |
| Clear values (keep formatting) | `spreadsheetsValuesClear` |

If a call returns `gateway.sheets.foo is not a workspace tool`, the
error lists every valid method — pick from it. Never re-send the
same call.

## Cardinal rules

1. **Two different `batchUpdate`s.** `spreadsheetsBatchUpdate` modifies
   structure (sheets, formatting, conditional rules, charts).
   `spreadsheetsValuesBatchUpdate` modifies cell values. They take
   completely different request bodies. Pick by what you're changing.
2. **A1 notation is the only way to address ranges.** `Sheet1!A1:D100`,
   `Sheet1!A:A` (whole column), `Sheet1!1:1` (whole row), `Sheet1`
   (everything in a sheet, useful for `append`). The exclamation mark is
   required when the sheet is named.
3. **`valueInputOption` matters.** `RAW` writes the literal string —
   `"=SUM(A1:A2)"` becomes the seven-character string `=SUM(A1:A2)`,
   not a formula. `USER_ENTERED` parses dates, numbers, and formulas
   like the user typed them. Default to `USER_ENTERED` unless you have
   a reason to preserve a literal `=`.
4. **`values` is `Array<Array<string|number|boolean>>`.** Outer array is
   rows, inner is cells. Even single-cell writes need `[[value]]`.
   Sheets returns numbers as numbers and dates as serial-day floats —
   not ISO strings.
5. **ALWAYS probe shape first.** Before computing anything (average,
   sum, count, lookup), run a small `spreadsheetsValuesGet` for the
   first 3-5 rows of a wide range (e.g. `Sheet1!A1:Z5`) and `print` it.
   Look at what you got: is row 1 a title? a header? data? Which column
   holds the numbers? Are the columns named at all? Then write the real
   script. Don't guess that there's a "Rating" column header — verify.
   Skipping this is the #1 cause of "no ratings found" / "column missing"
   / silently-zero-results bugs.

## Reading

**One range:**

```javascript
const r = await gateway.sheets.spreadsheetsValuesGet({
  spreadsheetId: "1abc...",
  range: "Pipeline!A1:D",                     // open-ended → up to last row
  valueRenderOption: "FORMATTED_VALUE",       // default; "UNFORMATTED_VALUE" returns raw numbers
  dateTimeRenderOption: "FORMATTED_STRING",   // or "SERIAL_NUMBER"
});
const rows = r.values ?? [];                  // null if range is empty
```

**Compute in the script — return a small answer, not the rows.** If
the user asked "what's the average / count / sum / max," do the math
here and return just the number. Returning the raw `values` array
dumps the sheet into the LLM context, where the next turn re-parses
it inline (badly).

```javascript
const r = await gateway.sheets.spreadsheetsValuesGet({
  spreadsheetId: "1abc...",
  range: "Sheet1!B:B",
  valueRenderOption: "UNFORMATTED_VALUE",     // numbers come back as numbers
});
const ratings = (r.values ?? []).flat().filter(v => typeof v === "number");
const avg = ratings.reduce((a, b) => a + b, 0) / ratings.length;
return { count: ratings.length, average: Number(avg.toFixed(2)) };
// NOT: return { rows: r.values }    ← this dumps the sheet into context
```

**Several ranges in one call** (one round-trip, much faster than N gets):

```javascript
const r = await gateway.sheets.spreadsheetsValuesBatchGet({
  spreadsheetId: "1abc...",
  ranges: ["Pipeline!A:A", "Forecast!B2:B100", "Notes!A1"],
});
const [ids, forecasts, note] = r.valueRanges.map(v => v.values ?? []);
```

**Discover sheet names + IDs** (sheetId is needed for any structural
batchUpdate — it's NOT the spreadsheetId):

```javascript
const meta = await gateway.sheets.spreadsheetsGet({
  spreadsheetId: "1abc...",
  fields: "sheets(properties(sheetId,title,gridProperties))",
});
for (const s of meta.sheets) console.log(s.properties.sheetId, s.properties.title);
```

## Writing values

**Overwrite a range:**

```javascript
await gateway.sheets.spreadsheetsValuesUpdate({
  spreadsheetId: "1abc...",
  range: "Pipeline!E1",
  valueInputOption: "USER_ENTERED",
  body: { values: [["=SUM(D2:D)"]] },
});
```

**Multiple ranges in one call:**

```javascript
await gateway.sheets.spreadsheetsValuesBatchUpdate({
  spreadsheetId: "1abc...",
  body: {
    valueInputOption: "USER_ENTERED",
    data: [
      { range: "Pipeline!E1",  values: [["=SUM(D2:D)"]] },
      { range: "Pipeline!F1",  values: [["=COUNTA(A2:A)"]] },
      { range: "Notes!A1:A2",  values: [["Auto-updated"], [new Date().toISOString()]] },
    ],
  },
});
```

**Append rows** (auto-finds the row after the last filled one):

```javascript
await gateway.sheets.spreadsheetsValuesAppend({
  spreadsheetId: "1abc...",
  range: "Pipeline",                          // bare sheet name; Sheets picks the table
  valueInputOption: "USER_ENTERED",
  insertDataOption: "INSERT_ROWS",            // pushes existing formulas down. Use OVERWRITE to replace.
  body: { values: [["2026-05-06", "Acme", "Stage 2", 25000]] },
});
```

**Clear** (keep formatting, drop values):

```javascript
await gateway.sheets.spreadsheetsValuesClear({
  spreadsheetId: "1abc...",
  range: "Pipeline!A2:D",
});
```

## Modifying structure (`spreadsheetsBatchUpdate`)

The big one. Takes `{ requests: [Request, ...] }` where each `Request`
is a tagged union — one (and only one) of `addSheet`, `deleteSheet`,
`updateSheetProperties`, `updateCells`, `repeatCell`,
`addConditionalFormatRule`, `addChart`, `mergeCells`, `autoResizeDimensions`, …

**Add a sheet:**

```javascript
const r = await gateway.sheets.spreadsheetsBatchUpdate({
  spreadsheetId: "1abc...",
  body: {
    requests: [
      { addSheet: { properties: { title: "Q3", gridProperties: { rowCount: 200, columnCount: 12 } } } },
    ],
  },
});
const newSheetId = r.replies[0].addSheet.properties.sheetId;
```

**Format a header row** (bold, light-grey fill — `repeatCell` writes
the same cell format across a range):

```javascript
await gateway.sheets.spreadsheetsBatchUpdate({
  spreadsheetId: "1abc...",
  body: {
    requests: [{
      repeatCell: {
        range: { sheetId: newSheetId, startRowIndex: 0, endRowIndex: 1 },   // half-open: row 0 only
        cell: {
          userEnteredFormat: {
            textFormat: { bold: true },
            backgroundColor: { red: 0.93, green: 0.93, blue: 0.93 },
          },
        },
        fields: "userEnteredFormat(textFormat,backgroundColor)",
      },
    }],
  },
});
```

**Auto-resize columns:**

```javascript
await gateway.sheets.spreadsheetsBatchUpdate({
  spreadsheetId: "1abc...",
  body: {
    requests: [{
      autoResizeDimensions: {
        dimensions: { sheetId: newSheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 4 },
      },
    }],
  },
});
```

**Conditional formatting** (red fill if Stage = "lost"):

```javascript
await gateway.sheets.spreadsheetsBatchUpdate({
  spreadsheetId: "1abc...",
  body: {
    requests: [{
      addConditionalFormatRule: {
        rule: {
          ranges: [{ sheetId: newSheetId, startRowIndex: 1, startColumnIndex: 2, endColumnIndex: 3 }],
          booleanRule: {
            condition: { type: "TEXT_EQ", values: [{ userEnteredValue: "lost" }] },
            format: { backgroundColor: { red: 0.97, green: 0.85, blue: 0.85 } },
          },
        },
        index: 0,
      },
    }],
  },
});
```

## Pitfalls

- **`sheetId` ≠ `spreadsheetId`.** `spreadsheetId` is the doc; `sheetId`
  is one tab inside it (a number, often 0 for the first tab). Look it
  up via `spreadsheetsGet` with `fields: "sheets(properties(sheetId,title))"`.
- **Index ranges in `batchUpdate` are half-open** (`endRowIndex` is
  exclusive). A1 ranges in `values_*` are closed (`A1:A1` is one cell).
- **`fields` is mandatory** on `repeatCell`, `updateCells`,
  `updateSheetProperties` — it tells Sheets which sub-fields you
  actually want to write. `fields: "*"` works but is brittle.
- **Append's range argument is a hint, not an anchor.** Pass just the
  sheet name (`"Pipeline"`) and Sheets finds the table; pass an A1
  range and Sheets searches within it.
- **Empty cells come back as missing array entries**, not `null` or
  `""`. `values[0].length` may be smaller than the column count. Always
  read with a default: `row[3] ?? ""`.
- **`UPDATE` doesn't extend the sheet.** Writing to `A101` on a
  100-row sheet errors. Either resize first via `spreadsheetsBatchUpdate`
  → `appendDimension`, or just use `values_append`.
- **Quota:** ~100 read or write requests per 100 seconds per user.
  Batch reads with `values_batchGet`, writes with `values_batchUpdate`,
  structural changes by stuffing many `requests` into one
  `spreadsheetsBatchUpdate`. Don't loop one cell at a time.
