// Export the synthetic fixture (Src/Fixture.js) as JSON for the PHP backend's fixture mode.
// Usage: node Php/Tools/ExportFixture.mjs   (writes Php/Tests/Fixture/FixtureData.json)
// The data is synthetic only; it is never uploaded to the server.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFixtureGrid, FIXTURE_FILES } from "../../Src/Fixture.js";

// Output next to the PHP tests
const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, "../Tests/Fixture/FixtureData.json");

// Grid exactly as spreadsheets.get would return it
const grid = await loadFixtureGrid();
// Binary files as base64 keyed by their Drive id
const files = {};
for (const [id, file] of Object.entries(FIXTURE_FILES)) {
  files[id] = { mimeType: file.mimeType, base64: Buffer.from(file.bytes).toString("base64") };
}

// Write the combined document
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify({ grid, files }, null, 1)}\n`, "utf8");
console.log(`wrote ${outPath} (${grid.length} rows, ${Object.keys(files).length} files)`);
