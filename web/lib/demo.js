import { cookies } from 'next/headers';
import { withVisitor } from '../../src/demo.mjs';

export async function withDemo(fn) {
  const id = (await cookies()).get('fleet-visitor')?.value;
  return withVisitor(id, fn);
}
