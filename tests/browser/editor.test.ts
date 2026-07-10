import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Lif } from "../../src/lif";
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
      await h.page.goto(`${h.baseUrl}/editor.html`);
      await h.page.locator("lif-editor .toolbar").waitFor();
      break;
    } catch (e) {
      if (attempt >= 2) throw e;
    }
  }
});

async function editorDoc(): Promise<Lif> {
  return h.page.evaluate(() => {
    const editor = document.querySelector("lif-editor") as unknown as { lif: Lif };
    return editor.lif;
  });
}

async function loadWarehouse(): Promise<void> {
  await h.page.evaluate(() => window.loadFixtureIntoEditor("warehouse.lif.json", "#e"));
}

describe("<lif-editor> creating elements", () => {
  test("add-node tool creates nodes where the canvas is clicked; undo/redo work", async () => {
    await h.page.locator('button[data-tool-button="add-node"]').click();
    await h.page.locator('#e svg[part="canvas"]').click({ position: { x: 300, y: 300 } });
    await h.page.locator('#e svg[part="canvas"]').click({ position: { x: 500, y: 260 } });

    let doc = await editorDoc();
    expect(doc.layouts[0]!.nodes.map((n) => n.nodeId)).toEqual(["n1", "n2"]);
    // Screen y decreased from 300→260 means world y increased (y-up).
    expect(doc.layouts[0]!.nodes[1]!.nodePosition.y).toBeGreaterThan(
      doc.layouts[0]!.nodes[0]!.nodePosition.y,
    );

    await h.page.locator('button[data-action="undo"]').click();
    doc = await editorDoc();
    expect(doc.layouts[0]!.nodes).toHaveLength(1);

    await h.page.locator('button[data-action="redo"]').click();
    doc = await editorDoc();
    expect(doc.layouts[0]!.nodes).toHaveLength(2);
  });

  test("add-edge tool connects two nodes and selects the new edge", async () => {
    await h.page.locator('button[data-tool-button="add-node"]').click();
    await h.page.locator('#e svg[part="canvas"]').click({ position: { x: 300, y: 300 } });
    await h.page.locator('#e svg[part="canvas"]').click({ position: { x: 500, y: 300 } });

    await h.page.locator('button[data-tool-button="add-edge"]').click();
    await h.page.locator('#e circle[data-node-id="n1"]').click();
    await expect(h.page.locator("#e .hint").textContent()).resolves.toContain('from "n1"');
    await h.page.locator('#e circle[data-node-id="n2"]').click();

    const doc = await editorDoc();
    expect(doc.layouts[0]!.edges).toHaveLength(1);
    const edge = doc.layouts[0]!.edges[0]!;
    expect(edge.edgeId).toBe("e1");
    expect(edge.startNodeId).toBe("n1");
    expect(edge.endNodeId).toBe("n2");
    expect(edge.vehicleTypeEdgeProperties[0]!.rotationAllowed).toBe(false);
    // Properties panel shows the edge.
    await expect(
      h.page.locator('[data-panel="properties"] h3').first().textContent(),
    ).resolves.toContain("edge");
  });

  test("add-station tool attaches a station to a clicked node", async () => {
    await h.page.locator('button[data-tool-button="add-node"]').click();
    await h.page.locator('#e svg[part="canvas"]').click({ position: { x: 300, y: 300 } });
    await h.page.locator('button[data-tool-button="add-station"]').click();
    await h.page.locator('#e circle[data-node-id="n1"]').click();

    const doc = await editorDoc();
    expect(doc.layouts[0]!.stations).toHaveLength(1);
    expect(doc.layouts[0]!.stations[0]!.interactionNodeIds).toEqual(["n1"]);
    await expect(h.page.locator("#e rect.station-box").count()).resolves.toBe(1);
  });
});

