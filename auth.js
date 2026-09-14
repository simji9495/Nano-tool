/**
 * 구글 로그인(리다이렉트 방식) + 마케터/에이전시 권한 확인.
 *
 * 프론트엔드에 구글의 외부 스크립트(GIS 등)를 전혀 불러오지 않는다 —
 * "외부 CDN 스크립트 일절 없음" 정책(frontend/public/index.html 참고)을
 * 지키기 위해, 로그인 버튼은 그냥 우리 백엔드 주소로 이동(리다이렉트)만
 * 하고, 구글과의 실제 교환은 전부 서버 대 서버로 처리한다.
 *
 * 권한은 JWT에 role/campaignIds를 담아두지 않고 매 요청마다 화이트리스트
 * 테이블(reelcheck_marketers / reelcheck_campaign_agencies)을 다시 조회한다.
 * JWT에 캐싱하면 화이트리스트에서 빠진 사람이 토큰 만료 전까지 계속 접근할
 * 수 있게 되므로, 조회 비용을 조금 더 쓰더라도 "다음 요청부터 즉시 차단"을
 * 택했다.
 */
import { OAuth2Client } from "google-auth-library";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";

export const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7일
export const OAUTH_STATE_MAX_AGE_MS = 10 * 60 * 1000; // 10분(로그인 절차 완료까지 넉넉한 시간)

/* 환경변수는 함수 안에서 그때그때 읽는다(모듈 최상단에서 한 번만 읽지
 * 않음) — ESM은 import된 모듈들을 이 파일 자신의 최상단 코드보다 먼저
 * 평가하므로, server.js가 자기 최상단에서 부르는 dotenv.config()보다
 * 이 파일의 최상단 코드가 먼저 실행돼버린다. 여기서 즉시 process.env.X를
 * 상수로 캐싱하면 .env 파일로 값을 넣는 로컬 개발 환경에서는 항상
 * undefined만 읽게 되는 문제가 생긴다. */
function getGoogleClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.OAUTH_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / OAUTH_REDIRECT_URI가 설정되지 않았습니다.");
  }
  return new OAuth2Client(clientId, clientSecret, redirectUri);
}

/* 구글 로그인 화면으로 보낼 주소를 만든다. state는 이 로그인 시도가
 * 정말 우리 사이트에서 시작된 게 맞는지 콜백에서 대조하기 위한 1회용
 * 값이다(발급 시 쿠키에도 같이 심어둔다 — server.js 참고). */
export function generateOAuthState() {
  return crypto.randomBytes(16).toString("hex");
}

export function buildGoogleAuthUrl(state) {
  return getGoogleClient().generateAuthUrl({
    access_type: "online",
    scope: ["openid", "email"],
    prompt: "select_account",
    state,
  });
}

/* 구글이 돌려준 authorization code를 실제 이메일로 교환한다. 코드를
 * 토큰으로 바꾸고, 그 안의 id_token이 우리 프로젝트(GOOGLE_CLIENT_ID)
 * 앞으로 발급된 진짜 값인지 한 번 더 검증한다. 이메일은 항상 소문자로
 * 반환한다 — 대소문자 차이로 화이트리스트 대조가 어긋나는 문제를 막기
 * 위해서다. */
export async function exchangeCodeForEmail(code) {
  const client = getGoogleClient();
  const { tokens } = await client.getToken(code);
  const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: process.env.GOOGLE_CLIENT_ID });
  const payload = ticket.getPayload();
  if (!payload?.email_verified) throw new Error("이메일이 확인되지 않은 구글 계정입니다.");
  return String(payload.email).toLowerCase();
}

export function signSessionToken(email) {
  return jwt.sign({ email }, process.env.SESSION_SECRET, { expiresIn: "7d" });
}

export function verifySessionToken(token) {
  return jwt.verify(token, process.env.SESSION_SECRET); // 만료·위조 시 그대로 throw
}

/* 마케터 화이트리스트(전역) → 에이전시 화이트리스트(캠페인별) 순으로 조회한다.
 * 둘 다 없으면 null(권한 없음). */
