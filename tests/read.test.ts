/**
 * Read-side tests: getOutline, readSection, findInDocument.
 */
import { describe, it, expect, vi } from "vitest";
import { mockGateway } from "@embabel/runtime-types";
import type { WorkspaceTools } from "../.embabel/gateway";
import {
  findInDocument,
  getOutline,
  readSection,
} from "../src/api/docs-editor";
import { buildDoc } from "./fixtures";

function gatewayWithDoc(doc: ReturnType<typeof buildDoc>) {
  return mockGateway<WorkspaceTools>({
    docs: {
      documentsGet: vi.fn().mockResolvedValue(doc),
    },
  });
}

describe("getOutline", () => {
  it("flattens heading paragraphs into spans", async () => {
    const doc = buildDoc([
      { style: "HEADING_1", text: "Introduction" },
      { style: "NORMAL_TEXT", text: "Body of intro." },
      { style: "HEADING_2", text: "Background" },
      { style: "NORMAL_TEXT", text: "Body of background." },
    ]);
    const gateway = gatewayWithDoc(doc);
    const outline = await getOutline(gateway, { documentId: "abc" });

    expect(outline.revisionId).toBe("r1");
    expect(outline.spans).toHaveLength(2);
    expect(outline.spans[0]).toMatchObject({ level: 1, text: "Introduction" });
    expect(outline.spans[1]).toMatchObject({ level: 2, text: "Background" });
    expect(outline.spans[0]?.anchor).toMatch(/^idx:/);
  });

  it("returns empty spans when the document has no styled headings", async () => {
    const doc = buildDoc([{ style: "NORMAL_TEXT", text: "Just body text." }]);
    const gateway = gatewayWithDoc(doc);
    const outline = await getOutline(gateway, { documentId: "abc" });
    expect(outline.spans).toEqual([]);
  });
});

describe("readSection", () => {
  it("returns the text under one heading until the next", async () => {
    const doc = buildDoc([
      { style: "HEADING_1", text: "First" },
      { style: "NORMAL_TEXT", text: "Body A." },
      { style: "NORMAL_TEXT", text: "Body B." },
      { style: "HEADING_1", text: "Second" },
      { style: "NORMAL_TEXT", text: "Other body." },
    ]);
    const gateway = gatewayWithDoc(doc);
    const outline = await getOutline(gateway, { documentId: "abc" });
    const anchor = outline.spans[0]!.anchor;

    const section = await readSection(gateway, { documentId: "abc", anchor });

    expect(section.anchor).toBe(anchor);
    expect(section.text).toContain("First");
    expect(section.text).toContain("Body A.");
    expect(section.text).toContain("Body B.");
    expect(section.text).not.toContain("Second");
    expect(section.text).not.toContain("Other body.");
  });

  it("throws when the anchor is not in the outline", async () => {
    const doc = buildDoc([{ style: "HEADING_1", text: "Only" }]);
    const gateway = gatewayWithDoc(doc);
    await expect(
      readSection(gateway, { documentId: "abc", anchor: "idx:9999" }),
    ).rejects.toThrow(/anchor not found/);
  });
});

describe("findInDocument", () => {
  it("returns each occurrence with its enclosing span", async () => {
    const doc = buildDoc([
      { style: "HEADING_1", text: "Apples" },
      { style: "NORMAL_TEXT", text: "Apples are red." },
      { style: "HEADING_1", text: "Oranges" },
      { style: "NORMAL_TEXT", text: "Oranges are not apples." },
    ]);
    const gateway = gatewayWithDoc(doc);
    const result = await findInDocument(gateway, {
      documentId: "abc",
      query: "apples",
    });

    expect(result.matches.length).toBeGreaterThanOrEqual(3);
    for (const m of result.matches) {
      expect(m.enclosingAnchor).toBeDefined();
      expect(m.context.toLowerCase()).toContain("apples");
    }
  });

  it("respects maxResults", async () => {
    const doc = buildDoc(
      Array.from({ length: 10 }, () => ({
        style: "NORMAL_TEXT",
        text: "needle in haystack",
      })),
    );
    const gateway = gatewayWithDoc(doc);
    const result = await findInDocument(gateway, {
      documentId: "abc",
      query: "needle",
      maxResults: 3,
    });
    expect(result.matches).toHaveLength(3);
  });

  it("returns empty matches for an empty query", async () => {
    const doc = buildDoc([{ style: "NORMAL_TEXT", text: "Anything" }]);
    const gateway = gatewayWithDoc(doc);
    const result = await findInDocument(gateway, { documentId: "abc", query: "" });
    expect(result.matches).toEqual([]);
  });
});
