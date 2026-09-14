import { NextResponse } from 'next/server';

export function middleware(request) {
  const name = 'fleet-visitor';
  const current = request.cookies.get(name)?.value;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(current || '')) return NextResponse.next();
  const id = crypto.randomUUID();
  request.cookies.set(name, id);
  const response = NextResponse.next({ request: { headers: request.headers } });
  response.cookies.set(name, id, { httpOnly: true, sameSite: 'lax', secure: request.nextUrl.protocol === 'https:', path: '/', maxAge: 60 * 60 * 24 * 30 });
  return response;
}
export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
