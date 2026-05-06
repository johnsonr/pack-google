---
name: google-docs-workflows
description: Google Docs workflows — reading a document's structured content (paragraphs, runs, tables, headings) and editing via `documents.batchUpdate` requests (insertText, deleteContentRange, replaceAllText, updateParagraphStyle, updateTextStyle, insertTable, etc.). Activate this skill BEFORE making any Docs call when the user asks about reading, editing, or formatting Google Docs.
---

# Google Docs Workflows

## Namespace

Calls go through `gateway.docs.<method>(args)` from inside
`execute_javascript` or `execute_python`. Only three methods exist
(this is the entire Docs API surface):

| Need | Method |
|---|---|
| Create a new document | `documents_create` |
| Read structured content | `documents_get` |
| Edit (insert, delete, format, replace, tables) | `documents_batchUpdate` |

If a call returns `gateway.docs.foo is not a workspace tool`, the
error lists the three valid methods.

## Cardinal rule: it's all `documents_batchUpdate`

The Docs API has exactly ONE write method: `documents_batchUpdate`.
Every edit — type a character, bold a word, insert a table, replace
all instances of "Foo" with "Bar" — is a `Request` in the `requests`
array. Knowing the request grammar IS the skill.

## Document model

`documents_get` returns:

```text
Document
  body
    content: StructuralElement[]            // top-level blocks
      paragraph         ParagraphElement[]  // paragraphs are a list of "runs" (text + formatting)
        textRun         { content, textStyle }
        inlineObjectElement   (image, embedded chart, ...)
        ...
      table
        tableRows[]
          tableCells[]
            content: StructuralElement[]    // recursive — cells contain paragraphs, tables, ...
      sectionBreak
      tableOfContents
```

Every character has an **integer index** in the document. The first
character is at index 1 (index 0 is reserved). Indices include
formatting marks, so:

- After insertion, downstream indices shift.
- `endIndex` of an element points one past the last character (half-open).

Read the body as plain text:

```javascript
const d = await gateway.docs.documents_get({ documentId: "abc..." });

function flatten(elements) {
  let out = "";
  for (const el of elements) {
    if (el.paragraph) {
      for (const p of el.paragraph.elements ?? []) {
        out += p.textRun?.content ?? "";
      }
    } else if (el.table) {
      for (const row of el.table.tableRows ?? []) {
        for (const cell of row.tableCells ?? []) {
          out += flatten(cell.content ?? []) + "\t";
        }
        out += "\n";
      }
    }
  }
  return out;
}

console.log(flatten(d.body?.content ?? []).slice(0, 1000));
```

## Request types (the things you put in `batchUpdate.requests`)

Each entry is an object with **exactly one** of these keys:

| Request | What it does |
|---|---|
| `insertText` | Insert text at an index |
| `deleteContentRange` | Delete a `[startIndex, endIndex)` range |
| `replaceAllText` | Find-and-replace across the doc |
| `updateTextStyle` | Set bold/italic/font/color on a range |
| `updateParagraphStyle` | Set heading style, alignment, spacing on a range |
| `insertTable` | Insert an empty rows×cols table |
| `insertTableRow` / `insertTableColumn` | Grow a table |
| `deleteTableRow` / `deleteTableColumn` | Shrink a table |
| `insertPageBreak` | Insert a page break |
| `insertSectionBreak` | Insert a section break |
| `createNamedRange` / `deleteNamedRange` | Bookmark a range |
| `replaceNamedRangeContent` | Replace content inside a named range |
| `updateDocumentStyle` | Margins, page size, default text style |
| `createHeader` / `createFooter` / `deleteHeader` / `deleteFooter` | Headers and footers |
| `insertInlineImage` / `replaceImage` | Images |

**Indices in a single batch are evaluated against the original
document**, not the running result — Docs reorders writes so they all
apply to the pre-batch state. So you can confidently insert text at
index 1 AND format index 1..15 in the same batch.

But the response indices are post-batch. If you need to know where a
just-inserted run ended up, do a `documents_get` after.

## Common patterns

### Replace placeholders in a template

The fastest way to fill out a templated doc. Operates on the literal
text — no index math needed.

```javascript
await gateway.docs.documents_batchUpdate({
  documentId: "doc-id",
  body: {
    requests: [
      { replaceAllText: { containsText: { text: "{{customer}}", matchCase: true }, replaceText: "Acme Corp" } },
      { replaceAllText: { containsText: { text: "{{date}}",     matchCase: true }, replaceText: "2026-05-06" } },
      { replaceAllText: { containsText: { text: "{{owner}}",    matchCase: true }, replaceText: "Alice Nguyen" } },
    ],
  },
});
```

