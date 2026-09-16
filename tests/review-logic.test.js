/**
 * 검수 로직 중 OpenAI 호출 없이 순수 로직만으로 검증 가능한 부분에 대한
 * 유닛 테스트. 이번 세션에서 실제로 발생했던 회귀(캡션 텍스트에 내부 판정
 * 문구가 섞여 들어간 버그, "개선/해결" 표현을 금칙어 위반으로 오판한 버그
 * 등)를 앞으로는 실제 영상을 올려서 눈으로 확인하기 전에 여기서 먼저 잡기
 * 위한 안전망이다. LLM 프롬프트/응답 처리 자체는 대상이 아니다 — 결정론적
 * 문자열 판정 함수만 검증한다.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://test.supabase.co";
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "test-service-key";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
process.env.ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "http://localhost:3000";

const {
  scanExactOccurrences,
  fuzzyContains,
  levenshtein,
  dedupeByText,
  buildOcrSummary,
  hasPositiveOverride,
} = await import("../server.js");

describe("levenshtein", () => {
  test("동일 문자열은 거리 0", () => {
    assert.equal(levenshtein("우르오스", "우르오스"), 0);
  });
  test("한 글자 치환은 거리 1", () => {
    assert.equal(levenshtein("우르오스", "우로오스"), 1);
  });
});

describe("fuzzyContains", () => {
  test("허용 편집거리 이내 근접 문자열은 true", () => {
    assert.equal(fuzzyContains("오늘의우로스세정", "우르오스", 0.3, 2), true);
  });
  test("허용 편집거리를 넘는 무관 문자열은 false", () => {
    // "실리콘 성분 X" 처럼 브랜드명과 무관한 문장까지 근접매치로 잡히던
    // 실측 오탐 사례 — minDist=2 상한을 넘는 차이라 false여야 한다.
    assert.equal(fuzzyContains("실리콘성분엑스", "우르오스", 0.3, 2), false);
  });
});

describe("scanExactOccurrences", () => {
  const tagged = "[11s] 우로스 스칼프 샴푸는\n[20s] 오늘 소개할 제품은";

  test("공백만 다르면 정확 매치(exact)로 잡는다", () => {
    const r = scanExactOccurrences("[5s] 우르오스   스칼프", "우르오스", "음성", "brand");
    assert.equal(r.exact.length, 1);
    assert.equal(r.near.length, 0);
  });

  test("편집거리 2 이내 근접 오독은 near로 잡고 exact엔 안 넣는다", () => {
    const r = scanExactOccurrences(tagged, "우르오스", "음성", "brand");
    assert.equal(r.exact.length, 0);
    assert.equal(r.near.length, 1);
    assert.match(r.near[0].fix, /우르오스/);
  });

  test("전혀 언급 안 되면 둘 다 빈 배열", () => {
    const r = scanExactOccurrences("[1s] 오늘 날씨가 좋네요", "우르오스", "음성", "brand");
    assert.equal(r.exact.length, 0);
    assert.equal(r.near.length, 0);
  });

  test("target이 빈 값이면 크래시 없이 빈 배열", () => {
    const r = scanExactOccurrences(tagged, "", "음성", "brand");
    assert.deepEqual(r, { exact: [], near: [] });
  });
});

describe("buildOcrSummary — Vision 판정 문구가 캡션 텍스트에 섞이던 버그의 회귀 테스트", () => {
  test("Vision이 빈 문자열로 답한 프레임(글자 없음)은 줄 자체를 생략한다", () => {
    const zipped = [{ t: 2, text: "아무 텍스트나" }];
    const verifications = [{ t: 2, correctedText: "", violates: false, matchedBan: null }];
    const summary = buildOcrSummary(zipped, verifications);
    assert.equal(summary, "");
  });

  test("위반이 확인되면 텍스트 뒤에 위반 사실만 덧붙이고, 내부 판정 문구를 통째로 자막인 것처럼 넣지 않는다", () => {
    const zipped = [{ t: 6, text: "경쟁사 이름" }];
    const verifications = [{ t: 6, correctedText: "경쟁사 이름", violates: true, matchedBan: "경쟁사" }];
    const summary = buildOcrSummary(zipped, verifications);
    assert.equal(summary, "[6s] 경쟁사 이름 (금칙어 위반 확인됨: 경쟁사)");
  });

  test("위반이 아니면 보정된 텍스트만 그대로 넣는다(OCR 오인식 확인됨 같은 문구를 덧붙이지 않는다)", () => {
    const zipped = [{ t: 6, text: "우로스 ULOS스칼프샴푸" }];
    const verifications = [{ t: 6, correctedText: "우르오스 스칼프샴푸", violates: false, matchedBan: null }];
    const summary = buildOcrSummary(zipped, verifications);
    assert.equal(summary, "[6s] 우르오스 스칼프샴푸");
    assert.doesNotMatch(summary, /확인됨|오인식|→/);
  });

  test("검증 대상이 아니었던 프레임은 원본 Tesseract 텍스트를 그대로 쓴다", () => {
    const zipped = [{ t: 1, text: "산뜻한 느낌" }];
    const summary = buildOcrSummary(zipped, []);
    assert.equal(summary, "[1s] 산뜻한 느낌");
  });

  test("텍스트가 없는 프레임은 애초에 건너뛴다", () => {
    const zipped = [{ t: 1, text: "" }];
    const summary = buildOcrSummary(zipped, []);
    assert.equal(summary, "");
  });
});

describe("hasPositiveOverride — 개선/해결 표현 오판 방지 안전망", () => {
  test("'개선'이 들어간 문구는 긍정으로 본다", () => {
    assert.equal(hasPositiveOverride("4주 임상으로 확인된 비듬 개선 효과"), true);
  });
  test("'해결'이 들어간 문구도 긍정으로 본다", () => {
    assert.equal(hasPositiveOverride("오랜 고민이었던 비듬을 해결했어요"), true);
  });
  test("긍정 키워드가 없는 문구는 false", () => {
    assert.equal(hasPositiveOverride("사용 후 비듬이 더 심해졌어요"), false);
  });
});

describe("dedupeByText", () => {
  test("거의 같은 텍스트가 반복되는 프레임은 하나만 남긴다", () => {
    const frames = [
      { t: 1, text: "우르오스 스칼프샴푸" },
      { t: 2, text: "우르오스 스칼프샴푸" },
      { t: 3, text: "완전히 다른 문구입니다" },
    ];
    const out = dedupeByText(frames);
    assert.equal(out.length, 2);
  });
});
