// ZXing adapter: QR, Data Matrix, Code 128/39, EAN/UPC, PDF417.
import { BrowserMultiFormatReader } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';
import type { BarcodeAdapter, BarcodeRead } from './index';

const hints = new Map();
hints.set(DecodeHintType.POSSIBLE_FORMATS, [
  BarcodeFormat.QR_CODE, BarcodeFormat.DATA_MATRIX, BarcodeFormat.CODE_128, BarcodeFormat.CODE_39,
  BarcodeFormat.EAN_13, BarcodeFormat.UPC_A, BarcodeFormat.PDF_417,
]);
hints.set(DecodeHintType.TRY_HARDER, true);

const fmt = (f: number) => BarcodeFormat[f] ?? String(f);

export const zxingBarcode: BarcodeAdapter = {
  name: 'zxing',
  async decodeImage(img) {
    const reader = new BrowserMultiFormatReader(hints);
    try {
      const r = img instanceof HTMLCanvasElement ? reader.decodeFromCanvas(img) : await reader.decodeFromImageElement(img);
      return [{ format: fmt(r.getBarcodeFormat()), text: r.getText() }];
    } catch {
      return []; // nothing decodable in this image
    }
  },
  async startLive(video, onRead, deviceId) {
    const reader = new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 150 });
    let lastText = '';
    let lastAt = 0;
    const controls = await reader.decodeFromVideoDevice(deviceId, video, (result) => {
      if (!result) return;
      const text = result.getText();
      // Suppress duplicate scan events of the same code (FR-DEV-007).
      if (text === lastText && Date.now() - lastAt < 2500) return;
      lastText = text; lastAt = Date.now();
      onRead({ format: fmt(result.getBarcodeFormat()), text } as BarcodeRead);
    });
    return () => controls.stop();
  },
};