describe("<lif-editor> editing", () => {
  test("dragging a node moves it and one undo restores the old position", async () => {
    await loadWarehouse();
    const before = await editorDoc();
    const dock = before.layouts[0]!.nodes.find((n) => n.nodeId === "n-dock")!;

    const box = (await h.page.locator('#e circle[data-node-id="n-dock"]').boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await h.page.mouse.move(cx, cy);
    await h.page.mouse.down();
    await h.page.mouse.move(cx + 60, cy + 40, { steps: 6 });
    await h.page.mouse.up();

    const after = await editorDoc();
    const moved = after.layouts[0]!.nodes.find((n) => n.nodeId === "n-dock")!;
    expect(moved.nodePosition.x).toBeGreaterThan(dock.nodePosition.x);
    expect(moved.nodePosition.y).toBeLessThan(dock.nodePosition.y); // screen +y = world -y

    await h.page.locator('button[data-action="undo"]').click();
    const undone = await editorDoc();
    expect(undone.layouts[0]!.nodes.find((n) => n.nodeId === "n-dock")!.nodePosition).toEqual(
      dock.nodePosition,
    );
  });

  test("a failed rename (duplicate id) reports near the field and reverts the input", async () => {
    await loadWarehouse();
    await h.page.locator('#e circle[data-node-id="n-dock"]').click();
    const idField = h.page.locator('[data-panel="properties"] input[data-field="nodeId"]');
    await idField.fill("n-charge"); // already exists
    await idField.press("Enter");

    // Error shown in the properties panel (not under the Raw JSON heading).
    await expect(h.page.locator("[data-op-error]").textContent()).resolves.toContain("already exists");
    await expect(h.page.locator("[data-json-error]").count()).resolves.toBe(0);
    // Input reverts to the real id; the document is unchanged.
    await expect(idField.inputValue()).resolves.toBe("n-dock");
    const doc = await editorDoc();
    expect(doc.layouts[0]!.nodes.some((n) => n.nodeId === "n-dock")).toBe(true);

    // A successful edit clears the error.
    await idField.fill("n-dock-2");
    await idField.press("Enter");
    await expect(h.page.locator("[data-op-error]").count()).resolves.toBe(0);
  });

  test("renaming a node via the properties panel updates edge and station references", async () => {
    await loadWarehouse();
    await h.page.locator('#e circle[data-node-id="n-pick"]').click();
    const idField = h.page.locator('[data-panel="properties"] input[data-field="nodeId"]');
    await idField.fill("n-pick-renamed");
    await idField.press("Enter");

    const doc = await editorDoc();
    const ground = doc.layouts[0]!;
    expect(ground.nodes.some((n) => n.nodeId === "n-pick-renamed")).toBe(true);
    expect(ground.edges.find((e) => e.edgeId === "e-west-pick")!.endNodeId).toBe("n-pick-renamed");
    expect(ground.stations.find((s) => s.stationId === "st-pick")!.interactionNodeIds).toEqual([
      "n-pick-renamed",
    ]);
  });

  test("deleting a node with the keyboard cascades to edges and stations", async () => {
    await loadWarehouse();
    await h.page.locator('#e circle[data-node-id="n-pick"]').click();
    await h.page.keyboard.press("Delete");

    const doc = await editorDoc();
    const ground = doc.layouts[0]!;
    expect(ground.nodes.some((n) => n.nodeId === "n-pick")).toBe(false);
    expect(ground.edges.some((e) => e.edgeId === "e-west-pick")).toBe(false);
    expect(ground.edges.some((e) => e.edgeId === "e-pick-west")).toBe(false);
    expect(ground.stations.some((s) => s.stationId === "st-pick")).toBe(false);
  });

  test("raw JSON editing replaces the selected element", async () => {
    await loadWarehouse();
    await h.page.locator('#e circle[data-node-id="n-charge"]').click();
    const textarea = h.page.locator('textarea[data-field="json"]');
    const json = JSON.parse((await textarea.inputValue())!);
    json.nodeDescription = "Charging bay, added via JSON";
    json.vehicleTypeNodeProperties[0].theta = -1.5707963267948966;
    await textarea.fill(JSON.stringify(json, null, 2));
    await h.page.locator('button[data-action="apply-json"]').click();

    const doc = await editorDoc();
    const charge = doc.layouts[0]!.nodes.find((n) => n.nodeId === "n-charge")!;
    expect(charge.nodeDescription).toBe("Charging bay, added via JSON");
    expect(charge.vehicleTypeNodeProperties[0]!.theta).toBeCloseTo(-Math.PI / 2, 12);
  });

  test("structurally-broken JSON applied via the hatch surfaces as a diagnostic (not silent)", async () => {
    await loadWarehouse();
    await h.page.locator('#e circle[data-node-id="n-charge"]').click();
    const textarea = h.page.locator('textarea[data-field="json"]');
    const json = JSON.parse((await textarea.inputValue())!);
    // Structurally invalid: x is not a number, blockingType is not in the enum.
    json.nodePosition.x = "not-a-number";
    json.vehicleTypeNodeProperties[0].actions = [{ actionType: "pick", blockingType: "BANANA" }];
    await textarea.fill(JSON.stringify(json, null, 2));
    await h.page.locator('button[data-action="apply-json"]').click();

    // The Checks panel and status badge must report the structural errors.
    await h.page.locator('button[data-action="toggle-diagnostics"]').click();
    const codes = await h.page.locator(".diagnostics li .code").allTextContents();
    expect(codes).toContain("LIF-P003"); // wrong type
    expect(codes).toContain("LIF-P007"); // invalid enum
    const badge = await h.page.locator(".badge").textContent();
    expect(Number(badge)).toBeGreaterThan(0);
  });

  test("invalid raw JSON shows an error and does not change the document", async () => {
    await loadWarehouse();
    await h.page.locator('#e circle[data-node-id="n-charge"]').click();
    const before = await editorDoc();
    await h.page.locator('textarea[data-field="json"]').fill("{ nope");
    await h.page.locator('button[data-action="apply-json"]').click();
    await expect(h.page.locator("[data-json-error]").textContent()).resolves.toContain(
      "Invalid JSON",
    );
    expect(await editorDoc()).toEqual(before);
  });
});

describe("<lif-editor> sidebar resizing", () => {
  async function sidebarWidth(): Promise<number> {
    return (await h.page.locator("lif-editor .sidebar").boundingBox())!.width;
  }

  async function handleCenter(): Promise<{ x: number; y: number }> {
    const box = (await h.page.locator("lif-editor .resizer").boundingBox())!;
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  test("dragging the divider adjusts the sidebar width", async () => {
    const before = await sidebarWidth();
    const { x, y } = await handleCenter();
    await h.page.mouse.move(x, y);
    await h.page.mouse.down();
    await h.page.mouse.move(x - 120, y, { steps: 4 });
    await h.page.mouse.up();
    const after = await sidebarWidth();
    expect(Math.abs(after - (before + 120))).toBeLessThanOrEqual(2);
  });

  test("width clamps to a usable minimum and double-click resets to the default", async () => {
    const before = await sidebarWidth();
    const { x, y } = await handleCenter();
    await h.page.mouse.move(x, y);
    await h.page.mouse.down();
    await h.page.mouse.move(x + 600, y, { steps: 4 }); // far past the right edge
    await h.page.mouse.up();
    const clamped = await sidebarWidth();
    expect(Math.abs(clamped - 180)).toBeLessThanOrEqual(2);

    await h.page.locator("lif-editor .resizer").dblclick();
    const reset = await sidebarWidth();
    expect(Math.abs(reset - before)).toBeLessThanOrEqual(2);
  });

  test("arrow keys resize the focused divider", async () => {
    const before = await sidebarWidth();
    await h.page.locator("lif-editor .resizer").focus();
    await h.page.keyboard.press("ArrowLeft");
    await h.page.keyboard.press("ArrowLeft");
    const wider = await sidebarWidth();
    expect(Math.abs(wider - (before + 32))).toBeLessThanOrEqual(2);

    await h.page.keyboard.press("ArrowRight");
    const narrower = await sidebarWidth();
    expect(Math.abs(narrower - (before + 16))).toBeLessThanOrEqual(2);
  });
});

describe("<lif-editor> on-vehicle tooling", () => {
  test("double-way creates both directions in one gesture and one undo removes both", async () => {
    await h.page.locator('button[data-tool-button="add-node"]').click();
    await h.page.locator('#e svg[part="canvas"]').click({ position: { x: 300, y: 300 } });
    await h.page.locator('#e svg[part="canvas"]').click({ position: { x: 500, y: 300 } });

    await h.page.locator('button[data-action="double-way"]').click();
    await h.page.locator('button[data-tool-button="add-edge"]').click();
    await h.page.locator('#e circle[data-node-id="n1"]').click();
    await h.page.locator('#e circle[data-node-id="n2"]').click();

    let doc = await editorDoc();
    expect(doc.layouts[0]!.edges).toHaveLength(2);
    expect(doc.layouts[0]!.edges[0]).toMatchObject({ startNodeId: "n1", endNodeId: "n2" });
    expect(doc.layouts[0]!.edges[1]).toMatchObject({ startNodeId: "n2", endNodeId: "n1" });

    await h.page.locator('button[data-action="undo"]').click();
    doc = await editorDoc();
    expect(doc.layouts[0]!.edges).toHaveLength(0);
  });

  test("chain mode connects each placed node from the previously placed one", async () => {
    await h.page.locator('button[data-action="chain"]').click();
    await h.page.locator('button[data-tool-button="add-node"]').click();
    await h.page.locator('#e svg[part="canvas"]').click({ position: { x: 300, y: 300 } });
    await h.page.locator('#e svg[part="canvas"]').click({ position: { x: 420, y: 300 } });
    await h.page.locator('#e svg[part="canvas"]').click({ position: { x: 420, y: 200 } });

    const doc = await editorDoc();
    expect(doc.layouts[0]!.nodes).toHaveLength(3);
    expect(doc.layouts[0]!.edges).toHaveLength(2);
    expect(doc.layouts[0]!.edges[0]).toMatchObject({ startNodeId: "n1", endNodeId: "n2" });
    expect(doc.layouts[0]!.edges[1]).toMatchObject({ startNodeId: "n2", endNodeId: "n3" });
  });

  test("grid generator bulk-creates connected nodes", async () => {
    await h.page.locator('button[data-action="grid-generator"]').click();
    await h.page.locator('input[data-grid-field="xCount"]').fill("2");
    await h.page.locator('input[data-grid-field="yCount"]').fill("2");
    await h.page.locator('input[data-grid-field="spacing"]').fill("2");
    await h.page.locator('input[data-grid-field="idPrefix"]').fill("gg");
    await h.page.locator('button[data-action="generate-grid"]').click();

    const doc = await editorDoc();
    expect(doc.layouts[0]!.nodes.map((n) => n.nodeId)).toEqual(["gg1", "gg2", "gg3", "gg4"]);
    expect(doc.layouts[0]!.edges).toHaveLength(8); // 4 adjacencies × both directions
    expect(doc.layouts[0]!.nodes[3]!.nodePosition).toEqual({ x: 2, y: 2 });
    // Status bar reflects the result.
    await expect(h.page.locator('[data-stat="nodes"]').textContent()).resolves.toContain("4");
  });

  test("layout dialog creates, edits (rename) and deletes layouts", async () => {
    await h.page.locator('button[data-action="create-layout"]').click();
    await h.page.locator('input[data-dialog-field="layoutId"]').fill("upper");
    await h.page.locator('input[data-dialog-field="layoutName"]').fill("Upper floor");
    await h.page.locator('button[data-action="save-layout"]').click();

    let doc = await editorDoc();
    expect(doc.layouts.map((l) => l.layoutId)).toEqual(["layout-1", "upper"]);
    await expect(h.page.locator('[data-stat="layout"]').textContent()).resolves.toContain("upper");

    await h.page.locator('button[data-action="edit-layout"]').click();
    await h.page.locator('input[data-dialog-field="layoutId"]').fill("upper2");
    await h.page.locator('input[data-dialog-field="layoutLevelId"]').fill("2");
    await h.page.locator('button[data-action="save-layout"]').click();
    doc = await editorDoc();
    expect(doc.layouts[1]).toMatchObject({ layoutId: "upper2", layoutName: "Upper floor", layoutLevelId: "2" });

    // Deleting needs an explicit second confirmation click.
    await h.page.locator('button[data-action="edit-layout"]').click();
    await h.page.locator('button[data-action="delete-layout"]').click();
    await expect(h.page.locator('button[data-action="delete-layout"]').textContent()).resolves.toContain("Really");
    await h.page.locator('button[data-action="delete-layout"]').click();
    doc = await editorDoc();
    expect(doc.layouts.map((l) => l.layoutId)).toEqual(["layout-1"]);
  });

  test("layout dialog attaches a calibrated background image to the viewer", async () => {
    const PIXEL =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    await h.page.locator('button[data-action="edit-layout"]').click();
    // Inject the draft href directly (file-picker plumbing is browser-native).
    await h.page.evaluate((href) => {
      const editor = document.querySelector("lif-editor") as unknown as {
        layoutDialog: { bgHref: string; bgWidth: string; bgHeight: string } | null;
      };
      editor.layoutDialog = { ...editor.layoutDialog!, bgHref: href, bgWidth: "12", bgHeight: "6" };
    }, PIXEL);
    await h.page.locator('input[data-dialog-field="bgX"]').fill("1");
    await h.page.locator('input[data-dialog-field="bgY"]').fill("2");
    await h.page.locator('button[data-action="save-layout"]').click();

    const bg = await h.page.evaluate(() => {
      const editor = document.querySelector("lif-editor") as unknown as {
        backgrounds: Record<string, { x: number; y: number; width: number; height: number }>;
      };
      return editor.backgrounds["layout-1"];
    });
    expect(bg).toMatchObject({ x: 1, y: 2, width: 12, height: 6 });
    await expect(h.page.locator("#e image.background").count()).resolves.toBe(1);
    // Backgrounds are runtime-only: the exported LIF is unchanged by them.
    const exported = await h.page.evaluate(() =>
      (document.querySelector("lif-editor") as unknown as { exportJson(): string }).exportJson(),
    );
    expect(exported).not.toContain("background");
  });

  test("station position fields set and unset the optional stationPosition", async () => {
    await loadWarehouse();
    await h.page.locator('#e rect[data-station-id="st-charge"]').click();
    const x = h.page.locator('input[data-field="stationX"]');
    await expect(x.inputValue()).resolves.toBe("17");

    await x.fill("18.5");
    await x.press("Enter");
    let doc = await editorDoc();
    let station = doc.layouts[0]!.stations.find((s) => s.stationId === "st-charge")!;
    expect(station.stationPosition).toMatchObject({ x: 18.5, y: 0 });

    await h.page.locator('button[data-action="clear-station-position"]').click();
    doc = await editorDoc();
    station = doc.layouts[0]!.stations.find((s) => s.stationId === "st-charge")!;
    expect(station.stationPosition).toBeUndefined();
  });

  test("element search finds across layouts, selects and switches layout", async () => {
    await loadWarehouse();
    await h.page.locator('input[data-field="search"]').fill("buf");
    const results = h.page.locator(".search-results li");
    await expect(results.count()).resolves.toBeGreaterThanOrEqual(3);

    await h.page.locator('.search-results li[data-result-id="n-buf-b"]').click();
    await expect(h.page.locator('[data-stat="layout"]').textContent()).resolves.toContain("mezzanine");
    await expect(
      h.page.locator('[data-panel="properties"] h3').first().textContent(),
    ).resolves.toContain("node");
    // The viewer centres on the node once the layout switch has settled.
    const centred = async () =>
      h.page.evaluate(() => {
        const editor = document.querySelector("lif-editor")!;
        const viewer = editor.shadowRoot!.querySelector("lif-viewer")! as unknown as {
          view: { scale: number; tx: number; ty: number };
        } & Element;
        const screenX = 8 * viewer.view.scale + viewer.view.tx;
        const screenY = -8 * viewer.view.scale + viewer.view.ty;
        return { dx: Math.abs(screenX - viewer.clientWidth / 2), dy: Math.abs(screenY - viewer.clientHeight / 2) };
      });
    const deadline = Date.now() + 2000;
    let delta = await centred();
    while ((delta.dx >= 2 || delta.dy >= 2) && Date.now() < deadline) {
      await h.page.waitForTimeout(50);
      delta = await centred();
    }
    expect(delta.dx).toBeLessThan(2);
    expect(delta.dy).toBeLessThan(2);
  });

  test("display filters live in the map controls and toggle the scene layers", async () => {
    await loadWarehouse();
    await h.page.locator('#e button[data-action="display-menu"]').click();
    await expect(h.page.locator('#e [data-panel="display-menu"]').count()).resolves.toBe(1);
    await h.page.locator('#e input[data-view-flag="nodes"]').click();
    await expect(h.page.locator("#e circle.node-dot").count()).resolves.toBe(0);
    await h.page.locator('#e input[data-view-flag="nodes"]').click();
    await expect(h.page.locator("#e circle.node-dot").count()).resolves.toBe(6);
    // Clicking the canvas closes the popover.
    await h.page.locator('#e svg[part="canvas"]').click({ position: { x: 300, y: 200 } });
    await expect(h.page.locator('#e [data-panel="display-menu"]').count()).resolves.toBe(0);
  });

  test("rulers are a sub-element of the grid and follow its state", async () => {
    await loadWarehouse();
    await expect(h.page.locator("#e text.ruler-label").count()).resolves.toBeGreaterThan(0);
    await h.page.locator('#e button[data-action="display-menu"]').click();

    // Rulers off alone: grid lines stay, labels go.
    await h.page.locator('#e input[data-view-flag="rulers"]').click();
    await expect(h.page.locator("#e text.ruler-label").count()).resolves.toBe(0);
    await expect(h.page.locator("#e line.grid-line").count()).resolves.toBeGreaterThan(0);
    await h.page.locator('#e input[data-view-flag="rulers"]').click();
    await expect(h.page.locator("#e text.ruler-label").count()).resolves.toBeGreaterThan(0);

    // Grid off: lines AND labels go, and the rulers checkbox is disabled.
    await h.page.locator('#e input[data-view-flag="grid"]').click();
    await expect(h.page.locator("#e line.grid-line").count()).resolves.toBe(0);
    await expect(h.page.locator("#e text.ruler-label").count()).resolves.toBe(0);
    await expect(
      h.page.locator('#e input[data-view-flag="rulers"]').isDisabled(),
    ).resolves.toBe(true);

    // Grid back on: rulers return with it (their own flag stayed true).
    await h.page.locator('#e input[data-view-flag="grid"]').click();
    await expect(h.page.locator("#e text.ruler-label").count()).resolves.toBeGreaterThan(0);
    await expect(
      h.page.locator('#e input[data-view-flag="rulers"]').isDisabled(),
    ).resolves.toBe(false);
  });

  test("measure tool exposes the four options and length measuring works end to end", async () => {
    await loadWarehouse();
    await h.page.locator('button[data-action="measure"]').click();
    await expect(h.page.locator("lif-editor lif-viewer[measuring]").count()).resolves.toBe(1);

    // The four sub-options appear, titled like the reference editor.
    for (const title of ["Measure Length", "Measure Area", "Show Segment Lengths", "Clear Previous Measure"]) {
      await expect(h.page.locator(`lif-editor button[title="${title}"]`).count()).resolves.toBe(1);
    }
    await expect(
      h.page.locator('button[data-action="measure-length"]').getAttribute("aria-pressed"),
    ).resolves.toBe("true");

    await h.page.locator('#e svg[part="canvas"]').click({ position: { x: 300, y: 300 } });
    await h.page.locator('#e svg[part="canvas"]').click({ position: { x: 400, y: 300 } });
    await h.page.locator('#e svg[part="canvas"]').dblclick({ position: { x: 400, y: 300 } });
    await expect(h.page.locator("#e g[data-measurement]").count()).resolves.toBe(1);
    await expect(h.page.locator("#e text.measure-total").count()).resolves.toBe(1);
    await expect(h.page.locator('[data-stat="measure"]').count()).resolves.toBe(1);

    // Segment-labels toggle.
    await expect(h.page.locator("#e text.measure-seg-label").count()).resolves.toBe(1);
    await h.page.locator('button[data-action="measure-segments"]').click();
    await expect(h.page.locator("#e text.measure-seg-label").count()).resolves.toBe(0);

    // Clear Previous Measure removes the finished measurement.
    await h.page.locator('button[data-action="measure-clear"]').click();
    await expect(h.page.locator("#e g[data-measurement]").count()).resolves.toBe(0);

    // No pending drawing → Esc exits the tool and the sub-options disappear.
    await h.page.keyboard.press("Escape");
    await expect(h.page.locator("lif-editor lif-viewer[measuring]").count()).resolves.toBe(0);
    await expect(h.page.locator('button[data-action="measure-length"]').count()).resolves.toBe(0);
  });

  test("measure area mode and Esc-cancels-pending behaviour", async () => {
    await loadWarehouse();
    await h.page.locator('button[data-action="measure"]').click();
    await h.page.locator('button[data-action="measure-area"]').click();
    await expect(
      h.page.locator('button[data-action="measure-area"]').getAttribute("aria-pressed"),
    ).resolves.toBe("true");

    await h.page.locator('#e svg[part="canvas"]').click({ position: { x: 300, y: 300 } });
    await h.page.locator('#e svg[part="canvas"]').click({ position: { x: 420, y: 300 } });
    await h.page.locator('#e svg[part="canvas"]').click({ position: { x: 420, y: 380 } });
    await h.page.locator('#e svg[part="canvas"]').dblclick({ position: { x: 420, y: 380 } });
    await expect(h.page.locator("#e text[data-measure-area]").count()).resolves.toBe(1);

    // Start another polygon, then Esc: cancels the pending drawing but stays in the tool…
    await h.page.locator('#e svg[part="canvas"]').click({ position: { x: 500, y: 300 } });
    await h.page.keyboard.press("Escape");
    await expect(h.page.locator("lif-editor lif-viewer[measuring]").count()).resolves.toBe(1);
    await expect(h.page.locator("#e g[data-measurement]").count()).resolves.toBe(1);
    // …and a second Esc leaves measuring entirely.
    await h.page.keyboard.press("Escape");
    await expect(h.page.locator("lif-editor lif-viewer[measuring]").count()).resolves.toBe(0);
  });

  test("status bar counts follow the document and toggle the checks panel", async () => {
    await loadWarehouse();
    await expect(h.page.locator('[data-stat="nodes"]').textContent()).resolves.toContain("6");
    await expect(h.page.locator('[data-stat="edges"]').textContent()).resolves.toContain("8");
    await expect(h.page.locator('[data-stat="stations"]').textContent()).resolves.toContain("2");
    await h.page.locator('button[data-action="status-checks"]').click();
    await expect(h.page.locator(".diagnostics").count()).resolves.toBe(1);
  });

  test("the theme toggle icon survives repeated toggles (fragment-reuse regression)", async () => {
    const iconCount = () => h.page.locator('button[data-action="theme"] svg').count();
    await expect(iconCount()).resolves.toBe(1);
    for (let i = 0; i < 3; i++) {
      await h.page.locator('button[data-action="theme"]').click();
      await expect(iconCount()).resolves.toBe(1);
    }
  });

  test("the theme toggle switches dark tokens on the editor and propagates to the viewer", async () => {
    await loadWarehouse();
    const surface = () =>
      h.page.evaluate(() => {
        const editor = document.querySelector("lif-editor")!;
        const viewer = editor.shadowRoot!.querySelector("lif-viewer")!;
        return {
          editorTheme: editor.getAttribute("theme"),
          viewerTheme: viewer.getAttribute("theme"),
          canvas: getComputedStyle(viewer).backgroundColor,
        };
      });

    const light = await surface();
    expect(light.viewerTheme).toBe("light");
    await h.page.locator('button[data-action="theme"]').click();
    const dark = await surface();
    expect(dark.editorTheme).toBe("dark");
    expect(dark.viewerTheme).toBe("dark");
    expect(dark.canvas).toBe("rgb(26, 26, 25)"); // #1a1a19
    expect(dark.canvas).not.toBe(light.canvas);

    await h.page.locator('button[data-action="theme"]').click();
    expect((await surface()).viewerTheme).toBe("light");
  });
});

describe("<lif-editor> keyboard bindings", () => {
  async function focusCanvas(): Promise<void> {
    await h.page.locator('#e svg[part="canvas"]').click({ position: { x: 200, y: 200 } });
  }
  const pressed = (selector: string) => h.page.locator(selector).getAttribute("aria-pressed");

  test("letter keys switch tools and toggle modes", async () => {
    await focusCanvas();
    await h.page.keyboard.press("n");
    await expect(pressed('button[data-tool-button="add-node"]')).resolves.toBe("true");
    await h.page.keyboard.press("e");
    await expect(pressed('button[data-tool-button="add-edge"]')).resolves.toBe("true");
    await h.page.keyboard.press("s");
    await expect(pressed('button[data-tool-button="add-station"]')).resolves.toBe("true");
    await h.page.keyboard.press("v");
    await expect(pressed('button[data-tool-button="select"]')).resolves.toBe("true");

    await h.page.keyboard.press("d");
    await expect(pressed('button[data-action="double-way"]')).resolves.toBe("true");
    await h.page.keyboard.press("c");
    await expect(pressed('button[data-action="chain"]')).resolves.toBe("true");

    await h.page.keyboard.press("m");
    await expect(h.page.locator("lif-editor lif-viewer[measuring]").count()).resolves.toBe(1);
    await h.page.keyboard.press("m");
    await expect(h.page.locator("lif-editor lif-viewer[measuring]").count()).resolves.toBe(0);

    await h.page.keyboard.press("g");
    await expect(h.page.locator("#e line.grid-line").count()).resolves.toBe(0);
    await h.page.keyboard.press("g");
    await expect(h.page.locator("#e line.grid-line").count()).resolves.toBeGreaterThan(0);
  });

  test("zoom keys step the view and 0 refits", async () => {
    await loadWarehouse();
    await focusCanvas();
    const scale = () =>
      h.page.evaluate(
        () =>
          (document.querySelector("lif-editor")!.shadowRoot!.querySelector("lif-viewer") as unknown as {
            view: { scale: number };
          }).view.scale,
      );
    const fitted = await scale();
    await h.page.keyboard.press("+");
    expect(await scale()).toBeGreaterThan(fitted);
    await h.page.keyboard.press("-");
    expect(await scale()).toBeCloseTo(fitted, 5);
    await h.page.keyboard.press("+");
    await h.page.keyboard.press("0");
    expect(await scale()).toBeCloseTo(fitted, 5);
  });

  test("arrow keys nudge the selected node in world metres", async () => {
    await loadWarehouse();
    await h.page.locator('#e circle[data-node-id="n-dock"]').click();
    await h.page.keyboard.press("ArrowRight");
    let doc = await editorDoc();
    expect(doc.layouts[0]!.nodes.find((n) => n.nodeId === "n-dock")!.nodePosition).toEqual({
      x: 0.1,
      y: 0,
    });
    await h.page.keyboard.press("Shift+ArrowUp");
    doc = await editorDoc();
    expect(doc.layouts[0]!.nodes.find((n) => n.nodeId === "n-dock")!.nodePosition).toEqual({
      x: 0.1,
      y: 1,
    });
    // Two undos restore the original position.
    await h.page.keyboard.press("Control+z");
    await h.page.keyboard.press("Control+z");
    doc = await editorDoc();
    expect(doc.layouts[0]!.nodes.find((n) => n.nodeId === "n-dock")!.nodePosition).toEqual({
      x: 0,
      y: 0,
    });
  });

  test("fullscreen targets the whole editor, from the button and the F key", async () => {
    await loadWarehouse();
    // The map-control button expands the editor host, not just the map.
    await h.page.locator('#e button[data-action="fullscreen"]').click();
    await h.page.waitForFunction(() => document.fullscreenElement?.tagName === "LIF-EDITOR");
    await h.page.locator('#e button[data-action="fullscreen"]').click();
    await h.page.waitForFunction(() => document.fullscreenElement === null);

    await focusCanvas();
    await h.page.keyboard.press("f");
    await h.page.waitForFunction(() => document.fullscreenElement?.tagName === "LIF-EDITOR");
    await h.page.keyboard.press("f");
    await h.page.waitForFunction(() => document.fullscreenElement === null);
  });

  test("? opens the shortcuts overlay; / focuses search; typing never triggers tools", async () => {
    await focusCanvas();
    await h.page.keyboard.press("?");
    await expect(h.page.locator('[data-panel="shortcuts"]').count()).resolves.toBe(1);
    await expect(h.page.locator('[data-panel="shortcuts"]').textContent()).resolves.toContain("Undo");
    await h.page.keyboard.press("Escape");
    await expect(h.page.locator('[data-panel="shortcuts"]').count()).resolves.toBe(0);

    await h.page.keyboard.press("/");
    const focused = await h.page.evaluate(
      () =>
        document
          .querySelector("lif-editor")!
          .shadowRoot!.activeElement?.getAttribute("data-field") ?? null,
    );
    expect(focused).toBe("search");

    // With the search field focused, tool letters are just text.
    await h.page.keyboard.type("nes");
    await expect(pressed('button[data-tool-button="select"]')).resolves.toBe("true");
    await expect(
      h.page.locator('input[data-field="search"]').inputValue(),
    ).resolves.toBe("nes");
  });
});

describe("<lif-editor> vehicle profile and actions", () => {
  async function setProfile(): Promise<void> {
    await h.page.evaluate(() => {
      const editor = document.querySelector("lif-editor") as unknown as {
        vehicleProfile: unknown;
      };
      editor.vehicleProfile = {
        vehicleTypeId: "veh.one",
        defaults: { rotationAllowed: true, maxSpeed: 1.1, orientationType: "TANGENTIAL" },
        limits: { maxSpeed: 1.5, maxHeight: 2.0 },
        supportedActions: [
          {
            actionType: "pick",
            description: "Pick up a load",
            scopes: ["NODE"],
            defaultRequirementType: "CONDITIONAL",
            defaultBlockingType: "HARD",
          },
          { actionType: "beep", defaultRequirementType: "OPTIONAL", defaultBlockingType: "NONE" },
        ],
      };
    });
  }

  test("profile drives creation defaults for nodes and edges", async () => {
    await setProfile();
    await h.page.locator('button[data-tool-button="add-node"]').click();
    await h.page.locator('#e svg[part="canvas"]').click({ position: { x: 300, y: 300 } });
    await h.page.locator('#e svg[part="canvas"]').click({ position: { x: 500, y: 300 } });
    await h.page.locator('button[data-tool-button="add-edge"]').click();
    await h.page.locator('#e circle[data-node-id="n1"]').click();
    await h.page.locator('#e circle[data-node-id="n2"]').click();

    const doc = await editorDoc();
    expect(doc.layouts[0]!.nodes[0]!.vehicleTypeNodeProperties[0]!.vehicleTypeId).toBe("veh.one");
    expect(doc.layouts[0]!.edges[0]!.vehicleTypeEdgeProperties[0]).toMatchObject({
      vehicleTypeId: "veh.one",
      rotationAllowed: true,
      maxSpeed: 1.1,
      orientationType: "TANGENTIAL",
    });
  });

  test("node vehicle section edits theta and manages the palette-driven actions", async () => {
    await setProfile();
    await h.page.locator('button[data-tool-button="add-node"]').click();
    await h.page.locator('#e svg[part="canvas"]').click({ position: { x: 350, y: 300 } });
    await h.page.locator('button[data-tool-button="select"]').click();
    await h.page.locator('#e circle[data-node-id="n1"]').click();

    // θ
    const theta = h.page.locator('input[data-field="vehicleTheta"]');
    await theta.fill("1.57");
    await theta.press("Enter");
    let doc = await editorDoc();
    expect(doc.layouts[0]!.nodes[0]!.vehicleTypeNodeProperties[0]!.theta).toBeCloseTo(1.57, 6);

    // Palette add: NODE scope offers pick and beep.
    const addSelect = h.page.locator('select[data-action="add-action"]');
    await expect(addSelect.locator("option").allTextContents()).resolves.toEqual([
      "+ Add action…",
      "pick",
      "beep",
    ]);
    await addSelect.selectOption("pick");
    doc = await editorDoc();
    const action = doc.layouts[0]!.nodes[0]!.vehicleTypeNodeProperties[0]!.actions![0]!;
    expect(action).toMatchObject({
      actionType: "pick",
      actionDescription: "Pick up a load",
      requirementType: "CONDITIONAL",
      blockingType: "HARD",
    });

    // Edit requirement + add a parameter.
    await h.page.locator('select[data-afield="requirementType"]').selectOption("REQUIRED");
    await h.page.locator('button[data-action="add-param"]').click();
    await h.page.locator('input[data-pfield="key"]').fill("loadType");
    await h.page.locator('input[data-pfield="key"]').press("Enter");
    await h.page.locator('input[data-pfield="value"]').fill("EUR-pallet");
    await h.page.locator('input[data-pfield="value"]').press("Enter");
    doc = await editorDoc();
    const edited = doc.layouts[0]!.nodes[0]!.vehicleTypeNodeProperties[0]!.actions![0]!;
    expect(edited.requirementType).toBe("REQUIRED");
    expect(edited.actionParameters).toEqual([{ key: "loadType", value: "EUR-pallet" }]);

    // Remove the action again.
    await h.page.locator('button[data-action="remove-action"]').click();
    doc = await editorDoc();
    expect(doc.layouts[0]!.nodes[0]!.vehicleTypeNodeProperties[0]!.actions).toBeUndefined();
  });

  test("edge vehicle section edits movement fields and warns beyond vehicle limits", async () => {
    await setProfile();
    await h.page.locator('button[data-tool-button="add-node"]').click();
    await h.page.locator('#e svg[part="canvas"]').click({ position: { x: 300, y: 300 } });
    await h.page.locator('#e svg[part="canvas"]').click({ position: { x: 500, y: 300 } });
    await h.page.locator('button[data-tool-button="add-edge"]').click();
    await h.page.locator('#e circle[data-node-id="n1"]').click();
    await h.page.locator('#e circle[data-node-id="n2"]').click();

    const speed = h.page.locator('input[data-field="maxSpeed"]');
    await expect(speed.inputValue()).resolves.toBe("1.1");
    await speed.fill("2.5"); // beyond limits.maxSpeed = 1.5
    await speed.press("Enter");
    let doc = await editorDoc();
    expect(doc.layouts[0]!.edges[0]!.vehicleTypeEdgeProperties[0]!.maxSpeed).toBe(2.5);
    await expect(h.page.locator('[data-limit-warning="maxSpeed"]').count()).resolves.toBe(1);

    await speed.fill("1.4");
    await speed.press("Enter");
    await expect(h.page.locator('[data-limit-warning="maxSpeed"]').count()).resolves.toBe(0);

    // Enum with explicit unset default.
    await h.page.locator('select[data-field="rotationAtStartNodeAllowed"]').selectOption("CW");
    doc = await editorDoc();
    expect(doc.layouts[0]!.edges[0]!.vehicleTypeEdgeProperties[0]!.rotationAtStartNodeAllowed).toBe("CW");

    // Blank a number to unset it.
    await speed.fill("");
    await speed.press("Enter");
    doc = await editorDoc();
    expect(doc.layouts[0]!.edges[0]!.vehicleTypeEdgeProperties[0]!.maxSpeed).toBeUndefined();
  });

  test("enable/remove the vehicle on elements that lack its type", async () => {
    await setProfile();
    await loadWarehouse(); // warehouse types are acme.*, not veh.one
    await h.page.locator('#e circle[data-node-id="n-dock"]').click();
    await expect(h.page.locator('[data-vehicle-section="node"]').textContent()).resolves.toContain(
      "not enabled for veh.one",
    );
    await h.page.locator('button[data-action="enable-vehicle"]').click();
    let doc = await editorDoc();
    let types = doc.layouts[0]!.nodes[0]!.vehicleTypeNodeProperties.map((p) => p.vehicleTypeId);
    expect(types).toEqual(["acme.tugger", "acme.forklift", "veh.one"]);
    await expect(
      h.page.locator('details[data-vehicle-other="acme.tugger"] summary').textContent(),
    ).resolves.toContain("acme.tugger");

    // The primary section's remove button (each other-type section has its own).
    await h.page
      .locator('[data-vehicle-section="node"] button[data-action="remove-vehicle"]')
      .click();
    doc = await editorDoc();
    types = doc.layouts[0]!.nodes[0]!.vehicleTypeNodeProperties.map((p) => p.vehicleTypeId);
    expect(types).toEqual(["acme.tugger", "acme.forklift"]);
  });

  test("other-type sections edit their own properties without the raw-JSON hatch", async () => {
    await loadWarehouse(); // no profile: primary = first sorted type (acme.forklift)
    // Pick a straight edge carrying both types and click its midpoint.
    const target = await h.page.evaluate(() => {
      const editor = document.querySelector("lif-editor")!;
      const doc = (editor as unknown as { lif: Lif }).lif;
      const layout = doc.layouts[0]!;
      const edge = layout.edges.find(
        (e) =>
          e.vehicleTypeEdgeProperties.length >= 2 &&
          !e.vehicleTypeEdgeProperties.some((p) => p.trajectory),
      )!;
      const pos = (id: string) => layout.nodes.find((n) => n.nodeId === id)!.nodePosition;
      const a = pos(edge.startNodeId);
      const b = pos(edge.endNodeId);
      const viewer = editor.shadowRoot!.querySelector("lif-viewer")!;
      const view = (viewer as unknown as { view: { scale: number; tx: number; ty: number } }).view;
      const rect = viewer.getBoundingClientRect();
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      return {
        edgeId: edge.edgeId,
        x: rect.left + mx * view.scale + view.tx,
        y: rect.top + (-my * view.scale + view.ty),
      };
    });
    const edgeId = target.edgeId;
    await h.page.mouse.click(target.x, target.y);
    await h.page.locator('[data-vehicle-section="edge"]').waitFor({ timeout: 5000 });

    const other = h.page.locator('details[data-vehicle-other="acme.tugger"]');
    await other.locator("summary").click();
    await other.locator('input[data-field="maxSpeed"]').fill("0.35");
    await other.locator('input[data-field="maxSpeed"]').press("Enter");

    const prop = await h.page.evaluate(
      ([id]) => {
        const editor = document.querySelector("lif-editor") as unknown as { lif: Lif };
        return editor.lif.layouts[0]!.edges
          .find((e) => e.edgeId === id)!
          .vehicleTypeEdgeProperties.find((p) => p.vehicleTypeId === "acme.tugger");
      },
      [edgeId],
    );
    expect(prop).toMatchObject({ vehicleTypeId: "acme.tugger", maxSpeed: 0.35 });
  });

  test("without a profile, action types are free text", async () => {
    await h.page.locator('button[data-tool-button="add-node"]').click();
    await h.page.locator('#e svg[part="canvas"]').click({ position: { x: 350, y: 300 } });
    await h.page.locator('button[data-tool-button="select"]').click();
    await h.page.locator('#e circle[data-node-id="n1"]').click();

    await h.page.locator('button[data-action="add-action"]').click();
    const typeInput = h.page.locator('input[data-afield="actionType"]');
    await typeInput.fill("customBeep");
    await typeInput.press("Enter");
    await h.page.locator('select[data-afield="blockingType"]').selectOption("SOFT");

    const doc = await editorDoc();
    const action = doc.layouts[0]!.nodes[0]!.vehicleTypeNodeProperties[0]!.actions![0]!;
    expect(action).toMatchObject({ actionType: "customBeep", blockingType: "SOFT" });
  });
});

describe("<lif-editor> vehicle types manager and analysis", () => {
  test("manager lists coverage, renames document-wide, completes and removes types", async () => {
    await loadWarehouse();
    // Nothing selected → document panel with the types manager.
    const tugRow = h.page.locator('[data-type-row="acme.tugger"]');
    await expect(tugRow.locator("[data-type-coverage]").textContent()).resolves.toMatch(
      /\d+\/\d+ nodes · \d+\/\d+ edges/,
    );

    // Rename sweeps every property entry.
    const forkInput = h.page.locator('[data-type-row="acme.forklift"] input[data-field="typeId"]');
    await forkInput.fill("acme.lifter");
    await forkInput.press("Enter");
    let doc = await editorDoc();
    const allTypes = (d: Lif) =>
      new Set(
        d.layouts.flatMap((l) => [
          ...l.nodes.flatMap((n) => n.vehicleTypeNodeProperties.map((p) => p.vehicleTypeId)),
          ...l.edges.flatMap((e) => e.vehicleTypeEdgeProperties.map((p) => p.vehicleTypeId)),
        ]),
      );
    expect(allTypes(doc)).toEqual(new Set(["acme.tugger", "acme.lifter"]));

    // A brand-new type added to every node and edge.
    await h.page.locator('input[data-field="newTypeId"]').fill("test.rover");
    await h.page.locator('button[data-action="add-type-everywhere"]').click();
    const roverRow = h.page.locator('[data-type-row="test.rover"]');
    const coverage = (await roverRow.locator("[data-type-coverage]").textContent())!;
    const [, n, nTotal, e, eTotal] = coverage.match(/(\d+)\/(\d+) nodes · (\d+)\/(\d+) edges/)!;
    expect(n).toBe(nTotal);
    expect(e).toBe(eTotal);
    // Complete rows offer no "Complete" button.
    await expect(roverRow.locator('[data-action="complete-type"]').count()).resolves.toBe(0);

    // Removal is a two-click confirm and sweeps the document.
    await roverRow.locator('button[data-action="remove-type"]').click();
    await expect(
      roverRow.locator('button[data-action="remove-type"]').textContent(),
    ).resolves.toContain("Confirm");
    await roverRow.locator('button[data-action="remove-type"]').click();
    doc = await editorDoc();
    expect(allTypes(doc).has("test.rover")).toBe(false);
  });

  test("Document and Vehicle types panels have toolbar toggles, freeing space for Checks", async () => {
    await loadWarehouse();
    // Both visible by default with nothing selected.
    await expect(h.page.locator('[data-panel="document"]').count()).resolves.toBe(1);
    await expect(h.page.locator('[data-panel="vehicle-types"]').count()).resolves.toBe(1);

    await h.page.locator('button[data-action="toggle-document"]').click();
    await expect(h.page.locator('[data-panel="document"]').count()).resolves.toBe(0);
    await expect(h.page.locator('[data-panel="vehicle-types"]').count()).resolves.toBe(1);

    await h.page.locator('button[data-action="toggle-types"]').click();
    await expect(h.page.locator('[data-panel="vehicle-types"]').count()).resolves.toBe(0);

    // With both hidden, Checks is the sidebar's only panel.
    await h.page.locator('button[data-action="toggle-diagnostics"]').click();
    await expect(h.page.locator(".sidebar .panel").count()).resolves.toBe(1);
    await expect(h.page.locator(".sidebar .panel h3").first().textContent()).resolves.toBe(
      "Checks",
    );

    // The toggles report pressed state and bring their sections back.
    await expect(
      h.page.locator('button[data-action="toggle-document"]').getAttribute("aria-pressed"),
    ).resolves.toBe("false");
    await h.page.locator('button[data-action="toggle-document"]').click();
    await h.page.locator('button[data-action="toggle-types"]').click();
    await expect(h.page.locator('[data-panel="document"]').count()).resolves.toBe(1);
    await expect(h.page.locator('[data-panel="vehicle-types"]').count()).resolves.toBe(1);
  });

  test("coverage highlight toggles the map's vehicle-type filter", async () => {
    await loadWarehouse();
    await h.page.locator('[data-type-row="acme.forklift"] button[data-action="filter-type"]').click();
    await expect(
      h.page.locator('select[data-action="vehicle-filter"]').inputValue(),
    ).resolves.toBe("acme.forklift");
    await h.page.locator('[data-type-row="acme.forklift"] button[data-action="filter-type"]').click();
    await expect(
      h.page.locator('select[data-action="vehicle-filter"]').inputValue(),
    ).resolves.toBe("");
  });

  test("network analysis surfaces coverage gaps and one-way traps in the checks", async () => {
    await h.page.evaluate(() => {
      const doc = {
        metaInformation: {
          projectIdentification: "analysis",
          creator: "test",
          exportTimestamp: "2026-07-09T00:00:00Z",
          lifVersion: "1.0.0",
        },
        layouts: [
          {
            layoutId: "L",
            layoutVersion: "1",
            nodes: [
              { nodeId: "a", nodePosition: { x: 0, y: 0 }, vehicleTypeNodeProperties: [{ vehicleTypeId: "t" }] },
              { nodeId: "b", nodePosition: { x: 2, y: 0 }, vehicleTypeNodeProperties: [{ vehicleTypeId: "t" }] },
              { nodeId: "c", nodePosition: { x: 4, y: 0 }, vehicleTypeNodeProperties: [] },
            ],
            edges: [
              {
                edgeId: "one-way",
                startNodeId: "a",
                endNodeId: "b",
                vehicleTypeEdgeProperties: [{ vehicleTypeId: "t", rotationAllowed: false }],
              },
            ],
            stations: [],
          },
        ],
      };
      const editor = document.querySelector("lif-editor") as unknown as {
        loadJson(text: string): unknown;
      };
      editor.loadJson(JSON.stringify(doc));
    });
    const codes = await h.page.evaluate(() => {
      const editor = document.querySelector("lif-editor") as unknown as {
        diagnostics: { code: string; message: string }[];
      };
      return editor.diagnostics.map((d) => d.code);
    });
    expect(codes).toContain("LIF-A001"); // node "c" unusable for "t"
    expect(codes).toContain("LIF-A004"); // "b" is enterable but not leavable
  });
});

describe("<lif-editor> marquee bulk selection", () => {
  test("Shift+drag selects, bulk-applies edge properties, and bulk-deletes with confirm", async () => {
    await loadWarehouse();
    // Marquee across the whole aisle row (world y ≈ 0): compute screen rect.
    const rect = await h.page.evaluate(() => {
      const editor = document.querySelector("lif-editor")!;
      const viewer = editor.shadowRoot!.querySelector("lif-viewer")!;
      const v = (viewer as unknown as { view: { scale: number; tx: number; ty: number } }).view;
      const r = viewer.getBoundingClientRect();
      const sx = (wx: number) => r.left + wx * v.scale + v.tx;
      const sy = (wy: number) => r.top + -wy * v.scale + v.ty;
      return { x0: sx(-1), y0: sy(1), x1: sx(17), y1: sy(-1) };
    });
    await h.page.keyboard.down("Shift");
    await h.page.mouse.move(rect.x0, rect.y0);
    await h.page.mouse.down();
    await h.page.mouse.move(rect.x1, rect.y1, { steps: 3 });
    await h.page.mouse.up();
    await h.page.keyboard.up("Shift");

    // Aisle row: n-dock, n-aisle-w, n-aisle-e, n-charge + the edges between them.
    const counts = h.page.locator("[data-bulk-counts]");
    await expect(counts.textContent()).resolves.toContain("4 nodes");
    const countsText = (await counts.textContent())!;
    const edgeCount = Number(countsText.match(/(\d+) edges/)?.[1]);
    expect(edgeCount).toBeGreaterThanOrEqual(4);

    // Bulk-apply a max speed for acme.tugger on all selected edges.
    await h.page.locator('select[data-field="bulkType"]').selectOption("acme.tugger");
    await h.page.locator('input[data-field="bulkMaxSpeed"]').fill("0.9");
    await h.page.locator('button[data-action="bulk-apply-edges"]').click();
    let doc = await editorDoc();
    const tuggerAisleSpeeds = doc.layouts[0]!.edges
      .filter((e) => ["e-dock-west", "e-west-east", "e-east-west", "e-east-charge"].includes(e.edgeId))
      .map((e) => e.vehicleTypeEdgeProperties.find((p) => p.vehicleTypeId === "acme.tugger")?.maxSpeed);
    expect(tuggerAisleSpeeds).toEqual([0.9, 0.9, 0.9, 0.9]);

    // Delete needs a confirming second click, then everything selected goes.
    const nodesBefore = doc.layouts[0]!.nodes.length;
    await h.page.locator('button[data-action="bulk-delete"]').click();
    await expect(
      h.page.locator('button[data-action="bulk-delete"]').textContent(),
    ).resolves.toContain("Confirm");
    await h.page.locator('button[data-action="bulk-delete"]').click();
    doc = await editorDoc();
    expect(doc.layouts[0]!.nodes.length).toBe(nodesBefore - 4);
    expect(doc.layouts[0]!.nodes.map((n) => n.nodeId)).not.toContain("n-dock");
    // One undo step restores the lot.
    await h.page.locator('button[data-action="undo"]').click();
    doc = await editorDoc();
    expect(doc.layouts[0]!.nodes.length).toBe(nodesBefore);
  });

  test("marquee enables a vehicle type on the selection; Esc clears it", async () => {
    await loadWarehouse();
    const rect = await h.page.evaluate(() => {
      const editor = document.querySelector("lif-editor")!;
      const viewer = editor.shadowRoot!.querySelector("lif-viewer")!;
      const v = (viewer as unknown as { view: { scale: number; tx: number; ty: number } }).view;
      const r = viewer.getBoundingClientRect();
      const sx = (wx: number) => r.left + wx * v.scale + v.tx;
      const sy = (wy: number) => r.top + -wy * v.scale + v.ty;
      return { x0: sx(-1), y0: sy(1), x1: sx(17), y1: sy(-1) };
    });
    await h.page.keyboard.down("Shift");
    await h.page.mouse.move(rect.x0, rect.y0);
    await h.page.mouse.down();
    await h.page.mouse.move(rect.x1, rect.y1, { steps: 3 });
    await h.page.mouse.up();
    await h.page.keyboard.up("Shift");
    await h.page.locator("[data-bulk-counts]").waitFor();

    await h.page.locator('select[data-field="bulkType"]').selectOption("acme.forklift");
    await h.page.locator('button[data-action="bulk-enable-type"]').click();
    const doc = await editorDoc();
    const dock = doc.layouts[0]!.nodes.find((n) => n.nodeId === "n-dock")!;
    expect(dock.vehicleTypeNodeProperties.some((p) => p.vehicleTypeId === "acme.forklift")).toBe(
      true,
    );

    await h.page.keyboard.press("Escape");
    await expect(h.page.locator("[data-bulk-counts]").count()).resolves.toBe(0);
  });
});

describe("<lif-editor> lif-change contract", () => {
  test("every committed edit emits lif-change with the new document; selection does not", async () => {
    await loadWarehouse();
    await h.page.evaluate(() => {
      (window as unknown as { changes: unknown[] }).changes = [];
      document.querySelector("lif-editor")!.addEventListener("lif-change", (ev) => {
        const detail = (ev as CustomEvent<{ lif: { layouts: { nodes: unknown[] }[] } }>).detail;
        (window as unknown as { changes: unknown[] }).changes.push(
          detail.lif.layouts[0]!.nodes.length,
        );
      });
    });
    // Selecting an element is not a document change.
    await h.page.locator('#e circle[data-node-id="n-dock"]').click();
    await expect(
      h.page.evaluate(() => (window as unknown as { changes: unknown[] }).changes.length),
    ).resolves.toBe(0);
    // One created node → exactly one event carrying the updated document.
    await h.page.locator('button[data-tool-button="add-node"]').click();
    await h.page.locator('#e svg[part="canvas"]').click({ position: { x: 320, y: 320 } });
    const changes = await h.page.evaluate(
      () => (window as unknown as { changes: number[] }).changes,
    );
    expect(changes).toEqual([7]); // warehouse ground had 6 nodes
  });
});

describe("<lif-editor> import/export and validation", () => {
  test("importing the quirky legacy fixture surfaces diagnostics and exports normalized JSON", async () => {
    const count = await h.page.evaluate(() =>
      window.loadFixtureIntoEditor("quirks-legacy.lif.json", "#e"),
    );
    expect(count).toBeGreaterThanOrEqual(6);

    // On a fresh import (not yet edited), the panel shows the load-time notices.
    await h.page.locator('button[data-action="toggle-diagnostics"]').click();
    const items = await h.page.locator(".diagnostics li").count();
    expect(items).toBeGreaterThanOrEqual(6);

    const exported = await h.page.evaluate(() => {
      const editor = document.querySelector("lif-editor") as unknown as {
        exportJson(): string;
      };
      return editor.exportJson();
    });
    const parsed = JSON.parse(exported);
    expect(parsed.layouts[1].stations[0].stationHeight).toBe(0.55);
    expect(parsed.layouts[0].nodes[0].vehicleTypeNodeProperties[0].actions[0].requirementType).toBe(
      "REQUIRED",
    );
    expect(parsed.layouts[0].stations).toEqual([]);
    // Export refreshed the timestamp.
    expect(parsed.metaInformation.exportTimestamp).not.toBe("2026-07-06T10:00:00.00Z");
  });

  test("validation panel reports semantic errors for a broken document", async () => {
    await h.page.evaluate(() =>
      window.loadFixtureIntoEditor("invalid-semantics.lif.json", "#e"),
    );
    await h.page.locator('button[data-action="toggle-diagnostics"]').click();
    await expect(h.page.locator(".diagnostics li.severity-error").count()).resolves.toBeGreaterThanOrEqual(10);
    const badge = await h.page.locator(".badge").textContent();
    expect(Number(badge)).toBeGreaterThanOrEqual(10);
  });

  test("Ctrl+Z / Ctrl+Shift+Z drive undo/redo from the keyboard", async () => {
    await h.page.locator('button[data-tool-button="add-node"]').click();
    await h.page.locator('#e svg[part="canvas"]').click({ position: { x: 300, y: 300 } });
    expect((await editorDoc()).layouts[0]!.nodes).toHaveLength(1);

    await h.page.keyboard.press("Control+z");
    expect((await editorDoc()).layouts[0]!.nodes).toHaveLength(0);
    await h.page.keyboard.press("Control+Shift+z");
    expect((await editorDoc()).layouts[0]!.nodes).toHaveLength(1);
  });
});
