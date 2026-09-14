/**
 * `state-sync.mjs` 의 GitHub 백엔드를 **가짜 Contents API** 로 검사한다 — 네트워크·토큰 없이.
 *
 * 확인하는 것: (1) 1MB 넘는 스냅샷도 raw Accept 로 받아 그대로 복원된다(JSON GET 의 content 는 비어 있다),
 * (2) 두 번째 PUT 은 기존 `sha` 를 싣는다, (3) 409 를 받으면 sha 를 다시 받아 한 번 더 PUT 한다,
 * (4) restore 는 빈 루트에만 풀고 내용 해시가 같다. 사용: node scripts/state-sync-check.mjs
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'fleet-state-check-'));
const root = join(tmp, 'root');
mkdirSync(join(root, 'visitors', 'v1', '.lock'), { recursive: true });
mkdirSync(join(root, 'agent-runs'), { recursive: true });
writeFileSync(join(root, 'agent-runs', 'big.json'), JSON.stringify({ pad: 'x'.repeat(1_500_000) })); // > 1MB, 압축은 작다
writeFileSync(join(root, 'daily-runs.json'), '{"used":7}');
writeFileSync(join(root, 'approvals.json.99.tmp'), 'partial');
process.env.FLEET_STATE_ROOT = root;

const store = { file: null, sha: 0 }; // 가짜 저장소: 파일 하나와 sha 카운터
const pre = { file: null, sha: 0 }; // preflight 는 별도 경로다 — 스냅샷 슬롯을 건드리면 안 된다
const seen = [];
let conflictOnce = false;
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const slot = req.url.includes('.preflight') ? pre : store;
    seen.push({ method: req.method, accept: req.headers.accept, hasSha: body.includes('"sha"') });
    assert.equal(req.headers.authorization, 'Bearer test-token');
    assert.ok(req.url.startsWith('/repos/owner/state-repo/contents/state.tar.gz'));
    if (req.method === 'GET') {
      if (!slot.file) { res.writeHead(404); return res.end('{}'); }
      if (req.headers.accept === 'application/vnd.github.raw+json') { res.writeHead(200); return res.end(slot.file); }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ sha: String(slot.sha), size: slot.file.length, encoding: 'none', content: '' })); // 1MB 초과 응답 꼴
    }
    if (req.method === 'PUT') {
      const json = JSON.parse(body);
      if (slot.file && json.sha !== String(slot.sha)) { res.writeHead(409); return res.end('{"message":"conflict"}'); }
      if (conflictOnce) { conflictOnce = false; slot.sha++; res.writeHead(409); return res.end('{"message":"stale"}'); }
      slot.file = Buffer.from(json.content, 'base64');
      slot.sha++;
      res.writeHead(slot.sha === 1 ? 201 : 200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ content: { sha: String(slot.sha) } }));
    }
    res.writeHead(405); res.end();
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.FLEET_STATE_API = 'http://127.0.0.1:' + server.address().port;
process.env.FLEET_STATE_REPO = 'owner/state-repo';
process.env.FLEET_STATE_TOKEN = 'test-token';

const { pickBackend, pack, contentHash, restore } = await import('./state-sync.mjs');
const backend = pickBackend();
const archive = join(tmp, 'a.tar.gz');
const hash = contentHash(root);

// (2) 첫 PUT 은 sha 없이, 두 번째는 sha 를 싣는다
pack(root, archive);
const first = await backend.upload(archive);
assert.equal(first.sha, '1');
assert.equal(seen.filter((s) => s.method === 'PUT').at(-1).hasSha, false);
pack(root, archive);
const second = await backend.upload(archive);
assert.equal(second.sha, '2');
assert.equal(seen.filter((s) => s.method === 'PUT').at(-1).hasSha, true);

// (3) 409 → sha 재조회 → 한 번 더
conflictOnce = true;
const third = await backend.upload(archive);
assert.equal(third.sha, '4');
assert.equal(seen.filter((s) => s.method === 'PUT').length, 4, 'PUT 4회 (성공·성공·409·재시도)');

// (1)(4) 빈 루트에 raw 로 받아 복원, 해시 일치, 잠금·tmp 는 없다
const root2 = join(tmp, 'root2');
mkdirSync(root2);
await restore(backend, root2);
assert.equal(seen.filter((s) => s.method === 'GET' && s.accept === 'application/vnd.github.raw+json').length, 1, 'raw GET 1회');
assert.equal(contentHash(root2), hash);
assert.equal(readFileSync(join(root2, 'daily-runs.json'), 'utf8'), '{"used":7}');
assert.equal(readFileSync(join(root2, 'agent-runs', 'big.json')).length, readFileSync(join(root, 'agent-runs', 'big.json')).length);
assert.throws(() => readFileSync(join(root2, 'visitors', 'v1', '.lock')));
assert.throws(() => readFileSync(join(root2, 'approvals.json.99.tmp')));
// 비어 있지 않은 루트에는 손대지 않는다
const before = contentHash(root2);
writeFileSync(join(root2, 'daily-runs.json'), '{"used":8}');
await restore(backend, root2);
assert.notEqual(contentHash(root2), before);
assert.equal(readFileSync(join(root2, 'daily-runs.json'), 'utf8'), '{"used":8}');

// (5) preflight 는 자기 경로만 쓴다 — 스냅샷 슬롯은 그대로고, 올린 것을 그대로 받아 온다
const snapshotBefore = { file: store.file, sha: store.sha };
const { preflight } = await import('./state-sync.mjs');
await preflight();
assert.equal(store.sha, snapshotBefore.sha, 'preflight 가 state.tar.gz 를 건드리지 않는다');
assert.equal(store.file, snapshotBefore.file);
assert.equal(pre.sha, 1, 'preflight 경로에 PUT 1회');
assert.match(pre.file.toString(), /^fleet-console preflight /);
await preflight(); // 두 번째는 기존 sha 를 실어 덮는다
assert.equal(pre.sha, 2);
await assert.rejects(() => preflight({ FLEET_STATE_TOKEN: 't' }), /FLEET_STATE_REPO/);

server.close();
rmSync(tmp, { recursive: true, force: true });
console.log('PASS: github backend — raw GET for >1MB, sha on PUT, 409 retry once, restore only into an empty root, preflight on its own path');
