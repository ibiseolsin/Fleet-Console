/**
 * 상태 루트(`FLEET_STATE_ROOT`)를 tar.gz 한 파일로 바깥에 보존한다 — 영구 디스크가 없는 Render Free 용.
 *
 *   restore  루트가 비어 있으면 최신 스냅샷을 받아 **같은 절대경로**에 푼다(픽스처의 링크드 워크트리가 절대경로다).
 *   preflight  실제 저장소·토큰을 왕복으로 확인한다(상태 스냅샷은 건드리지 않는다). 배포 전에 한 번.
 *   watch    `fs.watch` 재귀 감시 → 3초 디바운스 → 내용 해시가 바뀌었을 때만 tar.gz 를 올린다.
 *            SIGTERM/SIGINT 에 마지막 한 번 더 올리고 끝난다.
 *
 * 백엔드는 환경변수로 고른다 — `FLEET_STATE_REPO`(owner/repo, GitHub Contents API, 토큰 `FLEET_STATE_TOKEN`)가 있으면
 * `github`, 없고 `FLEET_STATE_DIR` 이 있으면 `dir`(폴더 하나 — 로컬·컨테이너 검사용), 둘 다 없으면 아무것도 안 한다.
 * 잠금 폴더(`.lock`·`.quota-lock`)와 `*.tmp` 는 스냅샷에 넣지 않는다. 앱 코드(`src/`)는 읽기만 한다.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import { STATE_ROOT } from '../src/state.mjs';

const ROOT = STATE_ROOT;
const DEBOUNCE_MS = Number(process.env.FLEET_STATE_SYNC_DEBOUNCE_MS || 3000);
const SAFETY_MS = Number(process.env.FLEET_STATE_SYNC_INTERVAL_MS || 60000); // 감시 이벤트를 놓쳤을 때의 안전망
const EXCLUDES = ['.lock', '.quota-lock', '*.tmp'];
const META = '.state-sync.json';
const log = (event, extra = {}) => console.log(JSON.stringify({ event: 'state-sync:' + event, ...extra }));

// ── 백엔드 ────────────────────────────────────────────────────────────────

function dirBackend(dir) {
  const file = join(dir, 'state.tar.gz');
  return {
    name: 'dir:' + dir,
    async download(to) {
      if (!existsSync(file)) return false;
      writeFileSync(to, readFileSync(file));
      return true;
    },
    async upload(from) {
      mkdirSync(dir, { recursive: true });
      const tmp = file + '.' + process.pid + '.tmp';
      writeFileSync(tmp, readFileSync(from));
      renameSync(tmp, file);
      return { bytes: statSync(file).size };
    },
  };
}

function githubBackend(repo, token, path = process.env.FLEET_STATE_PATH || 'state.tar.gz') {
  if (!token) throw new Error('FLEET_STATE_TOKEN 이 없습니다 (FLEET_STATE_REPO=' + repo + ')');
  const base = (process.env.FLEET_STATE_API || 'https://api.github.com') + '/repos/' + repo + '/contents/' + path;
  const branch = process.env.FLEET_STATE_BRANCH || '';
  const headers = (accept) => ({
    Authorization: 'Bearer ' + token,
    Accept: accept,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'fleet-console-state-sync',
  });
  const q = branch ? '?ref=' + encodeURIComponent(branch) : '';
  // 1MB 를 넘는 파일은 JSON GET 의 `content` 가 비므로(encoding "none") 본문은 raw 로, sha 는 JSON 으로 받는다.
  const sha = async () => {
    const r = await fetch(base + q, { headers: headers('application/vnd.github+json') });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('GitHub GET sha ' + r.status + ': ' + (await r.text()).slice(0, 200));
    return (await r.json()).sha;
  };
  return {
    name: 'github:' + repo + '/' + path,
    async download(to) {
      const r = await fetch(base + q, { headers: headers('application/vnd.github.raw+json') });
      if (r.status === 404) return false;
      if (!r.ok) throw new Error('GitHub GET raw ' + r.status + ': ' + (await r.text()).slice(0, 200));
      writeFileSync(to, Buffer.from(await r.arrayBuffer()));
      return true;
    },
    async upload(from) {
      const content = readFileSync(from).toString('base64');
      const put = async () => {
        const body = { message: 'state snapshot ' + new Date().toISOString(), content };
        const current = await sha();
        if (current) body.sha = current;
        if (branch) body.branch = branch;
        const r = await fetch(base, { method: 'PUT', headers: { ...headers('application/vnd.github+json'), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!r.ok) throw Object.assign(new Error('GitHub PUT ' + r.status + ': ' + (await r.text()).slice(0, 200)), { status: r.status });
        return { bytes: statSync(from).size, sha: (await r.json()).content?.sha };
      };
      try {
        return await put();
      } catch (e) {
        if (e.status !== 409 && e.status !== 422) throw e; // sha 가 그새 바뀜 — 한 번만 다시
        log('put-retry', { status: e.status });
        return put();
      }
    },
  };
}

export function pickBackend(env = process.env) {
  if (env.FLEET_STATE_REPO) return githubBackend(env.FLEET_STATE_REPO, env.FLEET_STATE_TOKEN);
  if (env.FLEET_STATE_DIR) return dirBackend(env.FLEET_STATE_DIR);
  return null;
}

// ── 스냅샷 ────────────────────────────────────────────────────────────────

const excluded = (name) => name === '.lock' || name === '.quota-lock' || name.endsWith('.tmp') || name === META;

/** 루트의 내용 해시 — 경로와 파일 내용만(잠금·tmp 제외). mtime 은 안 본다. */
export function contentHash(root = ROOT) {
  const h = createHash('sha256');
  const walk = (dir, rel) => {
    let names;
    try { names = readdirSync(dir).sort(); } catch { return; }
    for (const n of names) {
      if (excluded(n)) continue;
      const p = join(dir, n);
      const key = rel ? rel + '/' + n : n;
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p, key);
      else {
        let data;
        try { data = readFileSync(p); } catch { continue; }
        h.update(key).update('\0').update(data).update('\0');
      }
    }
  };
  walk(root, '');
  return h.digest('hex');
}

