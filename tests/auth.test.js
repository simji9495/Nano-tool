/**
 * auth.js의 핵심 권한 판단 로직에 대한 단위 테스트.
 *
 * server.js 전체를 supertest로 띄우는 통합 테스트는 이번 범위에 포함하지
 * 않았다 — supabase 클라이언트가 server.js 최상단에서 실제 SDK로
 * 생성되는 싱글턴이라, 이를 가짜로 바꿔치기하려면 서버 코드를 의존성
 * 주입 가능한 구조로 먼저 리팩터링해야 한다(이번 스코프 밖). 대신 여기서는
 * 실제 화이트리스트 판단·세션 토큰·CSRF 체크처럼 보안에 직접 영향을 주는
 * 로직을 진짜 함수 호출로 검증한다 — Express나 실제 DB 없이도 이 부분만
 * 정확하면 라우트에 붙이는 미들웨어 자체는 신뢰할 수 있다.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";

const {
  resolveAccess,
  signSessionToken,
  verifySessionToken,
  requireAuth,
  requireMarketer,
  requireCampaignAccess,
  verifyOrigin,
  devOnly,
} = await import("../auth.js");

/* server.js가 실제로 쓰는 것과 같은 모양의 체인(.from().select().eq()...)만
 * 흉내 내는 최소 가짜 supabase 클라이언트. */
function makeFakeSupabase({ marketerEmails = [], agencyRows = [], influencerRows = [] } = {}) {
  return {
    from(table) {
      return {
        select() {
          return {
            eq(col, val) {
              if (table === "reelcheck_marketers") {
                return { maybeSingle: async () => ({ data: marketerEmails.includes(val) ? { email: val } : null }) };
              }
              if (table === "reelcheck_campaign_agencies") {
                return Promise.resolve({ data: agencyRows.filter((r) => r.email === val) });
              }
              if (table === "reelcheck_influencers") {
                return { maybeSingle: async () => ({ data: influencerRows.find((r) => r.id === val) || null }) };
              }
              throw new Error(`unexpected table in test fake: ${table}`);
            },
          };
        },
      };
    },
  };
}

function makeRes() {
  const res = { statusCode: 200, body: undefined };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
}

describe("resolveAccess", () => {
  test("마케터 화이트리스트에 있으면 marketer 역할을 준다", async () => {
    const sb = makeFakeSupabase({ marketerEmails: ["jieun.shim@cheil.com"] });
    const access = await resolveAccess("jieun.shim@cheil.com", sb);
    assert.deepEqual(access, { role: "marketer" });
  });

  test("이메일 대소문자가 달라도 화이트리스트와 대조된다", async () => {
    const sb = makeFakeSupabase({ marketerEmails: ["jieun.shim@cheil.com"] });
    const access = await resolveAccess("Jieun.Shim@Cheil.com", sb);
    assert.equal(access?.role, "marketer");
  });

  test("마케터가 아니고 캠페인 화이트리스트에 있으면 agency 역할과 campaignIds를 준다", async () => {
    const sb = makeFakeSupabase({
      agencyRows: [
        { email: "agency@partner.com", campaign_id: "camp-1" },
        { email: "agency@partner.com", campaign_id: "camp-2" },
      ],
    });
    const access = await resolveAccess("agency@partner.com", sb);
    assert.equal(access.role, "agency");
    assert.deepEqual(access.campaignIds.sort(), ["camp-1", "camp-2"]);
  });

  test("어느 화이트리스트에도 없으면 null(권한 없음)", async () => {
    const sb = makeFakeSupabase({});
    const access = await resolveAccess("nobody@outside.com", sb);
    assert.equal(access, null);
  });

  test("이메일이 비어있으면 DB 조회 없이 바로 null", async () => {
    const access = await resolveAccess("", makeFakeSupabase({}));
    assert.equal(access, null);
  });
});

describe("session token", () => {
  test("서명한 토큰은 검증하면 같은 이메일로 돌아온다", () => {
    const token = signSessionToken("jieun.shim@cheil.com");
    const payload = verifySessionToken(token);
    assert.equal(payload.email, "jieun.shim@cheil.com");
  });

  test("위조/손상된 토큰은 검증 시 예외를 던진다", () => {
    const token = signSessionToken("jieun.shim@cheil.com");
    assert.throws(() => verifySessionToken(token + "tampered"));
  });
});

