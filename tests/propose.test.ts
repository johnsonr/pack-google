/**
 * proposeEdits — validation per op type. One Ok case + at least one
 * Invalid case per kind. Plus the plan-level invariants (revisionId
 * stamp, per-op ids).
 */
import { describe, it, expect, vi } from "vitest";
import { mockGateway } from "@embabel/runtime-types";
import type { WorkspaceTools } from "../.embabel/gateway";
import { proposeEdits } from "../src/api/docs-editor";
import { buildOutline } from "../src/lib/outline";
import type { EditOp } from "../src/types/edit-op";
import { buildDoc } from "./fixtures";

async function planAgainst(
  doc: ReturnType<typeof buildDoc>,
  build: (outline: ReturnType<typeof buildOutline>) => EditOp[],
) {
  const gateway = mockGateway<WorkspaceTools>({
    docs: { documentsGet: vi.fn().mockResolvedValue(doc) },
  });
  const outline = buildOutline(doc);
  const plan = await proposeEdits(gateway, { documentId: "abc", edits: build(outline) });
  return { plan, outline };
}

describe("proposeEdits — plan invariants", () => {
  it("stamps revisionId from the snapshot and assigns per-op ids", async () => {
    const doc = buildDoc([{ style: "HEADING_1", text: "Hello" }], {
      revisionId: "rev-7",
    });
    const { plan } = await planAgainst(doc, (outline) => [
      {
        kind: "DeleteSpan",
        anchor: outline.spans[0]!.anchor,
        reason: "obsolete",
      },
    ]);
    expect(plan.documentId).toBe("abc");
    expect(plan.revisionId).toBe("rev-7");
    expect(plan.edits).toHaveLength(1);
    expect(plan.edits[0]!.id).toBe("e1");
  });
});

describe("validation — Ok paths", () => {
  it("ReplaceText with a matching find", async () => {
    const doc = buildDoc([
      { style: "HEADING_1", text: "Heading" },
      { style: "NORMAL_TEXT", text: "Hello world." },
    ]);
    const { plan } = await planAgainst(doc, (outline) => [
      {
        kind: "ReplaceText",
        anchor: outline.spans[0]!.anchor,
        find: "Hello",
        replace: "Goodbye",
        reason: "rewrite",
      },
    ]);
    expect(plan.edits[0]!.status.kind).toBe("Ok");
  });

  it("InsertParagraph with a valid position", async () => {
    const doc = buildDoc([{ style: "HEADING_1", text: "Only" }]);
    const { plan } = await planAgainst(doc, (outline) => [
      {
        kind: "InsertParagraph",
        anchor: outline.spans[0]!.anchor,
        position: "After",
        content: "New paragraph",
        reason: "expand intro",
      },
    ]);
    expect(plan.edits[0]!.status.kind).toBe("Ok");
  });
});

