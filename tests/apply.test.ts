/**
 * applyEdits — the destructive path. Tests assert:
 *   - revisionId guard (conflict short-circuit)
 *   - only accepted Ok ops translate to batchUpdate
 *   - requests are sorted back-to-front
 *   - per-op translation produces the expected request kinds
 */
import { describe, it, expect, vi } from "vitest";
import { mockGateway } from "@embabel/runtime-types";
import type { WorkspaceTools } from "../.embabel/gateway";
import { applyEdits, proposeEdits, getOutline } from "../src/api/docs-editor";
import type { EditOp } from "../src/types/edit-op";
import { buildDoc } from "./fixtures";

function harness(doc: ReturnType<typeof buildDoc>) {
  // Same doc returned for every documentsGet call — applyEdits's
  // re-pull sees an unchanged revisionId, so the guard passes. The
  // conflict test below builds its own mock with explicit per-call
  // sequencing.
  const documentsGet = vi.fn().mockResolvedValue(doc);
  const documentsBatchUpdate = vi.fn().mockResolvedValue({ documentId: "abc" });
  const gateway = mockGateway<WorkspaceTools>({
    docs: { documentsGet, documentsBatchUpdate },
  });
  return { gateway, documentsBatchUpdate };
}

async function planWith(gateway: ReturnType<typeof harness>["gateway"], edits: EditOp[]) {
  const outline = await getOutline(gateway, { documentId: "abc" });
  const plan = await proposeEdits(gateway, { documentId: "abc", edits });
  return { plan, outline };
}

describe("applyEdits — guard", () => {
  it("returns a conflict when the doc revision moved", async () => {
    const original = buildDoc([{ style: "HEADING_1", text: "Section" }], { revisionId: "r1" });
    // getOutline + proposeEdits both see r1; applyEdits re-pulls and sees r2.
    const fresh = { ...original, revisionId: "r2" } as ReturnType<typeof buildDoc>;
    const documentsGet = vi.fn()
      .mockResolvedValueOnce(original)   // getOutline
      .mockResolvedValueOnce(original)   // proposeEdits
      .mockResolvedValueOnce(fresh);     // applyEdits re-pull
    const documentsBatchUpdate = vi.fn();
    const gateway = mockGateway<WorkspaceTools>({
      docs: { documentsGet, documentsBatchUpdate },
    });

    const outline = await getOutline(gateway, { documentId: "abc" });
    const plan = await proposeEdits(gateway, {
      documentId: "abc",
      edits: [{
        kind: "DeleteSpan",
        anchor: outline.spans[0]!.anchor,
        reason: "obsolete",
      }],
    });
    const result = await applyEdits(gateway, {
      documentId: "abc",
      plan,
      acceptedEditIds: plan.edits.map((e) => e.id),
    });

    expect(result.conflict).toEqual({ observedRevisionId: "r2" });
    expect(result.applied).toEqual([]);
    expect(documentsBatchUpdate).not.toHaveBeenCalled();
  });

  it("passes requiredRevisionId on the batchUpdate writeControl", async () => {
    const doc = buildDoc([{ style: "HEADING_1", text: "S" }], { revisionId: "rXYZ" });
    const { gateway, documentsBatchUpdate } = harness(doc);
    const { plan } = await planWith(gateway, [{
      kind: "DeleteSpan",
      anchor: (await getOutline(gateway, { documentId: "abc" })).spans[0]!.anchor,
      reason: "obsolete",
    }]);

    await applyEdits(gateway, {
      documentId: "abc",
      plan,
      acceptedEditIds: plan.edits.map((e) => e.id),
    });

    expect(documentsBatchUpdate).toHaveBeenCalledOnce();
    const call = documentsBatchUpdate.mock.calls[0]![0] as Record<string, unknown>;
    expect((call.writeControl as Record<string, unknown>).requiredRevisionId).toBe("rXYZ");
  });
});

describe("applyEdits — selection", () => {
  it("skips ops that aren't in acceptedEditIds", async () => {
    const doc = buildDoc([
      { style: "HEADING_1", text: "A" },
      { style: "HEADING_1", text: "B" },
    ]);
    const { gateway, documentsBatchUpdate } = harness(doc);
    const outline = await getOutline(gateway, { documentId: "abc" });
    const plan = await proposeEdits(gateway, {
      documentId: "abc",
      edits: [
        { kind: "DeleteSpan", anchor: outline.spans[0]!.anchor, reason: "drop A" },
        { kind: "DeleteSpan", anchor: outline.spans[1]!.anchor, reason: "drop B" },
      ],
    });
const result = await applyEdits(gateway, {
      documentId: "abc",
      plan,
      acceptedEditIds: ["e2"],   // only the second
    });

    expect(result.applied).toEqual(["e2"]);
    const call = documentsBatchUpdate.mock.calls[0]![0] as Record<string, unknown>;
    expect((call.requests as unknown[]).length).toBe(1);
  });

  it("skips Invalid ops even when their id is accepted", async () => {
    const doc = buildDoc([{ style: "HEADING_1", text: "S" }]);
    const { gateway, documentsBatchUpdate } = harness(doc);
    const outline = await getOutline(gateway, { documentId: "abc" });
    const plan = await proposeEdits(gateway, {
      documentId: "abc",
      edits: [
        { kind: "DeleteSpan", anchor: "idx:9999", reason: "bad" },   // Invalid
        { kind: "DeleteSpan", anchor: outline.spans[0]!.anchor, reason: "ok" },
      ],
    });
const result = await applyEdits(gateway, {
      documentId: "abc",
      plan,
      acceptedEditIds: ["e1", "e2"],
    });

    expect(result.applied).toEqual(["e2"]);
    const call = documentsBatchUpdate.mock.calls[0]![0] as Record<string, unknown>;
    expect((call.requests as unknown[]).length).toBe(1);
  });
});

