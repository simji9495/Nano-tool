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
  buildGuideline,
  scanDeterministicMatches,
  parseGuidelineResponse,
  composeReviewResult,
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

describe("buildGuideline", () => {
  test("campaign이 null이어도 크래시 없이 빈 기본값을 준다", () => {
    assert.deepEqual(buildGuideline(null), {
      brand: "",
      product: "",
      usps: [],
      bans: [],
      competitorBrands: [],
      brandAudioAliases: [],
      productAudioAliases: [],
    });
  });

  test("빈 문자열 항목은 배열에서 제거한다(설정 폼의 [\"\"] 기본값 대비)", () => {
    const g = buildGuideline({ brand: "우르오스", usps: ["", "쿨링감"], bans: [""] });
    assert.deepEqual(g.usps, ["쿨링감"]);
    assert.deepEqual(g.bans, []);
  });
});

describe("scanDeterministicMatches", () => {
  const guideline = buildGuideline({
    brand: "우르오스",
    product: "스칼프 샴푸",
    competitorBrands: ["경쟁브랜드"],
    brandAudioAliases: ["우로스"],
  });

  test("음성에서 등록된 허용 표기(우로스)는 근접매치가 아니라 정확 매치로 처리한다", () => {
    const m = scanDeterministicMatches("[1s] 우로스 스칼프 샴푸는", "", guideline);
    assert.equal(m.brandExact.length, 1);
    // 허용 표기로 이미 확정됐으니 "확인 필요" 근접 매치 목록엔 중복으로 남지 않는다.
    assert.equal(m.brandNear.length, 0);
  });

  test("자막에서는 같은 근접 오독(우로스)이라도 허용 표기가 적용되지 않는다", () => {
    const m = scanDeterministicMatches("", "[1s] 우로스 스칼프 샴푸는", guideline);
    assert.equal(m.brandExact.length, 0);
    assert.equal(m.brandNear.length, 1);
  });

  test("경쟁 브랜드 정확 매치는 competitorExact에 브랜드명을 note로 담는다", () => {
    const m = scanDeterministicMatches("[1s] 오늘은 경쟁브랜드 제품과 비교해봤어요", "", guideline);
    assert.equal(m.competitorExact.length, 1);
    assert.equal(m.competitorExact[0].note, "경쟁브랜드");
  });
});

describe("parseGuidelineResponse", () => {
  test("direction이 'other'인 ban 후보는 위반 목록에서 제외한다", () => {
    const r = parseGuidelineResponse({
      missingUsps: [],
      matchedUsps: [],
      feedback: "괜찮습니다",
      occurrences: [
        { type: "ban", quote: "비듬 개선 효과", direction: "other", banText: "비듬이 생긴다" },
      ],
    });
    assert.equal(r.llmOccurrences.length, 0);
    assert.deepEqual(r.contextualViolatedBans, []);
  });

  test("direction이 'worsen'이어도 긍정 키워드가 있으면 코드가 한 번 더 걸러낸다", () => {
    const r = parseGuidelineResponse({
      occurrences: [
        { type: "ban", quote: "비듬 개선 효과", direction: "worsen", banText: "비듬이 생긴다" },
      ],
    });
    assert.equal(r.llmOccurrences.length, 0);
  });

  test("direction이 'worsen'이고 긍정 키워드가 없으면 위반으로 남긴다", () => {
    const r = parseGuidelineResponse({
      occurrences: [
        { type: "ban", quote: "비듬이 심해졌어요", direction: "worsen", banText: "비듬이 생긴다" },
      ],
    });
    assert.equal(r.llmOccurrences.length, 1);
    assert.deepEqual(r.contextualViolatedBans, ["비듬이 생긴다"]);
  });

  test("usp/typo 타입은 direction과 무관하게 그대로 남는다", () => {
    const r = parseGuidelineResponse({
      occurrences: [{ type: "usp", quote: "쿨링감이 짱짱", note: "USP 충족" }],
    });
    assert.equal(r.llmOccurrences.length, 1);
  });
});

describe("composeReviewResult", () => {
  const emptyMatches = {
    brandExact: [], brandNear: [], productExact: [], productNear: [],
    competitorExact: [], competitorNear: [],
  };
  const emptyParsed = {
    missingUsps: [], matchedUsps: [], feedback: "", llmOccurrences: [], contextualViolatedBans: [],
  };

  test("브랜드/제품 언급 + 미충족 USP 없음 + 위반 없음이면 통과", () => {
    const matches = { ...emptyMatches, brandExact: [{ timestamp: 1 }], productExact: [{ timestamp: 2 }] };
    const r = composeReviewResult(matches, emptyParsed);
    assert.equal(r.result, "통과");
  });

  test("브랜드가 근접매치만 있어도(정확매치 없어도) 언급된 것으로 인정한다", () => {
    const matches = { ...emptyMatches, brandNear: [{ timestamp: 1 }], productExact: [{ timestamp: 2 }] };
    const r = composeReviewResult(matches, emptyParsed);
    assert.equal(r.brandMentioned, true);
    assert.equal(r.result, "통과");
  });

  test("브랜드 언급이 전혀 없으면 나머지가 다 충족돼도 반려", () => {
    const matches = { ...emptyMatches, productExact: [{ timestamp: 2 }] };
    const r = composeReviewResult(matches, emptyParsed);
    assert.equal(r.brandMentioned, false);
    assert.equal(r.result, "반려");
  });

  test("경쟁 브랜드 정확 매치가 있으면 위반으로 집계돼 반려된다", () => {
    const matches = {
      ...emptyMatches,
      brandExact: [{ timestamp: 1 }],
      productExact: [{ timestamp: 2 }],
      competitorExact: [{ timestamp: 3, note: "경쟁브랜드" }],
    };
    const r = composeReviewResult(matches, emptyParsed);
    assert.deepEqual(r.violatedBans, ["경쟁브랜드"]);
    assert.equal(r.result, "반려");
  });

  test("occurrences는 시간순으로 정렬된다", () => {
    const matches = {
      ...emptyMatches,
      brandExact: [{ timestamp: 10 }],
      productExact: [{ timestamp: 2 }],
    };
    const r = composeReviewResult(matches, emptyParsed);
    assert.deepEqual(r.occurrences.map((o) => o.timestamp), [2, 10]);
  });
});