export async function resolveAccess(email, supabase) {
  const normalized = String(email || "").toLowerCase();
  if (!normalized || !supabase) return null;

  const { data: marketer } = await supabase
    .from("reelcheck_marketers")
    .select("email")
    .eq("email", normalized)
    .maybeSingle();
  if (marketer) return { role: "marketer" };

  const { data: agencies } = await supabase
    .from("reelcheck_campaign_agencies")
    .select("campaign_id")
    .eq("email", normalized);
  if (agencies?.length) return { role: "agency", campaignIds: agencies.map((a) => a.campaign_id) };

  return null;
}

/* 쿠키의 세션 JWT만 확인한다 — 화이트리스트 조회는 하지 않는다(권한이
 * 필요한 라우트는 requireMarketer/requireCampaignAccess가 이어서 확인). */
export function requireAuth(req, res, next) {
  const token = req.cookies?.session;
  if (!token) return res.status(401).json({ error: "로그인이 필요합니다." });
  try {
    const { email } = verifySessionToken(token);
    req.user = { email };
    next();
  } catch {
    res.status(401).json({ error: "로그인이 만료됐습니다. 다시 로그인해주세요." });
  }
}

export function requireMarketer(supabase) {
  return async (req, res, next) => {
    const access = await resolveAccess(req.user?.email, supabase);
    if (access?.role !== "marketer") {
      return res.status(403).json({ error: "마케터 계정만 접근할 수 있습니다." });
    }
    req.access = access;
    next();
  };
}

/* getCampaignId(req, supabase)가 이 요청이 다루는 campaign_id를 알아낸다.
 * influencerId가 있는 요청은 클라이언트가 보낸 값을 그대로 믿지 않고, DB에서
 * 그 인플루언서가 실제로 속한 campaign_id를 역조회하는 함수를 넘겨야 한다
 * (위조 방지). 마케터는 화이트리스트 캠페인이 없다는 개념 자체가 없어
 * 전부 통과, 에이전시는 자신의 campaignIds 목록에 포함될 때만 통과한다. */
export function requireCampaignAccess(supabase, getCampaignId) {
  return async (req, res, next) => {
    const access = await resolveAccess(req.user?.email, supabase);
    if (!access) return res.status(403).json({ error: "접근 권한이 없습니다." });
    if (access.role === "marketer") {
      req.access = access;
      return next();
    }
    const campaignId = await getCampaignId(req, supabase);
    if (!campaignId || !access.campaignIds.includes(campaignId)) {
      return res.status(403).json({ error: "이 캠페인에 대한 접근 권한이 없습니다." });
    }
    req.access = access;
    next();
  };
}

/* 프론트(Vercel)와 백엔드(Render)가 서로 다른 도메인이라 쿠키를
 * sameSite=none으로 발급하는데, 이 설정은 CSRF 방어를 대신해주지 않는다.
 * 그래서 상태를 바꾸는 요청(POST/PUT/PATCH/DELETE)에 한해 Origin 헤더가
 * 우리 프론트 주소와 일치하는지 별도로 확인한다. Origin이 아예 없는
 * 요청(curl 등)은 브라우저 기반 CSRF 공격의 전제 자체가 성립하지 않으므로
 * 통과시킨다. */
export function verifyOrigin(allowedOrigin) {
  return (req, res, next) => {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();
    const origin = req.headers.origin;
    if (origin && origin !== allowedOrigin) {
      return res.status(403).json({ error: "허용되지 않은 출처의 요청입니다." });
    }
    next();
  };
}

/* 화면(마케터/에이전시 UI)에서는 전혀 쓰이지 않는 개발자 전용 테스트
 * 라우트(/api/transcribe 멀티파트, /api/frames, /api/inspect)는 로컬
 * 개발 중에는 로그인 없이 curl로 바로 테스트할 수 있게 두고, 배포 환경
 * (NODE_ENV=production)에서만 인증을 강제한다. 실사용자가 쓰는 화면에는
 * 영향이 없다 — 애초에 그 화면들이 호출하지 않는 라우트다. */
export function devOnly(middleware) {
  return (req, res, next) => {
    if (process.env.NODE_ENV !== "production") return next();
    return middleware(req, res, next);
  };
}