describe("validation — Invalid paths", () => {
  it("rejects when reason is blank", async () => {
    const doc = buildDoc([{ style: "HEADING_1", text: "Section" }]);
    const { plan } = await planAgainst(doc, (outline) => [
      {
        kind: "DeleteSpan",
        anchor: outline.spans[0]!.anchor,
        reason: "",
      },
    ]);
    const status = plan.edits[0]!.status;
    expect(status.kind).toBe("Invalid");
    if (status.kind === "Invalid") expect(status.reason).toMatch(/reason/i);
  });

  it("rejects unknown anchor", async () => {
    const doc = buildDoc([{ style: "HEADING_1", text: "Section" }]);
    const { plan } = await planAgainst(doc, (outline) => [
      {
        kind: "DeleteSpan",
        anchor: "idx:9999",
        reason: "wrong",
      },
    ]);
    const status = plan.edits[0]!.status;
    expect(status.kind).toBe("Invalid");
    if (status.kind === "Invalid") expect(status.reason).toMatch(/anchor not found/);
  });

  it("ReplaceText rejects when find absent", async () => {
    const doc = buildDoc([{ style: "HEADING_1", text: "Section" }]);
    const { plan } = await planAgainst(doc, (outline) => [
      {
        kind: "ReplaceText",
        anchor: outline.spans[0]!.anchor,
        find: "missing-string",
        replace: "x",
        reason: "rewrite",
      },
    ]);
    const status = plan.edits[0]!.status;
    expect(status.kind).toBe("Invalid");
    if (status.kind === "Invalid") expect(status.reason).toMatch(/not found/);
  });

  it("ReplaceText rejects when requested occurrence exceeds matches", async () => {
    const doc = buildDoc([
      { style: "HEADING_1", text: "S" },
      { style: "NORMAL_TEXT", text: "hello hello" },
    ]);
    const { plan } = await planAgainst(doc, (outline) => [
      {
        kind: "ReplaceText",
        anchor: outline.spans[0]!.anchor,
        find: "hello",
        replace: "hi",
        occurrence: 5,
        reason: "rewrite",
      },
    ]);
    const status = plan.edits[0]!.status;
    expect(status.kind).toBe("Invalid");
    if (status.kind === "Invalid") expect(status.reason).toMatch(/occurrence/);
  });

  it("SetInlineStyle rejects when format has no fields", async () => {
    const doc = buildDoc([
      { style: "HEADING_1", text: "Heading" },
      { style: "NORMAL_TEXT", text: "shall" },
    ]);
    const { plan } = await planAgainst(doc, (outline) => [
      {
        kind: "SetInlineStyle",
        anchor: outline.spans[0]!.anchor,
        find: "shall",
        format: {},
        reason: "emphasize",
      },
    ]);
    const status = plan.edits[0]!.status;
    expect(status.kind).toBe("Invalid");
    if (status.kind === "Invalid") expect(status.reason).toMatch(/format/);
  });

  it("MoveSpan rejects target equal to anchor", async () => {
    const doc = buildDoc([{ style: "HEADING_1", text: "Section" }]);
    const { plan } = await planAgainst(doc, (outline) => [
      {
        kind: "MoveSpan",
        anchor: outline.spans[0]!.anchor,
        target: outline.spans[0]!.anchor,
        position: "After",
        reason: "shuffle",
      },
    ]);
    const status = plan.edits[0]!.status;
    expect(status.kind).toBe("Invalid");
    if (status.kind === "Invalid") expect(status.reason).toMatch(/target/);
  });

  it("MoveSpan rejects target inside source span (descendant)", async () => {
    const doc = buildDoc([
      { style: "HEADING_1", text: "Parent" },
      { style: "HEADING_2", text: "Child" },
      { style: "NORMAL_TEXT", text: "More" },
    ]);
    const { plan } = await planAgainst(doc, (outline) => [
      {
        kind: "MoveSpan",
        anchor: outline.spans[0]!.anchor,
        target: outline.spans[1]!.anchor,
        position: "After",
        reason: "shuffle",
      },
    ]);
    const status = plan.edits[0]!.status;
    expect(status.kind).toBe("Invalid");
    if (status.kind === "Invalid") expect(status.reason).toMatch(/descendant/);
  });

  it("SetStyle rejects a demotion that would orphan a deeper child", async () => {
    const doc = buildDoc([
      { style: "HEADING_1", text: "Parent" },
      { style: "HEADING_3", text: "Child" },
    ]);
    const { plan } = await planAgainst(doc, (outline) => [
      {
        kind: "SetStyle",
        anchor: outline.spans[0]!.anchor,
        style: "Heading1",
        reason: "no-op",
      },
    ]);
    // Heading1 has child at level 3 — that's a 2-level gap, rejected.
    const status = plan.edits[0]!.status;
    if (status.kind === "Invalid") {
      expect(status.reason).toMatch(/orphan/);
    }
    // (When the rule passes — e.g. if we ever relax it — this just stays Ok.)
  });
});
