/**
 * Watcher-free demo server: `bun serve.ts` (package script: `bun run dev`).
 *
 * Rebuilds the demo bundle on each page load instead of watching files, so it
 * works where Bun's HMR dev server cannot create an inotify instance (e.g.
 * toolbox containers on desktops that exhaust fs.inotify.max_user_instances).
 * Use `bun run dev:hmr` for the watching variant when the host allows it.
 */

import { join } from "node:path";

const ROOT = import.meta.dir;
const port = Number(process.env.PORT || 4173);

async function buildDemoJs(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [join(ROOT, "demo/demo.ts")],
    target: "browser",
    format: "esm",
    sourcemap: "inline",
  });
  if (!result.success) {
    throw new Error(result.logs.map(String).join("\n"));
  }
  return result.outputs[0]!.text();
}

const server = Bun.serve({
  port,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/" || pathname === "/index.html") {
      const html = await Bun.file(join(ROOT, "demo/index.html")).text();
      return new Response(html.replace("./demo.ts", "/demo.js"), {
        headers: { "content-type": "text/html" },
      });
    }
    if (pathname === "/demo.js") {
      try {
        return new Response(await buildDemoJs(), {
          headers: { "content-type": "text/javascript" },
        });
      } catch (e) {
        console.error(e);
        return new Response(`// build failed:\n// ${(e as Error).message}`, {
          status: 500,
          headers: { "content-type": "text/javascript" },
        });
      }
    }
    if (pathname === "/favicon.ico") return new Response(null, { status: 204 });
    return new Response("not found", { status: 404 });
  },
});

console.log(`demo running at http://localhost:${server.port}/ (rebuild on refresh, no HMR)`);
