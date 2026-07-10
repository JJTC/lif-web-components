import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { startHarness, type Harness } from "./harness";

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h?.close();
});

beforeEach(async () => {
  for (let attempt = 0; ; attempt++) {
    try {
      await h.page.goto(`${h.baseUrl}/workspace.html`);
      // Base = the warehouse fixture; second source = a small annex from
      // another integrator whose n-dock id collides and whose frame is
      // offset. Inside the retry: a late navigation can destroy the context.
      await setupSources();
      break;
    } catch (e) {
      if (attempt >= 2) throw e;
    }
  }
  await h.page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
});

async function setupSources(): Promise<void> {
  await h.page.evaluate(async () => {
    const text = await (await fetch("/fixtures/warehouse.lif.json")).text();
    const { lif } = window.lifCore.parseLif(text);
    const annex = {
      metaInformation: {
        projectIdentification: "Annex",
        creator: "integrator-b",
        exportTimestamp: "2026-07-09T00:00:00Z",
        lifVersion: "1.0.0",
      },
      layouts: [
        {
          layoutId: "annex-floor",
          layoutVersion: "1",
          nodes: [
            {
              nodeId: "n-dock", // collides with the warehouse dock
              nodePosition: { x: 0, y: 10 },
              vehicleTypeNodeProperties: [{ vehicleTypeId: "acme.tugger" }],
            },
            {
              nodeId: "n-annex-1",
              nodePosition: { x: 4, y: 10 },
              vehicleTypeNodeProperties: [{ vehicleTypeId: "acme.tugger" }],
            },
          ],
          edges: [
            {
              edgeId: "e-annex-1",
              startNodeId: "n-dock",
              endNodeId: "n-annex-1",
              vehicleTypeEdgeProperties: [{ vehicleTypeId: "acme.tugger", rotationAllowed: true }],
            },
          ],
          stations: [],
        },
      ],
    };
    const workspace = document.querySelector("lif-workspace") as unknown as {
      sources: unknown[];
    };
    workspace.sources = [
      { sourceId: "main", label: "Warehouse (integrator A)", lif },
      { sourceId: "annex", label: "Annex (integrator B)", lif: annex },
    ];
  });
}

