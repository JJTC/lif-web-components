/**
 * Browser-test harness: bundles the components with Bun.build,
 * serves pages and fixtures with a real Bun.serve HTTP server, and drives a
 * real system Chromium through playwright-core (as a library — no mocked DOM).
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

const ROOT = join(import.meta.dir, "../..");

function chromiumBinary(): string {
  const candidates = [
    process.env.CHROMIUM_BIN,
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
  ].filter((p): p is string => !!p);
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    `No Chromium binary found (tried ${candidates.join(", ")}). ` +
      "Run inside the lif-dev toolbox (see toolbox/Containerfile) or set CHROMIUM_BIN.",
  );
}

async function bundleApp(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "pages/app.ts")],
    target: "browser",
    format: "esm",
    sourcemap: "inline",
  });
  if (!result.success) {
    throw new Error(`test bundle failed: ${result.logs.map(String).join("\n")}`);
  }
  return result.outputs[0]!.text();
}

function page(title: string, body: string): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
     <style>html,body{margin:0}</style></head>
     <body>${body}<script type="module" src="/app.js"></script></body></html>`,
    { headers: { "content-type": "text/html" } },
  );
}

export interface Harness {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  baseUrl: string;
  close(): Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  const appJs = await bundleApp();

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/viewer.html") {
        return page("viewer", `<lif-viewer id="v" style="display:block;width:800px;height:600px"></lif-viewer>`);
      }
      if (pathname === "/editor.html") {
        return page("editor", `<lif-editor id="e" style="width:1000px;height:700px"></lif-editor>`);
      }
      if (pathname === "/workspace.html") {
        return page(
          "workspace",
          `<lif-workspace id="w" style="width:1100px;height:640px"></lif-workspace>`,
        );
      }
      if (pathname === "/fleet.html") {
        return page(
          "fleet",
          `<div style="display:flex;gap:8px;width:1100px;height:600px">
             <lif-viewer id="v" style="flex:1"></lif-viewer>
             <lif-fleet-panel id="fp" style="width:280px"></lif-fleet-panel>
           </div>`,
        );
      }
      if (pathname === "/app.js") {
        return new Response(appJs, { headers: { "content-type": "text/javascript" } });
      }
      if (pathname === "/favicon.ico") {
        return new Response(null, { status: 204 });
      }
      if (pathname.startsWith("/fixtures/")) {
        const file = Bun.file(join(ROOT, "fixtures", pathname.slice("/fixtures/".length)));
        if (await file.exists()) return new Response(file);
      }
      return new Response("not found", { status: 404 });
    },
  });

  const browser = await chromium.launch({
    executablePath: chromiumBinary(),
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const pageObj = await context.newPage();
  pageObj.on("pageerror", (err) => console.error("[pageerror]", err.message));
  pageObj.on("console", (msg) => {
    if (msg.type() === "error") console.error("[console.error]", msg.text());
  });

  return {
    browser,
    context,
    page: pageObj,
    baseUrl: `http://localhost:${server.port}`,
    async close() {
      await browser.close();
      await server.stop(true);
    },
  };
}
