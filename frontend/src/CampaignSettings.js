import React, { useRef, useState } from 'react';

export default function CampaignSettings({ campaign, setCampaign, onSave, showToast }) {
    const [saving, setSaving] = useState(false);
    const [competitorOpen, setCompetitorOpen] = useState(false);
    const competitorInputRefs = useRef([]);
    const hasCompetitorEntries = campaign.competitorBrands.some(Boolean);
    const showCompetitor = competitorOpen || hasCompetitorEntries;

    // 콤마를 입력(또는 여러 개를 콤마로 붙여넣기)하면 그 앞부분을 확정된
    // 항목으로 쪼개고, 마지막 조각은 계속 입력 중인 값으로 남겨 새 입력란이
    // 자동으로 열린 것처럼 만든다 — 매번 "+ 추가" 버튼을 누르는 번거로움을 줄인다.
    const handleCompetitorChange = (i, rawValue) => {
        if (!rawValue.includes(',')) {
            let next = [...campaign.competitorBrands];
            next[i] = rawValue;
            setCampaign({ ...campaign, competitorBrands: next });
            return;
        }
        const parts = rawValue.split(',').map((s) => s.trim());
        const trailing = parts.pop();
        const completed = parts.filter(Boolean);
        let next = [...campaign.competitorBrands];
        next.splice(i, 1, ...completed, trailing);
        setCampaign({ ...campaign, competitorBrands: next });
        const focusIndex = i + completed.length;
        requestAnimationFrame(() => competitorInputRefs.current[focusIndex]?.focus());
    };

    const removeCompetitor = (i) => {
        const filtered = campaign.competitorBrands.filter((_, idx) => idx !== i);
        setCampaign({ ...campaign, competitorBrands: filtered.length ? filtered : [''] });
    };

    const handleSave = async () => {
        setSaving(true);
        try {
            await onSave();
            showToast('success', '가이드라인 저장 완료', '');
        } catch (err) {
            showToast('error', '가이드라인 저장 실패', err.message);
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="card">
            <div className="card-hd"><h2>가이드라인 규칙 입력 폼</h2></div>
            <div className="grid2">
                <div>
                    <label className="lab">정확한 브랜드 표기명</label>
                    <input className="in" value={campaign.brand} onChange={(e) => setCampaign({ ...campaign, brand: e.target.value })} />
                </div>
                <div>
                    <label className="lab">정확한 제품 표기명</label>
                    <input className="in" value={campaign.product} onChange={(e) => setCampaign({ ...campaign, product: e.target.value })} />
                </div>
            </div>
            <div style={{ marginTop: '20px' }}>
                <label className="lab">필수 포함 사항</label>
                <div style={{ fontSize: '11px', color: 'var(--mute)', marginBottom: '6px' }}>
                    *오디오 또는 자막에 반드시 포함되어야 하는 제품 USP 등을 기입해주세요.
                </div>
                {campaign.usps.map((usp, i) => (
                    <div key={i} style={{ display: 'flex', gap: '6px', marginBottom: '5px' }}>
                        <input className="in" value={usp} onChange={(e) => {
                            let newUsps = [...campaign.usps]; newUsps[i] = e.target.value; setCampaign({ ...campaign, usps: newUsps });
                        }} />
                        <button type="button" onClick={() => setCampaign({ ...campaign, usps: campaign.usps.filter((_, idx) => idx !== i) })}
                            style={{ background: '#FFF', border: '1px solid var(--line)', color: 'var(--graphite)', borderRadius: '4px', width: '32px', fontSize: '14px', fontWeight: 700, cursor: 'pointer' }}>
                            −
                        </button>
                    </div>
                ))}
                <button type="button" onClick={() => setCampaign({ ...campaign, usps: [...campaign.usps, ''] })}
                    style={{ background: '#FFF', border: '1px solid var(--stamp)', color: 'var(--stamp)', borderRadius: '4px', padding: '5px 10px', fontSize: '11px', fontWeight: 600, cursor: 'pointer' }}>
                    + USP 추가
                </button>
            </div>
            <div style={{ marginTop: '15px' }}>
                <label className="lab">금지 사항</label>
                <div style={{ fontSize: '11px', color: 'var(--mute)', marginBottom: '6px' }}>
                    *자주 쓰는 금칙은 아래 버튼으로 빠르게 추가하세요.
                    <br />
                    *그 외 개념적인 금지 사항(예: "자극감 언급")은 아래 입력란에 직접 적으면 문맥을 고려해 검수합니다
                    <br />
                    — "화한 느낌"은 찾아서 반려시키지만 "화한 느낌 없어서 좋아요" 같은 표현은 문맥을 고려하여 통과시킵니다.
                </div>
                {!showCompetitor && (
                    <div style={{ marginBottom: '10px' }}>
                        <div style={{ fontSize: '10px', fontWeight: 700, color: '#FF9800', letterSpacing: '0.02em', marginBottom: '4px' }}>
                            자주 쓰는 항목 추가
                        </div>
                        <button type="button" onClick={() => setCompetitorOpen(true)}
                            style={{ background: '#FF9800', border: 'none', color: '#FFF', borderRadius: '999px', padding: '6px 14px', fontSize: '11px', fontWeight: 700, cursor: 'pointer', boxShadow: '0 1px 3px rgba(255,152,0,0.4)' }}>
                            🏷️ 경쟁 브랜드 언급
                        </button>
                    </div>
                )}
                {showCompetitor && (
                    <div style={{ marginBottom: '12px', paddingLeft: '10px', borderLeft: '2px solid var(--block)' }}>
                        <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--block)', marginBottom: '4px' }}>
                            경쟁 브랜드 언급 — 브랜드명을 기입한 문자 그대로 정확히 검수합니다(띄어쓰기만 무시)
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' }}>
                            {campaign.competitorBrands.map((name, i) => {
                                const isLast = i === campaign.competitorBrands.length - 1;
                                if (!isLast) {
                                    if (!name) return null;
                                    return (
                                        <span key={i} style={{
                                            display: 'inline-flex', alignItems: 'center', gap: '4px',
                                            background: '#FFF', border: '1px solid var(--block)', color: 'var(--block)',
                                            borderRadius: '999px', padding: '3px 4px 3px 10px', fontSize: '12px', fontWeight: 600,
                                        }}>
                                            {name}
                                            <button type="button" onClick={() => removeCompetitor(i)}
                                                style={{ background: 'transparent', border: 'none', color: 'var(--block)', cursor: 'pointer', fontSize: '13px', lineHeight: 1, padding: '2px 4px' }}>
                                                ×
                                            </button>
                                        </span>
                                    );
                                }
                                return (
                                    <input
                                        key="new-competitor"
                                        className="in"
                                        placeholder="브랜드명"
                                        style={{ width: '110px', borderColor: 'var(--block)' }}
                                        value={name}
                                        ref={(el) => { competitorInputRefs.current[i] = el; }}
                                        onChange={(e) => handleCompetitorChange(i, e.target.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter' && e.currentTarget.value.trim()) {
                                                e.preventDefault();
                                                handleCompetitorChange(i, e.currentTarget.value + ',');
                                            }
                                        }}
                                    />
                                );
                            })}
                        </div>
                    </div>
                )}
                {campaign.bans.map((ban, i) => (
                    <div key={i} style={{ display: 'flex', gap: '6px', marginBottom: '5px' }}>
                        <input className="in" style={{ borderColor: 'var(--block)' }} value={ban} onChange={(e) => {
                            let newBans = [...campaign.bans]; newBans[i] = e.target.value; setCampaign({ ...campaign, bans: newBans });
                        }} />
                        <button type="button" onClick={() => setCampaign({ ...campaign, bans: campaign.bans.filter((_, idx) => idx !== i) })}
                            style={{ background: '#FFF', border: '1px solid var(--line)', color: 'var(--graphite)', borderRadius: '4px', width: '32px', fontSize: '14px', fontWeight: 700, cursor: 'pointer' }}>
                            −
                        </button>
                    </div>
                ))}
                <button type="button" onClick={() => setCampaign({ ...campaign, bans: [...campaign.bans, ''] })}
                    style={{ background: '#FFF', border: '1px solid var(--block)', color: 'var(--block)', borderRadius: '4px', padding: '5px 10px', fontSize: '11px', fontWeight: 600, cursor: 'pointer' }}>
                    + 금칙 항목 추가
                </button>
            </div>
            <button className="btn stamp" style={{ marginTop: '15px' }} disabled={saving} onClick={handleSave}>{saving ? '저장 중...' : '가이드라인 저장'}</button>
        </div>
    );
}
