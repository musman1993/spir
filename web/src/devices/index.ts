// Device abstraction (spec 11A.3, ADR-011). Business screens use these interfaces only,
// so a vendor SDK or an edge connector can replace an adapter without touching the UI logic.
import type { OcrResult } from './ocr';

export interface BarcodeRead { format: string; text: string }

export interface CameraDevice { deviceId: string; label: string }

/** Camera adapter: browser getUserMedia. */
export interface CameraAdapter {
  list(): Promise<CameraDevice[]>;
  start(video: HTMLVideoElement, deviceId?: string): Promise<void>;
  stop(): void;
  /** Captures the current frame at full sensor resolution. */
  capture(video: HTMLVideoElement): Promise<Blob>;
}

/** QR / 1D / 2D barcode decoding from a live video or a still image. */
export interface BarcodeAdapter {
  readonly name: string;
  decodeImage(img: HTMLImageElement | HTMLCanvasElement): Promise<BarcodeRead[]>;
  /** Every distinct barcode in the image (whole image + overlapping strips). */
  decodeAll(canvas: HTMLCanvasElement): Promise<BarcodeRead[]>;
  startLive(video: HTMLVideoElement, onRead: (r: BarcodeRead) => void, deviceId?: string): Promise<() => void>;
}

/** OCR engine adapter (Tesseract.js in a Web Worker today; a server or managed OCR later). */
export interface OcrAdapter {
  readonly engine: string;
  readonly engineVersion: string;
  recognize(image: Blob | HTMLCanvasElement, onProgress?: (p: number, status: string) => void): Promise<OcrResult>;
}

/**
 * USB/Bluetooth "keyboard wedge" scanners type the code and press Enter very quickly.
 * We distinguish them from a human typing by inter-key timing.
 */
export function listenForHidScanner(onScan: (text: string) => void, opts: { maxGapMs?: number; minLength?: number } = {}) {
  const maxGap = opts.maxGapMs ?? 35;
  const minLen = opts.minLength ?? 6;
  let buf = '';
  let last = 0;
  const handler = (e: KeyboardEvent) => {
    const now = performance.now();
    if (now - last > maxGap) buf = '';
    last = now;
    if (e.key === 'Enter') {
      if (buf.length >= minLen) { onScan(buf); e.preventDefault(); }
      buf = '';
      return;
    }
    if (e.key.length === 1) buf += e.key;
  };
  window.addEventListener('keydown', handler, true);
  return () => window.removeEventListener('keydown', handler, true);
}
