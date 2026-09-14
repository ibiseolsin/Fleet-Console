import { accessSync, constants } from 'node:fs';
import { STATE_ROOT } from '../../../src/state.mjs';

export const dynamic = 'force-dynamic';
export function GET() {
  try {
    accessSync(STATE_ROOT, constants.R_OK | constants.W_OK);
    return Response.json({ app: 'Fleet Console', status: 'ok' });
  } catch {
    return Response.json({ app: 'Fleet Console', status: 'state-unavailable' }, { status: 503 });
  }
}
