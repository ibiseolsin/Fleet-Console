#!/usr/bin/env node
/**
 * MCP 서버 — 도구 다섯을 외부 에이전트에게 stdio 로 연다 (읽기 셋: 슬라이스 3 · 쓰기 둘: 슬라이스 4).
 *
 *   node src/mcp/server.mjs          # stdio. Claude Code · MCP 클라이언트가 이렇게 띄운다
 *
 * 이 파일은 **전송만** 한다 — 도구의 이름·설명·스키마·핸들러는 `src/fleet/tools.mjs` 에 있고,
 * 뒤 슬라이스의 화면과 에이전트 루프도 그 표를 그대로 쓴다.
 *
 * 낼 것은 둘이다: 사람이 읽는 요약(`content`)과 구조화된 결과(`structuredContent`).
 * 요약만 내면 에이전트가 문장을 다시 파싱해야 하고, JSON 만 내면 사람이 회차 상세에서 읽을 것이 없다.
 *
 * 오류는 **그대로 반환한다** — 재시도하지 않는다 (`PRD.md §4`). 읽기 도구가 조용히 빈 결과를 내면
 * 부른 쪽이 "할 일이 없다" 로 읽는다.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { TOOLS } from '../fleet/tools.mjs';

const server = new McpServer(
  { name: 'fleet-console', version: '0.1.0' },
  {
    instructions: [
      '샌드박스 플릿의 상태·슬라이스 자격·지난 회차를 읽고(fleet_status · fleet_slices · fleet_report),',
      '파견·착륙을 실행한다(fleet_dispatch · fleet_land). 읽기 셋은 상태를 바꾸지 않으므로 마음껏 불러도 된다.',
      '쓰기 둘은 승인 게이트를 지난다 — 승인 없이 부르면 아무것도 만들지 않고 대기 항목만 생기고,',
      '사람이 승인한 뒤 같은 인자로 다시 불러야 실행된다. 승인은 도구가 아니라 사람의 자리다.',
    ].join(' '),
  }
);

for (const t of TOOLS) {
  server.registerTool(
    t.name,
    {
      title: t.title,
      description: t.description,
      inputSchema: t.schema,
      // 읽기인지 쓰기인지를 클라이언트가 **스키마에서** 알 수 있게 한다. 설명 문장에만 적으면
      // 도구를 고르는 쪽이 그 문장을 안 읽고도 안전한 줄 알고 부른다. 값은 도구마다 다르므로
      // 여기서 박지 않고 `tools.mjs` 의 표에서 가져온다 (`READ_ONLY` · `WRITE_GATED`).
      annotations: t.annotations,
    },
    async (args) => {
      const { data, text } = await t.run(args || {});
      return { content: [{ type: 'text', text }], structuredContent: data };
    }
  );
}

await server.connect(new StdioServerTransport());
