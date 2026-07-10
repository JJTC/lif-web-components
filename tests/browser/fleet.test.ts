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
      await h.page.goto(`${h.baseUrl}/fleet.html`);
      await h.page.evaluate(() => window.loadFixtureIntoViewer("warehouse.lif.json", "#v"));
      break;
    } catch (e) {
      if (attempt >= 2) throw e;
    }
  }
  // A small fleet with every status; instant tweens unless a test opts in.
  await h.page.evaluate(() => {
    const fleet = [
      { vehicleId: "amr-ok", label: "OK-1", x: 2, y: 1, theta: 0, batteryCharge: 91, driving: true },
      {
        vehicleId: "amr-warn",
        label: "Warn-1",
        x: 6, y: 2, theta: 0,
        status: "warning",
        batteryCharge: 55,
        charging: true,
        errors: [{ errorType: "lidarContamination", errorLevel: "WARNING", errorDescription: "LiDAR window dirty" }],
      },
      {
        vehicleId: "amr-err",
        label: "Err-1",
        x: 10, y: 4, theta: 1.5707963267948966,
        status: "error",
        batteryCharge: 34,
        orderId: "order-9",
        errors: [{ errorType: "motorStall", errorLevel: "FATAL", errorDescription: "Drive motor stalled" }],
      },
      { vehicleId: "amr-off", label: "Off-1", x: 14, y: 1, status: "offline", batteryCharge: 12 },
    ];
    const viewer = document.querySelector("lif-viewer") as unknown as {
      vehicleTransitionMs: number;
      vehicles: unknown[];
    };
    viewer.vehicleTransitionMs = 0;
    viewer.vehicles = fleet;
    const panel = document.querySelector("lif-fleet-panel") as unknown as { vehicles: unknown[] };
    panel.vehicles = fleet;
  });
  await h.page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
});