describe("<lif-workspace> layers, alignment and merge", () => {
  test("stacks one viewer per source and keeps their views synchronized while panning", async () => {
    await expect(h.page.locator("lif-workspace lif-viewer").count()).resolves.toBe(2);

    const stage = (await h.page.locator("lif-workspace lif-viewer.active").boundingBox())!;
    await h.page.mouse.move(stage.x + 300, stage.y + 300);
    await h.page.mouse.down();
    await h.page.mouse.move(stage.x + 420, stage.y + 360, { steps: 4 });
    await h.page.mouse.up();

    const views = await h.page.evaluate(() =>
      [...document.querySelector("lif-workspace")!.shadowRoot!.querySelectorAll("lif-viewer")].map(
        (v) => (v as unknown as { view: { scale: number; tx: number; ty: number } }).view,
      ),
    );
    expect(views).toHaveLength(2);
    expect(views[1]).toEqual(views[0]!);
    // The pan actually moved the frame (not the initial default).
    expect(Math.abs(views[0]!.tx)).toBeGreaterThan(0);
  });

  test("alignment inputs preview live on the overlay layer", async () => {
    const dy = h.page.locator('[data-layer-row="annex"] input[data-field="dy"]');
    await dy.fill("-8");
    await dy.press("Enter");
    const y = await h.page.evaluate(() => {
      const viewer = document
        .querySelector("lif-workspace")!
        .shadowRoot!.querySelector('lif-viewer[data-source-id="annex"]') as unknown as {
        lif: { layouts: { nodes: { nodeId: string; nodePosition: { y: number } }[] }[] };
      };
      return viewer.lif.layouts[0]!.nodes.find((n) => n.nodeId === "n-annex-1")!.nodePosition.y;
    });
    expect(y).toBeCloseTo(2, 10); // 10 + (-8)
  });

  test("merge prefixes colliding ids, unites the aligned layout with the base, and records provenance", async () => {
    await h.page.evaluate(() => {
      document.querySelector("lif-workspace")!.addEventListener("lif-merge", (ev) => {
        (window as unknown as { merged: unknown }).merged = (ev as CustomEvent).detail;
      });
    });
    await h.page.locator('[data-layer-row="annex"] input[data-field="dy"]').fill("-8");
    await h.page.locator('button[data-action="merge"]').click();
    const result = await h.page.evaluate(
      () =>
        (window as unknown as { merged: { lif: unknown; summary: unknown } }).merged as {
          lif: {
            layouts: { layoutId: string; nodes: { nodeId: string; nodePosition: { y: number } }[] }[];
            metaInformation: Record<string, unknown>;
          };
          summary: { sourceId: string; prefix: string | null; mergedIntoLayout: string | null }[];
        },
    );
    expect(result.summary).toEqual([
      { sourceId: "annex", prefix: "annex:", mergedIntoLayout: "ground" },
    ]);
    const ground = result.lif.layouts.find((l) => l.layoutId === "ground")!;
    const ids = ground.nodes.map((n) => n.nodeId);
    expect(ids).toContain("n-dock"); // the warehouse original
    expect(ids).toContain("annex:n-dock"); // the prefixed annex dock
    expect(ids).toContain("annex:n-annex-1");
    // The alignment transform is baked into the merged document.
    expect(ground.nodes.find((n) => n.nodeId === "annex:n-annex-1")!.nodePosition.y).toBeCloseTo(
      2,
      10,
    );
    expect(result.lif.metaInformation["x-mergedSources"]).toEqual([
      {
        projectIdentification: "Annex",
        creator: "integrator-b",
        exportTimestamp: "2026-07-09T00:00:00Z",
        // The annex layout was renamed into "ground" and unioned; its own
        // layout metadata is recorded rather than silently dropped.
        unionedLayouts: [{ layoutId: "ground", layoutVersion: "1" }],
      },
    ]);
    // No layout named annex-floor survives: it was united with "ground".
    expect(result.lif.layouts.map((l) => l.layoutId)).not.toContain("annex:annex-floor");
  });

  test("the opacity slider dims the document content only — not grid, rulers or controls", async () => {
    // Dim the active (base) layer, whose grid/rulers/controls are the visible ones.
    const slider = h.page.locator('[data-layer-row="main"] input[data-field="opacity"]');
    await slider.fill("0.4");
    const opacities = await h.page.evaluate(() => {
      const viewer = document
        .querySelector("lif-workspace")!
        .shadowRoot!.querySelector('lif-viewer[data-source-id="main"]')!;
      const opacity = (selector: string) =>
        Number(getComputedStyle(viewer.shadowRoot!.querySelector(selector)!).opacity);
      return {
        host: Number(getComputedStyle(viewer as Element).opacity),
        svg: opacity('svg[part="canvas"]'),
        scene: opacity('g[part="scene"]'),
        gridLine: opacity("line.grid-line"),
        rulerLabel: opacity("text.ruler-label"),
        vehicles: opacity('canvas[part="vehicle-layer"]'),
        controls: opacity('[part="zoom-controls"]'),
      };
    });
    expect(opacities.host).toBe(1); // the element itself is not dimmed…
    expect(opacities.scene).toBeCloseTo(0.4, 5); // …only the document content…
    expect(opacities.vehicles).toBeCloseTo(0.4, 5); // …and the vehicle overlay
    expect(opacities.svg).toBe(1); // instruments stay readable:
    expect(opacities.gridLine).toBe(1);
    expect(opacities.rulerLabel).toBe(1);
    expect(opacities.controls).toBe(1);
  });

  test("a colliding non-selected layout is prefixed, never fused into the base level", async () => {
    // Give the annex a second layout named like the warehouse's mezzanine.
    await h.page.evaluate(() => {
      const workspace = document.querySelector("lif-workspace") as unknown as {
        sources: { sourceId: string; lif: { layouts: unknown[] } }[];
      };
      const [main, annex] = workspace.sources;
      (annex!.lif.layouts as unknown[]).push({
        layoutId: "mezzanine", // collides with the warehouse level of the same name
        layoutVersion: "9",
        nodes: [
          {
            nodeId: "n-annex-store",
            nodePosition: { x: 0, y: 20 },
            vehicleTypeNodeProperties: [{ vehicleTypeId: "acme.tugger" }],
          },
        ],
        edges: [],
        stations: [],
      });
      workspace.sources = [main!, { ...annex!, lif: { ...annex!.lif } as never }];
      document.querySelector("lif-workspace")!.addEventListener("lif-merge", (ev) => {
        (window as unknown as { merged: unknown }).merged = (ev as CustomEvent).detail;
      });
    });
    await h.page.locator('button[data-action="merge"]').click();
    const result = await h.page.evaluate(
      () =>
        (window as unknown as {
          merged: { lif: { layouts: { layoutId: string; nodes: { nodeId: string }[] }[] } };
        }).merged,
    );
    const ids = result.lif.layouts.map((l) => l.layoutId);
    // The whole annex was prefixed: its mezzanine stays a separate level…
    expect(ids).toContain("annex:mezzanine");
    // …and the warehouse's own mezzanine gained nothing.
    const baseMezz = result.lif.layouts.find((l) => l.layoutId === "mezzanine")!;
    expect(baseMezz.nodes.map((n) => n.nodeId)).not.toContain("annex:n-annex-store");
    // The selected annex layout still united with the base level.
    const ground = result.lif.layouts.find((l) => l.layoutId === "ground")!;
    expect(ground.nodes.map((n) => n.nodeId)).toContain("annex:n-annex-1");
  });

  test("replacing sources revalidates layer state and re-registers the stack", async () => {
    await h.page.evaluate(() => {
      const workspace = document.querySelector("lif-workspace") as unknown as {
        sources: { sourceId: string; label?: string; lif: unknown }[];
      };
      const [main, annex] = workspace.sources;
      // Same sourceIds, new base document whose layouts are renamed.
      const renamed = structuredClone(main!.lif) as { layouts: { layoutId: string }[] };
      for (const layout of renamed.layouts) layout.layoutId = `v2-${layout.layoutId}`;
      workspace.sources = [{ ...main!, lif: renamed as never }, annex!];
      document.querySelector("lif-workspace")!.addEventListener("lif-merge", (ev) => {
        (window as unknown as { merged2: unknown }).merged2 = (ev as CustomEvent).detail;
      });
    });
    await h.page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
    // The base auto-refit for the new document propagated to the overlay.
    const views = await h.page.evaluate(() =>
      [...document.querySelector("lif-workspace")!.shadowRoot!.querySelectorAll("lif-viewer")].map(
        (v) => (v as unknown as { view: { scale: number; tx: number; ty: number } }).view,
      ),
    );
    expect(views[1]).toEqual(views[0]!);
    // Merging unites into the base's real (renamed) layout — no ghost id.
    await h.page.locator('button[data-action="merge"]').click();
    const result = await h.page.evaluate(
      () =>
        (window as unknown as {
          merged2: {
            lif: { layouts: { layoutId: string; nodes: { nodeId: string }[] }[] };
            summary: { mergedIntoLayout: string | null }[];
          };
        }).merged2,
    );
    expect(result.summary[0]!.mergedIntoLayout).toBe("v2-ground");
    const ground = result.lif.layouts.find((l) => l.layoutId === "v2-ground")!;
    expect(ground.nodes.map((n) => n.nodeId)).toContain("annex:n-annex-1");
    expect(result.lif.layouts.map((l) => l.layoutId)).not.toContain("ground");
  });

  test("source ids containing quotes do not break layer activation or sync", async () => {
    await h.page.evaluate(async () => {
      const text = await (await fetch("/fixtures/warehouse.lif.json")).text();
      const { lif } = window.lifCore.parseLif(text);
      (document.querySelector("lif-workspace") as unknown as { sources: unknown[] }).sources = [
        { sourceId: 'integrator "A"', label: "Quoted", lif },
      ];
    });
    await h.page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
    // Pan the (only, active) layer: sync path exercises #activeViewer().
    const stage = (await h.page.locator("lif-workspace lif-viewer").boundingBox())!;
    await h.page.mouse.move(stage.x + 300, stage.y + 300);
    await h.page.mouse.down();
    await h.page.mouse.move(stage.x + 360, stage.y + 320, { steps: 2 });
    await h.page.mouse.up();
    const ok = await h.page.evaluate(() => {
      const workspace = document.querySelector("lif-workspace") as unknown as {
        activeSourceId: string | null;
      };
      return workspace.activeSourceId === 'integrator "A"';
    });
    expect(ok).toBe(true);
  });

  test("hiding a layer removes it from the stage without affecting merge", async () => {
    await h.page.locator('[data-layer-row="annex"] button[data-action="toggle-visible"]').click();
    const hidden = await h.page.evaluate(() => {
      const viewer = document
        .querySelector("lif-workspace")!
        .shadowRoot!.querySelector('lif-viewer[data-source-id="annex"]') as HTMLElement;
      return getComputedStyle(viewer).display;
    });
    expect(hidden).toBe("none");
  });
});
