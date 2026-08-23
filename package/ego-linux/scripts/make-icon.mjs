#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveBrowserBinary } from "../src/platform.mjs";

/**
 * Build the Windows icon from the SVG this package already ships.
 *
 * A `.lnk` shortcut and an `.exe` both take a `.ico`, never an SVG, so one has
 * to be produced somewhere. The obvious ways all cost something this package
 * does not otherwise pay: ImageMagick and rsvg are system packages that a
 * contributor or a CI runner may not have, and `sharp` is a native npm
 * dependency in a package that currently has none.
 *
 * So the renderer is the browser the package already requires. It is present by
 * definition — nothing here works without it — it rasterises SVG correctly
 * because that is its job, and it behaves the same on Linux, Windows and macOS.
 *
 * The output is committed, so building an installer needs no browser at all.
 * Re-run this after changing the SVG:
 *
 *     node scripts/make-icon.mjs
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SVG = join(HERE, "..", "assets", "ego-lite-linux.svg");
const ICO = join(HERE, "..", "assets", "ego-lite.ico");

/**
 * The sizes Windows actually reaches for: 16 in a title bar, 32 on the taskbar,
 * 48 on the desktop, 256 for the large and jumbo views. The rest are the
 * in-between steps Explorer picks under display scaling; leaving them out makes
 * it downscale 256 badly rather than pick a rendered one.
 */
const SIZES = [16, 24, 32, 48, 64, 128, 256];

/**
 * Pack rendered PNGs into one ICO file.
 *
 * An ICO is a 6-byte header, one 16-byte directory entry per image, then the
 * images. Since Windows Vista an entry may hold a PNG verbatim rather than a
 * BMP, which is what makes this a copy rather than a re-encode.
 *
 * @param {{size: number, png: Buffer}[]} images
 * @returns {Buffer}
 */
export function packIco(images) {
  if (!images.length) throw new Error("an icon needs at least one image");

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon, 2 = cursor
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;

  images.forEach(({ size, png }, index) => {
    const at = index * 16;
    // 256 does not fit in a byte and is spelled 0, which is the format's own
    // convention rather than a bug.
    directory.writeUInt8(size >= 256 ? 0 : size, at);
    directory.writeUInt8(size >= 256 ? 0 : size, at + 1);
    directory.writeUInt8(0, at + 2); // palette size; 0 for truecolour
    directory.writeUInt8(0, at + 3); // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });

  return Buffer.concat([header, directory, ...images.map((i) => i.png)]);
}

/**
 * Render the SVG at one size, through the browser.
 *
 * The SVG is wrapped in an HTML page rather than screenshotted directly: a
 * standalone SVG document renders at its own intrinsic 512px and the window
 * would crop it, whereas an `<img>` sized to the viewport scales it exactly.
 *
 * A throwaway profile is not optional — pointed at a profile that is already
 * open, Chrome hands the URL to the running instance and exits without writing
 * anything, and the failure looks like a missing file.
 */
async function render(binary, svg, size, workDir) {
  const page = join(workDir, `icon-${size}.html`);
  const png = join(workDir, `icon-${size}.png`);
  await writeFile(
    page,
    "<style>html,body{margin:0;padding:0;background:transparent}" +
      `img{display:block;width:${size}px;height:${size}px}</style>` +
      `<img src="data:image/svg+xml;base64,${svg.toString("base64")}">`,
  );

  const code = await new Promise((resolve) => {
    const child = spawn(
      binary,
      [
        "--headless",
        "--disable-gpu",
        "--hide-scrollbars",
        // Without this the rounded corners come out on white instead of clear.
        "--default-background-color=00000000",
        `--user-data-dir=${join(workDir, "profile")}`,
        `--window-size=${size},${size}`,
        `--screenshot=${png}`,
        pathToFileURL(page).href,
      ],
      { stdio: ["ignore", "ignore", "ignore"], windowsHide: true },
    );
    child.on("error", () => resolve(-1));
    child.on("close", resolve);
  });

  let buffer;
  try {
    buffer = await readFile(png);
  } catch {
    throw new Error(
      `the browser wrote no ${size}px screenshot (exit ${code}). ` +
        `Binary: ${binary}`,
    );
  }
  // A PNG always starts \x89PNG. Checking beats shipping an icon Windows will
  // silently refuse to draw.
  if (buffer.subarray(0, 4).toString("latin1") !== "\x89PNG") {
    throw new Error(`the ${size}px render is not a PNG`);
  }
  return { size, png: buffer };
}

export async function buildIcon({ sizes = SIZES, out = ICO } = {}) {
  const binary = await resolveBrowserBinary();
  const svg = await readFile(SVG);
  const workDir = await mkdtemp(join(tmpdir(), "ego-icon-"));
  try {
    const images = [];
    // One at a time: seven browsers at once on a small machine is how this
    // starts failing intermittently in CI.
    for (const size of sizes) {
      images.push(await render(binary, svg, size, workDir));
    }
    const ico = packIco(images);
    await writeFile(out, ico);
    return { out, sizes, bytes: ico.length };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

// Only when run directly, so the test can import packIco without rendering.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { out, sizes, bytes } = await buildIcon();
  process.stdout.write(`wrote ${out} (${sizes.join(", ")}px, ${bytes} bytes)\n`);
}