describe("fleet monitoring (viewer status markers + <lif-fleet-panel>)", () => {
  test("markers carry their status and the canvas aria-label counts problems", async () => {
    const { statuses, aria } = await h.page.evaluate(() => {
      const viewer = document.querySelector("lif-viewer") as unknown as {
        getRenderedVehicles(): { vehicleId: string; status?: string }[];
        shadowRoot: ShadowRoot;
      };
      return {
        statuses: Object.fromEntries(
          viewer.getRenderedVehicles().map((v) => [v.vehicleId, v.status ?? "none"]),
        ),
        aria: viewer.shadowRoot.querySelector("canvas.vehicle-layer")!.getAttribute("aria-label"),
      };
    });
    expect(statuses).toEqual({
      "amr-ok": "none",
      "amr-warn": "warning",
      "amr-err": "error",
      "amr-off": "offline",
    });
    expect(aria).toBe("4 vehicles (1 error, 1 warning)");
  });

  test("at dot LOD the error vehicle is painted in the reserved critical color", async () => {
    const rgb = await h.page.evaluate(() => {
      const viewer = document.querySelector("lif-viewer") as unknown as {
        view: { scale: number; tx: number; ty: number };
        getRenderedVehicles(): { vehicleId: string; x: number; y: number; lod: string }[];
        shadowRoot: ShadowRoot;
      };
      viewer.view = { scale: 4, tx: 300, ty: 300 }; // far out: dot LOD
      return new Promise<number[]>((resolve) => {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const err = viewer.getRenderedVehicles().find((v) => v.vehicleId === "amr-err")!;
            const canvas = viewer.shadowRoot.querySelector("canvas.vehicle-layer") as HTMLCanvasElement;
            const dpr = window.devicePixelRatio || 1;
            const px = canvas
              .getContext("2d")!
              .getImageData(Math.round(err.x * dpr), Math.round(err.y * dpr), 1, 1).data;
            resolve([px[0]!, px[1]!, px[2]!]);
          }),
        );
      });
    });
    // #d03b3b — the fixed status palette's critical step.
    expect(Math.abs(rgb[0]! - 0xd0)).toBeLessThanOrEqual(12);
    expect(Math.abs(rgb[1]! - 0x3b)).toBeLessThanOrEqual(12);
    expect(Math.abs(rgb[2]! - 0x3b)).toBeLessThanOrEqual(12);
  });

  test("panel sorts problems first, shows battery/order/error details and filters by search", async () => {
    const rows = () =>
      h.page.evaluate(() =>
        [...document.querySelector("lif-fleet-panel")!.shadowRoot!.querySelectorAll(".main")].map(
          (b) => (b as HTMLElement).dataset.vehicleId,
        ),
      );
    expect(await rows()).toEqual(["amr-err", "amr-warn", "amr-off", "amr-ok"]);

    const panelText = await h.page.evaluate(
      () => document.querySelector("lif-fleet-panel")!.shadowRoot!.textContent!.replace(/\s+/g, " "),
    );
    expect(panelText).toContain("4 vehicles");
    expect(panelText).toContain("1 error");
    expect(panelText).toContain("1 warning");
    expect(panelText).toContain("1 offline");
    expect(panelText).toContain("Drive motor stalled");
    expect(panelText).toContain("34%");

    await h.page.locator("#fp input[type=search]").fill("warn");
    expect(await rows()).toEqual(["amr-warn"]);
  });

  test("clicking a row selects the vehicle in the viewer, centres it, and emits lif-select", async () => {
    await h.page.evaluate(() => {
      (window as unknown as { selections: unknown[] }).selections = [];
      document.querySelector("lif-fleet-panel")!.addEventListener("lif-select", (ev) => {
        (window as unknown as { selections: unknown[] }).selections.push(
          (ev as CustomEvent).detail,
        );
      });
    });
    await h.page.locator('#fp .main[data-vehicle-id="amr-err"]').click();
    const result = await h.page.evaluate(() => {
      const viewer = document.querySelector("lif-viewer") as unknown as {
        selectedId: string | null;
        selectedKind: string | null;
        clientWidth: number;
        clientHeight: number;
        getRenderedVehicles(): { vehicleId: string; x: number; y: number; selected: boolean }[];
      };
      return new Promise((resolve) => {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const err = viewer.getRenderedVehicles().find((v) => v.vehicleId === "amr-err")!;
            resolve({
              selectedId: viewer.selectedId,
              selectedKind: viewer.selectedKind,
              selectedFlag: err.selected,
              dx: Math.abs(err.x - viewer.clientWidth / 2),
              dy: Math.abs(err.y - viewer.clientHeight / 2),
              selections: (window as unknown as { selections: unknown[] }).selections,
            });
          }),
        );
      });
    });
    expect(result).toMatchObject({
      selectedId: "amr-err",
      selectedKind: "vehicle",
      selectedFlag: true,
      selections: [{ kind: "vehicle", id: "amr-err" }],
    });
    expect((result as { dx: number }).dx).toBeLessThan(1.5);
    expect((result as { dy: number }).dy).toBeLessThan(1.5);
  });

  test("fitView and centerOn end following and announce it; zoom keeps following", async () => {
    await h.page.evaluate(() => {
      (window as unknown as { followEvents: unknown[] }).followEvents = [];
      document.querySelector("lif-viewer")!.addEventListener("lif-follow-change", (ev) => {
        (window as unknown as { followEvents: unknown[] }).followEvents.push(
          (ev as CustomEvent).detail,
        );
      });
    });
    const followId = () =>
      h.page.evaluate(
        () =>
          (document.querySelector("lif-viewer") as unknown as { followVehicleId: string | null })
            .followVehicleId,
      );
    await h.page.locator('#fp li .follow[title="Follow on the map"]').first().click();
    expect(await followId()).toBe("amr-err");

    // Zooming does NOT end following — and re-centres even without a tween.
    const viewerBox = (await h.page.locator("#v").boundingBox())!;
    await h.page.mouse.move(viewerBox.x + 60, viewerBox.y + 60); // off-centre cursor
    await h.page.mouse.wheel(0, -240);
    expect(await followId()).toBe("amr-err");
    const offset = await h.page.evaluate(() => {
      const viewer = document.querySelector("lif-viewer") as unknown as {
        clientWidth: number;
        clientHeight: number;
        getRenderedVehicles(): { vehicleId: string; x: number; y: number }[];
      };
      return new Promise<number>((resolve) => {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const err = viewer.getRenderedVehicles().find((v) => v.vehicleId === "amr-err")!;
            resolve(Math.hypot(err.x - viewer.clientWidth / 2, err.y - viewer.clientHeight / 2));
          }),
        );
      });
    });
    expect(offset).toBeLessThan(1.5); // stationary vehicle stays centred

    // fitView is an explicit reframe: ends following.
    await h.page.evaluate(() =>
      (document.querySelector("lif-viewer") as unknown as { fitView(): void }).fitView(),
    );
    expect(await followId()).toBeNull();

    // Re-follow, then centerOn also ends it.
    await h.page.locator('#fp li .follow[title="Follow on the map"]').first().click();
    expect(await followId()).toBe("amr-err");
    await h.page.evaluate(() =>
      (document.querySelector("lif-viewer") as unknown as {
        centerOn(x: number, y: number): void;
      }).centerOn(0, 0),
    );
    expect(await followId()).toBeNull();

    const events = await h.page.evaluate(
      () => (window as unknown as { followEvents: { vehicleId: string | null }[] }).followEvents,
    );
    expect(events.map((e) => e.vehicleId)).toEqual(["amr-err", null, "amr-err", null]);
  });

  test("the follow button announces the selection like a row click (lif-select)", async () => {
    await h.page.evaluate(() => {
      (window as unknown as { panelSelects: unknown[] }).panelSelects = [];
      document.querySelector("lif-fleet-panel")!.addEventListener("lif-select", (ev) => {
        (window as unknown as { panelSelects: unknown[] }).panelSelects.push(
          (ev as CustomEvent).detail,
        );
      });
    });
    await h.page.locator('#fp li .follow[title="Follow on the map"]').first().click();
    const selects = await h.page.evaluate(
      () => (window as unknown as { panelSelects: unknown[] }).panelSelects,
    );
    expect(selects).toEqual([{ kind: "vehicle", id: "amr-err" }]);
  });

  test("follow keeps a moving vehicle centred through tweens; a manual pan ends it", async () => {
    await h.page.locator('#fp li .follow[title="Follow on the map"]').first().click();
    const followed = await h.page.evaluate(
      () => (document.querySelector("lif-viewer") as unknown as { followVehicleId: string | null }).followVehicleId,
    );
    expect(followed).toBe("amr-err"); // first row = highest severity

    // Move the fleet with a real tween and sample mid-animation.
    const centred = await h.page.evaluate(() => {
      const viewer = document.querySelector("lif-viewer") as unknown as {
        vehicleTransitionMs: number;
        vehicles: unknown[];
        clientWidth: number;
        clientHeight: number;
        getRenderedVehicles(): { vehicleId: string; x: number; y: number }[];
      };
      viewer.vehicleTransitionMs = 400;
      viewer.vehicles = [
        { vehicleId: "amr-err", label: "Err-1", x: 4, y: -2, theta: 0, status: "error" },
      ];
      const offsets: number[] = [];
      return new Promise<number[]>((resolve) => {
        const sample = () => {
          const err = viewer.getRenderedVehicles().find((v) => v.vehicleId === "amr-err");
          if (err) {
            offsets.push(
              Math.hypot(err.x - viewer.clientWidth / 2, err.y - viewer.clientHeight / 2),
            );
          }
          if (offsets.length < 8) requestAnimationFrame(sample);
          else resolve(offsets);
        };
        requestAnimationFrame(sample);
      });
    });
    // Every mid-tween frame keeps the followed vehicle at the viewport centre.
    for (const offset of centred) expect(offset).toBeLessThan(1.5);

    // Manual pan takes over and ends follow mode.
    const viewerBox = (await h.page.locator("#v").boundingBox())!;
    await h.page.mouse.move(viewerBox.x + 300, viewerBox.y + 300);
    await h.page.mouse.down();
    await h.page.mouse.move(viewerBox.x + 380, viewerBox.y + 340, { steps: 4 });
    await h.page.mouse.up();
    const after = await h.page.evaluate(() => {
      const viewer = document.querySelector("lif-viewer") as unknown as { followVehicleId: string | null };
      const btn = document
        .querySelector("lif-fleet-panel")!
        .shadowRoot!.querySelector("li .follow");
      return { followVehicleId: viewer.followVehicleId, pressed: btn?.getAttribute("aria-pressed") };
    });
    expect(after.followVehicleId).toBeNull();
    expect(after.pressed).toBe("false");
  });
});