describe("applyEdits — translation per op", () => {
  it("ReplaceText emits delete-then-insert", async () => {
    const doc = buildDoc([
      { style: "HEADING_1", text: "Section" },
      { style: "NORMAL_TEXT", text: "Hello world" },
    ]);
    const { gateway, documentsBatchUpdate } = harness(doc);
    const outline = await getOutline(gateway, { documentId: "abc" });
    const plan = await proposeEdits(gateway, {
      documentId: "abc",
      edits: [{
        kind: "ReplaceText",
        anchor: outline.spans[0]!.anchor,
        find: "Hello",
        replace: "Goodbye",
        reason: "rewrite",
      }],
    });
await applyEdits(gateway, {
      documentId: "abc",
      plan,
      acceptedEditIds: ["e1"],
    });
    const requests = (documentsBatchUpdate.mock.calls[0]![0] as { requests: Record<string, unknown>[] }).requests;
    expect(requests.some((r) => "deleteContentRange" in r)).toBe(true);
    expect(requests.some((r) => "insertText" in r)).toBe(true);
  });

  it("DeleteSpan emits a single deleteContentRange", async () => {
    const doc = buildDoc([{ style: "HEADING_1", text: "Section" }]);
    const { gateway, documentsBatchUpdate } = harness(doc);
    const outline = await getOutline(gateway, { documentId: "abc" });
    const plan = await proposeEdits(gateway, {
      documentId: "abc",
      edits: [{
        kind: "DeleteSpan",
        anchor: outline.spans[0]!.anchor,
        reason: "drop",
      }],
    });
await applyEdits(gateway, {
      documentId: "abc",
      plan,
      acceptedEditIds: ["e1"],
    });
    const requests = (documentsBatchUpdate.mock.calls[0]![0] as { requests: Record<string, unknown>[] }).requests;
    expect(requests).toHaveLength(1);
    expect(requests[0]).toHaveProperty("deleteContentRange");
  });

  it("SetStyle emits updateParagraphStyle with the right namedStyleType", async () => {
    const doc = buildDoc([{ style: "HEADING_3", text: "Section" }]);
    const { gateway, documentsBatchUpdate } = harness(doc);
    const outline = await getOutline(gateway, { documentId: "abc" });
    const plan = await proposeEdits(gateway, {
      documentId: "abc",
      edits: [{
        kind: "SetStyle",
        anchor: outline.spans[0]!.anchor,
        style: "Heading2",
        reason: "promote",
      }],
    });
await applyEdits(gateway, {
      documentId: "abc",
      plan,
      acceptedEditIds: ["e1"],
    });
    const request = (documentsBatchUpdate.mock.calls[0]![0] as { requests: Array<Record<string, unknown>> }).requests[0]!;
    expect(request).toHaveProperty("updateParagraphStyle");
    const paragraphStyle = (request.updateParagraphStyle as { paragraphStyle: { namedStyleType: string } }).paragraphStyle;
    expect(paragraphStyle.namedStyleType).toBe("HEADING_2");
  });

  it("multi-op batch is sorted back-to-front by sortIndex", async () => {
    const doc = buildDoc([
      { style: "HEADING_1", text: "First" },
      { style: "HEADING_1", text: "Second" },
      { style: "HEADING_1", text: "Third" },
    ]);
    const { gateway, documentsBatchUpdate } = harness(doc);
    const outline = await getOutline(gateway, { documentId: "abc" });
    const plan = await proposeEdits(gateway, {
      documentId: "abc",
      edits: outline.spans.map((s, i) => ({
        kind: "DeleteSpan" as const,
        anchor: s.anchor,
        reason: `drop ${i}`,
      })),
    });
await applyEdits(gateway, {
      documentId: "abc",
      plan,
      acceptedEditIds: plan.edits.map((e) => e.id),
    });

    const requests = (documentsBatchUpdate.mock.calls[0]![0] as {
      requests: Array<{ deleteContentRange: { range: { startIndex: number } } }>;
    }).requests;
    const indexes = requests.map((r) => r.deleteContentRange.range.startIndex);
    const sortedDescending = [...indexes].sort((a, b) => b - a);
    expect(indexes).toEqual(sortedDescending);
  });
});
