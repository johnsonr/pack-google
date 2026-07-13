/**
 * Drive → knowledge-base ingestion (pack side of the assistant's
 * EXTERNAL_DOCUMENTS spec). Three gateway methods:
 *
 *   ingestDoc   — export a Google Doc and land it in the searchable store
 *   ingestSheet — render a Google Sheet as markdown (one section + table
 *                 per tab) and land it likewise
 *   refresh     — re-ingest ONLY if Drive's modifiedTime has moved past the
 *                 stored version (ingest.status ⇄ files.get comparison)
 *
 * The pack owns ALL Drive/Sheets connectivity; the assistant side is the
 * source-neutral `ctx.ingest.*` surface. Provenance uri is
 * `drive://<fileId>` and Drive `modifiedTime` is the freshness anchor —
 * re-ingesting the same file REPLACES the stored version.
 */
import type { Drive_File, GatewayContext } from "../../.embabel/gateway";

/**
 * The assistant's source-neutral ingest surface. Declared structurally
 * because the pack's generated gateway types are synced from its OWN
 * apis.yml and don't include assistant built-ins.
 */
interface IngestSurface {
  ingest: {
    document(args: {
      content: string;
      uri: string;
      title: string;
      sourceKind: string;
      sourceModifiedAt?: string;
      ownerEmail?: string;
      publishedByDomain?: string;
    }): Promise<unknown>;
    status(args: { uri: string }): Promise<{
      exists: boolean;
      title?: string;
      sourceModifiedAt?: string;
      ingestedAt?: string;
    }>;
  };
}

type Ctx = GatewayContext & IngestSurface;

const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";
const GOOGLE_SHEET_MIME = "application/vnd.google-apps.spreadsheet";
/** Rows rendered per tab. Never truncated silently — see renderTab. */
const MAX_ROWS_PER_TAB = 500;

export interface IngestResult {
  uri: string;
  title: string;
  sourceModifiedAt?: string;
}

export interface RefreshResult extends IngestResult {
  /** 'refreshed' when a new version was ingested; 'fresh' when the stored version is current. */
  status: "refreshed" | "fresh";
}

/**
 * Ingest a Google Doc from the user's Drive into their searchable
 * knowledge base, so its content can answer questions via document
 * search. Use when the user wants to ask about, search, or remember a
 * Drive document. Re-run for the same fileId after the Doc changes —
 * ingestion replaces the stored version (or call `refresh`, which
 * checks first). Google Docs only; for spreadsheets use `ingestSheet`;
 * find the fileId via `drive.filesList` if you only have a name.
 */
export async function ingestDoc(
  ctx: Ctx,
  args: { fileId: string },
): Promise<IngestResult> {
  const meta = await fileMeta(ctx, args.fileId);
  if (meta.mimeType !== GOOGLE_DOC_MIME) {
    throw new Error(
      `Only Google Docs can be ingested here — '${meta.name ?? args.fileId}' is ${meta.mimeType ?? "of unknown type"}. For spreadsheets use ingestSheet.`,
    );
  }
  return land(ctx, meta, args.fileId, await exportDocText(ctx, args.fileId));
}

/**
 * Ingest a Google Sheet from the user's Drive into their searchable
 * knowledge base as markdown — one section per tab with the tab's data
 * as a table — so its content can answer questions via document search.
 * Best for reasonably stable reference sheets; for live operational
 * data prefer reading cells directly with the sheets values methods.
 * Re-run after the sheet changes (or call `refresh`).
 */
export async function ingestSheet(
  ctx: Ctx,
  args: { fileId: string },
): Promise<IngestResult> {
  const meta = await fileMeta(ctx, args.fileId);
  if (meta.mimeType !== GOOGLE_SHEET_MIME) {
    throw new Error(
      `Only Google Sheets can be ingested here — '${meta.name ?? args.fileId}' is ${meta.mimeType ?? "of unknown type"}. For documents use ingestDoc.`,
    );
  }
  return land(ctx, meta, args.fileId, await renderSheetMarkdown(ctx, args.fileId, meta.name ?? args.fileId));
}

/**
 * Re-ingest a Drive file ONLY if it changed since it was last ingested:
 * compares Drive's modifiedTime against the stored version and skips the
 * export entirely when they match. Use this (not ingestDoc/ingestSheet)
 * when you don't know whether the file moved — e.g. before answering
 * from a previously ingested document, or from a scheduled poll.
 * Returns status 'fresh' or 'refreshed'.
 */
