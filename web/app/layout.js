import './globals.css';

export const metadata = {
  title: 'Fleet Console',
  description: '여러 AI 코딩 에이전트 플릿의 판정을 도구와 화면으로 여는 콘솔',
};

export default function RootLayout({ children }) {
  return (
    <html lang="ko">
      <body>
        <header className="top">
          <div className="wrap">
            <b>
              <a href="/runs" style={{ textDecoration: 'none' }}>
                Fleet Console
              </a>
            </b>
            <span>관찰 → 자격 판정 → 승인 → 실행 → 기록</span>
            <nav>
              <a href="/demo">내 데모</a>
              <a href="/runs">회차</a>
              <a href="/approvals">승인 큐</a>
              <a href="/agent">에이전트</a>
              <a href="/eval">비용·시간</a>
            </nav>
          </div>
        </header>
        <main className="wrap">{children}</main>
      </body>
    </html>
  );
}
