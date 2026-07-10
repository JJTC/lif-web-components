import { describe, expect, test } from "bun:test";
import { parseLif, serializeLif } from "../../src/lif";
import { loadFixture } from "./helpers";

describe("serializeLif", () => {
  test("pretty-prints with two spaces by default", async () => {
    const { lif } = parseLif(await loadFixture("minimal.lif.json"));
    const out = serializeLif(lif);
    expect(out).toContain('\n  "metaInformation": {');
    expect(out.endsWith("}")).toBe(true);
  });

  test("indent 0 produces compact output", async () => {
    const { lif } = parseLif(await loadFixture("minimal.lif.json"));
    const out = serializeLif(lif, { indent: 0 });
    expect(out).not.toContain("\n");
    expect(JSON.parse(out)).toEqual(JSON.parse(serializeLif(lif)));
  });

  test("key order and unknown fields of the source survive", async () => {
    const text = await loadFixture("warehouse.lif.json");
    const { lif } = parseLif(text);
    // Object key order is preserved by parse (shallow copies keep insertion order).
    const out = serializeLif(lif);
    const keysOf = (s: string) => Object.keys(JSON.parse(s).layouts[0].nodes[0]);
    expect(keysOf(out)).toEqual(keysOf(text));
  });
});