describe("requireAuth", () => {
  test("쿠키가 없으면 401", () => {
    const req = { cookies: {} };
    const res = makeRes();
    requireAuth(req, res, () => assert.fail("next()가 호출되면 안 됨"));
    assert.equal(res.statusCode, 401);
  });

  test("유효한 세션 쿠키가 있으면 req.user.email을 채우고 next()를 호출한다", () => {
    const token = signSessionToken("jieun.shim@cheil.com");
    const req = { cookies: { session: token } };
    const res = makeRes();
    let nextCalled = false;
    requireAuth(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(req.user.email, "jieun.shim@cheil.com");
  });

  test("만료/위조된 쿠키는 401", () => {
    const req = { cookies: { session: "not-a-real-jwt" } };
    const res = makeRes();
    requireAuth(req, res, () => assert.fail("next()가 호출되면 안 됨"));
    assert.equal(res.statusCode, 401);
  });
});

describe("requireMarketer", () => {
  test("마케터 계정이면 통과한다", async () => {
    const sb = makeFakeSupabase({ marketerEmails: ["jieun.shim@cheil.com"] });
    const req = { user: { email: "jieun.shim@cheil.com" } };
    const res = makeRes();
    let nextCalled = false;
    await requireMarketer(sb)(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(req.access.role, "marketer");
  });

  test("에이전시 계정은 403", async () => {
    const sb = makeFakeSupabase({ agencyRows: [{ email: "agency@partner.com", campaign_id: "camp-1" }] });
    const req = { user: { email: "agency@partner.com" } };
    const res = makeRes();
    await requireMarketer(sb)(req, res, () => assert.fail("next()가 호출되면 안 됨"));
    assert.equal(res.statusCode, 403);
  });
});

describe("requireCampaignAccess", () => {
  test("마케터는 campaignId 조회 없이 항상 통과한다", async () => {
    const sb = makeFakeSupabase({ marketerEmails: ["jieun.shim@cheil.com"] });
    const req = { user: { email: "jieun.shim@cheil.com" }, params: { id: "camp-999" } };
    const res = makeRes();
    let nextCalled = false;
    const getCampaignId = async () => assert.fail("마케터는 이 함수가 호출되면 안 됨");
    await requireCampaignAccess(sb, getCampaignId)(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  });

  test("에이전시는 화이트리스트에 등록된 캠페인만 통과한다", async () => {
    const sb = makeFakeSupabase({ agencyRows: [{ email: "agency@partner.com", campaign_id: "camp-1" }] });
    const req = { user: { email: "agency@partner.com" }, params: { id: "camp-1" } };
    const res = makeRes();
    let nextCalled = false;
    await requireCampaignAccess(sb, async (r) => r.params.id)(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  });

  test("에이전시가 등록되지 않은 캠페인에 접근하면 403", async () => {
    const sb = makeFakeSupabase({ agencyRows: [{ email: "agency@partner.com", campaign_id: "camp-1" }] });
    const req = { user: { email: "agency@partner.com" }, params: { id: "camp-2" } };
    const res = makeRes();
    await requireCampaignAccess(sb, async (r) => r.params.id)(req, res, () => assert.fail("next()가 호출되면 안 됨"));
    assert.equal(res.statusCode, 403);
  });

  test("influencerId로 넘어온 요청은 클라이언트 값이 아니라 역조회된 campaign_id로 판단한다(위조 방지)", async () => {
    const sb = makeFakeSupabase({
      agencyRows: [{ email: "agency@partner.com", campaign_id: "real-camp" }],
      influencerRows: [{ id: "inf-1", campaign_id: "real-camp" }],
    });
    const getCampaignIdFromInfluencer = async (req, supabase) => {
      const { data } = await supabase.from("reelcheck_influencers").select("campaign_id").eq("id", req.body.influencerId).maybeSingle();
      return data?.campaign_id || null;
    };
    // 클라이언트가 body에 다른 campaignId를 실어 보내도(위조 시도), 실제 판단은
    // influencerId를 역조회한 값 하나만 본다.
    const req = { user: { email: "agency@partner.com" }, body: { influencerId: "inf-1", campaignId: "fake-camp" } };
    const res = makeRes();
    let nextCalled = false;
    await requireCampaignAccess(sb, getCampaignIdFromInfluencer)(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  });

  test("화이트리스트에 아예 없는 이메일은 403", async () => {
    const sb = makeFakeSupabase({});
    const req = { user: { email: "nobody@outside.com" }, params: { id: "camp-1" } };
    const res = makeRes();
    await requireCampaignAccess(sb, async (r) => r.params.id)(req, res, () => assert.fail("next()가 호출되면 안 됨"));
    assert.equal(res.statusCode, 403);
  });
});

describe("verifyOrigin (CSRF 방지)", () => {
  const mw = verifyOrigin("https://app.example.com");

  test("GET 요청은 검사하지 않는다", () => {
    const req = { method: "GET", headers: { origin: "https://evil.com" } };
    const res = makeRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  });

  test("허용된 origin의 POST는 통과한다", () => {
    const req = { method: "POST", headers: { origin: "https://app.example.com" } };
    const res = makeRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  });

  test("다른 origin의 POST는 403", () => {
    const req = { method: "POST", headers: { origin: "https://evil.com" } };
    const res = makeRes();
    mw(req, res, () => assert.fail("next()가 호출되면 안 됨"));
    assert.equal(res.statusCode, 403);
  });

  test("origin 헤더가 없는 POST(curl 등)는 통과한다", () => {
    const req = { method: "POST", headers: {} };
    const res = makeRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  });
});

describe("devOnly (개발용 라우트 우회)", () => {
  test("NODE_ENV=production이 아니면 감싼 미들웨어를 건너뛰고 그냥 통과시킨다", () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      const req = {};
      const res = makeRes();
      let nextCalled = false;
      devOnly(() => assert.fail("감싼 미들웨어가 호출되면 안 됨"))(req, res, () => { nextCalled = true; });
      assert.equal(nextCalled, true);
    } finally {
      process.env.NODE_ENV = original;
    }
  });

  test("NODE_ENV=production이면 감싼 미들웨어를 그대로 실행한다", () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const req = { cookies: {} };
      const res = makeRes();
      devOnly(requireAuth)(req, res, () => assert.fail("인증 없이 next()가 호출되면 안 됨"));
      assert.equal(res.statusCode, 401);
    } finally {
      process.env.NODE_ENV = original;
    }
  });
});