### Insert a heading at the top

```javascript
await gateway.docs.documents_batchUpdate({
  documentId: "doc-id",
  body: {
    requests: [
      { insertText: { location: { index: 1 }, text: "Executive Summary\n" } },
      { updateParagraphStyle: {
          range: { startIndex: 1, endIndex: 18 },
          paragraphStyle: { namedStyleType: "HEADING_1" },
          fields: "namedStyleType",
      }},
    ],
  },
});
```

### Append to the end

`endIndex` of the body's last `sectionBreak` minus 1 is "the end".
Read it once, then insert there.

```javascript
const d = await gateway.docs.documents_get({ documentId: "doc-id", fields: "body(content(endIndex))" });
const last = d.body.content.at(-1);
const end = last.endIndex - 1;

await gateway.docs.documents_batchUpdate({
  documentId: "doc-id",
  body: {
    requests: [
      { insertText: { location: { index: end }, text: "\n\nAppended note: see attached.\n" } },
    ],
  },
});
```

### Bold and color a phrase

```javascript
await gateway.docs.documents_batchUpdate({
  documentId: "doc-id",
  body: {
    requests: [{
      updateTextStyle: {
        range: { startIndex: 100, endIndex: 115 },
        textStyle: {
          bold: true,
          foregroundColor: { color: { rgbColor: { red: 0.8 } } },
        },
        fields: "bold,foregroundColor",
      },
    }],
  },
});
```

### Insert a table and fill it

Two phases — table creation first (so indices stabilize), then fill.

```javascript
await gateway.docs.documents_batchUpdate({
  documentId: "doc-id",
  body: {
    requests: [{ insertTable: { rows: 3, columns: 3, location: { index: 1 } } }],
  },
});

// Re-read to find the cell indices (they're not deterministic from
// the inputs because Docs surrounds the table with paragraph marks).
const d = await gateway.docs.documents_get({ documentId: "doc-id" });
// Walk d.body.content for `table`, then table.tableRows[r].tableCells[c].content[0]
// → grab its startIndex; that's where the cell's first paragraph begins.
// Then issue insertText for each cell in a single batch.
```

### Find-and-format (case study)

Because there's no "regex find" request, the pattern is: get the doc,
walk paragraphs to find offsets, then issue `updateTextStyle` on the
ranges. Example: bold every "TODO" in the doc.

```javascript
const d = await gateway.docs.documents_get({ documentId: "doc-id" });
const ranges = [];
function walk(elements, base = 0) {
  for (const el of elements) {
    if (el.paragraph) {
      for (const p of el.paragraph.elements ?? []) {
        const t = p.textRun?.content;
        if (!t) continue;
        let i = 0;
        while ((i = t.indexOf("TODO", i)) !== -1) {
          const start = p.startIndex + i;
          ranges.push({ startIndex: start, endIndex: start + 4 });
          i += 4;
        }
      }
    } else if (el.table) {
      for (const row of el.table.tableRows ?? []) {
        for (const cell of row.tableCells ?? []) walk(cell.content ?? []);
      }
    }
  }
}
walk(d.body.content);

await gateway.docs.documents_batchUpdate({
  documentId: "doc-id",
  body: {
    requests: ranges.map(r => ({
      updateTextStyle: { range: r, textStyle: { bold: true }, fields: "bold" },
    })),
  },
});
```

## Pitfalls

- **`fields` is mandatory** on `updateTextStyle`,
  `updateParagraphStyle`, and `updateDocumentStyle`. Docs needs to know
  which sub-fields you're writing vs. reading.
- **Index 0 is invalid.** Always start at 1. Trying to insert at index
  0 returns `INVALID_ARGUMENT`.
- **Ranges are half-open.** A range over `[1, 10)` covers 9 characters.
- **Newlines count.** Inserting `"Hi\n"` advances by 3.
- **You can't read or write directly to body without going through
  `body.content`.** There's no "set the whole document" call. To
  replace everything: `deleteContentRange` over the whole body, then
  `insertText`.
- **Headings are paragraph styles, not text styles.** Wrong:
  `updateTextStyle` with a `namedStyleType` (it doesn't exist on
  TextStyle). Right: `updateParagraphStyle` with
  `namedStyleType: "HEADING_1"`.
- **Lists are awkward.** Use `createParagraphBullets` /
  `deleteParagraphBullets` over a paragraph range; passing a bullet
  spec into `updateParagraphStyle` won't work.
- **Don't loop find-and-replace.** Use one `replaceAllText` per
  pattern in a single `batchUpdate` — much faster and atomic.
