import type { Lif } from "./types";

export interface SerializeOptions {
  /** Spaces of indentation; 0 emits compact JSON. Default: 2. */
  indent?: number;
}

/**
 * Serialize a LIF document to JSON.
 *
 * The document model *is* the JSON object graph, so serialization is plain
 * stringification: unknown/vendor fields survive, and anything the parser
 * normalized (numeric strings, legacy `required` flags) is emitted in
 * normalized form. No defaults are injected.
 */
export function serializeLif(lif: Lif, options: SerializeOptions = {}): string {
  const indent = options.indent ?? 2;
  return JSON.stringify(lif, null, indent > 0 ? indent : undefined);
}
