-- 화면 자막 검수가 백그라운드로 넘어간 시각을 기록해, 서버 재시작/크래시로
-- 그 작업이 멈춘 채 방치되는 걸 감지하는 데 쓴다(server.js의
-- finalizeStuckCaptionJobs 참고). Supabase SQL Editor에서 직접 실행하세요.

alter table reelcheck_influencers add column if not exists audio_done_at timestamptz;
