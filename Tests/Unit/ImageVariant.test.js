// Unit tests for Src/ImageVariant.js (Design §10-4)
import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptsWebp, chooseImageVariant, createImagesTransform, WEBP_QUALITY } from "../../Src/ImageVariant.js";
import { MAX_ATTACHMENT_BYTES } from "../../Src/Attachments.js";

// Browser-like Accept header that lists WebP
const ACCEPT = "image/avif,image/webp,image/apng,image/*,*/*;q=0.8";
// A 100-byte "original" image
const ORIGINAL = new Uint8Array(100).fill(7).buffer;

// Transformer stub that records calls and returns a buffer of the given size
function stubTransform(size) {
  const calls = [];
  const transform = async (bytes) => {
    calls.push(bytes);
    return new Uint8Array(size).buffer;
  };
  return { transform, calls };
}

// Run chooseImageVariant with a captured log
async function run(options) {
  const logs = [];
  const result = await chooseImageVariant({ bytes: ORIGINAL, mimeType: "image/jpeg", accept: ACCEPT, log: (entry) => logs.push(entry), ...options });
  return { result, logs };
}

test("acceptsWebp needs an explicit image/webp with q > 0", () => {
  assert.equal(acceptsWebp(ACCEPT), true);
  assert.equal(acceptsWebp("image/webp"), true);
  assert.equal(acceptsWebp("IMAGE/WEBP;q=0.5"), true);
  assert.equal(acceptsWebp("image/webp;q=0"), false);
  assert.equal(acceptsWebp("image/*,*/*"), false);
  assert.equal(acceptsWebp("*/*"), false);
  assert.equal(acceptsWebp(""), false);
  assert.equal(acceptsWebp(null), false);
});

test("smaller WebP is served as webp", async () => {
  const { transform, calls } = stubTransform(40);
  const { result, logs } = await run({ transform });
  assert.equal(calls.length, 1);
  assert.equal(result.format, "webp");
  assert.equal(result.mimeType, "image/webp");
  assert.equal(result.ext, "webp");
  assert.equal(result.body.byteLength, 40);
  assert.deepEqual(logs, []);
});

test("larger or equal WebP keeps the original without logging", async () => {
  for (const size of [100, 150]) {
    const { transform } = stubTransform(size);
    const { result, logs } = await run({ transform, mimeType: "image/png" });
    assert.equal(result.format, "original");
    assert.equal(result.mimeType, "image/png");
    assert.equal(result.ext, "png");
    assert.equal(result.body, ORIGINAL);
    assert.deepEqual(logs, []);
  }
});

test("no Accept or no image/webp in Accept: original and transform not called", async () => {
  for (const accept of [null, undefined, "", "image/png,image/*;q=0.8", "*/*"]) {
    const { transform, calls } = stubTransform(10);
    const { result, logs } = await run({ transform, accept });
    assert.equal(result.format, "original");
    assert.equal(calls.length, 0);
    assert.deepEqual(logs, []);
  }
});

test("missing transformer: original + webp_skipped(binding_missing)", async () => {
  const { result, logs } = await run({ transform: null });
  assert.equal(result.format, "original");
  assert.deepEqual(logs, [{ event: "webp_skipped", reason: "binding_missing" }]);
});

test("throwing transformer: original + transform_error", async () => {
  const { result, logs } = await run({ transform: async () => { throw new Error("9422 quota"); } });
  assert.equal(result.format, "original");
  assert.deepEqual(logs, [{ event: "webp_skipped", reason: "transform_error" }]);
  // A synchronous throw or a non-buffer result is handled the same way
  const sync = await run({ transform: () => { throw new Error("boom"); } });
  assert.deepEqual(sync.logs, [{ event: "webp_skipped", reason: "transform_error" }]);
  const empty = await run({ transform: async () => new ArrayBuffer(0) });
  assert.deepEqual(empty.logs, [{ event: "webp_skipped", reason: "transform_error" }]);
});

test("slow transformer: original + timeout", async () => {
  const { result, logs } = await run({ transform: () => new Promise(() => {}), timeoutMs: 20 });
  assert.equal(result.format, "original");
  assert.deepEqual(logs, [{ event: "webp_skipped", reason: "timeout" }]);
});

test("PDF, WebP and HEIC inputs never reach the transformer", async () => {
  for (const mimeType of ["application/pdf", "image/webp", "image/heic"]) {
    const { transform, calls } = stubTransform(1);
    const { result, logs } = await run({ transform, mimeType });
    assert.equal(calls.length, 0, mimeType);
    assert.equal(result.format, "original");
    assert.equal(result.mimeType, mimeType);
    assert.deepEqual(logs, []);
  }
});

test("over 20 MB: original + over_input_limit, transform not called", async () => {
  const { transform, calls } = stubTransform(1);
  const big = new ArrayBuffer(MAX_ATTACHMENT_BYTES + 1);
  const { result, logs } = await run({ transform, bytes: big });
  assert.equal(calls.length, 0);
  assert.equal(result.body, big);
  assert.deepEqual(logs, [{ event: "webp_skipped", reason: "over_input_limit" }]);
});

test("log lines contain only the fixed event/reason (no numbers or ids)", async () => {
  const lines = [];
  for (const transform of [null, async () => { throw new Error("FixturePng0000000000000000000001 100 bytes"); }]) {
    await chooseImageVariant({ bytes: ORIGINAL, mimeType: "image/jpeg", accept: ACCEPT, transform, log: (entry) => lines.push(JSON.stringify(entry)) });
  }
  for (const line of lines) {
    assert.deepEqual(Object.keys(JSON.parse(line)).sort(), ["event", "reason"]);
    assert.ok(!/\d/.test(line), line);
    assert.ok(!line.includes("Fixture"), line);
  }
});

test("createImagesTransform drives the binding with WebP quality 80", async () => {
  // Missing binding -> null
  assert.equal(createImagesTransform(undefined), null);
  assert.equal(createImagesTransform({}), null);
  const seen = {};
  const images = {
    input(stream) {
      seen.stream = stream;
      return {
        async output(options) {
          seen.options = options;
          return { response: () => new Response(new Uint8Array([1, 2, 3])) };
        },
      };
    },
  };
  const transform = createImagesTransform(images);
  const out = await transform(new Uint8Array([9, 9, 9, 9]).buffer);
  assert.deepEqual(seen.options, { format: "image/webp", quality: WEBP_QUALITY });
  assert.equal(WEBP_QUALITY, 80);
  assert.ok(seen.stream instanceof ReadableStream);
  assert.deepEqual([...new Uint8Array(out)], [1, 2, 3]);
});
