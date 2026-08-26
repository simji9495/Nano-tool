import React, { useRef, useState } from 'react';

export default function CampaignSettings({ campaign, setCampaign, onSave }) {
    const [saving, setSaving] = useState(false);
    const competitorInputRefs = useRef([]);

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

    const handleSave = async () => {
        setSaving(true);
        try {
            await onSave();
            alert('가이드라인이 저장되었습니다.');
        } catch (err) {
            alert(`가이드라인 저장 실패: ${err.message}`);
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
                <label className="lab">필수 포함 핵심 USP 명단</label>
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
                <label className="lab">경쟁 브랜드명 (기입한 문자 그대로 정확히 검수 — 띄어쓰기만 무시)</label>
                <div style={{ fontSize: '11px', color: 'var(--mute)', marginBottom: '6px' }}>
                    구체적인 브랜드명을 그대로 적어주세요. 예: "아이디얼포맨"이라고 적으면 "아이디얼 포맨"처럼 띄어쓰기가 달라도 찾아내 반려시킵니다. 콤마(,)로 구분해 여러 개를 한 번에 붙여넣어도 자동으로 나뉩니다.
                </div>
                {campaign.competitorBrands.map((name, i) => (
                    <div key={i} style={{ display: 'flex', gap: '6px', marginBottom: '5px' }}>
                        <input
                            className="in"
                            style={{ borderColor: 'var(--block)' }}
                            value={name}
                            ref={(el) => { competitorInputRefs.current[i] = el; }}
                            onChange={(e) => handleCompetitorChange(i, e.target.value)}
                        />
                        <button type="button" onClick={() => setCampaign({ ...campaign, competitorBrands: campaign.competitorBrands.filter((_, idx) => idx !== i) })}
                            style={{ background: '#FFF', border: '1px solid var(--line)', color: 'var(--graphite)', borderRadius: '4px', width: '32px', fontSize: '14px', fontWeight: 700, cursor: 'pointer' }}>
                            −
                        </button>
                    </div>
                ))}
                <button type="button" onClick={() => setCampaign({ ...campaign, competitorBrands: [...campaign.competitorBrands, ''] })}
                    style={{ background: '#FFF', border: '1px solid var(--block)', color: 'var(--block)', borderRadius: '4px', padding: '5px 10px', fontSize: '11px', fontWeight: 600, cursor: 'pointer' }}>
                    + 경쟁 브랜드명 추가
                </button>
            </div>
            <div style={{ marginTop: '15px' }}>
                <label className="lab">그 외 금칙 항목 (문맥 고려하여 검수)</label>
                <div style={{ fontSize: '11px', color: 'var(--mute)', marginBottom: '6px' }}>
                    경쟁 브랜드명이 아닌 개념적인 금지 사항을 적어주세요. 예: "자극감 언급"이라고 적으면 "화한 느낌" 같은 표현도 찾아내지만, "화한 느낌 없이"처럼 부정된 표현은 위반으로 보지 않습니다.
                </div>
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
