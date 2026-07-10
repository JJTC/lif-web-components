/**
 * Build the distributable ESM bundles + type declarations with Bun (ADR 0002).
 * Usage: bun run build.ts   (the `build` npm script also runs `tsc` for .d.ts)
 *
 * Four entry points mirror the package's exports map:
 *   dist/index.js   — components + core (imports "lit", kept external so
 *                     consumers dedupe a single Lit copy)
 *   dist/lif.js     — the dependency-free core alone
 *   dist/vda5050.js — dependency-free VDA 5050 runtime-message mappers
 *   dist/mc.js      — master-control components (Lit external, ADR 0013)
 */

async function bundle(entry: string, outname: string, external: string[]): Promise<void> {
  const result = await Bun.build({
    entrypoints: [entry],
    outdir: "dist",
    target: "browser",
    format: "esm",
    minify: false,
    sourcemap: "linked",
    external,
    naming: `${outname}.[ext]`,
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  for (const artifact of result.outputs) {
    console.log(`built ${artifact.path} (${(artifact.size / 1024).toFixed(1)} kB)`);
  }
}

await bundle("src/index.ts", "index", ["lit", "lit/*"]);
await bundle("src/lif/index.ts", "lif", []);
await bundle("src/vda5050/index.ts", "vda5050", []);
await bundle("src/mc/index.ts", "mc", ["lit", "lit/*"]);
