import type { CameraAdapter } from './index';

let stream: MediaStream | null = null;

export const browserCamera: CameraAdapter = {
  async list() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'videoinput').map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }));
  },
  async start(video, deviceId) {
    this.stop();
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot open a camera. Use "Upload photo" instead.');
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: deviceId
        ? { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } }
        : { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
    video.srcObject = stream;
    video.setAttribute('playsinline', 'true');
    await video.play();
  },
  stop() {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
  },
  async capture(video) {
    const c = document.createElement('canvas');
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    c.getContext('2d')!.drawImage(video, 0, 0);
    return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Capture failed'))), 'image/jpeg', 0.92));
  },
};

export function describeCameraError(e: any): string {
  const n = e?.name;
  if (n === 'NotAllowedError') return 'Camera permission was blocked. Allow camera access in the browser address bar, or upload a photo instead.';
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'No camera was found. Connect one, or upload a photo instead.';
  if (n === 'NotReadableError') return 'The camera is in use by another app. Close it and try again.';
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') return 'Cameras only work over HTTPS. Open the app through its https:// address.';
  return e?.message ?? 'The camera could not be started.';
}
