---
name: google-docs-editor-workflows
description: Structured Google Docs editing via `docs_editor` — outline, section reads, substring search, and a proposed/reviewed/applied edit flow safe against concurrent edits. Activate BEFORE any docs_editor call; it returns the namespace and rules to follow.
---

# Google Docs — structured editing via `gateway.docsEditor`

The `docsEditor` namespace is a typed wrapper around the raw
`gateway.docs.*` API. It does three things the raw API doesn't:

1. **Outline-first reads.** `getOutline(docId)` returns a heading tree
   so you can reason about structure without pulling the whole
   document body into your context.
2. **Anchored sections.** `readSection(docId, anchor)` and
   `findInDocument(docId, query)` return spans/matches tagged with
   anchors you can reuse for editing — no offset arithmetic.
3. **Guarded propose/apply.** `proposeEdits` returns a validated
   `EditPlan` stamped with the document's `revisionId`. `applyEdits`
   sends `requiredRevisionId` on the underlying batchUpdate, so a
   concurrent edit elsewhere fails cleanly rather than silently
   stomping on the user.

## Cardinal rules

1. **Prefer `gateway.docsEditor.*` over `gateway.docs.*`.** Use
   `docsEditor.getOutline` instead of pulling the full document and
   walking it yourself; use `docsEditor.proposeEdits` +
   `applyEdits` instead of building raw `documentsBatchUpdate`
   requests.
2. **Never call `gateway.docs.documentsBatchUpdate` directly for
   user-visible edits.** It bypasses validation and the revisionId
   guard. The raw method still exists for cases where you genuinely
   need a kind of edit the seven ops don't express (e.g. table
   insertions in v1); use it sparingly and own the consequences.
3. **Edits are a two-step flow.** Always `proposeEdits` first,
   inspect the returned `EditPlan` (every entry has `status: Ok` or
   `status: Invalid(reason)`), then call `applyEdits` with the
   `acceptedEditIds` list. Invalid ops never reach the document.

## The seven edit ops

`proposeEdits` takes a list of `EditOp` — a discriminated union with
seven `kind` values:

| Kind | Purpose |
|---|---|
| `ReplaceText` | Substring substitution inside a span. `find` + `replace` + optional `occurrence`. |
| `SetInlineStyle` | Bold/italic/underline/link a substring without retyping it. |
| `ReplaceSpan` | Overwrite a whole span's text (one heading section). |
| `InsertParagraph` | Add a new paragraph relative to a span (`Before`, `After`, `FirstChild`, `LastChild`). |
| `DeleteSpan` | Remove a span and its children. |
| `SetStyle` | Change a paragraph's style (promote/demote heading level, etc.). |
| `MoveSpan` | Relocate a span next to another (delete+insert atomically). |

Every op carries an `anchor` (from `getOutline` / `readSection`) and a
non-empty `reason` (shown in the review UI).

## Typical flow

```js
// 1. Understand the structure.
const outline = await gateway.docsEditor.getOutline({ documentId });
// outline.spans = [{ anchor, level, text, startIndex, endIndex }, …]

// 2. Read just the section you care about.
const section = await gateway.docsEditor.readSection({
  documentId,
  anchor: outline.spans[0].anchor,
});

// 3. Propose edits.
const plan = await gateway.docsEditor.proposeEdits({
  documentId,
  edits: [
    {
      kind: "ReplaceText",
      anchor: outline.spans[0].anchor,
      find: "Hello",
      replace: "Goodbye",
      reason: "rename intro greeting",
    },
  ],
});
// plan.edits[i].status === "Ok" | { kind: "Invalid", reason: "..." }

// 4. Apply only the ones that validated.
const accepted = plan.edits
  .filter((e) => e.status.kind === "Ok")
  .map((e) => e.id);

const result = await gateway.docsEditor.applyEdits({
  documentId,
  plan,
  acceptedEditIds: accepted,
});
if (result.conflict) {
  // Doc moved under us — re-propose against the current state.
}
```

## When to fall back to raw `gateway.docs.*`

- Creating a brand-new document: `gateway.docs.documentsCreate(...)`.
- Inserting a table / image: not yet expressible as an EditOp; use
  `documentsBatchUpdate` and own the lack-of-guard risk.
- Pure-read of the whole raw document JSON: `documentsGet` directly.

For everything else — outline navigation, structured reads, text and
style edits — `gateway.docsEditor.*` is the right entrypoint.
