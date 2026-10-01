import type { PipelineDeps } from "./deps.ts";
import { enrich } from "./enrich.ts";
import { extract } from "./extract.ts";
import { fetchSource } from "./fetch-source.ts";
import { messageSchemas, type QueueName } from "./messages.ts";

/** Validates a queue message and runs the step it belongs to. */
export async function dispatch(deps: PipelineDeps, queue: QueueName, body: unknown) {
  switch (queue) {
    case "fetch-source":
      return fetchSource(deps, messageSchemas["fetch-source"].parse(body));
    case "extract":
      return extract(deps, messageSchemas.extract.parse(body));
    case "enrich":
      return enrich(deps, messageSchemas.enrich.parse(body));
  }
}
