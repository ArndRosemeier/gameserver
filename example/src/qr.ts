// qr.ts - show a code as a QR code, and read one with the camera.
// Scanning uses the browser's BarcodeDetector where it exists (Chrome on Android) and falls back to
// jsQR everywhere else (Safari, Firefox, desktop Chrome). Both are bundled, so this works offline.
import qrcode from "qrcode-generator";

/** Renders `text` as an SVG QR code into `el`. */
export function showQr(el: HTMLElement, text: string): void {
  const qr = qrcode(0, "L");
  qr.addData(text);
  qr.make();
  el.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

/**
 * Opens the camera in `video` and calls `onCode` with the first QR code it reads, then stops.
 * Returns a stop function. Rejects if there is no camera or the user said no.
 */
export async function scanQr(video: HTMLVideoElement, onCode: (text: string) => void): Promise<() => void> {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
  video.srcObject = stream;
  video.setAttribute("playsinline", "");
  video.muted = true;
  await video.play();
  let running = true;
  const stop = () => { running = false; stream.getTracks().forEach((t) => t.stop()); video.srcObject = null; };

  const Detector = (globalThis as any).BarcodeDetector;
  const detector = Detector && (await Detector.getSupportedFormats?.())?.includes("qr_code")
    ? new Detector({ formats: ["qr_code"] }) : null;
  const jsQR = detector ? null : (await import("jsqr")).default;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;

  const tick = async () => {
    if (!running) return;
    let text: string | null = null;
    if (video.readyState >= 2) {
      if (detector) {
        const codes = await detector.detect(video).catch(() => []);
        text = codes[0]?.rawValue ?? null;
      } else {
        const scale = Math.min(1, 640 / video.videoWidth);
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        text = jsQR!(img.data, img.width, img.height, { inversionAttempts: "dontInvert" })?.data ?? null;
      }
    }
    if (text && running) { stop(); onCode(text); return; }
    setTimeout(tick, 120);
  };
  tick();
  return stop;
}
