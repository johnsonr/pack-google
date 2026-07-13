/**
 * Drive → knowledge-base ingestion: ingestDoc must hand the assistant's
 * source-neutral ingest tool the exported content plus provenance —
 * `drive://<fileId>` uri, Drive `modifiedTime` as the freshness anchor,
 * and the external owner when the Doc is merely shared with the user.
 */
import { describe, it, expect, vi } from "vitest";
import { mockGateway } from "@embabel/runtime-types";
import type { WorkspaceTools } from "../.embabel/gateway";
import { ingestDoc, ingestSheet, refresh } from "../src/api/drive-ingest";

/** First-call first-arg of a vi.fn whose implementation is argless-typed. */
function firstArg<T>(fn: unknown): T {
  return (fn as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0] as T;
}

const DOC_META = {
  id: "f-123",
  name: "Q3 Plan",
  mimeType: "application/vnd.google-apps.document",
  modifiedTime: "2026-07-10T09:00:00.000Z",
  ownedByMe: true,
};

const SHEET_META = {
  ...DOC_META,
  name: "Q3 Numbers",
  mimeType: "application/vnd.google-apps.spreadsheet",
};

function gateway(overrides: {
  meta?: Record<string, unknown>;
  exportImpl?: (args: { mimeType: string }) => Promise<unknown>;
  ingestImpl?: () => Promise<unknown>;
  statusImpl?: () => Promise<unknown>;
  spreadsheet?: Record<string, unknown>;
  values?: Record<string, unknown>;
}) {
  const ingestDocument =
    vi.fn(overrides.ingestImpl ?? (async () => ({ status: "ingested" })));
  const ingestStatus = vi.fn(overrides.statusImpl ?? (async () => ({ exists: false })));
  const filesExport = vi.fn(
    overrides.exportImpl ?? (async () => "# Q3 Plan\nShip the thing."),
  );
  const gw = mockGateway<WorkspaceTools>({
    drive: {
      filesGet: vi.fn().mockResolvedValue(overrides.meta ?? DOC_META),
      filesExport,
    },
    sheets: {
      spreadsheetsGet: vi.fn().mockResolvedValue(
        overrides.spreadsheet ?? {
          sheets: [
            { properties: { title: "Revenue" } },
            { properties: { title: "Hidden", hidden: true } },
            { properties: { title: "Costs" } },
          ],
        },
      ),
      spreadsheetsValuesBatchGet: vi.fn().mockResolvedValue(
        overrides.values ?? {
          valueRanges: [
            { values: [["Region", "Amount"], ["EMEA", 120], ["APAC", 80]] },
            { values: [["Item", "Cost"], ["Hosting", 40]] },
          ],
        },
      ),
    },
    ingest: { document: ingestDocument, status: ingestStatus },
  } as never);
  return { gw: gw as never, ingestDocument, ingestStatus, filesExport };
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

describe("ingestSheet", () => {
  it("renders one markdown section per visible tab and ingests with provenance", async () => {
    const { gw, ingestDocument } = gateway({ meta: SHEET_META });

    const result = await ingestSheet(gw, { fileId: "f-123" });

    expect(result.uri).toBe("drive://f-123");
    const content = firstArg<{ content: string }>(ingestDocument).content;
    expect(content).toContain("# Q3 Numbers");
    expect(content).toContain("## Revenue");
    expect(content).toContain("| EMEA | 120 |");
    expect(content).toContain("## Costs");
    expect(content).toContain("| Hosting | 40 |");
    expect(content).not.toContain("## Hidden");
    expect(ingestDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceKind: "drive",
        sourceModifiedAt: SHEET_META.modifiedTime,
        title: "Q3 Numbers",
      }),
    );
  });

  it("refuses non-sheet files and points at ingestDoc", async () => {
    const { gw, ingestDocument } = gateway({});

    await expect(ingestSheet(gw, { fileId: "f-123" })).rejects.toThrow(/Only Google Sheets/);
    expect(ingestDocument).not.toHaveBeenCalled();
  });

  it("says explicitly when rows were dropped — no silent caps", async () => {
    const manyRows = [["h"], ...Array.from({ length: 600 }, (_, i) => [`r${i}`])];
    const { gw, ingestDocument } = gateway({
      meta: SHEET_META,
      spreadsheet: { sheets: [{ properties: { title: "Big" } }] },
      values: { valueRanges: [{ values: manyRows }] },
    });

    await ingestSheet(gw, { fileId: "f-123" });

    const content = firstArg<{ content: string }>(ingestDocument).content;
    expect(content).toContain("101 more rows not ingested");
    expect(content).toContain("| r498 |");
    expect(content).not.toContain("| r499 |");
  });
});

describe("refresh", () => {
  it("skips the export entirely when the stored version matches Drive's modifiedTime", async () => {
    const { gw, ingestDocument, filesExport } = gateway({
      statusImpl: async () => ({
        exists: true,
        sourceModifiedAt: DOC_META.modifiedTime,
      }),
    });

    const result = await refresh(gw, { fileId: "f-123" });

    expect(result.status).toBe("fresh");
    expect(filesExport).not.toHaveBeenCalled();
    expect(ingestDocument).not.toHaveBeenCalled();
  });

  it("re-ingests when Drive's modifiedTime moved past the stored version", async () => {
    const { gw, ingestDocument } = gateway({
      statusImpl: async () => ({
        exists: true,
        sourceModifiedAt: "2026-07-01T00:00:00.000Z",
      }),
    });

    const result = await refresh(gw, { fileId: "f-123" });

    expect(result.status).toBe("refreshed");
    expect(ingestDocument).toHaveBeenCalledWith(
      expect.objectContaining({ sourceModifiedAt: DOC_META.modifiedTime }),
    );
  });

  it("ingests a never-ingested file", async () => {
    const { gw, ingestDocument } = gateway({});

    const result = await refresh(gw, { fileId: "f-123" });

    expect(result.status).toBe("refreshed");
    expect(ingestDocument).toHaveBeenCalled();
  });

  it("routes a spreadsheet through the sheet renderer", async () => {
    const { gw, ingestDocument } = gateway({ meta: SHEET_META });

    const result = await refresh(gw, { fileId: "f-123" });

    expect(result.status).toBe("refreshed");
    const content = firstArg<{ content: string }>(ingestDocument).content;
    expect(content).toContain("## Revenue");
  });
});
