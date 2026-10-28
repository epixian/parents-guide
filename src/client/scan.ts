// Scan the ISBN barcode on a book with the camera. The browser's own
// BarcodeDetector reads the video where it can (Android Chrome); other
// browsers (iPhone Safari, Firefox, desktop Chrome) load the quagga2 reader
// (JavaScript, from this site) on the first scan. The video never leaves the
// browser.

import { isbnFromBarcode } from "../shared/isbn.js";

/** The barcode texts in the current video frame. */
type Detect = (video: HTMLVideoElement) => Promise<string[]>;

/** Retail barcode formats. A book's ISBN is an EAN-13; the others get the "not an ISBN" message. */
const NATIVE_FORMATS = ["ean_13", "upc_a", "upc_e", "ean_8"];
const QUAGGA_READERS = ["ean_reader", "upc_reader", "upc_e_reader", "ean_8_reader"] as const;
/** Time between two reads of the video. */
const SCAN_GAP_MS = 150;
/** Frames are scaled to this width for quagga2: faster, and a barcode stays readable. */
const FRAME_WIDTH = 800;

const PROMPT = "Point the camera at the barcode on the back of the book.";
const NOT_ISBN =
  "This barcode is not the ISBN. Many paperbacks have the ISBN barcode inside the front cover. You can also type the ISBN in the search box.";

interface NativeDetector {
  detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>;
}
interface NativeDetectorClass {
  new (options: { formats: string[] }): NativeDetector;
  getSupportedFormats(): Promise<string[]>;
}

/** True when the browser can use a camera (a secure page with getUserMedia). */
export const canScan = () => !!navigator.mediaDevices?.getUserMedia;

async function nativeDetect(): Promise<Detect | null> {
  const Detector = (window as unknown as { BarcodeDetector?: NativeDetectorClass }).BarcodeDetector;
  if (!Detector) return null;
  const supported = await Detector.getSupportedFormats().catch(() => [] as string[]);
  if (!supported.includes("ean_13")) return null;
  const detector = new Detector({ formats: NATIVE_FORMATS.filter((f) => supported.includes(f)) });
  return async (video) => (await detector.detect(video)).map((b) => b.rawValue);
}

async function quaggaDetect(): Promise<Detect> {
  const { default: Quagga } = await import("@ericblade/quagga2");
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  return async (video) => {
    if (!video.videoWidth) return [];
    const scale = Math.min(1, FRAME_WIDTH / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const result = await Quagga.decodeSingle({
      src: canvas.toDataURL("image/jpeg", 0.9),
      numOfWorkers: 0,
      locate: true,
      inputStream: { size: canvas.width },
      decoder: { readers: [...QUAGGA_READERS] },
    }).catch(() => undefined);
    const code = result?.codeResult?.code;
    return code ? [code] : [];
  };
}

/** The message for a camera that cannot start. */
function cameraError(err: unknown): string {
  const name = (err as DOMException)?.name;
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "The camera is blocked. Allow the camera for this site in the browser settings, or type the ISBN in the search box.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No camera found. Type the ISBN in the search box.";
  return "The camera could not start. Type the ISBN in the search box.";
}

/**
 * Open the scanner. Resolves with the ISBN-13 of the first book barcode, or
 * null when the user closes the dialog. The camera stops in both cases.
 */
export function scanIsbn(): Promise<string | null> {
  const dialog = document.createElement("dialog");
  dialog.className = "modal scan-dialog";
  dialog.setAttribute("aria-labelledby", "scan-title");
  dialog.innerHTML = `
    <h2 id="scan-title">Scan a book barcode</h2>
    <div class="scan-view">
      <video muted playsinline aria-hidden="true"></video>
      <div class="scan-guide" aria-hidden="true"></div>
    </div>
    <p class="scan-status" role="status">Starting the camera…</p>
    <div class="modal-actions"><button type="button" data-scan-cancel>Cancel</button></div>`;
  document.body.append(dialog);
  const video = dialog.querySelector("video")!;
  const status = dialog.querySelector(".scan-status")!;

  let stream: MediaStream | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done = false;

  return new Promise((resolve) => {
    const finish = (isbn: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const track of stream?.getTracks() ?? []) track.stop();
      dialog.close();
      dialog.remove();
      resolve(isbn);
    };
    dialog.addEventListener("close", () => finish(null));
    dialog.querySelector("[data-scan-cancel]")!.addEventListener("click", () => finish(null));
    dialog.showModal();

    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
      } catch (err) {
        status.textContent = cameraError(err);
        return;
      }
      if (done) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      video.srcObject = stream;
      await video.play().catch(() => {});
      status.textContent = PROMPT;

      let detect: Detect;
      try {
        detect = (await nativeDetect()) ?? (await quaggaDetect());
      } catch {
        status.textContent = "The barcode reader could not load. Type the ISBN in the search box.";
        return;
      }
      // A reader can misread one frame, so a code counts only when two frames in a row give it.
      let last = "";
      const tick = async () => {
        if (done) return;
        try {
          const text = (await detect(video))[0] ?? "";
          if (text && text === last) {
            const isbn = isbnFromBarcode(text);
            if (isbn) return finish(isbn);
            status.textContent = NOT_ISBN;
          }
          last = text;
        } catch {
          // A frame that cannot be read (the video is not ready yet): try the next one.
        }
        timer = setTimeout(() => void tick(), SCAN_GAP_MS);
      };
      void tick();
    })();
  });
}
