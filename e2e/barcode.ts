import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A fake camera picture for Chromium (--use-file-for-fake-video-capture): one
// Y4M frame with an EAN-13 barcode on white. Chromium shows it in a loop.

const L = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"];
const G = ["0100111", "0110011", "0011011", "0100001", "0011101", "0111001", "0000101", "0010001", "0001001", "0010111"];
const R = L.map((code) => [...code].map((bit) => (bit === "0" ? "1" : "0")).join(""));
const PARITY = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"];

/** The 95 modules of an EAN-13 (1 = bar). A 12-digit UPC-A is the same with a leading 0. */
function ean13Modules(code: string): string {
  const d = (code.length === 12 ? `0${code}` : code).split("").map(Number);
  const left = d.slice(1, 7).map((n, i) => (PARITY[d[0]!]![i] === "L" ? L : G)[n]).join("");
  const right = d.slice(7).map((n) => R[n]).join("");
  return `101${left}01010${right}101`;
}

/** Write the Y4M file for the barcode and return its path. */
export function barcodeVideo(code: string): string {
  const [width, height, module, top, barHeight] = [640, 480, 4, 140, 200];
  const modules = ean13Modules(code);
  const x0 = Math.round((width - modules.length * module) / 2);
  const y = Buffer.alloc(width * height, 255);
  for (let row = top; row < top + barHeight; row++) {
    for (let m = 0; m < modules.length; m++) {
      if (modules[m] === "1") y.fill(0, row * width + x0 + m * module, row * width + x0 + (m + 1) * module);
    }
  }
  const chroma = Buffer.alloc((width / 2) * (height / 2) * 2, 128);
  const file = join(tmpdir(), `pg-barcode-${code}.y4m`);
  writeFileSync(file, Buffer.concat([Buffer.from(`YUV4MPEG2 W${width} H${height} F10:1 Ip A1:1 C420jpeg\nFRAME\n`), y, chroma]));
  return file;
}

/** Chromium options for a fake camera that shows the barcode. */
export const fakeCamera = (code: string) => ({
  launchOptions: {
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${barcodeVideo(code)}`],
  },
  permissions: ["camera"],
});
