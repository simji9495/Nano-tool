import React, { useState } from "react";

const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);
const YEARS = Array.from({ length: 8 }, (_, i) => new Date().getFullYear() - 1 + i);

const emptyForm = () => ({
  advertiser: "",
  name: "",
  startYear: String(new Date().getFullYear()),
  startMonth: "1",
  endMonth: "12",
  manager: "",
});

export function formatCampaignPeriod(c) {
  if (!c?.startYear) return "-";
  return `${c.startYear}년 ${Number(c.startMonth)}월 ~ ${Number(c.endMonth)}월`;
}

export default function CampaignCreate({
  campaigns,
  selectedCampaignId,
  onCreate,
  onSelect,
  role,
}) {
  // 캠페인 정보 입력(생성)은 마케터의 기능이다 — 인플루언서 업로드 화면에서는
  // 입력란을 아예 숨기고, 이미 생성된 캠페인 중에서 선택만 하게 한다.
  const canCreate = role !== "influencer";
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const setField = (key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setError("");
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const advertiser = form.advertiser.trim();
    const name = form.name.trim();
    const manager = form.manager.trim();
    const startYear = Number(form.startYear);
    const startMonth = Number(form.startMonth);
    const endMonth = Number(form.endMonth);

    if (!advertiser || !name || !manager) {
      setError("광고주명, 프로젝트명, 담당자를 모두 입력해주세요.");
      return;
    }
    if (endMonth < startMonth) {
      setError("종료월은 시작월과 같거나 이후여야 합니다. (같은 연도 기준)");
      return;
    }

    setSaving(true);
    setError("");
    try {
      await onCreate({
        advertiser,
        name,
        startYear,
        startMonth,
        endMonth,
        manager,
      });
      setForm(emptyForm());
    } catch (err) {
      setError(err.message || "캠페인 생성에 실패했습니다.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      {canCreate && (
      <div className="card">
        <div className="card-hd">
          <h2>캠페인 생성</h2>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="grid2">
            <div>
              <label className="lab">광고주명</label>
              <input
                className="in"
                value={form.advertiser}
                onChange={(e) => setField("advertiser", e.target.value)}
                placeholder="예: 우르오스"
              />
            </div>
            <div>
              <label className="lab">프로젝트명</label>
              <input
                className="in"
                value={form.name}
                onChange={(e) => setField("name", e.target.value)}
                placeholder="예: 스킨 브리지 로션 시딩 캠페인"
              />
            </div>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr",
              gap: 14,
              marginTop: 14,
            }}
          >
            <div>
              <label className="lab">캠페인 시작 연도</label>
              <select
                className="in"
                value={form.startYear}
                onChange={(e) => setField("startYear", e.target.value)}
              >
                {YEARS.map((y) => (
                  <option key={y} value={y}>
                    {y}년
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="lab">시작월</label>
              <select
                className="in"
                value={form.startMonth}
                onChange={(e) => setField("startMonth", e.target.value)}
              >
                {MONTHS.map((m) => (
                  <option key={m} value={m}>
                    {m}월
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="lab">종료월</label>
              <select
                className="in"
                value={form.endMonth}
                onChange={(e) => setField("endMonth", e.target.value)}
              >
                {MONTHS.map((m) => (
                  <option key={m} value={m}>
                    {m}월
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div style={{ marginTop: 14 }}>
            <label className="lab">담당자</label>
            <input
              className="in"
              value={form.manager}
              onChange={(e) => setField("manager", e.target.value)}
              placeholder="예: 김제일"
            />
          </div>
          {error && (
            <p style={{ color: "var(--block)", fontSize: 13, margin: "12px 0 0" }}>
              {error}
            </p>
          )}
          <button
            type="submit"
            className="btn stamp"
            style={{ marginTop: 16 }}
            disabled={saving}
          >
            {saving ? "생성 중..." : "캠페인 생성"}
          </button>
        </form>
      </div>
      )}

      <div className="card">
        <div className="card-hd">
          <h2>캠페인 목록</h2>
        </div>
        {campaigns.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--mute)", margin: 0 }}>
            {canCreate
              ? "아직 생성된 캠페인이 없습니다. 위 정보로 첫 캠페인을 만들어주세요."
              : "아직 등록된 캠페인이 없습니다. 마케터가 캠페인을 생성하면 여기서 선택할 수 있습니다."}
          </p>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>광고주</th>
                <th>프로젝트명</th>
                <th>기간</th>
                <th>담당자</th>
                <th>인원</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => (
                <tr
                  key={c.id}
                  style={{
                    background:
                      c.id === selectedCampaignId ? "#F7F9F5" : undefined,
                  }}
                >
                  <td>{c.advertiser}</td>
                  <td style={{ fontWeight: 600 }}>{c.name}</td>
                  <td>{formatCampaignPeriod(c)}</td>
                  <td>{c.manager}</td>
                  <td>{(c.influencers || []).length}명</td>
                  <td>
                    <button
                      className={`btn sm ${c.id === selectedCampaignId ? "" : "outline"}`}
                      onClick={() => onSelect(c.id)}
                    >
                      {canCreate
                        ? c.id === selectedCampaignId ? "선택됨 · 검수하기" : "이 캠페인으로 검수"
                        : c.id === selectedCampaignId ? "선택됨 · 영상 업로드하기" : "이 캠페인으로 영상 업로드하기"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
