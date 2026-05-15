/**
 * Document-editing surface for Google Docs. Five gateway methods built
 * on the raw `gateway.docs.*` primitives:
 *
 *   getOutline       — heading tree for a document
 *   readSection      — text content of one span
 *   findInDocument   — substring search returning matches + enclosing span
 *   proposeEdits     — validate a list of EditOps, return a planned set
 *   applyEdits       — destructive: send the accepted ops as one batchUpdate
 *                       with the revisionId guard
 *
 * The revisionId guard lives in `applyEdits`: the snapshot pulled by
 * `proposeEdits` stamps the plan, and `applyEdits` re-pulls the doc
 * just before mutation. If the revisionId changed, we abort and tell
 * the caller — the user must re-propose against the current state.
 *
 * See `plans/DOC_EDIT.md` in the assistant repo for the design.
 */
import type { GatewayContext } from "../../.embabel/gateway";
import { buildOutline, findSpan, spanText } from "../lib/outline";
import type { Outline } from "../lib/outline";
import { translate } from "../lib/translate";
import { validateOp } from "../lib/validate";
import type {
  AnchorId,
  ApplyResult,
  EditOp,
  EditOpId,
  EditPlan,
  PlannedEdit,
} from "../types/edit-op";

// --- Read methods -----------------------------------------------------

export async function getOutline(
  ctx: GatewayContext,
  args: { documentId: string },
): Promise<Outline> {
  const doc = await ctx.docs.documentsGet({ documentId: args.documentId });
  return buildOutline(doc);
}

export interface SectionContent {
  anchor: AnchorId;
  text: string;
  revisionId: string;
}

export async function readSection(
  ctx: GatewayContext,
  args: { documentId: string; anchor: AnchorId },
): Promise<SectionContent> {
  const doc = await ctx.docs.documentsGet({ documentId: args.documentId });
  const outline = buildOutline(doc);
  const span = findSpan(outline, args.anchor);
  if (!span) throw new Error(`anchor not found: ${args.anchor}`);
  return {
    anchor: args.anchor,
    text: spanText(doc, span),
    revisionId: doc.revisionId ?? "",
  };
}

export interface FindMatch {
  startIndex: number;
  text: string;
  enclosingAnchor?: AnchorId;
  context: string;
}

export async function findInDocument(
  ctx: GatewayContext,
  args: { documentId: string; query: string; maxResults?: number },
): Promise<{ matches: FindMatch[]; revisionId: string }> {
  if (!args.query) {
    return { matches: [], revisionId: "" };
  }
  const doc = await ctx.docs.documentsGet({ documentId: args.documentId });
  const outline = buildOutline(doc);
  const needleLower = args.query.toLowerCase();
  const max = args.maxResults ?? 50;

  // Iterate the document paragraph-by-paragraph so we still find matches
  // in preamble (content before the first heading) and in docs without
  // any styled headings. Each match is attributed to the span whose
  // range contains the paragraph's startIndex — undefined when the
  // paragraph isn't inside any heading span.
  const matches: FindMatch[] = [];
  const content = doc.body?.content ?? [];
  outer: for (const element of content) {
    const paragraph = element.paragraph;
    if (!paragraph) continue;
    const paragraphStart = element.startIndex ?? 0;
    const enclosing = outline.spans.find(
      (s) => s.startIndex <= paragraphStart && paragraphStart < s.endIndex,
    );
    const text = (paragraph.elements ?? [])
      .map((el) => el.textRun?.content ?? "")
      .join("");
    const lower = text.toLowerCase();
    let i = 0;
    while (true) {
      if (matches.length >= max) break outer;
      const idx = lower.indexOf(needleLower, i);
      if (idx < 0) break;
      matches.push({
        startIndex: paragraphStart + idx,
        text: args.query,
        enclosingAnchor: enclosing?.anchor,
        context: contextSnippet(text, idx, args.query.length),
      });
      i = idx + args.query.length;
    }
  }
  return { matches, revisionId: doc.revisionId ?? "" };
}

// --- Edit methods -----------------------------------------------------

export async function proposeEdits(
  ctx: GatewayContext,
  args: { documentId: string; edits: EditOp[] },
): Promise<EditPlan> {
  const doc = await ctx.docs.documentsGet({ documentId: args.documentId });
  const planned: PlannedEdit[] = args.edits.map((op, i) => ({
    id: `e${i + 1}`,
    op,
    status: validateOp(op, doc),
    preview: buildPreview(op, doc),
  }));
  return {
    documentId: args.documentId,
    revisionId: doc.revisionId ?? "",
    edits: planned,
  };
}

export async function applyEdits(
  ctx: GatewayContext,
  args: {
    documentId: string;
    plan: EditPlan;
    acceptedEditIds: EditOpId[];
  },
): Promise<ApplyResult> {
  // Re-pull just before mutating so we either send `requiredRevisionId`
  // that matches reality or surface a clean conflict to the caller.
  const fresh = await ctx.docs.documentsGet({ documentId: args.documentId });
  const freshRevision = fresh.revisionId ?? "";
  if (freshRevision !== args.plan.revisionId) {
    return {
      documentId: args.documentId,
      revisionIdUsed: args.plan.revisionId,
      applied: [],
      conflict: { observedRevisionId: freshRevision },
    };
  }

  const acceptedSet = new Set(args.acceptedEditIds);
  const opsToApply = args.plan.edits.filter(
    (e) => acceptedSet.has(e.id) && e.status.kind === "Ok",
  );

  const translated = opsToApply.flatMap((e) => translate(e.op, fresh));
  // Back-to-front so earlier mutations don't shift the index space of
  // later ones in the same batch.
  translated.sort((a, b) => b.sortIndex - a.sortIndex);

  if (translated.length === 0) {
    return {
      documentId: args.documentId,
      revisionIdUsed: freshRevision,
      applied: [],
    };
  }

  await ctx.docs.documentsBatchUpdate({
    documentId: args.documentId,
    requests: translated.map((t) => t.request),
    writeControl: { requiredRevisionId: freshRevision },
  } as Parameters<typeof ctx.docs.documentsBatchUpdate>[0]);

  return {
    documentId: args.documentId,
    revisionIdUsed: freshRevision,
    applied: opsToApply.map((e) => e.id),
  };
}

// --- Helpers ----------------------------------------------------------

function contextSnippet(text: string, start: number, length: number): string {
  const PAD = 32;
  const from = Math.max(0, start - PAD);
  const to = Math.min(text.length, start + length + PAD);
  return text.slice(from, to);
}

function buildPreview(op: EditOp, doc: Awaited<ReturnType<GatewayContext["docs"]["documentsGet"]>>) {
  // Best-effort: compute a short before/after pair for the review card.
  // Full fidelity arrives in Phase 2 with named-range anchors. For now
  // we omit the preview when the snapshot doesn't hold the data we need
  // — the UI falls back to rendering the op summary.
  const outline = buildOutline(doc);
  const span = findSpan(outline, op.anchor);
  if (!span) return undefined;
  switch (op.kind) {
    case "ReplaceText":
      return { before: op.find, after: op.replace };
    case "ReplaceSpan":
      return { before: span.text, after: op.content.split("\n")[0] ?? op.content };
    case "DeleteSpan":
      return { before: span.text, after: "" };
    case "InsertParagraph":
      return { before: "", after: op.content };
    case "SetStyle":
      return { before: `(level ${span.level}) ${span.text}`, after: `(${op.style}) ${span.text}` };
    default:
      return undefined;
  }
}
