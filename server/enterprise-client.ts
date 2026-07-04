import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { Request, Response } from 'express';
import { enterpriseApiBaseUrl } from './deployment-config.js';
import { tokenFromRequest } from './auth.js';
import { toErrorMessage } from './errors.js';

const ENTERPRISE_FETCH_TIMEOUT_MS = 15_000;

function fetchWithTimeout(url: string, init: RequestInit): Promise<globalThis.Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ENTERPRISE_FETCH_TIMEOUT_MS);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(id));
}

type HeadersInput = Record<string, string | undefined | null>;

export function organizationIdFromRequest(req: Request): string | null {
  const header = req.header('x-bees-organization-id')?.trim();
  if (header) return header;
  const query = typeof req.query.organizationId === 'string' ? req.query.organizationId.trim() : '';
  if (query) return query;
  const bodyValue = (req.body as { organizationId?: unknown } | undefined)?.organizationId;
  return typeof bodyValue === 'string' && bodyValue.trim() ? bodyValue.trim() : null;
}

export function hasSelectedOrganization(req: Request): boolean {
  return Boolean(organizationIdFromRequest(req));
}

function authHeaders(req: Request, extra?: HeadersInput): Record<string, string> {
  const token = tokenFromRequest(req);
  const organizationId = organizationIdFromRequest(req);
  const cookie = req.header('cookie');
  const csrfToken = req.header('x-csrf-token');
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(cookie ? { Cookie: cookie } : {}),
    ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
    ...(organizationId ? { 'X-Bees-Organization-Id': organizationId } : {}),
    ...Object.fromEntries(Object.entries(extra ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
  };
}

function upstreamUrl(path: string): string {
  return `${enterpriseApiBaseUrl()}${path.startsWith('/') ? path : `/${path}`}`;
}

async function parseUpstreamBody(response: globalThis.Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

export async function enterpriseJson<T>(
  req: Request,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = authHeaders(req, {
    ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
    ...(init.headers as Record<string, string> | undefined),
  });
  const response = await fetchWithTimeout(upstreamUrl(path), {
    ...init,
    headers,
  });
  const body = await parseUpstreamBody(response);
  if (!response.ok) {
    const message = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
      ? body.error
      : `Enterprise OpenBees returned HTTP ${response.status}`;
    const error = new Error(message) as Error & { status?: number; body?: unknown };
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body as T;
}

export async function proxyEnterpriseJson(req: Request, res: Response, path: string, init: RequestInit = {}): Promise<void> {
  try {
    const response = await fetchWithTimeout(upstreamUrl(path), {
      ...init,
      headers: authHeaders(req, {
        ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        ...(init.headers as Record<string, string> | undefined),
      }),
    });
    const body = await parseUpstreamBody(response);
    res.status(response.status).json(body ?? {});
  } catch (error) {
    res.status(502).json({ error: toErrorMessage(error, 'Enterprise OpenBees is unavailable') });
  }
}

export async function proxyEnterpriseResponse(req: Request, res: Response, path: string, init: RequestInit = {}): Promise<void> {
  try {
    const response = await fetchWithTimeout(upstreamUrl(path), {
      ...init,
      headers: authHeaders(req, {
        ...(init.headers as Record<string, string> | undefined),
      }),
    });
    const contentType = response.headers.get('content-type');
    const contentDisposition = response.headers.get('content-disposition');
    if (contentType) res.setHeader('Content-Type', contentType);
    if (contentDisposition) res.setHeader('Content-Disposition', contentDisposition);
    res.status(response.status);
    const body = Buffer.from(await response.arrayBuffer());
    res.send(body);
  } catch (error) {
    res.status(502).json({ error: toErrorMessage(error, 'Enterprise OpenBees is unavailable') });
  }
}

export async function proxyEnterpriseSse(req: Request, res: Response, path: string): Promise<void> {
  try {
    const response = await fetch(upstreamUrl(path), {
      headers: authHeaders(req, { Accept: 'text/event-stream' }),
    });
    if (!response.ok || !response.body) {
      const body = await parseUpstreamBody(response);
      const message = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
        ? body.error
        : `Enterprise OpenBees returned HTTP ${response.status}`;
      res.status(response.status).json({ error: message });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const reader = response.body.getReader();
    req.on('close', () => reader.cancel().catch(() => undefined));
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  } catch (error) {
    if (!res.headersSent) {
      res.status(502).json({ error: toErrorMessage(error, 'Enterprise OpenBees event stream is unavailable') });
    } else {
      res.end();
    }
  }
}

export async function formDataFromRequestBody(
  body: Record<string, unknown>,
  files: Express.Multer.File[],
  transform?: (key: string, value: unknown) => [string, unknown] | null,
): Promise<FormData> {
  const formData = new FormData();
  for (const [key, rawValue] of Object.entries(body)) {
    const transformed = transform ? transform(key, rawValue) : [key, rawValue] as [string, unknown];
    if (!transformed) continue;
    const [nextKey, value] = transformed;
    if (value === undefined || value === null || value === '') continue;
    formData.append(nextKey, String(value));
  }

  for (const file of files) {
    const bytes = await readFile(file.path);
    const blob = new Blob([bytes], { type: file.mimetype || 'application/octet-stream' });
    formData.append('attachments', blob, file.originalname || basename(file.path));
  }

  return formData;
}
