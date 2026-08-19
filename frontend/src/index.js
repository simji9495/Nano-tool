import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import * as XLSX from "xlsx";
import CampaignSettings from "./CampaignSettings";
import CampaignCreate, { formatCampaignPeriod } from "./CampaignCreate";

const API_BASE = process.env.REACT_APP_API_BASE || "http://localhost:8787";
const STORAGE_KEY = "reelcheck_campaigns_v1";

const defaultGuidelines = {
  brand: "",
  product: "",
  usps: [""],
  bans: [""],
};

function loadLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { campaigns: [], selectedCampaignId: null };
    const parsed = JSON.parse(raw);
    return {
      campaigns: Array.isArray(parsed.campaigns) ? parsed.campaigns : [],
      selectedCampaignId: parsed.selectedCampaignId || null,
    };
  } catch {
    return { campaigns: [], selectedCampaignId: null };
  }
}

function parseYearMonth(dateStr) {
  const m = String(dateStr || "").match(/^(\d{4})-(\d{2})/);
  if (!m) return { year: "", month: "" };
  return { year: Number(m[1]), month: Number(m[2]) };
}

function mapApiCampaign(row, localInfluencers = []) {
  const start = parseYearMonth(row.start_date);
  const end = parseYearMonth(row.end_date);
  return {
    id: row.id,
    advertiser: row.advertiser || "",
    name: row.name || "",
    startYear: start.year,
    startMonth: start.month,
    endMonth: end.month || start.month,
    manager: row.manager || "",
    brand: row.brand || "",
    product: row.product || "",
    usps: Array.isArray(row.usps) && row.usps.length ? row.usps : [""],
    bans: Array.isArray(row.bans) && row.bans.length ? row.bans : [""],
    influencers: localInfluencers,
  };
}

