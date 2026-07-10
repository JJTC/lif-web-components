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
  // Retry once: a goto can occasionally race the previous test's teardown.
  for (let attempt = 0; ; attempt++) {
    try {
      await h.page.goto(`${h.baseUrl}/viewer.html`);
      await h.page.evaluate(() => window.loadFixtureIntoViewer("warehouse.lif.json", "#v"));
      break;
    } catch (e) {
      if (attempt >= 2) throw e;
    }
  }
});

describe("<lif-viewer> rendering", () => {
  test("renders the ground layout: 6 nodes, 8 edges, 2 stations", async () => {
    await expect(h.page.locator("#v circle.node-dot").count()).resolves.toBe(6);
    await expect(h.page.locator("#v path.edge-hit").count()).resolves.toBe(8);
    await expect(h.page.locator("#v rect.station-box").count()).resolves.toBe(2);
  });

  test("scene marks carry ARIA roles and labels for screen readers", async () => {
    await expect(
      h.page.locator('#v circle[data-node-id="n-dock"]').getAttribute("aria-label"),
    ).resolves.toBe("Node n-dock, Dock");
    await expect(
      h.page.locator('#v path[data-edge-id="e-west-east"]').getAttribute("aria-label"),
    ).resolves.toContain("n-aisle-w to n-aisle-e");
    await expect(
      h.page.locator('#v rect[data-station-id="st-pick"]').getAttribute("aria-label"),
    ).resolves.toContain("Station st-pick");
    await expect(
      h.page.locator("#v svg[part='canvas']").getAttribute("aria-label"),
    ).resolves.toContain("LIF layout");
  });

  test("renders y-up: the pick node (y=6) appears above the dock node (y=0)", async () => {
    const pick = await h.page.locator('#v circle[data-node-id="n-pick"]').boundingBox();
    const dock = await h.page.locator('#v circle[data-node-id="n-dock"]').boundingBox();
    expect(pick).not.toBeNull();
    expect(dock).not.toBeNull();
    expect(pick!.y).toBeLessThan(dock!.y);
    // Same x in the world (dock 0, pick 4) → pick is to the right of dock.
    expect(pick!.x).toBeGreaterThan(dock!.x);
  });

  test("the NURBS trajectory edge renders as a sampled curve, not a straight line", async () => {
    const d = await h.page
      .locator('#v path.edge-hit[data-edge-id="e-east-lift-arc"]')
      .getAttribute("d");
    expect(d).not.toBeNull();
    // 49 sample points → 48 line segments.
    expect(d!.split("L").length).toBeGreaterThan(40);
    // Both arc endpoints sit at world x=12; the curve bulges toward +x
    // (screen-pixel coordinates), well beyond the endpoints' x.
    const xs = d!
      .replaceAll("M", "")
      .split("L")
      .map((seg) => Number(seg.trim().split(/\s+/)[0]));
    expect(Math.abs(xs[0]! - xs[xs.length - 1]!)).toBeLessThan(1);
    expect(Math.max(...xs)).toBeGreaterThan(xs[0]! + 20);
  });

  test("deep zoom: markers keep their pixel size and the scale limit allows mm-level inspection", async () => {
    await h.page.locator('#v svg[part="canvas"]').hover({ position: { x: 400, y: 300 } });
    for (let i = 0; i < 8; i++) {
      await h.page.mouse.wheel(0, -600);
    }
    const scale = await h.page.evaluate(() => {
      const v = document.querySelector("lif-viewer") as unknown as {
        view: { scale: number };
      };
      return v.view.scale;
    });
    // Far beyond the old 2000 px/m ceiling that made deep inspection impossible.
    expect(scale).toBeGreaterThan(10000);
    // Screen-space rendering: markers are plain pixel sizes at any zoom.
    await expect(
      h.page.locator("#v circle.node-dot").first().getAttribute("r"),
    ).resolves.toBe("6");
  });

  test("clicking a node emits lif-select and selection renders when applied", async () => {
    await h.page.evaluate(() => {
      const viewer = document.querySelector("lif-viewer")!;
      viewer.addEventListener("lif-select", (ev) => {
        const detail = (ev as CustomEvent<{ kind: string | null; id: string | null }>).detail;
        (window as unknown as Record<string, unknown>).lastSelect = detail;
        (viewer as unknown as { selectedId: string | null }).selectedId = detail.id;
      });
    });
    await h.page.locator('#v circle[data-node-id="n-charge"]').click();
    const detail = await h.page.evaluate(
      () => (window as unknown as Record<string, unknown>).lastSelect,
    );
    expect(detail).toEqual({ kind: "node", id: "n-charge" });
    await expect(
      h.page.locator('#v circle[data-node-id="n-charge"].selected').count(),
    ).resolves.toBe(1);

    // Clicking empty canvas deselects (position chosen to avoid the tabs overlay).
    await h.page.locator('#v svg[part="canvas"]').click({ position: { x: 700, y: 80 } });
    const cleared = await h.page.evaluate(
      () => (window as unknown as Record<string, unknown>).lastSelect,
    );
    expect(cleared).toEqual({ kind: null, id: null });
  });

  test("layout tabs switch between layouts", async () => {
    await expect(h.page.locator("#v .tabs button").count()).resolves.toBe(2);
    await h.page.locator("#v .tabs button", { hasText: "Mezzanine" }).click();
    await expect(h.page.locator("#v circle.node-dot").count()).resolves.toBe(3);
    await expect(h.page.locator("#v rect.station-box").count()).resolves.toBe(1);
    // The two-node station draws a dashed link to each interaction node.
    await expect(h.page.locator("#v path.station-link").count()).resolves.toBe(2);
  });

  test("wheel zoom and drag pan change the view transform", async () => {
    const before = await h.page.evaluate(() => {
      const v = document.querySelector("lif-viewer") as unknown as {
        view: { scale: number; tx: number; ty: number };
      };
      return v.view;
    });
    await h.page.locator('#v svg[part="canvas"]').hover({ position: { x: 400, y: 300 } });
    await h.page.mouse.wheel(0, -480);
    const zoomed = await h.page.evaluate(() => {
      const v = document.querySelector("lif-viewer") as unknown as {
        view: { scale: number; tx: number; ty: number };
      };
      return v.view;
    });
    expect(zoomed.scale).toBeGreaterThan(before.scale);

    await h.page.mouse.move(400, 300);
    await h.page.mouse.down();
    await h.page.mouse.move(480, 260, { steps: 5 });
    await h.page.mouse.up();
    const panned = await h.page.evaluate(() => {
      const v = document.querySelector("lif-viewer") as unknown as {
        view: { scale: number; tx: number; ty: number };
      };
      return v.view;
    });
    expect(panned.tx - zoomed.tx).toBeCloseTo(80, 0);
    expect(panned.ty - zoomed.ty).toBeCloseTo(-40, 0);
  });

  test("live vehicles render on the canvas layer, filtered by the active layout via mapId/layoutId", async () => {
    const drawnIds = async (): Promise<string[]> => {
      // Wait one frame so the coalesced canvas draw has happened.
      await h.page.evaluate(
        () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
      );
      return h.page.evaluate(() =>
        (document.querySelector("lif-viewer") as unknown as {
          getRenderedVehicles(): { vehicleId: string }[];
        })
          .getRenderedVehicles()
          .map((v) => v.vehicleId)
          .sort(),
      );
    };
    await h.page.evaluate(() => {
      const v = document.querySelector("lif-viewer") as unknown as {
        vehicleTransitionMs: number;
        vehicles: unknown[];
      };
      v.vehicleTransitionMs = 0;
      v.vehicles = [
        { vehicleId: "agv-1", x: 0, y: 0, theta: 0, mapId: "map-ground" },
        { vehicleId: "agv-2", x: 12, y: 6, theta: 1.5707963267948966, mapId: "map-mezzanine" },
        // No map/layout: eligible everywhere. Placed inside both layouts'
        // fitted viewports, since off-screen vehicles are culled.
        { vehicleId: "agv-3", x: 10, y: 6 },
      ];
    });
    expect(await drawnIds()).toEqual(["agv-1", "agv-3"]);

    await h.page.locator("#v .tabs button", { hasText: "Mezzanine" }).click();
    expect(await drawnIds()).toEqual(["agv-2", "agv-3"]);

    await h.page.evaluate(() => {
      (document.querySelector("lif-viewer") as unknown as { vehicles: unknown[] }).vehicles = [];
    });
    expect(await drawnIds()).toEqual([]);
    // The canvas exposes a fleet summary for assistive tech.
    await expect(
      h.page.locator("#v canvas.vehicle-layer").getAttribute("aria-label"),
    ).resolves.toBe("no vehicles");
  });

  test("a vehicle marker sits at its reported world position and shows its heading", async () => {
    await h.page.evaluate(() => {
      const v = document.querySelector("lif-viewer") as unknown as {
        vehicleTransitionMs: number;
        vehicles: unknown[];
      };
      v.vehicleTransitionMs = 0;
      v.vehicles = [{ vehicleId: "agv-1", x: 4, y: 0, theta: Math.PI / 2 }];
    });
    await h.page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
    const marker = await h.page.evaluate(
      () =>
        (document.querySelector("lif-viewer") as unknown as {
          getRenderedVehicles(): { x: number; y: number; rotationDeg: number; lod: string }[];
        }).getRenderedVehicles()[0]!,
    );
    const viewerBox = (await h.page.locator("#v").boundingBox())!;
    const node = (await h.page.locator('#v circle[data-node-id="n-aisle-w"]').boundingBox())!;
    expect(Math.abs(viewerBox.x + marker.x - (node.x + node.width / 2))).toBeLessThanOrEqual(1.5);
    expect(Math.abs(viewerBox.y + marker.y - (node.y + node.height / 2))).toBeLessThanOrEqual(1.5);
    // World θ = +π/2 (CCW) becomes −90° on the y-down screen.
    expect(marker.rotationDeg).toBeCloseTo(-90, 5);
    expect(marker.lod).toBe("full");
  });

  test("vehicle canvas applies LOD at overview zoom and culls off-screen vehicles", async () => {
    await h.page.evaluate(() => {
      const v = document.querySelector("lif-viewer") as unknown as {
        vehicleTransitionMs: number;
        vehicles: unknown[];
        view: { scale: number; tx: number; ty: number };
      };
      v.vehicleTransitionMs = 0;
      v.vehicles = [
        { vehicleId: "near", x: 4, y: 0, theta: 0 },
        { vehicleId: "far-away", x: 5000, y: 5000, theta: 0 }, // far outside any viewport
      ];
    });
    const rendered = async () => {
      await h.page.evaluate(
        () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
      );
      return h.page.evaluate(() =>
        (document.querySelector("lif-viewer") as unknown as {
          getRenderedVehicles(): { vehicleId: string; lod: string }[];
        }).getRenderedVehicles(),
      );
    };
    // Fitted zoom: full markers; the distant vehicle is culled.
    let list = await rendered();
    expect(list.map((v) => v.vehicleId)).toEqual(["near"]);
    expect(list[0]!.lod).toBe("full");

    // Zoom far out: below the label threshold vehicles become dots.
    await h.page.evaluate(() => {
      const v = document.querySelector("lif-viewer") as unknown as {
        view: { scale: number; tx: number; ty: number };
      };
      v.view = { scale: 10, tx: 400, ty: 300 };
    });
    list = await rendered();
    expect(list.find((v) => v.vehicleId === "near")!.lod).toBe("dot");
  });

  test("pan rides a scene transform mid-gesture and re-projects crisp at rest", async () => {
    const sceneTransform = () =>
      h.page.evaluate(() => {
        const scene = document.querySelector("lif-viewer")!.shadowRoot!.querySelector("g.scene")!;
        return scene.getAttribute("style") ?? "";
      });
    expect(await sceneTransform()).toBe(""); // at rest after the initial fit

    const dockBefore = (await h.page.locator('#v circle[data-node-id="n-dock"]').boundingBox())!;
    await h.page.mouse.move(400, 300);
    await h.page.mouse.down();
    await h.page.mouse.move(470, 340, { steps: 3 });
    // Mid-gesture: the delta lives in one style transform, not re-projection.
    expect(await sceneTransform()).toContain("transform");
    await h.page.mouse.up();
    expect(await sceneTransform()).toBe(""); // re-projected at rest

    // And the pan is baked in exactly: the node moved by the drag delta.
    const dockAfter = (await h.page.locator('#v circle[data-node-id="n-dock"]').boundingBox())!;
    expect(dockAfter.x - dockBefore.x).toBeCloseTo(70, 0);
    expect(dockAfter.y - dockBefore.y).toBeCloseTo(40, 0);
  });

  test("Shift+drag emits a lif-marquee world rectangle", async () => {
    await h.page.evaluate(() => {
      document.querySelector("lif-viewer")!.addEventListener("lif-marquee", (ev) => {
        (window as unknown as { marquee: unknown }).marquee = (ev as CustomEvent).detail;
      });
    });
    // Fitted view: compute expected world coords from the live transform.
    const expected = await h.page.evaluate(() => {
      const v = (document.querySelector("lif-viewer") as unknown as {
        view: { scale: number; tx: number; ty: number };
      }).view;
      const world = (px: number, py: number) => ({
        x: (px - v.tx) / v.scale,
        y: -(py - v.ty) / v.scale,
      });
      return { a: world(200, 200), b: world(500, 400) };
    });
    await h.page.keyboard.down("Shift");
    await h.page.mouse.move(200, 200);
    await h.page.mouse.down();
    await h.page.mouse.move(500, 400, { steps: 3 });
    // The rubber band renders while dragging.
    await expect(h.page.locator("#v rect.marquee").count()).resolves.toBe(1);
    await h.page.mouse.up();
    await h.page.keyboard.up("Shift");
    await expect(h.page.locator("#v rect.marquee").count()).resolves.toBe(0);

    const detail = await h.page.evaluate(
      () =>
        (window as unknown as { marquee: { minX: number; minY: number; maxX: number; maxY: number } })
          .marquee,
    );
    expect(detail.minX).toBeCloseTo(Math.min(expected.a.x, expected.b.x), 5);
    expect(detail.maxX).toBeCloseTo(Math.max(expected.a.x, expected.b.x), 5);
    expect(detail.minY).toBeCloseTo(Math.min(expected.a.y, expected.b.y), 5);
    expect(detail.maxY).toBeCloseTo(Math.max(expected.a.y, expected.b.y), 5);
  });

  test("route overlay: solid base, dashed horizon following the edge trajectory, action badges", async () => {
    await h.page.evaluate(() => {
      const v = document.querySelector("lif-viewer") as unknown as { routes: unknown[] };
      v.routes = [
        {
          routeId: "order-9",
          stops: [
            { nodeId: "n-dock", actions: ["pick"] },
            { nodeId: "n-aisle-w" },
            { nodeId: "n-aisle-e" },
            { nodeId: "n-lift-g", released: false, actions: ["drop", "beep"] },
          ],
          edgeIds: [null, "e-west-east", "e-east-lift-arc"],
        },
      ];
    });
    const info = await h.page.evaluate(() => {
      const v = document.querySelector("lif-viewer")!;
      const g = v.shadowRoot!.querySelector('g.route[data-route-id="order-9"]')!;
      return {
        aria: g.getAttribute("aria-label"),
        base: g.querySelector(".route-base")?.getAttribute("d") ?? "",
        horizon: g.querySelector(".route-horizon")?.getAttribute("d") ?? "",
        badges: [...g.querySelectorAll(".route-stop-badge text")].map((t) => t.textContent),
        badgeTitle: g
          .querySelector('.route-stop-badge[data-route-stop="n-lift-g"] title')!
          .textContent,
      };
    });
    expect(info.aria).toBe("Route order-9, 4 stops (1 planned)");
    // Two committed legs: dock→aisle-w (straight fallback) + aisle-w→aisle-e.
    expect(info.base.match(/M /g)!.length).toBe(2);
    // The horizon leg follows the NURBS arc: a sampled polyline, not one line.
    expect(info.horizon.match(/L /g)!.length).toBeGreaterThan(10);
    expect(info.badges.sort()).toEqual(["1", "2"]);
    expect(info.badgeTitle).toBe("drop, beep");
  });

  test("route legs off the displayed layout are skipped; unknown nodes render nothing", async () => {
    await h.page.evaluate(() => {
      const v = document.querySelector("lif-viewer") as unknown as { routes: unknown[] };
      v.routes = [
        {
          // Crosses to the mezzanine: only the ground legs may render.
          routeId: "cross",
          stops: [
            { nodeId: "n-aisle-e" },
            { nodeId: "n-lift-g" },
            { nodeId: "n-lift-m" },
            { nodeId: "n-buf-a" },
          ],
        },
        { routeId: "ghost", stops: [{ nodeId: "nope-1" }, { nodeId: "nope-2" }] },
      ];
    });
    const info = await h.page.evaluate(() => {
      const v = document.querySelector("lif-viewer")!;
      const cross = v.shadowRoot!.querySelector('g.route[data-route-id="cross"]');
      return {
        crossLegs: cross?.querySelector(".route-base")?.getAttribute("d")?.match(/M /g)?.length,
        ghost: v.shadowRoot!.querySelector('g.route[data-route-id="ghost"]') !== null,
      };
    });
    expect(info.crossLegs).toBe(1); // only n-aisle-e → n-lift-g is on "ground"
    expect(info.ghost).toBe(false);

    // Switch layouts: the mezzanine legs appear there instead.
    await h.page.locator("#v .tabs button", { hasText: "Mezzanine" }).click();
    const mezzanineLegs = await h.page.evaluate(
      () =>
        document
          .querySelector("lif-viewer")!
          .shadowRoot!.querySelector('g.route[data-route-id="cross"] .route-base')
          ?.getAttribute("d")
          ?.match(/M /g)?.length,
    );
    expect(mezzanineLegs).toBe(1); // n-lift-m → n-buf-a
  });

  test("multiSelectedIds highlights nodes, edges and stations with the selection style", async () => {
    await h.page.evaluate(() => {
      (document.querySelector("lif-viewer") as unknown as { multiSelectedIds: string[] }).multiSelectedIds = [
        "n-dock",
        "e-west-east",
        "st-pick",
      ];
    });
    await expect(
      h.page.locator('#v circle[data-node-id="n-dock"].multi-selected').count(),
    ).resolves.toBe(1);
    await expect(h.page.locator("#v path.edge.multi-selected").count()).resolves.toBe(2); // line + arrow
    await expect(
      h.page.locator('#v rect[data-station-id="st-pick"].multi-selected').count(),
    ).resolves.toBe(1);
    await h.page.evaluate(() => {
      (document.querySelector("lif-viewer") as unknown as { multiSelectedIds: string[] }).multiSelectedIds = [];
    });
    await expect(h.page.locator("#v .multi-selected").count()).resolves.toBe(0);
  });

  test("wheel zoom re-renders live: marks keep their size, labels grow to the cap", async () => {
    const snapshot = () =>
      h.page.evaluate(() => {
        const root = document.querySelector("lif-viewer")!.shadowRoot!;
        return {
          sceneStyle: root.querySelector("g.scene")!.getAttribute("style") ?? "",
          nodeR: root.querySelector('circle[data-node-id="n-dock"]')!.getAttribute("r"),
          labelPx: Number(root.querySelector("text.scene-label")!.getAttribute("font-size")),
        };
      });
    const before = await snapshot();
    await h.page.mouse.move(400, 300);
    await h.page.mouse.wheel(0, -240); // zoom in
    await h.page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
    const after = await snapshot();
    // Small document: no gesture-time scaling — re-projected immediately.
    expect(after.sceneStyle).toBe("");
    expect(after.nodeR).toBe(before.nodeR); // marks are screen-fixed, no pop
    expect(after.labelPx).toBeGreaterThan(before.labelPx); // labels genuinely grow
  });

  test("huge documents keep the delta transform during zoom and settle at rest", async () => {
    await h.page.evaluate(() => {
      // > LIVE_ZOOM_ELEMENT_LIMIT elements: 841 nodes + 1624 edges.
      const s = 29;
      const nodes = [];
      const edges = [];
      for (let j = 0; j < s; j++) {
        for (let i = 0; i < s; i++) {
          const id = j * s + i;
          nodes.push({
            nodeId: `n${id}`,
            nodePosition: { x: i * 2, y: j * 2 },
            vehicleTypeNodeProperties: [],
          });
          if (i < s - 1)
            edges.push({
              edgeId: `e${id}r`,
              startNodeId: `n${id}`,
              endNodeId: `n${id + 1}`,
              vehicleTypeEdgeProperties: [],
            });
          if (j < s - 1)
            edges.push({
              edgeId: `e${id}u`,
              startNodeId: `n${id}`,
              endNodeId: `n${id + s}`,
              vehicleTypeEdgeProperties: [],
            });
        }
      }
      (document.querySelector("lif-viewer") as unknown as { lif: unknown }).lif = {
        metaInformation: {
          projectIdentification: "big",
          creator: "test",
          exportTimestamp: "2026-07-12T00:00:00Z",
          lifVersion: "1.0.0",
        },
        layouts: [{ layoutId: "L", layoutVersion: "1", nodes, edges, stations: [] }],
      };
    });
    await h.page.waitForTimeout(300); // auto-fit + reprojection settle
    const sceneStyle = () =>
      h.page.evaluate(
        () =>
          document.querySelector("lif-viewer")!.shadowRoot!.querySelector("g.scene")!
            .getAttribute("style") ?? "",
      );
    await h.page.mouse.move(400, 300);
    await h.page.mouse.wheel(0, -240);
    expect(await sceneStyle()).toContain("transform"); // delta during the burst
    await h.page.waitForTimeout(250); // …then the rest timer re-projects
    expect(await sceneStyle()).toBe("");
  });

  test("a wheel zoom during a pan drag is kept by the following pointermove", async () => {
    await h.page.mouse.move(400, 300);
    await h.page.mouse.down();
    await h.page.mouse.move(430, 300, { steps: 2 });
    const before = await h.page.evaluate(
      () => (document.querySelector("lif-viewer") as unknown as { view: { scale: number; tx: number } }).view,
    );
    await h.page.mouse.wheel(0, -240); // zoom in mid-drag
    const zoomed = await h.page.evaluate(
      () => (document.querySelector("lif-viewer") as unknown as { view: { scale: number; tx: number } }).view,
    );
    expect(zoomed.scale).toBeGreaterThan(before.scale);
    // Keep dragging: the scale must survive and the pan continue smoothly
    // from the zoomed view (10 px pointer travel = 10 px tx, no teleport).
    await h.page.mouse.move(440, 300, { steps: 2 });
    const after = await h.page.evaluate(
      () => (document.querySelector("lif-viewer") as unknown as { view: { scale: number; tx: number } }).view,
    );
    await h.page.mouse.up();
    expect(after.scale).toBeCloseTo(zoomed.scale, 10);
    expect(after.tx - zoomed.tx).toBeCloseTo(10, 0);
  });

  test("re-attaching the viewer mid-tween resumes the animation without a new update", async () => {
    const arrived = await h.page.evaluate(
      () =>
        new Promise<boolean>((resolve) => {
          const viewer = document.querySelector("lif-viewer")!;
          const v = viewer as unknown as {
            vehicleTransitionMs: number;
            vehicles: unknown[];
            view: { scale: number; tx: number };
            getRenderedVehicles(): { x: number }[];
          };
          v.vehicleTransitionMs = 0;
          v.vehicles = [{ vehicleId: "agv-1", x: 0, y: 0, theta: 0 }];
          v.vehicleTransitionMs = 1500;
          v.vehicles = [{ vehicleId: "agv-1", x: 8, y: 0, theta: 0 }];
          const parent = viewer.parentElement!;
          viewer.remove(); // cancels the animation frame; the tween stays queued
          setTimeout(() => {
            parent.append(viewer); // connectedCallback must resume the loop
            const deadline = performance.now() + 4000;
            const poll = () => {
              const drawn = v.getRenderedVehicles()[0];
              const targetX = 8 * v.view.scale + v.view.tx;
              if (drawn && Math.abs(drawn.x - targetX) < 1) return resolve(true);
              if (performance.now() > deadline) return resolve(false);
              requestAnimationFrame(poll);
            };
            requestAnimationFrame(poll);
          }, 100);
        }),
    );
    expect(arrived).toBe(true); // no vehicles re-assignment happened after re-attach
  });

  test("selectedKind disambiguates a station whose id equals a node id (guideline 10.13)", async () => {
    // A charging station whose stationId equals its interaction nodeId is legal.
    await h.page.evaluate(() => {
      const doc = {
        metaInformation: { projectIdentification: "t", creator: "t", exportTimestamp: "2026-07-06T10:00:00.00Z", lifVersion: "1.0.0" },
        layouts: [
          {
            layoutId: "l",
            layoutVersion: "1",
            nodes: [{ nodeId: "CHG", mapId: "m", nodePosition: { x: 0, y: 0 }, vehicleTypeNodeProperties: [{ vehicleTypeId: "t" }] }],
            edges: [],
            stations: [{ stationId: "CHG", interactionNodeIds: ["CHG"], stationName: "Charger" }],
          },
        ],
      };
      const viewer = document.querySelector("lif-viewer") as unknown as {
        lif: unknown;
        selectedId: string;
        selectedKind: string;
      };
      viewer.lif = doc;
      viewer.selectedId = "CHG";
      viewer.selectedKind = "station";
    });
    // Only the station shows a selection ring; the node does not.
    await expect(h.page.locator("#v rect.station-box.selected").count()).resolves.toBe(1);
    await expect(h.page.locator("#v circle.node-dot.selected").count()).resolves.toBe(0);

    await h.page.evaluate(() => {
      (document.querySelector("lif-viewer") as unknown as { selectedKind: string }).selectedKind = "node";
    });
    await expect(h.page.locator("#v circle.node-dot.selected").count()).resolves.toBe(1);
    await expect(h.page.locator("#v rect.station-box.selected").count()).resolves.toBe(0);
  });

  test("clicking a vehicle on the canvas layer emits lif-select with kind 'vehicle'", async () => {
    await h.page.evaluate(() => {
      const viewer = document.querySelector("lif-viewer") as unknown as HTMLElement & {
        vehicleTransitionMs: number;
        vehicles: unknown[];
      };
      viewer.vehicleTransitionMs = 0;
      viewer.vehicles = [{ vehicleId: "agv-1", x: 8, y: 3, theta: 0 }];
      viewer.addEventListener("lif-select", (ev) => {
        (window as unknown as Record<string, unknown>).lastSelect = (ev as CustomEvent).detail;
      });
    });
    await h.page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
    const marker = await h.page.evaluate(
      () =>
        (document.querySelector("lif-viewer") as unknown as {
          getRenderedVehicles(): { x: number; y: number }[];
        }).getRenderedVehicles()[0]!,
    );
    const viewerBox = (await h.page.locator("#v").boundingBox())!;
    await h.page.mouse.click(viewerBox.x + marker.x, viewerBox.y + marker.y);
    const detail = await h.page.evaluate(
      () => (window as unknown as Record<string, unknown>).lastSelect,
    );
    expect(detail).toEqual({ kind: "vehicle", id: "agv-1" });
  });

  test("poses interpolate smoothly between fleet updates", async () => {
    await h.page.goto(`${h.baseUrl}/viewer.html`);
    await h.page.evaluate(() => window.loadFixtureIntoViewer("minimal.lif.json", "#v"));
    await h.page.evaluate(() => {
      const v = document.querySelector("lif-viewer") as unknown as {
        vehicleTransitionMs: number;
        vehicles: unknown[];
      };
      v.vehicleTransitionMs = 0;
      v.vehicles = [{ vehicleId: "agv-1", x: 0, y: 0, theta: 0 }]; // at node n1
    });
    const centerX = async (selector: string) => {
      const box = (await h.page.locator(selector).boundingBox())!;
      return box.x + box.width / 2;
    };
    const markerX = async () => {
      const viewerBox = (await h.page.locator("#v").boundingBox())!;
      const x = await h.page.evaluate(
        () =>
          (document.querySelector("lif-viewer") as unknown as {
            getRenderedVehicles(): { x: number }[];
          }).getRenderedVehicles()[0]?.x ?? NaN,
      );
      return viewerBox.x + x;
    };
    const startX = await centerX('#v circle[data-node-id="n1"]');
    const endX = await centerX('#v circle[data-node-id="n2"]');

    // Sample the drawn position every frame during the tween: some sample
    // must lie strictly between the endpoints (interpolation, not a jump).
    // Frame-driven sampling instead of a flat sleep — a loaded runner cannot
    // race the tween past the midpoint before we look.
    const samples = await h.page.evaluate(
      () =>
        new Promise<number[]>((resolve) => {
          const v = document.querySelector("lif-viewer") as unknown as {
            vehicleTransitionMs: number;
            vehicles: unknown[];
            getRenderedVehicles(): { x: number }[];
          };
          v.vehicleTransitionMs = 800;
          v.vehicles = [{ vehicleId: "agv-1", x: 8, y: 0, theta: 0 }]; // to node n2
          const seen: number[] = [];
          const start = performance.now();
          const tick = () => {
            const drawn = v.getRenderedVehicles()[0];
            if (drawn) seen.push(drawn.x);
            if (performance.now() - start < 1200) requestAnimationFrame(tick);
            else resolve(seen);
          };
          requestAnimationFrame(tick);
        }),
    );
    const viewerBox = (await h.page.locator("#v").boundingBox())!;
    const pageXs = samples.map((x) => viewerBox.x + x);
    expect(pageXs.some((x) => x > startX + 20 && x < endX - 20)).toBe(true); // mid-flight
    const finalX = await markerX();
    expect(Math.abs(finalX - endX)).toBeLessThanOrEqual(2); // arrived
  });

  test("metric grid with rulers renders by default and can be hidden", async () => {
    // At the warehouse fit scale the step lands on 5 m → a handful of lines each way.
    const gridLines = await h.page.locator("#v line.grid-line").count();
    expect(gridLines).toBeGreaterThanOrEqual(6);
    const labels = await h.page.locator("#v text.ruler-label").allTextContents();
    expect(labels.some((t) => t.includes("0 m"))).toBe(true);
    expect(labels.every((t) => t.endsWith(" m"))).toBe(true);
    // Both orientations exist: at least one vertical (x1==x2) and one horizontal line.
    const orientations = await h.page.evaluate(() => {
      const lines = [...document.querySelector("lif-viewer")!.shadowRoot!.querySelectorAll("line.grid-line")];
      return {
        vertical: lines.filter((l) => l.getAttribute("x1") === l.getAttribute("x2")).length,
        horizontal: lines.filter((l) => l.getAttribute("y1") === l.getAttribute("y2")).length,
      };
    });
    expect(orientations.vertical).toBeGreaterThanOrEqual(3);
    expect(orientations.horizontal).toBeGreaterThanOrEqual(3);

    await h.page.evaluate(() => {
      (document.querySelector("lif-viewer") as unknown as { showGrid: boolean }).showGrid = false;
    });
    await expect(h.page.locator("#v line.grid-line").count()).resolves.toBe(0);
  });

  test("a background image renders with world-metre calibration (ROS origin convention)", async () => {
    const PIXEL =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    await h.page.evaluate((href) => {
      const v = document.querySelector("lif-viewer") as unknown as {
        backgrounds: Record<string, unknown>;
      };
      v.backgrounds = { ground: { href, x: 0, y: 0, width: 10, height: 5, opacity: 0.5 } };
    }, PIXEL);
    const image = h.page.locator("#v image.background");
    await expect(image.count()).resolves.toBe(1);
    const { attrs, view } = await h.page.evaluate(() => {
      const viewer = document.querySelector("lif-viewer")!;
      const img = viewer.shadowRoot!.querySelector("image.background")!;
      return {
        attrs: {
          x: Number(img.getAttribute("x")),
          y: Number(img.getAttribute("y")),
          width: Number(img.getAttribute("width")),
          height: Number(img.getAttribute("height")),
        },
        view: (viewer as unknown as { view: { scale: number; tx: number; ty: number } }).view,
      };
    });
    // Lower-left (0,0), 10×5 m ⇒ top-left screen anchor is project(0, 5).
    expect(attrs.width).toBeCloseTo(10 * view.scale, 1);
    expect(attrs.height).toBeCloseTo(5 * view.scale, 1);
    expect(attrs.x).toBeCloseTo(view.tx, 1);
    expect(attrs.y).toBeCloseTo(-5 * view.scale + view.ty, 1);

    // Only layouts with a configured background show one.
    await h.page.locator("#v .tabs button", { hasText: "Mezzanine" }).click();
    await expect(h.page.locator("#v image.background").count()).resolves.toBe(0);
  });

  test("display filters hide nodes, edges, stations and labels", async () => {
    const set = (patch: Record<string, boolean>) =>
      h.page.evaluate((p) => {
        Object.assign(document.querySelector("lif-viewer") as object, p);
      }, patch);

    await set({ showNodes: false });
    await expect(h.page.locator("#v circle.node-dot").count()).resolves.toBe(0);
    await set({ showNodes: true, showEdges: false });
    await expect(h.page.locator("#v path.edge-hit").count()).resolves.toBe(0);
    await set({ showEdges: true, showStations: false });
    await expect(h.page.locator("#v rect.station-box").count()).resolves.toBe(0);
    await set({ showStations: true, showLabels: false, showGrid: false });
    await expect(h.page.locator("#v svg text").count()).resolves.toBe(0);
  });

  test("hiding trajectories falls back to straight edges", async () => {
    const curved = await h.page
      .locator('#v path.edge-hit[data-edge-id="e-east-lift-arc"]')
      .getAttribute("d");
    expect(curved!.split("L").length).toBeGreaterThan(40);
    await h.page.evaluate(() => {
      (document.querySelector("lif-viewer") as unknown as { showTrajectories: boolean }).showTrajectories = false;
    });
    const straight = await h.page
      .locator('#v path.edge-hit[data-edge-id="e-east-lift-arc"]')
      .getAttribute("d");
    expect(straight!.split("L").length).toBe(2);
  });

  test("measure length: multi-point polyline with segment labels and a running total", async () => {
    const scale = await h.page.evaluate(() => {
      const v = document.querySelector("lif-viewer") as unknown as {
        measuring: boolean;
        view: { scale: number };
      };
      v.measuring = true;
      return v.view.scale;
    });
    const fmt = (v: number) => String(parseFloat(v.toFixed(2)));

    await h.page.locator('#v svg[part="canvas"]').click({ position: { x: 400, y: 200 } });
    await h.page.locator('#v svg[part="canvas"]').click({ position: { x: 520, y: 200 } });
    await h.page.locator('#v svg[part="canvas"]').click({ position: { x: 520, y: 260 } });
    await h.page.locator('#v svg[part="canvas"]').dblclick({ position: { x: 520, y: 260 } });

    await expect(h.page.locator("#v g[data-measurement]").count()).resolves.toBe(1);
    await expect(h.page.locator("#v line.measure-line").count()).resolves.toBe(2);
    const segLabels = await h.page.locator("#v text.measure-seg-label").allTextContents();
    expect(segLabels).toEqual([`${fmt(120 / scale)} m`, `${fmt(60 / scale)} m`]);
    const total = await h.page.locator("#v text.measure-total").textContent();
    expect(total).toBe(`${fmt(180 / scale)} m`);

    // Hiding segment labels keeps the total.
    await h.page.evaluate(() => {
      (document.querySelector("lif-viewer") as unknown as { measureSegmentLabels: boolean }).measureSegmentLabels = false;
    });
    await expect(h.page.locator("#v text.measure-seg-label").count()).resolves.toBe(0);
    await expect(h.page.locator("#v text.measure-total").count()).resolves.toBe(1);

    // Leaving the mode clears everything.
    await h.page.evaluate(() => {
      (document.querySelector("lif-viewer") as unknown as { measuring: boolean }).measuring = false;
    });
    await expect(h.page.locator("#v line.measure-line").count()).resolves.toBe(0);
  });

  test("measure area: the polygon closes and shows an m² label; measurements persist across mode switches", async () => {
    const scale = await h.page.evaluate(() => {
      const v = document.querySelector("lif-viewer") as unknown as {
        measuring: boolean;
        view: { scale: number };
      };
      v.measuring = true;
      return v.view.scale;
    });
    const fmt = (v: number) => String(parseFloat(v.toFixed(2)));

    // First a length measurement…
    await h.page.locator('#v svg[part="canvas"]').click({ position: { x: 300, y: 150 } });
    await h.page.locator('#v svg[part="canvas"]').click({ position: { x: 360, y: 150 } });
    await h.page.locator('#v svg[part="canvas"]').dblclick({ position: { x: 360, y: 150 } });
    // …then switch to area: the completed measurement must survive.
    await h.page.evaluate(() => {
      (document.querySelector("lif-viewer") as unknown as { measureMode: string }).measureMode = "area";
    });
    await expect(h.page.locator("#v g[data-measurement]").count()).resolves.toBe(1);

    await h.page.locator('#v svg[part="canvas"]').click({ position: { x: 400, y: 200 } });
    await h.page.locator('#v svg[part="canvas"]').click({ position: { x: 520, y: 200 } });
    await h.page.locator('#v svg[part="canvas"]').click({ position: { x: 520, y: 260 } });
    await h.page.locator('#v svg[part="canvas"]').dblclick({ position: { x: 520, y: 260 } });

    await expect(h.page.locator("#v g[data-measurement]").count()).resolves.toBe(2);
    // Triangle 120px × 60px: 3 lines including the closing one.
    await expect(
      h.page.locator('#v g[data-measure-mode="area"] line.measure-line').count(),
    ).resolves.toBe(3);
    const area = await h.page.locator("#v text[data-measure-area]").textContent();
    expect(area).toBe(`${fmt((120 * 60) / 2 / (scale * scale))} m²`);

    // Clear Previous Measure removes only the newest measurement.
    await h.page.evaluate(() => {
      (document.querySelector("lif-viewer") as unknown as { clearLastMeasurement(): void }).clearLastMeasurement();
    });
    await expect(h.page.locator("#v g[data-measurement]").count()).resolves.toBe(1);
    await expect(h.page.locator('#v g[data-measure-mode="length"]').count()).resolves.toBe(1);
  });

  test("scene labels scale with zoom, clear their marks, and hide when illegible", async () => {
    // The attribute AND the rendering: a stylesheet font-size would silently
    // defeat the attribute (CSS beats presentation attributes) — assert both.
    const labelFontSize = async () =>
      Number(await h.page.locator("#v text.scene-label").first().getAttribute("font-size"));
    const renderedHeight = async () =>
      (await h.page.locator("#v text.scene-label").first().boundingBox())!.height;
    // Programmatic view changes ride the gesture-time group transform first;
    // exact attributes (font sizes, LOD) settle at rest-reprojection.
    const setScale = async (scale: number) => {
      await h.page.evaluate((s) => {
        const v = document.querySelector("lif-viewer") as unknown as {
          view: { scale: number; tx: number; ty: number };
        };
        v.view = { ...v.view, scale: s };
      }, scale);
      // Past the 150 ms rest timer: the scene has re-projected.
      await h.page.waitForTimeout(220);
    };

    // Let the async auto-fit and its re-projection settle before driving scales.
    await h.page.waitForTimeout(250);
    await setScale(50);
    expect(await labelFontSize()).toBeCloseTo(13, 0); // 0.26 m/em × 50 px/m
    const renderedAt50 = await renderedHeight();
    await setScale(70);
    expect(await labelFontSize()).toBeCloseTo(18.2, 0); // grows with zoom
    await setScale(200);
    expect(await labelFontSize()).toBe(20); // clamped (0.26 m/em × 200 = 52 → cap)
    const renderedAt200 = await renderedHeight();
    // The visual size actually grew with the zoom (13 → 20 px) — not just
    // the attribute: a stylesheet font-size would pin it.
    expect(renderedAt200).toBeGreaterThan(renderedAt50 * 1.3);
    await setScale(10); // 2.6 px — illegible, so hidden entirely
    await expect(h.page.locator("#v text.scene-label").count()).resolves.toBe(0);
    // Ruler labels are instruments, not world objects: fixed and still there.
    await expect(h.page.locator("#v text.ruler-label").count()).resolves.toBeGreaterThan(0);

    // Placement steers labels away from incident edges (and clears markers):
    await setScale(50);
    // "Aisle west" has edges left, right and up → the free side is below.
    const aisleW = (await h.page.locator('#v circle[data-node-id="n-aisle-w"]').boundingBox())!;
    const aisleWLabel = (await h.page
      .locator("#v text.scene-label", { hasText: "Aisle west" })
      .boundingBox())!;
    expect(aisleWLabel.y).toBeGreaterThanOrEqual(aisleW.y + aisleW.height - 1);
    // "Pick face" hangs off a downward edge → its label must sit above,
    // never on the track (the reported bug).
    const pick = (await h.page.locator('#v circle[data-node-id="n-pick"]').boundingBox())!;
    const pickLabel = (await h.page
      .locator("#v text.scene-label", { hasText: /^Pick face$/ })
      .boundingBox())!;
    expect(pickLabel.y + pickLabel.height).toBeLessThanOrEqual(pick.y + 1);
    // "Dock" ends a single edge heading right → label on the free left side.
    const dock = (await h.page.locator('#v circle[data-node-id="n-dock"]').boundingBox())!;
    const dockLabel = (await h.page
      .locator("#v text.scene-label", { hasText: "Dock" })
      .boundingBox())!;
    expect(dockLabel.x + dockLabel.width).toBeLessThanOrEqual(dock.x + 1);
  });

  test("zoom controls step the scale around the centre and fit re-frames the layout", async () => {
    const view = () =>
      h.page.evaluate(
        () =>
          (document.querySelector("lif-viewer") as unknown as {
            view: { scale: number; tx: number; ty: number };
          }).view,
      );
    const initial = await view(); // auto-fitted on load
    await h.page.locator('#v [data-action="zoom-in"]').click();
    const zoomedIn = await view();
    expect(zoomedIn.scale).toBeGreaterThan(initial.scale);

    await h.page.locator('#v [data-action="zoom-out"]').click();
    expect((await view()).scale).toBeCloseTo(initial.scale, 5);

    // Disturb the view, then Fit restores the fitted frame.
    await h.page.mouse.move(400, 300);
    await h.page.mouse.down();
    await h.page.mouse.move(620, 420, { steps: 4 });
    await h.page.mouse.up();
    await h.page.locator('#v [data-action="zoom-in"]').click();
    await h.page.locator('#v [data-action="fit-view"]').click();
    const fitted = await view();
    expect(fitted.scale).toBeCloseTo(initial.scale, 5);
    expect(Math.abs(fitted.tx - initial.tx)).toBeLessThan(1);
    expect(Math.abs(fitted.ty - initial.ty)).toBeLessThan(1);
  });

  test("the fullscreen button expands the viewer element and toggles back", async () => {
    await h.page.locator('#v button[data-action="fullscreen"]').click();
    await h.page.waitForFunction(() => document.fullscreenElement?.tagName === "LIF-VIEWER");
    // The button reflects the state (after the fullscreenchange-triggered render).
    await h.page
      .locator('#v button[data-action="fullscreen"][title="Exit fullscreen"]')
      .waitFor({ timeout: 5000 });
    await h.page.locator('#v button[data-action="fullscreen"]').click();
    await h.page.waitForFunction(() => document.fullscreenElement === null);
  });

  test("centerOn pans the requested world position to the viewport centre", async () => {
    await h.page.evaluate(() => {
      (document.querySelector("lif-viewer") as unknown as { centerOn(x: number, y: number): void }).centerOn(16, 0);
    });
    const { screen, rect } = await h.page.evaluate(() => {
      const viewer = document.querySelector("lif-viewer")!;
      const v = viewer as unknown as { view: { scale: number; tx: number; ty: number } };
      return {
        screen: { x: 16 * v.view.scale + v.view.tx, y: -0 * v.view.scale + v.view.ty },
        rect: { w: viewer.clientWidth, h: viewer.clientHeight },
      };
    });
    expect(screen.x).toBeCloseTo(rect.w / 2, 0);
    expect(screen.y).toBeCloseTo(rect.h / 2, 0);
  });

  test("vehicle-type filter dims elements the type cannot use", async () => {
    await h.page.evaluate(() => {
      const v = document.querySelector("lif-viewer") as unknown as {
        vehicleTypeId: string | null;
      };
      v.vehicleTypeId = "acme.forklift";
    });
    // Tugger-only nodes: n-charge and n-lift-g.
    await expect(h.page.locator("#v g.dimmed > circle.node-dot").count()).resolves.toBe(2);
    await expect(
      h.page.locator('#v g.dimmed > circle[data-node-id="n-charge"]').count(),
    ).resolves.toBe(1);
  });
});
