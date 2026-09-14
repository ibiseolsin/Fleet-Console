/** 저장소 루트의 `src/fleet/*` 를 화면이 그대로 쓴다 — 파서를 화면용으로 복사하지 않는다. */
const nextConfig = {
  outputFileTracingRoot: new URL('..', import.meta.url).pathname,
  serverExternalPackages: ['@modelcontextprotocol/sdk'],
};

export default nextConfig;
