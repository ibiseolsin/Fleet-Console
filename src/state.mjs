import { AsyncLocalStorage } from 'node:async_hooks';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// One mount point for fixture, approvals, histories, SDK sessions and global quota.
export const STATE_ROOT = resolve(process.env.FLEET_STATE_ROOT || join(REPO, 'sandbox'));
// Next may load this module in more than one server bundle. Share the request context.
const key = Symbol.for('fleet-console.state');
const context = globalThis[key] ||= new AsyncLocalStorage();
export const stateRoot = () => context.getStore()?.root || STATE_ROOT;
export const statePath = (...parts) => join(stateRoot(), ...parts);
export const inVisitor = () => !!context.getStore()?.visitor;
export const withState = (root, fn, visitor = false) => context.run({ root: resolve(root), visitor }, fn);
export const fixtureRoot = () => statePath('fleet');
