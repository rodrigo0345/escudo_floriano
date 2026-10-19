import type { AxiosResponse } from 'axios';

import { http } from './httpClient';
import type { Page } from './types';

/**
 * Walks every page of a cursor-paginated list (`?limit=&cursor=` → `{items, nextCursor}`, the
 * convention AGENTS.md documents) and returns the concatenated items. The viewer's lists
 * (facilities, places, water points) are small enough per location that loading them in one
 * shot is simpler than teaching every caller to page through a UI control.
 */
export async function fetchAllPages<T>(path: string, params: Record<string, string> = {}): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;
  do {
    const response: AxiosResponse<Page<T>> = await http.get<Page<T>>(path, {
      params: { ...params, limit: 200, ...(cursor ? { cursor } : {}) },
    });
    items.push(...response.data.items);
    cursor = response.data.nextCursor;
  } while (cursor);
  return items;
}