const isEmpty = (root) => !existsSync(root) || readdirSync(root).filter((n) => n !== META).length === 0;

export function pack(root, out) {
  writeFileSync(join(root, META), JSON.stringify({ root, at: new Date().toISOString(), platform: process.platform }) + '\n');
  // 경로는 상대로 넘긴다 — Windows 의 GNU tar 가 `C:` 를 원격 호스트로 읽는다(로컬 검사용; 배포는 Linux).
  const cwd = dirname(out);
  execFileSync('tar', ['-czf', basename(out), ...EXCLUDES.map((e) => '--exclude=' + e), '-C', rel(cwd, root), '.'], { cwd, stdio: 'pipe' });
  return statSync(out).size;
}

export function unpack(root, archive) {
  mkdirSync(root, { recursive: true });
  const cwd = dirname(archive);
  execFileSync('tar', ['-xzf', basename(archive), '-C', rel(cwd, root)], { cwd, stdio: 'pipe' });
  try {
    const meta = JSON.parse(readFileSync(join(root, META), 'utf8'));
    if (meta.root !== root) log('root-mismatch', { snapshot: meta.root, here: root, note: '픽스처 워크트리의 gitdir 이 절대경로라 깨질 수 있다' });
    return meta;
  } catch {
    return null;
  }
}

const rel = (from, to) => relative(from, to).split(sep).join('/') || '.';
const scratch = () => join(tmpdir(), 'fleet-state-' + process.pid + '-' + Date.now() + '.tar.gz');

// ── 명령 ────────────────────────────────────────────────────────────────

export async function restore(backend = pickBackend(), root = ROOT) {
  if (!backend) return log('restore-skip', { reason: '백엔드 없음' });
  if (!isEmpty(root)) return log('restore-skip', { reason: '루트가 비어 있지 않음', root });
  const file = scratch();
  try {
    const started = Date.now();
    if (!(await backend.download(file))) return log('restore-skip', { reason: '스냅샷 없음', backend: backend.name });
    const meta = unpack(root, file);
    log('restored', { backend: backend.name, bytes: statSync(file).size, ms: Date.now() - started, snapshotAt: meta?.at, hash: contentHash(root) });
  } finally {
    rmSync(file, { force: true });
  }
}

