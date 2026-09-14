import { redirect } from 'next/navigation';

/** 대시보드(`/`)는 슬라이스 6의 몫이다. 지금은 회차 목록이 첫 화면이다. */
export default function Home() {
  redirect('/runs');
}
