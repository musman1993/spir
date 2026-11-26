// Company logo for the centre of QR labels.
// Drop the logo into web/public/brand/ as logo.png (preferred, ideally square with a transparent or
// white background) or logo.svg. PNG wins when both exist. The file is read once and embedded as a
// data URL so it survives rasterising and printing.
import { useEffect, useState } from 'react';

const base = import.meta.env.BASE_URL.replace(/\/?$/, '/');
let pending: Promise<string | null> | null = null;

async function fetchAsDataUrl(path: string): Promise<string | null> {
  try {
    const res = await fetch(`${base}${path}`, { cache: 'no-cache' });
    // The dev server answers unknown paths with index.html, so check that an image came back.
    if (!res.ok || !(res.headers.get('content-type') ?? '').startsWith('image/')) return null;
    const blob = await res.blob();
    return await new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => resolve(null);
      r.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

export function loadBrandLogo(): Promise<string | null> {
  pending ??= (async () => (await fetchAsDataUrl('brand/logo.png')) ?? (await fetchAsDataUrl('brand/logo.svg')))();
  return pending;
}

/** undefined while loading, null when no logo file exists. */
export function useBrandLogo() {
  const [logo, setLogo] = useState<string | null | undefined>(undefined);
  useEffect(() => { loadBrandLogo().then(setLogo); }, []);
  return logo;
}
