-- 구글 로그인 화이트리스트 테이블.
-- 이 파일은 코드 저장용이며, 실제 테이블 생성은 Supabase 대시보드의
-- SQL Editor에서 이 내용을 직접 실행해야 합니다(서버는 DB 스키마를
-- 변경할 권한이 없습니다).

-- 마케터는 캠페인과 무관하게 전역으로 허용되는 이메일 목록입니다.
-- (제일기획 사내 메일이 Google Workspace가 아니라 도메인 기반 판별이
-- 불가능해, 개별 이메일을 직접 등록하는 방식으로 갑니다.)
create table if not exists reelcheck_marketers (
  email text primary key,
  created_at timestamptz default now()
);

-- 에이전시는 캠페인별로 허용되는 이메일 목록입니다. 등록과 동시에 즉시
-- 허용되며, 별도의 초대 메일 발송은 없습니다.
create table if not exists reelcheck_campaign_agencies (
  campaign_id uuid references reelcheck_campaigns(id) on delete cascade,
  email text not null,
  created_at timestamptz default now(),
  primary key (campaign_id, email)
);

-- 마케터 화이트리스트 시딩 예시 (이메일은 반드시 소문자로 입력):
-- insert into reelcheck_marketers (email) values ('jieun.shim@cheil.com');
