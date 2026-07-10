export type DiagnosticSeverity = "error" | "warning" | "info";

export interface Diagnostic {
  severity: DiagnosticSeverity;
  /** Stable identifier, e.g. "LIF-P002" (parser) or "LIF-V005" (validator). */
  code: string;
  /** JSON path into the document, e.g. "layouts[0].edges[3].endNodeId". */
  path: string;
  message: string;
}

export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === "error");
}

/** Collects diagnostics while tracking the current JSON path. */
export class DiagnosticCollector {
  readonly diagnostics: Diagnostic[] = [];
  private readonly stack: string[] = [];

  path(): string {
    // Segments carry leading dots ("​.layouts[0]"); strip the root one.
    return this.stack.join("").replace(/^\./, "");
  }

  in<T>(segment: string, fn: () => T): T {
    this.stack.push(segment);
    try {
      return fn();
    } finally {
      this.stack.pop();
    }
  }

  add(severity: DiagnosticSeverity, code: string, message: string, pathSuffix = ""): void {
    this.diagnostics.push({ severity, code, path: this.path() + pathSuffix, message });
  }

  error(code: string, message: string, pathSuffix = ""): void {
    this.add("error", code, message, pathSuffix);
  }

  warning(code: string, message: string, pathSuffix = ""): void {
    this.add("warning", code, message, pathSuffix);
  }

  info(code: string, message: string, pathSuffix = ""): void {
    this.add("info", code, message, pathSuffix);
  }
}
