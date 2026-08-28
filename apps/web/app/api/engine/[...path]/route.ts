import type { NextRequest } from 'next/server';

declare const __FDA_ENGINE_ORIGIN__: string;
declare const __FDA_ENGINE_SECRET__: string;

export const dynamic = 'force-dynamic';

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  if (!path.length || path[0] !== 'v1') return Response.json({ message: 'Unsupported engine route' }, { status: 404 });
  if (request.method !== 'GET') {
    const origin = request.headers.get('origin');
    if (origin && origin !== request.nextUrl.origin) return Response.json({ message: 'Cross-origin mutation rejected' }, { status: 403 });
    if (request.headers.get('x-fda-csrf') !== 'local-ui-v1') return Response.json({ message: 'CSRF token required' }, { status: 403 });
  }
  const engineOrigin = __FDA_ENGINE_ORIGIN__;
  const engineSecret = __FDA_ENGINE_SECRET__;
  if (!engineOrigin || !engineSecret) return Response.json({ message: 'Local engine is not configured' }, { status: 503 });
  const target = new URL(`/${path.join('/')}`, engineOrigin);
  target.search = request.nextUrl.search;
  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : (await request.text()) || '{}';
  const upstream = await fetch(target, { method: request.method, headers: { authorization: `Bearer ${engineSecret}`, accept: request.headers.get('accept') ?? 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, body, cache: 'no-store' });
  return new Response(upstream.body, { status: upstream.status, headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json', 'cache-control': upstream.headers.get('cache-control') ?? 'no-store' } });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const DELETE = proxy;
