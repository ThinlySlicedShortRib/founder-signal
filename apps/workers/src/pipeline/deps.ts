import type { AuthorEnricher, DiscoveryQueryGenerator, LetterWriter, WebSearcher } from "@fs/ai";
import type { Db } from "@fs/db";
import type { Fetcher, TranscriptProvider, YouTubeClient } from "@fs/ingest";
import type { ContentStore } from "../lib/content-store.ts";
import type { Queues } from "../lib/queues.ts";
import type { ImageStore } from "../letters/image-store.ts";
import type { StockPhotos } from "../letters/images.ts";
import type { Enricher } from "./enrich.ts";

/** Open web discovery's model calls (build plan §6.3a). */
export interface Discovery {
  queries: DiscoveryQueryGenerator;
  search: WebSearcher;
}

/** Everything the pipeline steps touch, injected so tests and the local runner can swap them. */
export interface PipelineDeps {
  db: Db;
  queues: Queues;
  store: ContentStore;
  fetch: Fetcher;
  youtube: YouTubeClient | null;
  transcripts: TranscriptProvider | null;
  /** Null disables enrichment (items stay `extracted`). */
  enricher: Enricher | null;
  /** Writes letter copy. Falls back to copy from excerpts when it fails. */
  letterWriter: LetterWriter;
  /** Null skips author cards' details (a card is then just the name). */
  authorEnricher: AuthorEnricher | null;
  /** Null: pieces without a lead image get no picture. */
  stockPhotos: StockPhotos | null;
  /** Copies article images to our bucket. Null: letters hotlink the publisher's image. */
  images: ImageStore | null;
  /** Searches the open web for pieces before each letter. Null: letters only draw from followed sources. */
  discovery: Discovery | null;
  /** Minimum gap between requests to one host; defaults to PER_HOST_INTERVAL_MS. */
  politenessMs?: number;
  now?: () => Date;
  /** For feedback codes; injectable for tests. */
  random?: () => number;
  log?: (event: string, data?: Record<string, unknown>) => void;
}

export function logger(deps: PipelineDeps) {
  return deps.log ?? ((event, data) => console.log(JSON.stringify({ level: "info", event, ...data })));
}
