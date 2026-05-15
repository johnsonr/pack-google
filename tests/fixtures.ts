/**
 * Shared document fixtures for docs-editor tests. Keep these small —
 * each test builds the minimum doc shape it needs.
 */
import type { Docs_Document } from "../.embabel/gateway";

interface ParagraphSpec {
  style?: string;
  text: string;
  /** Resolved by the helper, but you can override for index-math tests. */
  startIndex?: number;
}

/**
 * Build a synthetic `Docs_Document` from a flat list of paragraphs.
 * Indexes are assigned sequentially so the structure mimics what the
 * Docs API returns. Tests that care about indexes pass explicit
 * `startIndex` values.
 */
export function buildDoc(
  paragraphs: ParagraphSpec[],
  options: { revisionId?: string } = {},
): Docs_Document {
  let cursor = 1; // Docs API uses 1-based indexes.
  const content = paragraphs.map((p) => {
    const startIndex = p.startIndex ?? cursor;
    const text = p.text.endsWith("\n") ? p.text : `${p.text}\n`;
    const endIndex = startIndex + text.length;
    cursor = endIndex;
    return {
      startIndex,
      endIndex,
      paragraph: {
        paragraphStyle: p.style ? { namedStyleType: p.style } : undefined,
        elements: [{ textRun: { content: text } }],
      },
    };
  });
  return {
    revisionId: options.revisionId ?? "r1",
    body: { content },
  } as Docs_Document;
}
