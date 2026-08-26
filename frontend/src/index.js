import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import * as XLSX from "xlsx";
import CampaignSettings from "./CampaignSettings";
import CampaignCreate, { formatCampaignPeriod } from "./CampaignCreate";

const API_BASE = process.env.REACT_APP_API_BASE || "http://localhost:8787";
const STORAGE_KEY = "reelcheck_campaigns_v1";

/* Render 서버를 거치지 않고 스토리지(서명된 URL)로 직접 업로드한다 — 대용량
 * 영상이 Render의 요청 처리 시간 한도(~300초)에 걸려 실패하는 문제를 피하기
 * 위함. XMLHttpRequest를 쓰는 이유는 fetch가 업로드 진행률(progress)을
 * 지원하지 않기 때문. */
function uploadFileWithProgress(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`업로드 실패 (HTTP ${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("업로드 중 네트워크 오류가 발생했습니다."));
    xhr.send(file);
  });
}

const defaultGuidelines = {
  brand: "",
  product: "",
  usps: [""],
  bans: [""],
  competitorBrands: [""],
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

function formatTimestamp(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

const OCCURRENCE_TYPE_LABEL = {
  brand: "브랜드",
  product: "제품",
  usp: "USP",
  ban: "금칙어",
  typo: "오타",
};

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
    competitorBrands: Array.isArray(row.competitor_brands) && row.competitor_brands.length ? row.competitor_brands : [""],
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
  const [reviewTab, setReviewTab] = useState("combined");

  const selectedCampaign =
    campaigns.find((c) => c.id === selectedCampaignId) || null;
  const influencers = selectedCampaign?.influencers || [];
  const campaign = selectedCampaign
    ? {
        brand: selectedCampaign.brand || "",
        product: selectedCampaign.product || "",
        usps: selectedCampaign.usps?.length ? selectedCampaign.usps : [""],
        bans: selectedCampaign.bans?.length ? selectedCampaign.bans : [""],
        competitorBrands: selectedCampaign.competitorBrands?.length ? selectedCampaign.competitorBrands : [""],
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

        // 명단은 로컬 캐시가 아니라 서버(Supabase)를 원본으로 삼는다 — 그래야
        // 새로고침하거나 다른 기기/브라우저에서 열어도 그대로 유지된다.
        const influencerLists = await Promise.all(
          rows.map(async (row) => {
            try {
              const r = await fetch(
                `${API_BASE}/api/campaigns/${row.id}/influencers`,
              );
              if (!r.ok) return [];
              const infRows = await r.json();
              return Array.isArray(infRows)
                ? infRows.map((inf) => ({
                    id: inf.id,
                    name: inf.name,
                    handle: inf.handle,
                    status: inf.status,
                    result: inf.result,
                    feedback: inf.feedback || "",
                    videoName: inf.video_name || undefined,
                    transcript: inf.transcript || undefined,
                    review: inf.review || undefined,
                  }))
                : [];
            } catch {
              return [];
            }
          }),
        );
        if (cancelled) return;

        const mapped = rows.map((row, i) => mapApiCampaign(row, influencerLists[i]));
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

  // 검수 결과 팝업을 새로 열 때마다 "종합" 탭으로 되돌린다.
  useEffect(() => {
    setReviewTab("combined");
  }, [selectedInf?.id]);

  // 📋 가이드라인 저장 — 백엔드 캠페인 행에 실제로 반영해야 새로고침/다른 기기에서도 유지된다.
  const saveGuidelines = async () => {
    if (!selectedCampaignId) throw new Error("캠페인을 먼저 선택해주세요.");
    const res = await fetch(`${API_BASE}/api/campaigns/${selectedCampaignId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        brand: campaign.brand,
        product: campaign.product,
        usps: campaign.usps,
        bans: campaign.bans,
        competitorBrands: campaign.competitorBrands,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "가이드라인 저장에 실패했습니다.");
  };

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
      competitorBrands: value.competitorBrands,
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
    reader.onload = async (evt) => {
      const workbook = XLSX.read(evt.target.result, { type: "binary" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rawData = XLSX.utils.sheet_to_json(sheet);
      const formatted = rawData.map((item, idx) => ({
        name: (item["이름"] || item["name"] || `인플루언서_${idx + 1}`)
          .toString()
          .trim(),
        handle: (item["핸들"] || item["handle"] || "@unknown")
          .toString()
          .trim(),
      }));

      try {
        const res = await fetch(
          `${API_BASE}/api/campaigns/${selectedCampaignId}/influencers/bulk`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ influencers: formatted }),
          },
        );
        const rows = await res.json();
        if (!res.ok) throw new Error(rows.error || "명단 등록에 실패했습니다.");
        // 서버가 실제로 발급한 id(uuid)를 그대로 써야 이후 검수/피드백 저장이 해당 행을 정확히 찾아간다.
        setInfluencers(
          rows.map((row) => ({
            id: row.id,
            name: row.name,
            handle: row.handle,
            status: row.status,
            result: row.result,
            feedback: row.feedback || "",
          })),
        );
        alert(
          `🎉 [${selectedCampaign.name}] 명단이 ${rows.length}명으로 갱신되었습니다.`,
        );
      } catch (err) {
        alert(`❌ 명단 등록 실패: ${err.message}`);
      }
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

  // 📡 백그라운드에서 진행 중인 화면 자막 검수가 끝났는지 주기적으로 확인
  // crv 키프레임 추출이 서버 사양에 따라 오래 걸릴 수 있어, 5초 간격 × 90회(7분 30초)까지 기다려본다.
  const pollForFinalReview = (id, attemptsLeft = 90) => {
    if (attemptsLeft <= 0) {
      setInfluencers((prev) =>
        prev.map((inf) =>
          inf.id === id
            ? { ...inf, status: "검수완료(음성) — 자막 확인이 오래 걸리고 있습니다. 새로고침해서 다시 확인해주세요." }
            : inf,
        ),
      );
      return;
    }
    setTimeout(async () => {
      try {
        const res = await fetch(`${API_BASE}/api/influencers/${id}`);
        if (res.ok) {
          const row = await res.json();
          if (row.status === "검수완료") {
            setInfluencers((prev) =>
              prev.map((inf) =>
                inf.id === id
                  ? {
                      ...inf,
                      status: "검수완료",
                      result: row.result,
                      feedback: row.feedback,
                      transcript: row.transcript,
                      review: row.review,
                    }
                  : inf,
              ),
            );
            return; // 최종 결과 도착, 폴링 종료
          }
          // 아직 최종 결과는 아니지만, 음성 판정(1단계)이 먼저 나왔으면 그 사이에도
          // 화면에 미리 보여준다 — 업로드부터 여기까지 전부 백그라운드라 이게 없으면
          // 자막 검수가 끝날 때까지 "검수 중..."만 보인다.
          if (row.status?.includes("(음성)")) {
            setInfluencers((prev) =>
              prev.map((inf) =>
                inf.id === id && inf.status !== row.status
                  ? {
                      ...inf,
                      status: row.status,
                      result: row.result,
                      feedback: row.feedback,
                      transcript: row.transcript,
                      review: row.review,
                    }
                  : inf,
              ),
            );
          }
        }
      } catch {
        /* 다음 폴링에서 재시도 */
      }
      pollForFinalReview(id, attemptsLeft - 1);
    }, 5000);
  };

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
          ? { ...inf, status: "업로드 중... 0%", videoName: file.name }
          : inf,
      ),
    );

    try {
      // 1) 업로드용 서명 URL 발급 (Render 서버가 아니라 스토리지로 바로 올릴 주소)
      const presignRes = await fetch(`${API_BASE}/api/uploads/presign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ influencerId: id, filename: file.name }),
      });
      const presignData = await presignRes.json();
      if (!presignRes.ok) throw new Error(presignData.error || "업로드 준비에 실패했습니다.");

      // 2) 브라우저 → 스토리지 직접 업로드. Render의 요청 처리 시간 한도(~300초)를
      // 타지 않아서 느린 회선에서도 대용량 영상이 끝까지 올라간다.
      await uploadFileWithProgress(presignData.signedUrl, file, (pct) => {
        setInfluencers((prev) =>
          prev.map((inf) =>
            inf.id === id ? { ...inf, status: `업로드 중... ${pct}%` } : inf,
          ),
        );
      });

      setInfluencers((prev) =>
        prev.map((inf) => (inf.id === id ? { ...inf, status: "검수 중..." } : inf)),
      );

      // 3) 업로드 완료를 서버에 알려 검수 시작
      const res = await fetch(`${API_BASE}/api/transcribe/from-storage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storagePath: presignData.path,
          influencerId: id,
          campaign,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "검수 요청이 실패했습니다.");

      // 다운로드·전사·검수는 전부 서버에서 백그라운드로 진행된다(대용량 영상
      // 기준으로 이 자체도 오래 걸릴 수 있어 응답을 기다리지 않음) — 음성 판정이
      // 나오는 시점부터 폴링이 알아서 화면을 갱신한다.
      pollForFinalReview(id);
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
                    onSave={saveGuidelines}
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
                      <td>
                        {inf.status}
                        {inf.status?.includes("(음성)") && (
                          <div className="ocr-pending">
                            <span className="dot" />
                            화면 자막 확인 중
                          </div>
                        )}
                      </td>
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
                    <td>
                      {inf.status}
                      {inf.status?.includes("(음성)") && (
                        <div className="ocr-pending">
                          <span className="dot" />
                          화면 자막 확인 중
                        </div>
                      )}
                    </td>
                    <td>
                      <span
                        className={`st ${inf.result === "통과" ? "pass" : inf.result === "-" ? "none" : "block"}`}
                        role={inf.result !== "-" ? "button" : undefined}
                        tabIndex={inf.result !== "-" ? 0 : undefined}
                        title={inf.result !== "-" ? "검수 사유 보기" : undefined}
                        style={
                          inf.result !== "-"
                            ? { cursor: "pointer" }
                            : undefined
                        }
                        onClick={() => {
                          if (inf.result === "-") return;
                          setFeedbackMode("view");
                          setSelectedInf(inf);
                        }}
                        onKeyDown={(e) => {
                          if (inf.result === "-") return;
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
          const rootReview =
            modalInf.review && !modalInf.review.error ? modalInf.review : null;
          // 이전 버전(음성/자막 분리 전)에 저장된 검수 결과는 audio/caption 필드가
          // 아예 없다 — 그런 경우엔 탭을 감추고 예전처럼 종합 결과만 보여준다.
          const hasSplitReview =
            rootReview && ("audio" in rootReview || "caption" in rootReview);
          const TABS = [
            { key: "combined", label: "종합" },
            { key: "audio", label: "🎤 음성" },
            { key: "caption", label: "🖼 자막" },
          ];
          const activeReview = !rootReview
            ? null
            : reviewTab === "audio"
              ? rootReview.audio
              : reviewTab === "caption"
                ? rootReview.caption
                : rootReview;
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
              style={{
                width: "480px",
                maxHeight: "85vh",
                overflowY: "auto",
                padding: "20px",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <h3>
                {isView
                  ? `${modalInf.name} ${modalInf.result === "통과" ? "통과" : "반려"} 사유`
                  : `${modalInf.name} 피드백 작성`}
              </h3>
              {modalInf.status?.includes("(음성)") && (
                <div className="ocr-pending" style={{ marginBottom: "10px" }}>
                  <span className="dot" />
                  화면 자막 검수가 아직 진행 중입니다. 결과가 업데이트되면 자동으로 반영됩니다.
                </div>
              )}
              {rootReview && (
                <>
                  {hasSplitReview && (
                    <div style={{ display: "flex", gap: "4px", marginBottom: "8px" }}>
                      {TABS.map((t) => (
                        <button
                          key={t.key}
                          type="button"
                          onClick={() => setReviewTab(t.key)}
                          className="btn sm"
                          style={{
                            flex: 1,
                            background: reviewTab === t.key ? "var(--stamp)" : "#FFF",
                            color: reviewTab === t.key ? "#FFF" : "var(--graphite)",
                            border: "1px solid var(--line)",
                          }}
                        >
                          {t.label}
                        </button>
                      ))}
                    </div>
                  )}
                  {!activeReview || activeReview.failed ? (
                    <div
                      style={{
                        fontSize: "12px",
                        color: "var(--mute)",
                        background: "#F7F9F5",
                        border: "1px solid var(--line)",
                        borderRadius: "4px",
                        padding: "10px",
                        marginBottom: "12px",
                      }}
                    >
                      {activeReview?.failed
                        ? "화면 자막 검수에 실패해 음성 기준으로만 최종 판정되었습니다."
                        : reviewTab === "caption"
                          ? "화면 자막 검수가 아직 진행 중입니다."
                          : "표시할 결과가 없습니다."}
                    </div>
                  ) : (
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
                        {activeReview.brandMentioned ? "✅" : "❌"}
                        {"  "}/ 제품명 언급:{" "}
                        {activeReview.productMentioned ? "✅" : "❌"}
                        {activeReview.reviewNeeded && (
                          <span style={{ color: "var(--block)", marginLeft: "6px" }}>
                            ⚠️ 표기 확인 필요 (아래 발견 내역 참고)
                          </span>
                        )}
                      </div>
                      {activeReview.matchedUsps?.length > 0 && (
                        <div>
                          ✅ 충족 USP: {activeReview.matchedUsps.join(", ")}
                        </div>
                      )}
                      {activeReview.missingUsps?.length > 0 && (
                        <div style={{ color: "var(--block)" }}>
                          ⚠️ 누락 USP: {activeReview.missingUsps.join(", ")}
                        </div>
                      )}
                      {activeReview.violatedBans?.length > 0 && (
                        <div style={{ color: "var(--block)" }}>
                          🚫 위반 금칙어:{" "}
                          {activeReview.violatedBans.join(", ")}
                        </div>
                      )}
                      {activeReview.feedback && (
                        <div style={{ marginTop: "6px" }}>{activeReview.feedback}</div>
                      )}
                      {activeReview.occurrences?.length > 0 && (
                        <div style={{ marginTop: "10px" }}>
                          <div style={{ fontWeight: 600, marginBottom: "4px" }}>
                            세부 발견 내역
                          </div>
                          <table
                            style={{
                              width: "100%",
                              borderCollapse: "collapse",
                              fontSize: "11px",
                            }}
                          >
                            <thead>
                              <tr style={{ textAlign: "left", borderBottom: "1px solid var(--line)" }}>
                                <th style={{ padding: "4px 6px" }}>시간</th>
                                {reviewTab === "combined" && (
                                  <th style={{ padding: "4px 6px" }}>출처</th>
                                )}
                                <th style={{ padding: "4px 6px" }}>내용</th>
                              </tr>
                            </thead>
                            <tbody>
                              {activeReview.occurrences.map((o, idx) => (
                                <tr
                                  key={idx}
                                  style={{
                                    borderBottom: "1px solid var(--line)",
                                    background: o.needsReview ? "#FFF7E6" : undefined,
                                  }}
                                >
                                  <td style={{ padding: "4px 6px", whiteSpace: "nowrap" }}>
                                    {formatTimestamp(o.timestamp)}
                                  </td>
                                  {reviewTab === "combined" && (
                                    <td style={{ padding: "4px 6px", whiteSpace: "nowrap" }}>
                                      {o.source === "자막" ? "🖼 자막" : "🎤 음성"}
                                    </td>
                                  )}
                                  <td style={{ padding: "4px 6px" }}>
                                    "{o.quote}"
                                    {o.type && (
                                      <span style={{ color: "var(--mute)" }}>
                                        {" "}
                                        ({OCCURRENCE_TYPE_LABEL[o.type] || o.type}
                                        {o.note ? ` · ${o.note}` : ""})
                                      </span>
                                    )}
                                    {o.needsReview && (
                                      <span style={{ color: "var(--block)", fontWeight: 600 }}>
                                        {" "}
                                        ⚠️ 등록된 표기와 정확히 일치하지 않음 — 원본 확인 필요
                                      </span>
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
              {/* 탭이 있으면(종합/음성/자막) 각 탭 안에 이미 그 탭 기준 피드백이
                  나와있어서, 여기서 또 종합 기준 피드백을 고정으로 보여주면
                  탭 내용과 달라 보여 혼란스럽다 — 탭이 있을 때는 생략한다. */}
              {isView && !hasSplitReview && (
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
              )}
              {!isView && (
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
