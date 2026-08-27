import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { packIco } from "../scripts/make-icon.mjs";

/**
 * The Windows icon is a committed build artifact, produced from the SVG by
 * `scripts/make-icon.mjs`. Nothing on Linux opens a `.ico`, so a malformed one
 * would sail through every other check here and only show up as a blank square
 * in a Windows Start Menu — which is exactly the kind of thing nobody notices
 * until a user reports it.
 *
 * So this parses the real committed file rather than trusting the writer.
 */

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");
const PNG_MAGIC = "\x89PNG\r\n\x1a\n";

/** Read an ICO back into the entries it claims to hold. */
function parseIco(buffer) {
  assert.equal(buffer.readUInt16LE(0), 0, "reserved field");
  assert.equal(buffer.readUInt16LE(2), 1, "type 1 = icon");
  const count = buffer.readUInt16LE(4);

  const entries = [];
  for (let index = 0; index < count; index += 1) {
    const at = 6 + index * 16;
    entries.push({
      // 0 is how the format spells 256, since the field is one byte.
      width: buffer.readUInt8(at) || 256,
      height: buffer.readUInt8(at + 1) || 256,
      planes: buffer.readUInt16LE(at + 4),
      bitCount: buffer.readUInt16LE(at + 6),
      bytes: buffer.readUInt32LE(at + 8),
      offset: buffer.readUInt32LE(at + 12),
    });
  }
  return entries;
}

/** The size a PNG declares in its own IHDR, which is the size that renders. */
function pngDimensions(buffer) {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

describe("packIco", () => {
  it("lays out the header, the directory and the images in that order", () => {
    const a = Buffer.from("first-image");
    const b = Buffer.from("second-image-longer");
    const ico = packIco([
      { size: 16, png: a },
      { size: 32, png: b },
    ]);

    const entries = parseIco(ico);
    assert.equal(entries.length, 2);
    assert.deepEqual(
      entries.map((e) => [e.width, e.height]),
      [
        [16, 16],
        [32, 32],
      ],
    );
    // The offsets have to point at the images, or Windows draws nothing.
    assert.equal(
      ico
        .subarray(entries[0].offset, entries[0].offset + entries[0].bytes)
        .toString(),
      "first-image",
    );
    assert.equal(
      ico
        .subarray(entries[1].offset, entries[1].offset + entries[1].bytes)
        .toString(),
      "second-image-longer",
    );
    assert.equal(
      ico.length,
      6 + 32 + a.length + b.length,
      "no padding, no gaps",
    );
  });

  it("spells 256 as zero, because the field is one byte", () => {
    const [entry] = parseIco(packIco([{ size: 256, png: Buffer.from("x") }]));
    assert.equal(entry.width, 256, "reads back as 256");
    // And the byte on disk really is 0, not 255 clamped.
    assert.equal(
      packIco([{ size: 256, png: Buffer.from("x") }]).readUInt8(6),
      0,
    );
  });

  it("declares 32-bit truecolour for every entry", () => {
    for (const entry of parseIco(
      packIco([{ size: 48, png: Buffer.from("x") }]),
    )) {
      assert.equal(entry.planes, 1);
      assert.equal(entry.bitCount, 32);
    }
  });

  it("refuses to write an icon with no images in it", () => {
    assert.throws(() => packIco([]), /at least one image/);
  });
});

describe("the committed Windows icon", () => {
  it("holds the sizes Windows reaches for", async () => {
    const ico = await readFile(join(ASSETS, "ego-lite.ico"));
    const sizes = parseIco(ico).map((entry) => entry.width);
    // 16 in a title bar, 32 on the taskbar, 48 on the desktop, 256 for the
    // jumbo view. Without those four Explorer downscales one that is there.
    for (const required of [16, 32, 48, 256]) {
      assert.ok(sizes.includes(required), `no ${required}px entry in ${sizes}`);
    }
  });

  it("points every entry at a real PNG of the size it claims", async () => {
    const ico = await readFile(join(ASSETS, "ego-lite.ico"));
    for (const entry of parseIco(ico)) {
      assert.ok(
        entry.offset + entry.bytes <= ico.length,
        `the ${entry.width}px entry runs past the end of the file`,
      );
      const image = ico.subarray(entry.offset, entry.offset + entry.bytes);
      assert.equal(
        image.subarray(0, 8).toString("latin1"),
        PNG_MAGIC,
        `the ${entry.width}px entry is not a PNG`,
      );
      // The directory and the image have to agree: Windows sizes from the
      // directory and draws from the PNG, so a mismatch renders stretched.
      assert.deepEqual(
        pngDimensions(image),
        { width: entry.width, height: entry.height },
        `the ${entry.width}px entry contains a differently sized PNG`,
      );
    }
  });

  it("is not a blank square", async () => {
    const ico = await readFile(join(ASSETS, "ego-lite.ico"));
    const entries = parseIco(ico);
    const largest = entries.reduce((a, b) => (a.width > b.width ? a : b));
    // A failed render still writes a valid PNG — an empty one. Real artwork at
    // 256px does not compress to a few hundred bytes.
    assert.ok(
      largest.bytes > 2000,
      `the ${largest.width}px entry is only ${largest.bytes} bytes, which is a blank render`,
    );
  });
});
