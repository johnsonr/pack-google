/**
 * Edit vocabulary for structured document editing — the seven ops plus
 * supporting types. See `specs/PACK_COMPILER.md` and `plans/DOC_EDIT.md`
 * in the assistant repo.
 *
 * Three categories, split along the axes that matter (substring vs span
 * vs structure × content vs style × replace vs insert vs delete):
 *
 *   substring:        ReplaceText, SetInlineStyle
 *   span content:     ReplaceSpan, InsertParagraph, DeleteSpan
 *   structure only:   SetStyle, MoveSpan
 *
 * Each op is a discriminated-union variant tagged by `kind`. Every op
 * carries a non-empty `reason` for the review UI.
 */

export type AnchorId = string;

/** Paragraph style names. Match Google Docs `namedStyleType` values. */
export type ParagraphStyle =
  | "Heading1"
  | "Heading2"
  | "Heading3"
  | "Heading4"
  | "Heading5"
  | "Heading6"
  | "Body"
  | "Bullet"
  | "Numbered"
  | "Quote";

export type Position = "Before" | "After" | "FirstChild" | "LastChild";

export interface InlineFormat {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  link?: string;
}

// --- Substring-level ---------------------------------------------------

export interface ReplaceText {
  kind: "ReplaceText";
  anchor: AnchorId;
  find: string;
  replace: string;
  /** 1-based occurrence within the span; `"all"` replaces every match. */
  occurrence?: number | "all";
  reason: string;
}

export interface SetInlineStyle {
  kind: "SetInlineStyle";
  anchor: AnchorId;
  find: string;
  occurrence?: number;
  format: InlineFormat;
  reason: string;
}

// --- Span-level content ------------------------------------------------

export interface ReplaceSpan {
  kind: "ReplaceSpan";
  anchor: AnchorId;
  content: string;
  reason: string;
}

export interface InsertParagraph {
  kind: "InsertParagraph";
  anchor: AnchorId;
  position: Position;
  content: string;
  style?: ParagraphStyle;
  reason: string;
}

export interface DeleteSpan {
  kind: "DeleteSpan";
  anchor: AnchorId;
  reason: string;
}

// --- Structure-only ----------------------------------------------------

export interface SetStyle {
  kind: "SetStyle";
  anchor: AnchorId;
  style: ParagraphStyle;
  reason: string;
}

export interface MoveSpan {
  kind: "MoveSpan";
  anchor: AnchorId;
  target: AnchorId;
  position: Position;
  reason: string;
}

export type EditOp =
  | ReplaceText
  | SetInlineStyle
  | ReplaceSpan
  | InsertParagraph
  | DeleteSpan
  | SetStyle
  | MoveSpan;

// --- Plan / result shapes ---------------------------------------------

export type EditOpId = string;

export type EditOpStatus =
  | { kind: "Ok" }
  | { kind: "Invalid"; reason: string };

export interface PlannedEdit {
  id: EditOpId;
  op: EditOp;
  status: EditOpStatus;
  /** Optional preview rendered for review-card display. */
  preview?: { before: string; after: string };
}

export interface EditPlan {
  documentId: string;
  revisionId: string;
  edits: PlannedEdit[];
}

export interface ApplyResult {
  documentId: string;
  /** Revision id observed when the batch was sent. */
  revisionIdUsed: string;
  applied: EditOpId[];
  /** Non-empty when the doc moved under us. Caller should re-propose. */
  conflict?: { observedRevisionId: string };
}
