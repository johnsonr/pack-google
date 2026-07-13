/**
 * Drive → knowledge-base ingestion: ingestDoc must hand the assistant's
 * source-neutral ingest tool the exported content plus provenance —
 * `drive://<fileId>` uri, Drive `modifiedTime` as the freshness anchor,
 * and the external owner when the Doc is merely shared with the user.
 */
import { describe, it, expect, vi } from "vitest";
import { mockGateway } from "@embabel/runtime-types";
import type { WorkspaceTools } from "../.embabel/gateway";
import { ingestDoc } from "../src/api/drive-ingest";

const DOC_META = {
  id: "f-123",
  name: "Q3 Plan",
  mimeType: "application/vnd.google-apps.document",
  modifiedTime: "2026-07-10T09:00:00.000Z",
  ownedByMe: true,
};

function gateway(overrides: {
  meta?: Record<string, unknown>;
  exportImpl?: (args: { mimeType: string }) => Promise<unknown>;
  ingestImpl?: () => Promise<unknown>;
}) {
  const ingestDocument =
    vi.fn(overrides.ingestImpl ?? (async () => ({ status: "ingested" })));
  const filesExport = vi.fn(
    overrides.exportImpl ?? (async () => "# Q3 Plan\nShip the thing."),
  );
  const gw = mockGateway<WorkspaceTools>({
    drive: {
      filesGet: vi.fn().mockResolvedValue(overrides.meta ?? DOC_META),
      filesExport,
    },
    ingest: { document: ingestDocument },
  } as never);
  return { gw: gw as never, ingestDocument, filesExport };
}

describe("ingestDoc", () => {
  it("exports markdown and ingests with drive:// provenance and the freshness anchor", async () => {
    const { gw, ingestDocument, filesExport } = gateway({});

    const result = await ingestDoc(gw, { fileId: "f-123" });

    expect(filesExport).toHaveBeenCalledWith({ fileId: "f-123", mimeType: "text/markdown" });
    expect(ingestDocument).toHaveBeenCalledWith({
      content: "# Q3 Plan\nShip the thing.",
      uri: "drive://f-123",
      title: "Q3 Plan",
      sourceKind: "drive",
      sourceModifiedAt: "2026-07-10T09:00:00.000Z",
      ownerEmail: undefined,
    });
    expect(result).toEqual({
      uri: "drive://f-123",
      title: "Q3 Plan",
      sourceModifiedAt: "2026-07-10T09:00:00.000Z",
    });
  });

  it("falls back to plain text when markdown export is unavailable", async () => {
    const { gw, ingestDocument, filesExport } = gateway({
      exportImpl: async ({ mimeType }) => {
        if (mimeType === "text/markdown") throw new Error("HTTP 400: unsupported export type");
        return "Q3 Plan. Ship the thing.";
      },
    });

    await ingestDoc(gw, { fileId: "f-123" });

    expect(filesExport).toHaveBeenCalledTimes(2);
    expect(ingestDocument).toHaveBeenCalledWith(
      expect.objectContaining({ content: "Q3 Plan. Ship the thing." }),
    );
  });

  it("stamps the external owner for a Doc shared WITH the user", async () => {
    const { gw, ingestDocument } = gateway({
      meta: {
        ...DOC_META,
        ownedByMe: false,
        owners: [{ emailAddress: "owner@acme.com" }],
      },
    });

    await ingestDoc(gw, { fileId: "f-123" });

    expect(ingestDocument).toHaveBeenCalledWith(
      expect.objectContaining({ ownerEmail: "owner@acme.com" }),
    );
  });

  it("refuses non-Doc files with an actionable error and ingests nothing", async () => {
    const { gw, ingestDocument } = gateway({
      meta: { ...DOC_META, mimeType: "application/vnd.google-apps.spreadsheet" },
    });

    await expect(ingestDoc(gw, { fileId: "f-123" })).rejects.toThrow(/Only Google Docs/);
    expect(ingestDocument).not.toHaveBeenCalled();
  });

  it("propagates an ingest-tool failure instead of reporting success", async () => {
    const { gw } = gateway({
      ingestImpl: async () => {
        throw new Error("tool ingest_document error: Ingestion failed");
      },
    });

    await expect(ingestDoc(gw, { fileId: "f-123" })).rejects.toThrow(/Ingestion failed/);
  });
});
