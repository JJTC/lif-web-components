import { join } from "node:path";
import type { Diagnostic } from "../../src/lif";

export function fixturePath(name: string): string {
  return join(import.meta.dir, "../../fixtures", name);
}

export async function loadFixture(name: string): Promise<string> {
  return Bun.file(fixturePath(name)).text();
}

export function codes(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.map((d) => d.code);
}

export function byCode(diagnostics: readonly Diagnostic[], code: string): Diagnostic[] {
  return diagnostics.filter((d) => d.code === code);
}
