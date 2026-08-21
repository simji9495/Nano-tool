import React from 'react';

export default function CampaignSettings({ campaign, setCampaign }) {
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
                <label className="lab">브랜드 금기사항 및 금칙어 목록</label>
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
                    + 금칙어 추가
                </button>
            </div>
            <button className="btn stamp" style={{ marginTop: '15px' }} onClick={() => alert('실시간 캠페인 가이드가 수정되었습니다.')}>가이드라인 저장</button>
        </div>
    );
}
