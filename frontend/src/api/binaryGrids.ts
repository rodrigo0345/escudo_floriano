import { http } from './httpClient';
import type { GridData, GridDtype } from './types';

const ARRAY_CTOR: Record<GridDtype, new (buf: ArrayBuffer) => ArrayBufferView> = {
  int16: Int16Array,
  uint16: Uint16Array,
  uint8: Uint8Array,
  float32: Float32Array,
};

/**
 * Fetches one of the server's raw raster grids (`application/octet-stream`, dimensions and
 * element type in the `X-Grid-*` response headers — see AGENTS.md's conventions section).
 * Every grid endpoint in this API (`/locations/{id}/grids/{layer}` and
 * `/simulations/{id}/grids/{grid}`) shares this exact shape, so this is the one place that
 * knows how to decode it; callers just name the path and get back a typed array plus geometry.
 */
export async function fetchGrid(path: string, params: Record<string, string> = {}): Promise<GridData> {
  const response = await http.get<ArrayBuffer>(path, { params, responseType: 'arraybuffer' });
  const header = (name: string) => response.headers[name.toLowerCase()] as string | undefined;
  const dtype = (header('X-Grid-Dtype') ?? 'uint8') as GridDtype;
  const Ctor = ARRAY_CTOR[dtype];
  return {
    width: Number(header('X-Grid-Width') ?? 0),
    height: Number(header('X-Grid-Height') ?? 0),
    cellM: Number(header('X-Grid-Cell-M') ?? 0),
    dtype,
    data: new Ctor(response.data),
  };
}
