-- 음성 검수에서 브랜드/제품명 발음 오인식을 허용 표기로 등록하는 기능.
-- Supabase SQL Editor에서 직접 실행하세요.
-- 자막(화면 텍스트)에는 적용하지 않고 음성 인식에만 사용합니다.

alter table reelcheck_campaigns add column if not exists brand_audio_aliases jsonb default '[]'::jsonb;
alter table reelcheck_campaigns add column if not exists product_audio_aliases jsonb default '[]'::jsonb;