export async function watchAndSync(backend = pickBackend(), root = ROOT) {
  if (!backend) return log('watch-skip', { reason: '백엔드 없음' });
  let last = process.env.FLEET_STATE_SYNC_ASSUME_SAVED === '0' ? null : contentHash(root); // 방금 restore 한 내용은 이미 올라가 있다
  let timer = null;
  let flushing = null;
  let dirty = false;
  let stopping = false;
  let uploads = 0;

  const flush = async (why) => {
    if (flushing) { dirty = true; return flushing; }
    flushing = (async () => {
      do {
        dirty = false;
        const hash = contentHash(root);
        if (hash === last) { log('unchanged', { why }); continue; }
        const file = scratch();
        try {
          const started = Date.now();
          const bytes = pack(root, file);
          const r = await backend.upload(file);
          last = hash;
          uploads++;
          log('uploaded', { why, bytes, ms: Date.now() - started, uploads, sha: r?.sha });
        } catch (e) {
          log('upload-failed', { why, error: String(e).slice(0, 300) });
          dirty = true; // 다음 기회에 다시
          if (!stopping) setTimeout(() => flush('retry'), DEBOUNCE_MS * 5).unref();
          break;
        } finally {
          rmSync(file, { force: true });
        }
      } while (dirty && !stopping);
    })().finally(() => { flushing = null; });
    return flushing;
  };

  const schedule = () => {
    if (stopping) return;
    clearTimeout(timer);
    timer = setTimeout(() => flush('change'), DEBOUNCE_MS);
  };
  const watcher = watch(root, { recursive: true }, (_event, name) => {
    if (name && excluded(basename(String(name)))) return;
    schedule();
  });
  watcher.on('error', (e) => log('watch-error', { error: String(e) }));
  const safety = SAFETY_MS > 0 ? setInterval(() => flush('interval'), SAFETY_MS) : null;
  log('watching', { root, backend: backend.name, debounceMs: DEBOUNCE_MS, hash: last });

  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    clearTimeout(timer);
    if (safety) clearInterval(safety);
    watcher.close();
    log('stopping', { signal });
    if (flushing) await flushing;
    await flush('final');
    log('stopped', { uploads });
    process.exit(0);
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  return stop;
}


/**
 * 배포 전 자격증명 왕복 확인 — 상태 스냅샷은 건드리지 않고 `<path>.preflight` 하나를 올렸다가 받아 본다.
 * Render 는 셸이 없어 토큰 오류를 부팅 로그로만 본다. 여기서 먼저 거른다.
 */
export async function preflight(env = process.env) {
  if (!env.FLEET_STATE_REPO) throw new Error('FLEET_STATE_REPO 가 없습니다 (owner/repo)');
  const path = (env.FLEET_STATE_PATH || 'state.tar.gz') + '.preflight';
  const backend = githubBackend(env.FLEET_STATE_REPO, env.FLEET_STATE_TOKEN, path);
  const file = scratch();
  const payload = Buffer.from('fleet-console preflight ' + new Date().toISOString() + ' ' + randomBytes(16).toString('hex') + '\n');
  try {
    writeFileSync(file, payload);
    const started = Date.now();
    const put = await backend.upload(file);
    rmSync(file, { force: true });
    if (!(await backend.download(file))) throw new Error('올린 직후 받지 못했습니다 — 브랜치(FLEET_STATE_BRANCH)를 확인하세요');
    const back = readFileSync(file);
    if (!back.equals(payload)) throw new Error('받은 내용이 올린 것과 다릅니다 (' + back.length + 'B ≠ ' + payload.length + 'B)');
    log('preflight-ok', { repo: env.FLEET_STATE_REPO, path, bytes: put.bytes, ms: Date.now() - started, note: '확인용 파일은 저장소에 남는다' });
  } catch (e) {
    const hint = { 401: '토큰이 잘못됐거나 만료됐습니다', 403: '토큰에 이 저장소의 Contents 쓰기 권한이 없습니다', 404: '저장소 이름이 틀렸거나 토큰이 그 저장소에 접근할 수 없습니다', 409: '같은 저장소에 다른 서버가 동시에 쓰고 있습니다' }[e.status];
    log('preflight-fail', { repo: env.FLEET_STATE_REPO, path, error: e.message, hint });
    throw e;
  } finally {
    rmSync(file, { force: true });
  }
}

const isMain = process.argv[1] && basename(process.argv[1]) === 'state-sync.mjs';
if (isMain) {
  const cmd = process.argv[2];
  if (cmd === 'restore') await restore();
  else if (cmd === 'watch') await watchAndSync();
  else if (cmd === 'preflight') await preflight();
  else if (cmd === 'hash') console.log(contentHash());
  else if (cmd === 'pack') { const out = process.argv[3] || 'state.tar.gz'; console.log(JSON.stringify({ out, bytes: pack(ROOT, out), hash: contentHash() })); }
  else { console.error('usage: node scripts/state-sync.mjs restore|watch|preflight|hash|pack [out]'); process.exit(1); }
}