export async function refresh(
  ctx: Ctx,
  args: { fileId: string },
): Promise<RefreshResult> {
  const meta = await fileMeta(ctx, args.fileId);
  const uri = `drive://${meta.id ?? args.fileId}`;
  const stored = await ctx.ingest.status({ uri });
  if (stored.exists && stored.sourceModifiedAt === meta.modifiedTime) {
    return {
      status: "fresh",
      uri,
      title: meta.name ?? args.fileId,
      sourceModifiedAt: meta.modifiedTime,
    };
  }
  const result =
    meta.mimeType === GOOGLE_SHEET_MIME
      ? await ingestSheet(ctx, args)
      : await ingestDoc(ctx, args);
  return { status: "refreshed", ...result };
}

// --- Shared plumbing --------------------------------------------------

async function fileMeta(ctx: Ctx, fileId: string): Promise<Drive_File> {
  return ctx.drive.filesGet({
    fileId,
    fields: "id,name,mimeType,modifiedTime,ownedByMe,owners(emailAddress)",
  });
}

/** Hand the exported content to the assistant's source-neutral ingest seam. */
async function land(
  ctx: Ctx,
  meta: Drive_File,
  fileId: string,
  content: string,
): Promise<IngestResult> {
  const uri = `drive://${meta.id ?? fileId}`;
  await ctx.ingest.document({
    content,
    uri,
    title: meta.name ?? fileId,
    sourceKind: "drive",
    sourceModifiedAt: meta.modifiedTime,
    // A doc someone shared with the user is OWNED by them, not the user.
    ownerEmail: meta.ownedByMe === false ? meta.owners?.[0]?.emailAddress : undefined,
  });
  return { uri, title: meta.name ?? fileId, sourceModifiedAt: meta.modifiedTime };
}

/**
 * Export the Doc as markdown (keeps headings/structure for better
 * chunking); fall back to plain text for older Docs/tenants where the
 * markdown export MIME isn't available.
 */
async function exportDocText(ctx: Ctx, fileId: string): Promise<string> {
  try {
    return asText(await ctx.drive.filesExport({ fileId, mimeType: "text/markdown" }));
  } catch {
    return asText(await ctx.drive.filesExport({ fileId, mimeType: "text/plain" }));
  }
}

/**
 * Render the whole spreadsheet as markdown: `# <sheet>` then one
 * `## <tab>` section per tab with its values as a pipe table — headings
 * drive the chunker, so each tab becomes its own searchable section.
 * (Drive's own CSV export covers only the FIRST tab, hence the Sheets
 * values API here.)
 */
async function renderSheetMarkdown(ctx: Ctx, fileId: string, title: string): Promise<string> {
  const spreadsheet = await ctx.sheets.spreadsheetsGet({
    spreadsheetId: fileId,
    fields: "sheets(properties(title,hidden))",
  });
  const tabs = (spreadsheet.sheets ?? [])
    .map((s) => s.properties)
    .filter((p): p is NonNullable<typeof p> => !!p?.title && !p.hidden)
    .map((p) => p.title as string);
  if (tabs.length === 0) throw new Error(`Spreadsheet '${title}' has no visible tabs to ingest.`);

  const batch = await ctx.sheets.spreadsheetsValuesBatchGet({
    spreadsheetId: fileId,
    ranges: tabs.map((t) => `'${t.replace(/'/g, "''")}'`),
    valueRenderOption: "FORMATTED_VALUE",
  });
  const sections = tabs.map((tab, i) =>
    renderTab(tab, (batch.valueRanges?.[i]?.values ?? []) as unknown[][]),
  );
  return [`# ${title}`, ...sections].join("\n\n");
}

function renderTab(tab: string, rows: unknown[][]): string {
  if (rows.length === 0) return `## ${tab}\n\n(empty tab)`;
  const shown = rows.slice(0, MAX_ROWS_PER_TAB);
  const width = Math.max(...shown.map((r) => r.length));
  const cell = (v: unknown) =>
    String(v ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  const line = (r: unknown[]) =>
    `| ${Array.from({ length: width }, (_, c) => cell(r[c])).join(" | ")} |`;
  const lines = [
    `## ${tab}`,
    "",
    line(shown[0] ?? []),
    `|${" --- |".repeat(width)}`,
    ...shown.slice(1).map(line),
  ];
  if (rows.length > shown.length) {
    // Spec rule: no silent caps — the document itself says what was dropped.
    lines.push("", `(${rows.length - shown.length} more rows not ingested — read the live sheet for full data)`);
  }
  return lines.join("\n");
}

function asText(exported: unknown): string {
  if (typeof exported === "string") return exported;
  // The gateway normalizes most responses to JSON; a non-string export
  // body (rare) is still ingestable as its JSON rendering.
  return JSON.stringify(exported);
}
