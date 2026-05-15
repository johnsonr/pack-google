/**
 * Validate a single [[EditOp]] against the current document snapshot.
 * Returns an [[EditOpStatus]] — `Ok` or `Invalid` with a reason string.
 *
 * Validation runs before any mutation: every rule that would cause
 * `applyEdits` to fail at the API layer is checked here first, so the
 * review UI shows the user exactly which ops can't proceed.
 */
import type { Docs_Document } from "../../.embabel/gateway";
import type { EditOp, EditOpStatus, ParagraphStyle } from "../types/edit-op";
import { buildOutline, findSpan, spanText } from "./outline";

export function validateOp(op: EditOp, doc: Docs_Document): EditOpStatus {
  if (!op.reason || op.reason.trim() === "") {
    return { kind: "Invalid", reason: "reason is required" };
  }
  const outline = buildOutline(doc);
  const span = findSpan(outline, op.anchor);
  if (!span) {
    return { kind: "Invalid", reason: `anchor not found: ${op.anchor}` };
  }

  switch (op.kind) {
    case "ReplaceText": {
      const text = spanText(doc, span);
      const count = countOccurrences(text, op.find);
      if (count === 0) {
        return { kind: "Invalid", reason: `'${op.find}' not found in span` };
      }
      if (op.occurrence !== "all" && (op.occurrence ?? 1) > count) {
        return {
          kind: "Invalid",
          reason: `'${op.find}' occurrence ${op.occurrence} requested but only ${count} match${count === 1 ? "" : "es"} present`,
        };
      }
      return { kind: "Ok" };
    }

    case "SetInlineStyle": {
      const text = spanText(doc, span);
      const count = countOccurrences(text, op.find);
      if (count === 0) {
        return { kind: "Invalid", reason: `'${op.find}' not found in span` };
      }
      if ((op.occurrence ?? 1) > count) {
        return {
          kind: "Invalid",
          reason: `'${op.find}' occurrence ${op.occurrence ?? 1} requested but only ${count} present`,
        };
      }
      if (!hasAnyFormatField(op.format)) {
        return { kind: "Invalid", reason: "format must set at least one field" };
      }
      return { kind: "Ok" };
    }

    case "ReplaceSpan":
    case "DeleteSpan":
      return { kind: "Ok" };

    case "InsertParagraph": {
      if (op.position === "FirstChild" || op.position === "LastChild") {
        // Heading spans are containers by definition; non-heading spans
        // wouldn't be in the outline in the first place. Future
        // non-heading anchors will need a real container check.
        return { kind: "Ok" };
      }
      return { kind: "Ok" };
    }

    case "SetStyle": {
      if (!isHeadingStyle(op.style)) return { kind: "Ok" };
      // For heading targets, prevent demoting in a way that would orphan
      // a deeper heading directly beneath. Find the next span; if it has
      // a level deeper than the new style by more than 1, reject.
      const idx = outline.spans.indexOf(span);
      const next = outline.spans[idx + 1];
      if (!next) return { kind: "Ok" };
      const newLevel = parseHeadingLevel(op.style);
      if (next.level > newLevel + 1) {
        return {
          kind: "Invalid",
          reason: `setting span to ${op.style} would orphan child heading at level ${next.level}`,
        };
      }
      return { kind: "Ok" };
    }

    case "MoveSpan": {
      if (op.target === op.anchor) {
        return { kind: "Invalid", reason: "target cannot equal anchor" };
      }
      const target = findSpan(outline, op.target);
      if (!target) {
        return { kind: "Invalid", reason: `target anchor not found: ${op.target}` };
      }
      // Descendant means: target appears after source in the outline and
      // every heading between them is strictly deeper than source. Flat
      // index ranges don't capture nesting because sibling headings
      // partition the index space — we need the level information.
      const srcIdx = outline.spans.indexOf(span);
      const tgtIdx = outline.spans.indexOf(target);
      if (tgtIdx > srcIdx) {
        let isDescendant = true;
        for (let i = srcIdx + 1; i <= tgtIdx; i++) {
          if (outline.spans[i]!.level <= span.level) { isDescendant = false; break; }
        }
        if (isDescendant) {
          return { kind: "Invalid", reason: "target is a descendant of anchor" };
        }
      }
      return { kind: "Ok" };
    }
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let i = 0;
  while (true) {
    const idx = haystack.indexOf(needle, i);
    if (idx < 0) break;
    count++;
    i = idx + needle.length;
  }
  return count;
}

function hasAnyFormatField(format: {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  link?: string;
}): boolean {
  return (
    format.bold !== undefined ||
    format.italic !== undefined ||
    format.underline !== undefined ||
    format.link !== undefined
  );
}

function isHeadingStyle(style: ParagraphStyle): boolean {
  return style.startsWith("Heading");
}

function parseHeadingLevel(style: ParagraphStyle): number {
  if (!isHeadingStyle(style)) return 0;
  return Number.parseInt(style.slice("Heading".length), 10);
}