function App() {
  const local = loadLocal();
  const [role, setRole] = useState("marketer");
  const [tab, setTab] = useState("campaign");
  const [guideOpen, setGuideOpen] = useState(false);
  const [campaigns, setCampaigns] = useState(local.campaigns);
  const [selectedCampaignId, setSelectedCampaignId] = useState(
    local.selectedCampaignId,
  );
  const [selectedInf, setSelectedInf] = useState(null);
  const [feedbackMode, setFeedbackMode] = useState("edit");
  const [feedbackText, setFeedbackText] = useState("");

  const selectedCampaign =
    campaigns.find((c) => c.id === selectedCampaignId) || null;
  const influencers = selectedCampaign?.influencers || [];
  const campaign = selectedCampaign
    ? {
        brand: selectedCampaign.brand || "",
        product: selectedCampaign.product || "",
        usps: selectedCampaign.usps?.length ? selectedCampaign.usps : [""],
        bans: selectedCampaign.bans?.length ? selectedCampaign.bans : [""],
      }
    : defaultGuidelines;

  useEffect(() => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ campaigns, selectedCampaignId }),
    );
  }, [campaigns, selectedCampaignId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/campaigns`);
        if (!res.ok) return;
        const rows = await res.json();
        if (!Array.isArray(rows) || cancelled) return;
        const localNow = loadLocal();
        const mapped = rows.map((row) =>
          mapApiCampaign(
            row,
            localNow.campaigns.find((c) => c.id === row.id)?.influencers || [],
          ),
        );
        if (!mapped.length) return;
        setCampaigns((prev) => {
          const remoteIds = new Set(mapped.map((c) => c.id));
          const localsOnly = prev.filter((c) => !remoteIds.has(c.id));
          return [...mapped, ...localsOnly];
        });
      } catch {
        /* 로컬 저장소만 사용 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const patchSelectedCampaign = (patch) => {
    if (!selectedCampaignId) return;
    setCampaigns((prev) =>
      prev.map((c) => (c.id === selectedCampaignId ? { ...c, ...patch } : c)),
    );
  };

  const setCampaign = (next) => {
    const value = typeof next === "function" ? next(campaign) : next;
    patchSelectedCampaign({
      brand: value.brand,
      product: value.product,
      usps: value.usps,
      bans: value.bans,
    });
  };

  const setInfluencers = (updater) => {
    if (!selectedCampaignId) return;
    setCampaigns((prev) =>
      prev.map((c) => {
        if (c.id !== selectedCampaignId) return c;
        const current = c.influencers || [];
        const next = typeof updater === "function" ? updater(current) : updater;
        return { ...c, influencers: next };
      }),
    );
  };

  const handleCreateCampaign = async (payload) => {
    const localId =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `c_${Date.now()}`;
    let created = {
      id: localId,
      ...payload,
      ...defaultGuidelines,
      influencers: [],
    };

    try {
      const res = await fetch(`${API_BASE}/api/campaigns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        const row = await res.json();
        created = mapApiCampaign(row, []);
      }
    } catch {
      /* 서버 없이도 로컬에서 캠페인 운영 */
    }

    setCampaigns((prev) => [created, ...prev]);
    setSelectedCampaignId(created.id);
  };

  const handleSelectCampaign = (id) => {
    setSelectedCampaignId(id);
    setTab("dashboard");
  };

  // 📥 마케터용 샘플 엑셀 파일 즉시 생성 및 다운로드
  const handleDownloadSample = () => {
    const data = [
      { 이름: "홍길동", 핸들: "@hong_vlog" },
      { 이름: "박리뷰", 핸들: "@park_vlog" },
    ];
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "양식");
    XLSX.writeFile(wb, "reelcheck_sample.xlsx");
  };

  // 📂 파일 업로드 및 데이터 변환 처리 (선택 중인 캠페인 명단만 갱신)
  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!selectedCampaignId) {
      alert("먼저 캠페인을 생성하거나 선택한 뒤 명단을 업로드해주세요.");
      e.target.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = (evt) => {
      const workbook = XLSX.read(evt.target.result, { type: "binary" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rawData = XLSX.utils.sheet_to_json(sheet);
      const formatted = rawData.map((item, idx) => ({
        id: Date.now() + idx,
        name: (item["이름"] || item["name"] || `인플루언서_${idx + 1}`)
          .toString()
          .trim(),
        handle: (item["핸들"] || item["handle"] || "@unknown")
          .toString()
          .trim(),
        status: "미제출",
        result: "-",
      }));
      setInfluencers(formatted);
      fetch(`${API_BASE}/api/campaigns/${selectedCampaignId}/influencers/bulk`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ influencers: formatted }),
      }).catch(() => {});
      alert(
        `🎉 [${selectedCampaign.name}] 명단이 ${formatted.length}명으로 갱신되었습니다.`,
      );
    };
    reader.readAsBinaryString(file);
  };

  // 📊 [신규 고도화] 명단 상태값 기준 실시간 통계 변수 자동 연산
  const totalCount = influencers.length;
  const passCount = influencers.filter((i) => i.result === "통과").length;
  const failCount = influencers.filter((i) => i.result === "반려").length;
  const pendingCount = influencers.filter((i) => i.result === "-").length;

  // 통과율 계산 (0명일 때 NaN 방지 처리)
  const passRate =
    totalCount > 0
      ? Math.round((passCount / (passCount + failCount || 1)) * 100)
      : 0;

  // 🎬 인플루언서별 영상 파일 업로드 → 백엔드 STT + 가이드라인 검수 요청
  const handleVideoUpload = async (id, file) => {
    if (!file) return;
    if (!selectedCampaignId) {
      alert("캠페인을 선택한 뒤 영상을 업로드해주세요.");
      return;
    }
    setInfluencers((prev) =>
      prev.map((inf) =>
        inf.id === id
          ? { ...inf, status: "검수 중...", videoName: file.name }
          : inf,
      ),
    );

    const form = new FormData();
    form.append("video", file);
    form.append("campaign", JSON.stringify(campaign));

    try {
      const res = await fetch(`${API_BASE}/api/transcribe`, {
        method: "POST",
        body: form,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "검수 요청이 실패했습니다.");

      const review = data.review;
      setInfluencers((prev) =>
        prev.map((inf) => {
          if (inf.id !== id) return inf;
          if (review?.error) {
            return {
              ...inf,
              status: "검수실패",
              result: "-",
              feedback: `가이드라인 검수 실패: ${review.error}`,
            };
          }
          if (!review) {
            return {
              ...inf,
              status: "전사완료",
              result: "-",
              feedback: "가이드라인이 없어 판정을 건너뛰었습니다.",
            };
          }
          return {
            ...inf,
            status: "검수완료",
            result: review.result,
            feedback: review.feedback,
            transcript: data.text,
            review,
          };
        }),
      );
    } catch (err) {
      setInfluencers((prev) =>
        prev.map((inf) =>
          inf.id === id
            ? {
                ...inf,
                status: "검수실패",
                result: "-",
                feedback: `오류: ${err.message}`,
              }
            : inf,
        ),
      );
      alert(`❌ 검수 요청 실패: ${err.message}`);
    }
  };

  return (
    <div>
      {/* 상단 바 */}
      <div className="bar">
        <div className="brand">
          REEL<em>CHECK</em>
        </div>
        <div className="roles">
          <button
            className={role === "marketer" ? "active" : ""}
            onClick={() => setRole("marketer")}
          >
            마케터 화면
          </button>
          <button
            className={role === "influencer" ? "active" : ""}
            onClick={() => setRole("influencer")}
          >
            인플루언서 업로드
          </button>
        </div>
      </div>

      <div className="wrap">
        <div className="steps" style={{ marginTop: 0 }}>
          <button
            className={tab === "campaign" ? "active" : ""}
            onClick={() => setTab("campaign")}
          >
            캠페인 생성
          </button>
          <button
            className={tab === "dashboard" ? "active" : ""}
            onClick={() => setTab("dashboard")}
          >
            검수 대시보드
          </button>
        </div>

        {tab === "campaign" ? (
          <CampaignCreate
            campaigns={campaigns}
            selectedCampaignId={selectedCampaignId}
            onCreate={handleCreateCampaign}
            onSelect={handleSelectCampaign}
          />
        ) : (
          <>
        <h1 style={{ fontSize: "22px", margin: "10px 0" }}>
          콘텐츠 1차 자동 검수 대시보드
        </h1>
        {selectedCampaign ? (
          <p className="lede" style={{ marginTop: 0 }}>
            현재 캠페인: <b>{selectedCampaign.advertiser}</b> ·{" "}
            {selectedCampaign.name} · {formatCampaignPeriod(selectedCampaign)} ·
            담당 {selectedCampaign.manager}
          </p>
        ) : (
          <div className="card">
            <p style={{ margin: 0, fontSize: 13.5 }}>
              선택된 캠페인이 없습니다. 최상단 <b>캠페인 생성</b> 탭에서 캠페인을
              만든 뒤, 해당 캠페인 명단만 독립적으로 운영됩니다.
            </p>
            <button
              className="btn stamp"
              style={{ marginTop: 12 }}
              onClick={() => setTab("campaign")}
            >
              캠페인 생성하러 가기
            </button>
          </div>
        )}

        {selectedCampaign && (
        <>
        {role === "marketer" ? (
          <div>
            {/* 가이드라인 입력 아코디언 (기본 접힘, 항상 접근 가능) */}
            <div className="card" style={{ marginBottom: "20px" }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  cursor: "pointer",
                }}
                onClick={() => setGuideOpen(!guideOpen)}
              >
                <h3 style={{ margin: 0, fontSize: "14px" }}>
                  📋 가이드라인 입력 {guideOpen ? "▲" : "▼"}
                </h3>
              </div>
              {guideOpen && (
                <div style={{ marginTop: "12px" }}>
                  <CampaignSettings
                    campaign={campaign}
                    setCampaign={setCampaign}
                  />
                </div>
              )}
            </div>

            {/* ⚡ [핵심 패치] 대시보드 최상단 실시간 검수 통계 스코어보드 그리드 */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(4, 1fr)",
                gap: "12px",
                marginBottom: "20px",
              }}
            >
              <div
                className="card"
                style={{
                  padding: "15px",
                  margin: 0,
                  textAlign: "center",
                  borderLeft: "4px solid #111",
                }}
              >
                <div
                  style={{
                    fontSize: "11px",
                    fontWeight: 600,
                    color: "var(--mute)",
                  }}
                >
                  총 대상 인원
                </div>
                <div
                  style={{
                    fontSize: "22px",
                    fontWeight: 700,
                    margin: "4px 0 0",
                  }}
                >
                  {totalCount}명
                </div>
              </div>
              <div
                className="card"
                style={{
                  padding: "15px",
                  margin: 0,
                  textAlign: "center",
                  borderLeft: "4px solid #4CAF50",
                }}
              >
                <div
                  style={{
                    fontSize: "11px",
                    fontWeight: 600,
                    color: "var(--mute)",
                  }}
                >
                  AI 자동 통과
                </div>
                <div
                  style={{
                    fontSize: "22px",
                    fontWeight: 700,
                    color: "#4CAF50",
                    margin: "4px 0 0",
                  }}
                >
                  {passCount}명
                </div>
              </div>
              <div
                className="card"
                style={{
                  padding: "15px",
                  margin: 0,
                  textAlign: "center",
                  borderLeft: "4px solid #F44336",
                }}
              >
                <div
                  style={{
                    fontSize: "11px",
                    fontWeight: 600,
                    color: "var(--mute)",
                  }}
                >
                  가이드 위반 (반려)
                </div>
                <div
                  style={{
                    fontSize: "22px",
                    fontWeight: 700,
                    color: "#F44336",
                    margin: "4px 0 0",
                  }}
                >
                  {failCount}명
                </div>
              </div>
              <div
                className="card"
                style={{
                  padding: "15px",
                  margin: 0,
                  textAlign: "center",
                  borderLeft: "4px solid #FF9800",
                }}
              >
                <div
                  style={{
                    fontSize: "11px",
                    fontWeight: 600,
                    color: "var(--mute)",
                  }}
                >
                  검수 대기 (통과율)
                </div>
                <div
                  style={{
                    fontSize: "22px",
                    fontWeight: 700,
                    color: "#FF9800",
                    margin: "4px 0 0",
                  }}
                >
                  {pendingCount}명{" "}
                  <span style={{ fontSize: "12px", color: "var(--graphite)" }}>
                    ({passRate}%)
                  </span>
                </div>
              </div>
            </div>

            {/* 명단 대량 등록 섹션 */}
            <div
              className="card"
              style={{
                backgroundColor: "#F7F9F5",
                border: "2px dashed var(--stamp)",
                padding: "20px",
                marginBottom: "20px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: "12px",
                }}
              >
                <h3
                  style={{ margin: 0, color: "var(--stamp)", fontSize: "14px" }}
                >
                  📊 명단 대량 등록 매니저
                </h3>
                <button
                  onClick={handleDownloadSample}
                  style={{
                    background: "#FFF",
                    border: "1px solid var(--stamp)",
                    color: "var(--stamp)",
                    borderRadius: "4px",
                    padding: "5px 10px",
                    fontSize: "11px",
                    fontWeight: "600",
                    cursor: "pointer",
                  }}
                >
                  📥 양식 엑셀 다운로드
                </button>
              </div>
              <div
                style={{
                  background: "#FFF",
                  padding: "8px",
                  border: "1px solid var(--line)",
                  borderRadius: "4px",
                  display: "inline-block",
                }}
              >
                <input
                  type="file"
                  accept=".csv, .xlsx, .xls"
                  onChange={handleFileUpload}
                  style={{ fontSize: "13px", cursor: "pointer" }}
                />
              </div>
            </div>

            {/* 라이브 테이블 현황판 */}
            <div className="card">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>인플루언서 정보</th>
                    <th>제출 상태</th>
                    <th>AI 판정</th>
                    <th>작업</th>
                  </tr>
                </thead>
                <tbody>
                  {influencers.map((inf) => (
                    <tr key={inf.id}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{inf.name}</div>
                        <div style={{ fontSize: "11px", color: "var(--mute)" }}>
                          {inf.handle}
                        </div>
                      </td>
                      <td>{inf.status}</td>
                      <td>
                        <span
                          className={`st ${inf.result === "통과" ? "pass" : inf.result === "-" ? "none" : "block"}`}
                        >
                          {inf.result}
                        </span>
                      </td>
                      <td>
                        <button
                          className="btn sm"
                          onClick={() => {
                            setFeedbackMode("edit");
                            setSelectedInf(inf);
                            setFeedbackText(inf.feedback || "");
                          }}
                        >
                          상세 피드백
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : influencers.length === 0 ? (
          <div
            className="card"
            style={{ padding: "30px", textAlign: "center" }}
          >
            <h3>📹 인플루언서 영상 제출 레이어</h3>
            <p
              style={{
                fontSize: "13px",
                color: "var(--mute)",
                marginTop: "10px",
              }}
            >
              광고 원본 비디오를 분석 서버로 안전하게 전송하는 컨트롤러
              구역입니다.
            </p>
          </div>
        ) : (
          <div className="card">
            <table className="tbl">
              <thead>
                <tr>
                  <th>인플루언서 정보</th>
                  <th>제출 상태</th>
                  <th>검수 상태</th>
                  <th>영상 파일 업로드</th>
                </tr>
              </thead>
              <tbody>
                {influencers.map((inf) => (
                  <tr key={inf.id}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{inf.name}</div>
                      <div style={{ fontSize: "11px", color: "var(--mute)" }}>
                        {inf.handle}
                      </div>
                    </td>
                    <td>{inf.status}</td>
                    <td>
                      <span
                        className={`st ${inf.result === "통과" ? "pass" : inf.result === "-" ? "none" : "block"}`}
                        role={inf.result === "반려" ? "button" : undefined}
                        tabIndex={inf.result === "반려" ? 0 : undefined}
                        title={inf.result === "반려" ? "반려 사유 보기" : undefined}
                        style={
                          inf.result === "반려"
                            ? { cursor: "pointer" }
                            : undefined
                        }
                        onClick={() => {
                          if (inf.result !== "반려") return;
                          setFeedbackMode("view");
                          setSelectedInf(inf);
                        }}
                        onKeyDown={(e) => {
                          if (inf.result !== "반려") return;
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setFeedbackMode("view");
                            setSelectedInf(inf);
                          }
                        }}
                      >
                        {inf.result}
                      </span>
                    </td>
                    <td>
                      <input
                        type="file"
                        accept="video/*"
                        onChange={(e) =>
                          handleVideoUpload(inf.id, e.target.files[0])
                        }
                        style={{ fontSize: "12px" }}
                      />
                      {inf.videoName && (
                        <div
                          style={{
                            fontSize: "11px",
                            color: "var(--mute)",
                            marginTop: "4px",
                          }}
                        >
                          📎 {inf.videoName}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        </>
        )}

        {/* 피드백 / 반려사유 모달창 */}
        {selectedInf && (() => {
          const modalInf =
            influencers.find((i) => i.id === selectedInf.id) || selectedInf;
          const isView = feedbackMode === "view";
          return (
          <div
            style={{
              position: "fixed",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: "rgba(0,0,0,0.5)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 100,
            }}
            onClick={() => setSelectedInf(null)}
          >
            <div
              className="card"
              style={{ width: "400px", padding: "20px" }}
              onClick={(e) => e.stopPropagation()}
            >
              <h3>
                {isView
                  ? `${modalInf.name} 반려 사유`
                  : `${modalInf.name} 피드백 작성`}
              </h3>
              {modalInf.review && !modalInf.review.error && (
                <div
                  style={{
                    fontSize: "12px",
                    background: "#F7F9F5",
                    border: "1px solid var(--line)",
                    borderRadius: "4px",
                    padding: "10px",
                    marginBottom: "12px",
                    lineHeight: 1.6,
                  }}
                >
                  <div>
                    브랜드 언급:{" "}
                    {modalInf.review.brandMentioned ? "✅" : "❌"}
                    {"  "}/ 제품명 언급:{" "}
                    {modalInf.review.productMentioned ? "✅" : "❌"}
                  </div>
                  {modalInf.review.matchedUsps?.length > 0 && (
                    <div>
                      ✅ 충족 USP: {modalInf.review.matchedUsps.join(", ")}
                    </div>
                  )}
                  {modalInf.review.missingUsps?.length > 0 && (
                    <div style={{ color: "var(--block)" }}>
                      ⚠️ 누락 USP: {modalInf.review.missingUsps.join(", ")}
                    </div>
                  )}
                  {modalInf.review.violatedBans?.length > 0 && (
                    <div style={{ color: "var(--block)" }}>
                      🚫 위반 금칙어:{" "}
                      {modalInf.review.violatedBans.join(", ")}
                    </div>
                  )}
                </div>
              )}
              {isView ? (
                <div
                  className="in"
                  style={{
                    minHeight: "80px",
                    marginBottom: "12px",
                    whiteSpace: "pre-wrap",
                    lineHeight: 1.6,
                    background: "#FBFCFA",
                  }}
                >
                  {modalInf.feedback || "등록된 반려 사유가 없습니다."}
                </div>
              ) : (
                <textarea
                  className="in"
                  style={{ height: "80px", marginBottom: "12px" }}
                  value={feedbackText}
                  onChange={(e) => setFeedbackText(e.target.value)}
                />
              )}
              <div
                style={{
                  display: "flex",
                  gap: "8px",
                  justifyContent: "flex-end",
                }}
              >
                <button
                  className="btn"
                  style={{ backgroundColor: "#858E88" }}
                  onClick={() => setSelectedInf(null)}
                >
                  닫기
                </button>
                {!isView && (
                  <button
                    className="btn stamp"
                    onClick={() => {
                      setInfluencers((prev) =>
                        prev.map((i) =>
                          i.id === modalInf.id
                            ? {
                                ...i,
                                feedback: feedbackText,
                                status: "피드백완료",
                              }
                            : i,
                        ),
                      );
                      setSelectedInf(null);
                    }}
                  >
                    저장
                  </button>
                )}
              </div>
            </div>
          </div>
          );
        })()}
          </>
        )}
      </div>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);
