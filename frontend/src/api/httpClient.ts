import axios, { type AxiosInstance } from 'axios';

import type { Problem } from './types';

/**
 * Every network call in this app goes through this one axios instance, never a bare `fetch`
 * or a second axios instance — that is what makes `ApiError` and the `/api/v1` base URL
 * apply uniformly. In dev, Vite proxies `/api/v1` to `VITE_API_PROXY_TARGET` (see
 * vite.config.ts); in production nginx proxies the same path straight to the backend
 * container (see docker/nginx.conf), so this file never needs to know a real hostname.
 */
export const BASE_URL = '/api/v1';

export const http: AxiosInstance = axios.create({
  baseURL: BASE_URL,
  headers: { 'Content-Type': 'application/json' },
});

/** A `application/problem+json` error (RFC 9457), normalized so callers can branch on `code`. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly problem: Problem | null;

  constructor(status: number, problem: Problem | null) {
    super(problem?.detail ?? problem?.title ?? `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = problem?.code ?? 'unknown_error';
    this.problem = problem;
  }
}

/** Binary grid requests use `responseType: 'arraybuffer'`, so an error body arrives as bytes too — decode it back to JSON before giving up. */
function readProblem(data: unknown): Problem | null {
  if (!data) return null;
  if (data instanceof ArrayBuffer) {
    try {
      return JSON.parse(new TextDecoder().decode(data)) as Problem;
    } catch {
      return null;
    }
  }
  return typeof data === 'object' ? (data as Problem) : null;
}

http.interceptors.response.use(
  (response) => response,
  (error) => {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status ?? 0;
      throw new ApiError(status, readProblem(error.response?.data));
    }
    throw error;
  },
);
