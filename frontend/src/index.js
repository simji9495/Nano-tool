import React, { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import * as XLSX from "xlsx";
import CampaignSettings from "./CampaignSettings";
import CampaignCreate, { formatCampaignPeriod } from "./CampaignCreate";
import LandingPage from "./LandingPage";
import Logo from "./Logo";

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

// AI 판정은 참고용일 뿐, 실제 업로드(게시) 가능여부는 마케터가 직접 "통과"를
// 눌러 확정해야만 O가 된다 — 아직 마케터가 판정하지 않았으면 AI 판정과 무관하게
// 항상 X다(AI 판정 오류 가능성을 감안해 최종 승인 권한은 마케터에게만 있다).
function isUploadEligible(inf) {
  return inf.marketerResult === "통과";
}

// 서버가 넘겨주는 "검수완료"는 AI 파이프라인이 끝났다는 뜻일 뿐, 마케터가
// 최종 판정을 내렸는지는 별개다 — 마케터 판정 여부에 따라 "AI 검수완료"와
// "최종 검수완료"로 구분해서 보여준다. 그 외 상태(업로드 중/검수 중/미제출
// 등)는 그대로 노출한다.
function submissionStatusLabel(inf) {
  if (inf.status === "검수완료") {
    return inf.marketerResult ? "최종 검수완료" : "AI 검수완료";
  }
  return inf.status;
}

// "업로드 중... N%" 상태는 텍스트 대신 시각적 진행률 바로 보여준다. 그 외
// 상태는 기존처럼 라벨 텍스트(+ 자막 검수 중 표시)로 보여준다.
function StatusCell({ inf }) {
  const m = inf.status?.match(/^업로드 중\.\.\. (\d+)%$/);
  if (m) {
    const pct = Number(m[1]);
    return (
      <div style={{ minWidth: "120px" }}>
        <div className="upload-row">
          <span>업로드 중</span>
          <span className="pct">{pct}%</span>
        </div>
        <div className="upload-track">
          <div className="upload-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>
    );
  }
  return (
    <>
      {submissionStatusLabel(inf)}
      {inf.status?.includes("(음성)") && (
        <div className="ocr-pending">
          <span className="dot" />
          화면 자막 확인 중
        </div>
      )}
    </>
  );
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
  // 접속하면 먼저 랜딩 페이지(소개 화면)를 보여주고, "Get Started"를 누르면
  // "제일기획/MCN·에이전시" 중 하나를 고르는 화면으로 이어진다. 로그인 기능은
  // 아직 붙이지 않아 버튼도 없다. 로고를 누르면 언제든 랜딩 페이지로 돌아온다.
  const [screen, setScreen] = useState("landing");
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
  // 마케터가 세부 발견 내역을 직접 고친 초안 — 탭(종합/음성/자막)별로 따로 보관하고,
  // 실제로 손댄 탭만 저장 시 review에 반영한다(안 건드린 탭은 서버 원본 그대로 유지).
  const [occDrafts, setOccDrafts] = useState({});
  const [editingOccIdx, setEditingOccIdx] = useState(null);
  const [addRowOpen, setAddRowOpen] = useState(false);
  const [newRow, setNewRow] = useState({ time: "", source: "자막", checks: [], quote: "", fix: "" });
  const [toast, setToast] = useState(null); // { type: "success"|"error"|"info", title, desc }
  const toastTimerRef = useRef(null);

  // 브라우저 기본 alert() 대신 쓰는 커스텀 알림. 4초 후 자동으로 사라지고,
  // 연달아 호출되면 이전 타이머를 취소하고 새로 띄운다.
  const showToast = (type, title, desc = "") => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ type, title, desc });
    toastTimerRef.current = setTimeout(() => setToast(null), 4000);
  };

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
                    handle: inf.handle,
                    status: inf.status,
                    result: inf.result,
                    marketerResult: inf.marketer_result || null,
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

        // 캠페인 목록도 서버가 원본이다 — Supabase에서 직접 삭제한 캠페인이
        // 로컬 캐시(localStorage)에 남아 되살아나지 않도록, 응답이 오면
        // 로컬에만 있던 캠페인은 유지하지 않고 서버 목록으로 완전히 교체한다.
        const mapped = rows.map((row, i) => mapApiCampaign(row, influencerLists[i]));
        setCampaigns(mapped);
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
    setOccDrafts({});
    setEditingOccIdx(null);
    setAddRowOpen(false);
    setNewRow({ time: "", source: "자막", checks: [], quote: "", fix: "" });
  }, [selectedInf?.id]);

  // 세부 발견 내역 표를 마케터가 수정/삭제/추가한 탭별 초안을 실제 review 구조에
  // 합친다 — 손대지 않은 탭은 서버가 준 원본 그대로 둔다.
  const applyOccurrenceEdits = (rootReview, drafts) => {
    if (!rootReview || !drafts || !Object.keys(drafts).length) return rootReview;
    const updated = { ...rootReview };
    if (drafts.combined) updated.occurrences = drafts.combined;
    if (drafts.audio && updated.audio) updated.audio = { ...updated.audio, occurrences: drafts.audio };
    if (drafts.caption && updated.caption) updated.caption = { ...updated.caption, occurrences: drafts.caption };
    return updated;
  };

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
    const res = await fetch(`${API_BASE}/api/campaigns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || "캠페인 생성에 실패했습니다.");
    }
    const row = await res.json();
    const created = mapApiCampaign(row, []);

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
      { 핸들: "@hong_vlog" },
      { 핸들: "@park_vlog" },
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
      showToast("info", "캠페인을 먼저 선택해주세요", "명단은 캠페인을 생성하거나 선택한 뒤 업로드할 수 있습니다.");
      e.target.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = async (evt) => {
      const workbook = XLSX.read(evt.target.result, { type: "binary" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rawData = XLSX.utils.sheet_to_json(sheet);
      const formatted = rawData.map((item) => ({
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
            handle: row.handle,
            status: row.status,
            result: row.result,
            feedback: row.feedback || "",
          })),
        );
        showToast("success", "명단 등록 완료", `[${selectedCampaign.name}] 명단이 ${rows.length}명으로 갱신되었습니다.`);
      } catch (err) {
        showToast("error", "명단 등록 실패", err.message);
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
      showToast("info", "캠페인을 먼저 선택해주세요", "캠페인을 선택한 뒤 영상을 업로드할 수 있습니다.");
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
      showToast("error", "검수 요청 실패", err.message);
    }
  };

  // 마케터가 상세 피드백 팝업에서 통과/반려를 직접 확정하거나 코멘트만 저장할 때 호출.
  // AI 판정이 틀릴 수 있어 마케터 판정을 별도로 기록해두고(업로드 가능여부는
  // isUploadEligible이 이 값을 AI 판정보다 우선한다), 서버(Supabase)에도 반영해야
  // 새로고침하거나 다른 기기에서 봐도 유지된다.
  const saveMarketerFeedback = async (id, patch) => {
    try {
      const res = await fetch(`${API_BASE}/api/influencers/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "저장에 실패했습니다.");
      setInfluencers((prev) =>
        prev.map((inf) =>
          inf.id === id
            ? {
                ...inf,
                ...(patch.feedback !== undefined ? { feedback: patch.feedback } : {}),
                ...(patch.marketerResult !== undefined ? { marketerResult: patch.marketerResult } : {}),
                ...(patch.review !== undefined ? { review: patch.review } : {}),
              }
            : inf,
        ),
      );
      return true;
    } catch (err) {
      showToast("error", "저장 실패", err.message);
      return false;
    }
  };

  if (screen === "landing") {
    return <LandingPage onGetStarted={() => setScreen("home")} />;
  }

  if (screen === "home") {
    return (
      <div className="home">
        <div className="bar">
          <Logo onClick={() => setScreen("landing")} />
          <span className="spacer" />
          <span className="bar-sub">인플루언서 콘텐츠 1차 검수 솔루션</span>
        </div>
        <div className="home-body">
          <div className="eyebrow">Get started</div>
          <h1>어떤 화면으로 접속하시겠어요?</h1>
          <div className="role-row">
            <button
              className="role-btn"
              onClick={() => {
                setRole("marketer");
                setScreen("app");
              }}
            >
              <span className="num">1</span>
              <div className="role-title">제일기획</div>
              <div className="arrow">마케터 화면으로 →</div>
            </button>
            <button
              className="role-btn"
              onClick={() => {
                setRole("influencer");
                setScreen("app");
              }}
            >
              <span className="num">2</span>
              <div className="role-title">MCN / 에이전시</div>
              <div className="arrow">업로드 화면으로 →</div>
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* 상단 바 */}
      <div className="bar">
        <Logo onClick={() => setScreen("landing")} />
        <span className="spacer" />
        <div className="roles">
          <button
            className={role === "marketer" ? "active" : ""}
            onClick={() => setRole("marketer")}
          >
            제일기획
          </button>
          <button
            className={role === "influencer" ? "active" : ""}
            onClick={() => setRole("influencer")}
          >
            MCN/에이전시
          </button>
        </div>
      </div>

      <div className="wrap">
        <div className="steps" style={{ marginTop: 0 }}>
          <button
            className={tab === "campaign" ? "active" : ""}
            onClick={() => setTab("campaign")}
          >
            {role === "influencer" ? "캠페인 선택" : "캠페인 생성"}
          </button>
          <button
            className={tab === "dashboard" ? "active" : ""}
            onClick={() => setTab("dashboard")}
          >
            {role === "influencer" ? "콘텐츠 검수 현황" : "검수 대시보드"}
          </button>
        </div>

        {tab === "campaign" ? (
          <CampaignCreate
            campaigns={campaigns}
            selectedCampaignId={selectedCampaignId}
            onCreate={handleCreateCampaign}
            onSelect={handleSelectCampaign}
            role={role}
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
                <h3 style={{ margin: 0, fontSize: "14px", display: "flex", alignItems: "center", gap: "8px" }}>
                  <span className="step-badge">1</span> 가이드라인 입력 {guideOpen ? "▲" : "▼"}
                </h3>
              </div>
              {guideOpen && (
                <div style={{ marginTop: "12px" }}>
                  <CampaignSettings
                    campaign={campaign}
                    setCampaign={setCampaign}
                    onSave={saveGuidelines}
                    showToast={showToast}
                  />
                </div>
              )}
            </div>

            {/* 명단 대량 등록 섹션 (STEP 2) */}
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
                  style={{ margin: 0, color: "var(--stamp)", fontSize: "14px", display: "flex", alignItems: "center", gap: "8px" }}
                >
                  <span className="step-badge">2</span> 인플루언서 명단 등록
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

            {/* 라이브 테이블 현황판 */}
            <div className="card">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>No.</th>
                    <th>인플루언서 계정 핸들</th>
                    <th>제출 상태</th>
                    <th>AI 판정</th>
                    <th>마케터 판정</th>
                    <th>업로드 가능여부</th>
                  </tr>
                </thead>
                <tbody>
                  {influencers.map((inf, idx) => (
                    <tr key={inf.id}>
                      <td>{idx + 1}</td>
                      <td>{inf.handle}</td>
                      <td>
                        <StatusCell inf={inf} />
                      </td>
                      <td>
                        <span
                          className={`st ${inf.result === "통과" ? "pass" : inf.result === "-" ? "none" : "block"}`}
                          role={inf.result !== "-" ? "button" : undefined}
                          tabIndex={inf.result !== "-" ? 0 : undefined}
                          title={inf.result !== "-" ? "AI 검수 사유 보기" : undefined}
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
                        <span
                          className={`st ${inf.marketerResult === "통과" ? "pass" : !inf.marketerResult ? "none" : "block"}`}
                          role="button"
                          tabIndex={0}
                          title="마케터 판정 내리기/확인"
                          style={{ cursor: "pointer" }}
                          onClick={() => {
                            setFeedbackMode("edit");
                            setSelectedInf(inf);
                            setFeedbackText(inf.feedback || "");
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              setFeedbackMode("edit");
                              setSelectedInf(inf);
                              setFeedbackText(inf.feedback || "");
                            }
                          }}
                        >
                          {inf.marketerResult || "검토하기"}
                        </span>
                      </td>
                      <td>
                        <span className={`st ${isUploadEligible(inf) ? "pass" : "block"}`}>
                          {isUploadEligible(inf) ? "O" : "X"}
                        </span>
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
                  <th>No.</th>
                  <th>인플루언서 계정 핸들</th>
                  <th>제출 상태</th>
                  <th>AI 판정</th>
                  <th>마케터 판정</th>
                  <th>업로드 가능여부</th>
                  <th>영상 파일 업로드</th>
                </tr>
              </thead>
              <tbody>
                {influencers.map((inf, idx) => (
                  <tr key={inf.id}>
                    <td>{idx + 1}</td>
                    <td>{inf.handle}</td>
                    <td>
                      <StatusCell inf={inf} />
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
                      <span
                        className={`st ${inf.marketerResult === "통과" ? "pass" : !inf.marketerResult ? "none" : "block"}`}
                        role="button"
                        tabIndex={0}
                        title="마케터 판정 내리기/확인"
                        style={{ cursor: "pointer" }}
                        onClick={() => {
                          setFeedbackMode("edit");
                          setSelectedInf(inf);
                          setFeedbackText(inf.feedback || "");
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setFeedbackMode("edit");
                            setSelectedInf(inf);
                            setFeedbackText(inf.feedback || "");
                          }
                        }}
                      >
                        {inf.marketerResult || "-"}
                      </span>
                    </td>
                    <td>
                      <span className={`st ${isUploadEligible(inf) ? "pass" : "block"}`}>
                        {isUploadEligible(inf) ? "O" : "X"}
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
          // 피드백 기입/반려·통과 버튼은 마케터 화면에서만 노출한다 — 인플루언서
          // 업로드 화면에서 마케터 판정 배지를 눌러도 결과를 읽기만 할 수 있고
          // 직접 판정을 내릴 수는 없다.
          const canEditVerdict = !isView && role === "marketer";
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
                width: "min(720px, 94vw)",
                maxHeight: "85vh",
                overflowY: "auto",
                padding: "20px",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  justifyContent: "space-between",
                  gap: "10px",
                  marginBottom: "4px",
                }}
              >
                <div>
                  {isView && (
                    <span
                      style={{
                        display: "inline-block",
                        fontSize: "10.5px",
                        fontWeight: 700,
                        padding: "3px 9px",
                        borderRadius: "999px",
                        marginBottom: "8px",
                        color: modalInf.result === "통과" ? "var(--pass)" : "var(--block)",
                        background: modalInf.result === "통과" ? "var(--pass-bg)" : "var(--block-bg)",
                      }}
                    >
                      {modalInf.result === "통과" ? "통과" : "반려"}
                    </span>
                  )}
                  <h3 style={{ margin: 0 }}>
                    {isView
                      ? `${modalInf.handle} ${modalInf.result === "통과" ? "통과" : "반려"} 사유`
                      : canEditVerdict
                        ? `${modalInf.handle} 피드백 작성`
                        : `${modalInf.handle} 코멘트 확인`}
                  </h3>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedInf(null)}
                  aria-label="닫기"
                  style={{
                    border: "none",
                    background: "transparent",
                    color: "var(--mute)",
                    width: "28px",
                    height: "28px",
                    borderRadius: "999px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "pointer",
                    flex: "none",
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                    <path d="M5 5L19 19M19 5L5 19" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
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
                  ) : (() => {
                    const occDraft = occDrafts[reviewTab];
                    const occ = occDraft ?? activeReview.occurrences ?? [];
                    // 아직 이 탭을 손대지 않았으면(occDraft가 없으면) 서버 원본을 복제해
                    // 초안으로 승격시키고, 그 위에 편집을 적용한다.
                    const mutateOcc = (fn) => {
                      const base = (occDraft ?? (activeReview.occurrences || [])).map((o) => ({ ...o }));
                      setOccDrafts((prev) => ({ ...prev, [reviewTab]: fn(base) }));
                    };
                    const saveEditedRow = (idx, content, fix) => {
                      mutateOcc((base) =>
                        base.map((o, i) =>
                          i === idx
                            ? { ...o, quote: content, fix, type: undefined, note: "", needsReview: false, manual: true }
                            : o,
                        ),
                      );
                      setEditingOccIdx(null);
                    };
                    const deleteRow = (idx) => mutateOcc((base) => base.filter((_, i) => i !== idx));
                    const addRow = () => {
                      const secs = parseInt(newRow.time, 10) || 0;
                      const parts = [];
                      if (newRow.checks.length) parts.push(newRow.checks.join(", "));
                      if (newRow.quote.trim()) parts.push(`"${newRow.quote.trim()}"`);
                      mutateOcc((base) =>
                        [
                          ...base,
                          {
                            timestamp: secs,
                            source: newRow.source,
                            quote: parts.join(" — ") || "(내용 미입력)",
                            type: undefined,
                            note: "",
                            needsReview: Boolean(newRow.fix.trim()) || newRow.checks.length > 0,
                            fix: newRow.fix.trim(),
                          },
                        ].sort((a, b) => a.timestamp - b.timestamp),
                      );
                      setAddRowOpen(false);
                      setNewRow({ time: "", source: "자막", checks: [], quote: "", fix: "" });
                    };
                    const toggleCheck = (val) => {
                      setNewRow((prev) => ({
                        ...prev,
                        checks: prev.checks.includes(val)
                          ? prev.checks.filter((c) => c !== val)
                          : [...prev.checks, val],
                      }));
                    };
                    const brandFlag = occ.some((o) => o.type === "brand" && o.needsReview);
                    const productFlag = occ.some((o) => o.type === "product" && o.needsReview);
                    const matchedCount = activeReview.matchedUsps?.length || 0;
                    const missingCount = activeReview.missingUsps?.length || 0;
                    const uspTotal = matchedCount + missingCount;
                    const banCount = activeReview.violatedBans?.length || 0;
                    const cards = [
                      {
                        k: "브랜드 언급",
                        tone: !activeReview.brandMentioned ? "bad" : brandFlag ? "warn" : "neutral",
                        v: !activeReview.brandMentioned ? "언급되지 않음" : brandFlag ? "표기 확인 필요" : "확인됨",
                      },
                      {
                        k: "제품명 언급",
                        tone: !activeReview.productMentioned ? "bad" : productFlag ? "warn" : "neutral",
                        v: !activeReview.productMentioned ? "언급되지 않음" : productFlag ? "표기 확인 필요" : "확인됨",
                      },
                      {
                        k: "필수 포함사항",
                        tone: uspTotal === 0 ? "neutral" : missingCount > 0 ? "warn" : "neutral",
                        v: uspTotal === 0 ? "해당 없음" : `${matchedCount} / ${uspTotal} 충족`,
                      },
                      {
                        k: "금지사항 위반",
                        tone: banCount > 0 ? "bad" : "neutral",
                        v: banCount > 0 ? `${banCount}건` : "없음",
                      },
                    ];
                    const needsReviewCount = occ.filter((o) => o.needsReview).length;
                    const summaryParts = [];
                    if (missingCount > 0) summaryParts.push(`누락 USP ${activeReview.missingUsps.join(", ")}`);
                    if (banCount > 0) summaryParts.push(`금지사항 위반 ${activeReview.violatedBans.join(", ")}`);
                    if (needsReviewCount > 0) summaryParts.push(`표기 확인 필요 ${needsReviewCount}건`);
                    const summaryText =
                      summaryParts.length > 0
                        ? summaryParts.join(", ") + "."
                        : "특이사항이 발견되지 않았습니다.";

                    return (
                      <div style={{ marginBottom: "12px" }}>
                        <div className="stat-grid">
                          {cards.map((c) => (
                            <div key={c.k} className={`stat-card ${c.tone}`}>
                              <div className="k">{c.k}</div>
                              <div className="v">
                                <span className="dot" />
                                {c.v}
                              </div>
                            </div>
                          ))}
                        </div>
                        <div className="summary-line">{summaryText}</div>
                        {activeReview.feedback && (
                          <div style={{ fontSize: "12px", lineHeight: 1.6, marginBottom: "12px" }}>
                            {activeReview.feedback}
                          </div>
                        )}
                        {(occ.length > 0 || canEditVerdict) && (
                          <div>
                            <div className="detail-hd-row">
                              <div style={{ fontSize: "12px", fontWeight: 700 }}>세부 발견 내역</div>
                            </div>
                            {occ.length > 0 && (
                              <div className="detail-wrap">
                                <table className="detail-tbl">
                                  <thead>
                                    <tr>
                                      <th>시간</th>
                                      {reviewTab === "combined" && <th>출처</th>}
                                      <th>내용</th>
                                      <th>수정방향</th>
                                      {canEditVerdict && <th></th>}
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {occ.map((o, idx) => {
                                      const isEditing = canEditVerdict && editingOccIdx === idx;
                                      return (
                                        <tr key={idx} style={{ background: o.needsReview ? "var(--warn-bg)" : undefined }}>
                                          <td style={{ whiteSpace: "nowrap" }}>{formatTimestamp(o.timestamp)}</td>
                                          {reviewTab === "combined" && (
                                            <td style={{ whiteSpace: "nowrap" }}>
                                              {o.source === "자막" ? "🖼 자막" : "🎤 음성"}
                                            </td>
                                          )}
                                          {isEditing ? (
                                            <>
                                              <td>
                                                <input
                                                  className="occ-edit-in"
                                                  defaultValue={o.quote}
                                                  id={`occ-content-${idx}`}
                                                />
                                              </td>
                                              <td>
                                                <input
                                                  className="occ-edit-in"
                                                  defaultValue={o.fix || ""}
                                                  placeholder="수정방향 입력"
                                                  id={`occ-fix-${idx}`}
                                                />
                                              </td>
                                              <td className="ops-cell">
                                                <button
                                                  type="button"
                                                  className="occ-icon-btn"
                                                  title="저장"
                                                  onClick={() =>
                                                    saveEditedRow(
                                                      idx,
                                                      document.getElementById(`occ-content-${idx}`).value,
                                                      document.getElementById(`occ-fix-${idx}`).value,
                                                    )
                                                  }
                                                >
                                                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                                                    <path d="M5 12.5L10 17L19 7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                                                  </svg>
                                                </button>
                                              </td>
                                            </>
                                          ) : (
                                            <>
                                              <td>
                                                "{o.quote}"
                                                {o.type && (
                                                  <span style={{ color: "var(--mute)" }}>
                                                    {" "}
                                                    ({OCCURRENCE_TYPE_LABEL[o.type] || o.type}
                                                    {o.note ? ` · ${o.note}` : ""})
                                                  </span>
                                                )}
                                                {o.needsReview && !o.manual && (
                                                  <span style={{ color: "var(--warn)", fontWeight: 600 }}>
                                                    {" "}
                                                    ⚠️ 등록된 표기와 정확히 일치하지 않음 — 원본 확인 필요
                                                  </span>
                                                )}
                                              </td>
                                              <td className={`fix-cell${o.fix ? "" : " empty"}`}>{o.fix || "—"}</td>
                                              {canEditVerdict && (
                                                <td className="ops-cell">
                                                  <button
                                                    type="button"
                                                    className="occ-icon-btn"
                                                    title="수정"
                                                    onClick={() => setEditingOccIdx(idx)}
                                                  >
                                                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                                                      <path d="M4 20L4.6 16.5L15.3 5.8C15.9 5.2 16.9 5.2 17.5 5.8L18.2 6.5C18.8 7.1 18.8 8.1 18.2 8.7L7.5 19.4L4 20Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                                                    </svg>
                                                  </button>
                                                  <button
                                                    type="button"
                                                    className="occ-icon-btn danger"
                                                    title="삭제"
                                                    onClick={() => deleteRow(idx)}
                                                  >
                                                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                                                      <path d="M5 7H19M9 7V5C9 4.4 9.4 4 10 4H14C14.6 4 15 4.4 15 5V7M7 7L7.6 19C7.7 19.6 8.1 20 8.7 20H15.3C15.9 20 16.3 19.6 16.4 19L17 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                                                    </svg>
                                                  </button>
                                                </td>
                                              )}
                                            </>
                                          )}
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            )}

                            {canEditVerdict && (
                              <>
                                <button
                                  type="button"
                                  className="row-add-btn"
                                  onClick={() => setAddRowOpen((v) => !v)}
                                >
                                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
                                    <path d="M12 5V19M5 12H19" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
                                  </svg>
                                  발견 내역 직접 추가
                                </button>
                                {addRowOpen && (
                                  <div className="new-row-form">
                                    <div className="nrf-grid">
                                      <div className="k">시간</div>
                                      <div className="time-in-wrap">
                                        <input
                                          className="in"
                                          type="number"
                                          min="0"
                                          value={newRow.time}
                                          placeholder="14"
                                          onChange={(e) => setNewRow((p) => ({ ...p, time: e.target.value }))}
                                        />
                                        <span style={{ fontSize: "11px", color: "var(--mute)" }}>초</span>
                                        <span className="time-preview">{formatTimestamp(newRow.time)}</span>
                                      </div>

                                      <div className="k">출처</div>
                                      <div className="toggle-pair">
                                        {["자막", "음성"].map((s) => (
                                          <button
                                            key={s}
                                            type="button"
                                            className={newRow.source === s ? "active" : ""}
                                            onClick={() => setNewRow((p) => ({ ...p, source: s }))}
                                          >
                                            {s}
                                          </button>
                                        ))}
                                      </div>

                                      <div className="k">내용</div>
                                      <div>
                                        <div className="chk-row">
                                          {[
                                            ["brand", "브랜드명 표기 위반"],
                                            ["product", "제품명 표기 위반"],
                                            ["typo", "오탈자"],
                                            ["etc", "기타"],
                                          ].map(([val, label]) => (
                                            <label key={val}>
                                              <input
                                                type="checkbox"
                                                checked={newRow.checks.includes(label)}
                                                onChange={() => toggleCheck(label)}
                                              />
                                              {label}
                                            </label>
                                          ))}
                                        </div>
                                        <input
                                          className="in"
                                          style={{ marginTop: "8px" }}
                                          value={newRow.quote}
                                          placeholder="영상에서 발견된 문구를 그대로 적어주세요 (선택)"
                                          onChange={(e) => setNewRow((p) => ({ ...p, quote: e.target.value }))}
                                        />
                                      </div>

                                      <div className="k">수정방향</div>
                                      <input
                                        className="in"
                                        value={newRow.fix}
                                        placeholder='예: "더운 날씨에 쓰기 좋은 우르오스 스킨브리지로션"으로 수정'
                                        onChange={(e) => setNewRow((p) => ({ ...p, fix: e.target.value }))}
                                      />

                                      <div className="nrf-actions">
                                        <button
                                          type="button"
                                          className="cancel"
                                          onClick={() => {
                                            setAddRowOpen(false);
                                            setNewRow({ time: "", source: "자막", checks: [], quote: "", fix: "" });
                                          }}
                                        >
                                          취소
                                        </button>
                                        <button type="button" className="confirm" onClick={addRow}>
                                          표에 추가
                                        </button>
                                      </div>
                                    </div>
                                  </div>
                                )}
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </>
              )}
              {/* 탭이 있으면(종합/음성/자막) 각 탭 안에 이미 그 탭 기준 피드백이
                  나와있어서, 여기서 또 종합 기준 피드백을 고정으로 보여주면
                  탭 내용과 달라 보여 혼란스럽다 — 탭이 있을 때는 생략한다. */}
              {((isView && !hasSplitReview) || (!isView && !canEditVerdict)) && (
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
                  {!isView && (
                    <div style={{ fontSize: "12px", marginBottom: "6px" }}>
                      마케터 코멘트:{" "}
                      <b style={{ color: modalInf.marketerResult === "통과" ? "#4CAF50" : modalInf.marketerResult === "반려" ? "var(--block)" : "var(--mute)" }}>
                        {modalInf.marketerResult || "-"}
                      </b>
                    </div>
                  )}
                  {modalInf.feedback || "등록된 반려 사유가 없습니다."}
                </div>
              )}
              {canEditVerdict && (
                <>
                  <div style={{ fontSize: "12px", marginBottom: "6px" }}>
                    마케터 코멘트:{" "}
                    <b style={{ color: modalInf.marketerResult === "통과" ? "#4CAF50" : modalInf.marketerResult === "반려" ? "var(--block)" : "var(--mute)" }}>
                      {modalInf.marketerResult || "-"}
                    </b>
                    {" "}(AI 판정보다 우선 적용됩니다 — 업로드 가능여부를 직접 결정합니다)
                  </div>
                  <textarea
                    className="in"
                    placeholder="반려 사유를 남기면 인플루언서/담당자가 확인할 수 있습니다."
                    style={{ height: "80px", marginBottom: "12px" }}
                    value={feedbackText}
                    onChange={(e) => setFeedbackText(e.target.value)}
                  />
                </>
              )}
              <div
                style={{
                  display: "flex",
                  gap: "8px",
                  justifyContent: "flex-end",
                }}
              >
                {canEditVerdict && (
                  <>
                    <button
                      className="btn"
                      style={{ backgroundColor: "var(--block)" }}
                      onClick={async () => {
                        if (!feedbackText.trim()) {
                          showToast("info", "반려 사유를 입력해주세요", "");
                          return;
                        }
                        const ok = await saveMarketerFeedback(modalInf.id, {
                          marketerResult: "반려",
                          feedback: feedbackText,
                          review: applyOccurrenceEdits(rootReview, occDrafts),
                        });
                        if (ok) setSelectedInf(null);
                      }}
                    >
                      코멘트 저장 및 반려
                    </button>
                    <button
                      className="btn"
                      style={{ backgroundColor: "#4CAF50" }}
                      onClick={async () => {
                        const ok = await saveMarketerFeedback(modalInf.id, {
                          marketerResult: "통과",
                          feedback: feedbackText,
                          review: applyOccurrenceEdits(rootReview, occDrafts),
                        });
                        if (ok) setSelectedInf(null);
                      }}
                    >
                      통과
                    </button>
                  </>
                )}
                <button
                  className="btn"
                  style={{ backgroundColor: "#858E88" }}
                  onClick={() => setSelectedInf(null)}
                >
                  닫기
                </button>
              </div>
            </div>
          </div>
          );
        })()}
          </>
        )}
      </div>
      {toast && (
        <div className="toast-wrap">
          <div className={`toast ${toast.type}`}>
            <span className="icon">
              {toast.type === "success" && (
                <svg viewBox="0 0 24 24" fill="none" width="11" height="11">
                  <path d="M5 12.5L10 17L19 7" stroke="#18181A" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
              {toast.type === "error" && (
                <svg viewBox="0 0 24 24" fill="none" width="11" height="11">
                  <path d="M6 6L18 18M18 6L6 18" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
                </svg>
              )}
              {toast.type === "info" && (
                <svg viewBox="0 0 24 24" fill="none" width="11" height="11">
                  <circle cx="12" cy="8" r="1.4" fill="#fff" />
                  <path d="M12 11.5V17" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
                </svg>
              )}
            </span>
            <div className="body">
              <div className="title">{toast.title}</div>
              {toast.desc && <div className="desc">{toast.desc}</div>}
            </div>
            <button className="close" onClick={() => setToast(null)}>
              ✕
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);
