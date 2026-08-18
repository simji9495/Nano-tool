import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';

function App() {
    const [role, setRole] = useState("marketer");
    const [step, setStep] = useState(1);
    const [campaign, setCampaign] = useState({ brand: "", product: "" });
    const [influencers] = useState([
        { id: 1, name: "김나노", handle: "@nano_review", status: "미제출", result: "-" },
        { id: 2, name: "이리뷰", handle: "@lee_vlog", status: "검수완료", result: "통과" }
    ]);

    return (
        <div>
            <div className="bar">
                <div className="brand">REEL<em>CHECK</em></div>
                <div className="bar-sub">NANO-INFLUENCER PLATFORM</div>
                <div className="spacer"></div>
                <div className="roles">
                    <button className={role === "marketer" ? "active" : ""} onClick={() => setRole("marketer")}>MARKETER</button>
                    <button className={role === "influencer" ? "active" : ""} onClick={() => setRole("influencer")}>INFLUENCER</button>
                </div>
            </div>

            <div className="wrap">
                <span className="eyebrow">AUTOMATED CONTENT VERIFICATION</span>
                <h1 style={{fontSize: "27px", margin: "6px 0 0"}}>인플루언서 콘텐츠 1차 검수 대시보드</h1>
                <p className="lede">AI 기술을 기반으로 숏폼 영상의 자막, 오디오를 자동 실시간 선별합니다.</p>

                {role === "marketer" ? (
                    <div>
                        <div className="steps">
                            <button className={step === 1 ? "active" : ""} onClick={() => setStep(1)}>1. 캠페인 가이드 설정</button>
                            <button className={step === 2 ? "active" : ""} onClick={() => setStep(2)}>2. 대상 인플루언서 관리</button>
                        </div>

                        {step === 1 ? (
                            <div className="card">
                                <div className="card-hd"><h2>캠페인 규칙 설정</h2></div>
                                <div className="grid2">
                                    <div>
                                        <label className="lab">브랜드명</label>
                                        <input className="in" placeholder="예: 나노뷰티" value={campaign.brand} onChange={(e)=>setCampaign({...campaign, brand: e.target.value})} />
                                    </div>
                                    <div>
                                        <label className="lab">제품명</label>
                                        <input className="in" placeholder="예: 수분 크림 에센스" value={campaign.product} onChange={(e)=>setCampaign({...campaign, product: e.target.value})} />
                                    </div>
                                </div>
                                <button className="btn stamp" style={{marginTop: '20px'}} onClick={() => alert('저장되었습니다.')}>규칙 저장하기</button>
                            </div>
                        ) : (
                            <div className="card">
                                <div className="card-hd"><h2>인플루언서 검수 현황 리스트</h2></div>
                                <table className="tbl">
                                    <thead>
                                        <tr>
                                            <th>인플루언서 정보</th>
                                            <th>제출 상태</th>
                                            <th>AI 검수 결과</th>
                                            <th>관리</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {influencers.map(inf => (
                                            <tr key={inf.id}>
                                                <td>
                                                    <div style={{fontWeight:600}}>{inf.name}</div>
                                                    <div style={{color: '#858E88', fontSize: '11px'}}>{inf.handle}</div>
                                                </td>
                                                <td>{inf.status}</td>
                                                <td><span className="st pass">{inf.result}</span></td>
                                                <td><button className="btn sm" onClick={() => alert(inf.name + ' 피드백')}>상세 보기</button></td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>
                ) : (
                    <div className="card">
                        <div className="card-hd"><h2>콘텐츠 제출 및 1차 검수</h2></div>
                        <div className="drop">
                            <div style={{fontWeight: 600}}>검수받을 영상 파일을 선택하세요</div>
                            <input type="file" style={{marginTop: '15px'}} onChange={() => alert('분석을 시작합니다.')} />
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
