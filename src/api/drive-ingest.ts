/**
 * Drive → knowledge-base ingestion. One gateway method:
 *
 *   ingestDoc — export a Google Doc's content and land it in the
 *               assistant's searchable document store, with provenance
 *               (`drive://<fileId>`) and the Drive `modifiedTime` as the
 *               freshness anchor.
 *
 * The pack owns ALL Drive connectivity (files.get + files.export); the
 * assistant side is the source-neutral `ingest_document` tool, reached
 * here as `ctx.ingest.document(...)`. Re-running for the same file
 * REPLACES the stored version — this method is also the refresh path
 * when the Doc has changed.
 *
 * Google Docs only for now: other Drive types (Sheets, PDFs, uploads)
 * need different export/extraction handling and come later.
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
  };
}

type Ctx = GatewayContext & IngestSurface;

const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";

export interface IngestDocResult {
  uri: string;
  title: string;
  sourceModifiedAt?: string;
}

/**
 * Ingest a Google Doc from the user's Drive into their searchable
 * knowledge base, so its content can answer questions via document
 * search. Use when the user wants to ask about, search, or remember a
 * Drive document. Re-run for the same fileId after the Doc changes —
 * ingestion replaces the stored version (the stored `sourceModifiedAt`
 * tells you which version is held). Google Docs only; find the fileId
 * via `drive.filesList` if you only have a name.
 */
export async function ingestDoc(
  ctx: Ctx,
  args: { fileId: string },
): Promise<IngestDocResult> {
  const meta: Drive_File = await ctx.drive.filesGet({
    fileId: args.fileId,
    fields: "id,name,mimeType,modifiedTime,ownedByMe,owners(emailAddress)",
  });
  if (meta.mimeType !== GOOGLE_DOC_MIME) {
    throw new Error(
      `Only Google Docs can be ingested for now — '${meta.name ?? args.fileId}' is ${meta.mimeType ?? "of unknown type"}.`,
    );
  }
  const content = await exportText(ctx, args.fileId);
  const uri = `drive://${meta.id ?? args.fileId}`;
  await ctx.ingest.document({
    content,
    uri,
    title: meta.name ?? args.fileId,
    sourceKind: "drive",
    sourceModifiedAt: meta.modifiedTime,
    // A doc someone shared with the user is OWNED by them, not the user.
    ownerEmail: meta.ownedByMe === false ? meta.owners?.[0]?.emailAddress : undefined,
  });
  return {
    uri,
    title: meta.name ?? args.fileId,
    sourceModifiedAt: meta.modifiedTime,
  };
}

/**
 * Export the Doc as markdown (keeps headings/structure for better
 * chunking); fall back to plain text for older Docs/tenants where the
 * markdown export MIME isn't available.
 */
async function exportText(ctx: Ctx, fileId: string): Promise<string> {
  try {
    return asText(await ctx.drive.filesExport({ fileId, mimeType: "text/markdown" }));
  } catch {
    return asText(await ctx.drive.filesExport({ fileId, mimeType: "text/plain" }));
  }
}

function asText(exported: unknown): string {
  if (typeof exported === "string") return exported;
  // The gateway normalizes most responses to JSON; a non-string export
  // body (rare) is still ingestable as its JSON rendering.
  return JSON.stringify(exported);
}
