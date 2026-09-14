/**
 * server.js를 실제로 import해서(app.listen은 하지 않음, NODE_ENV=test 참고)
 * 로그인 관문 자체가 라우트에 제대로 걸려있는지 확인하는 최소 통합 테스트.
 *
 * supabase는 실제 네트워크에 붙지 않는 더미 자격증명으로 생성한다 —
 * createClient 자체는 네트워크 검증 없이 클라이언트 객체만 만들기 때문에,
 * "설정은 돼있다(requireSupabase 통과)"만 흉내 내면 그 다음 단계인
 * requireAuth/CSRF 체크를 실제 HTTP 요청으로 검증할 수 있다. 화이트리스트
 * 조회가 실제로 맞물려야 하는 마케터/에이전시 역할 분기까지는 이 테스트로
 * 검증하지 않는다 — server.js가 supabase를 자기 최상단에서 직접 생성하는
 * 구조라, 그 결과를 가짜 데이터로 바꿔치기하려면 의존성 주입 리팩터링이
 * 먼저 필요하다(이번 스코프 밖, auth.test.js의 단위 테스트로 그 로직 자체는
 * 이미 검증했다).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

process.env.NODE_ENV = "test";
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://test.supabase.co";
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "test-service-key";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
process.env.ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "http://localhost:3000";

const { default: app } = await import("../server.js");

describe("GET /api/health", () => {
  test("로그인 없이도 응답한다(공개 라우트)", async () => {
    const res = await request(app).get("/api/health");
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.supabase, "boolean");
  });
});

describe("로그인 없이 보호된 라우트를 호출하면", () => {
  test("GET /api/campaigns → 401", async () => {
    const res = await request(app).get("/api/campaigns");
    assert.equal(res.status, 401);
  });

  test("POST /api/campaigns → 401", async () => {
    const res = await request(app).post("/api/campaigns").send({ advertiser: "x", name: "y" });
    assert.equal(res.status, 401);
  });

  test("GET /api/auth/me → 401", async () => {
    const res = await request(app).get("/api/auth/me");
    assert.equal(res.status, 401);
  });

  test("PATCH /api/influencers/:id/marketer-result → 401", async () => {
    const res = await request(app).patch("/api/influencers/abc/marketer-result").send({ marketerResult: "통과" });
    assert.equal(res.status, 401);
  });
});

describe("CSRF Origin 체크", () => {
  test("허용되지 않은 Origin에서의 POST는 403(로그인 여부와 무관)", async () => {
    const res = await request(app)
      .post("/api/campaigns")
      .set("Origin", "https://evil.example.com")
      .send({ advertiser: "x", name: "y" });
    assert.equal(res.status, 403);
  });

  test("GET 요청은 Origin이 달라도 막히지 않는다(로그인만 걸림)", async () => {
    const res = await request(app).get("/api/campaigns").set("Origin", "https://evil.example.com");
    assert.equal(res.status, 401); // 403(CSRF)이 아니라 401(로그인 필요)이어야 한다
  });
});
