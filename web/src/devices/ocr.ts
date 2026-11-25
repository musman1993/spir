// Tesseract.js adapter. Runs in a Web Worker so the page stays responsive.
// Returns lines + words with confidence and bounding boxes; the server does field extraction.
import { createWorker, type Worker } from 'tesseract.js';
import type { OcrAdapter } from './index';

export interface BBox { x0: number; y0: number; x1: number; y1: number }
export interface OcrWord { text: string; confidence: number; bbox: BBox }
export interface OcrLine { text: string; confidence: number; bbox: BBox; words: OcrWord[] }
export interface OcrResult { engine: string; engineVersion: string; text: string; confidence: number; lines: OcrLine[] }

let workerPromise: Promise<Worker> | null = null;
let progressCb: ((p: number, s: string) => void) | undefined;

function getWorker() {
  workerPromise ??= createWorker('eng', 1, {
    logger: (m: any) => progressCb?.(m.progress ?? 0, m.status ?? ''),
  });
  return workerPromise;
}

export const tesseractOcr: OcrAdapter = {
  engine: 'tesseract.js',
  engineVersion: '7',
  async recognize(image, onProgress) {
    progressCb = onProgress;
    const worker = await getWorker();
    const { data } = await worker.recognize(image as any, {}, { blocks: true, text: true });
    const lines: OcrLine[] = [];
    for (const block of (data as any).blocks ?? []) {
      for (const para of block.paragraphs ?? []) {
        for (const line of para.lines ?? []) {
          lines.push({
            text: String(line.text ?? '').trim(),
            confidence: line.confidence,
            bbox: line.bbox,
            words: (line.words ?? []).map((w: any) => ({ text: w.text, confidence: w.confidence, bbox: w.bbox })),
          });
        }
      }
    }
    progressCb = undefined;
    return { engine: this.engine, engineVersion: this.engineVersion, text: data.text ?? '', confidence: data.confidence ?? 0, lines: lines.filter((l) => l.text) };
  },
};
