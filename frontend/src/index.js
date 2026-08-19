import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';

function App() {
    const [role, setRole] = useState("marketer");
    const [influencers, setInfluencers] = useState([
        { id: 1, name: "김나노", handle: "@nano", status: "검수완료", result: "통과", feedback: "준수 완료" },
        { id: 2, name: "이리뷰", handle: "@lee", status: "미제출", result: "-", feedback: "" },
        { id: 3, name: "최쇼츠", handle: "@shorts", status: "검수완료", result: "반려", feedback: "금칙어 포함" }
    ]);
    const [selectedInf, setSelectedInf] = useState(null);
    const [feedbackText, setFeedbackText] = useState("");

    // 📥 마케터용 샘플 엑셀 파일 즉시 생성 및 다운로드
    const handleDownloadSample = () => {
        const data = [{ "이름": "홍길동", "핸들": "@hong_vlog" }, { "이름": "박리뷰", "핸들": "@park_vlog" }];
        const ws = XLSX.utils.json_to_sheet(data);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "양식");
        XLSX.writeFile(wb, "reelcheck_sample.xlsx");
    };

    // 📂 파일 업로드 및 데이터 변환 처리
    const handleFileUpload = (e) => {
        const file = e.target.files;
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (evt) => {
            const workbook = XLSX.read(evt.target.result, { type: 'binary' });
            const sheet = workbook.Sheets[workbook.SheetNames];
            const rawData = XLSX.utils.sheet_to_json(sheet);
            const formatted = rawData.map((item, idx) => ({
                id: Date.now() + idx,
                name: (item['이름'] || item['name'] || `인플루언서_${idx + 1}`).toString().trim(),
                handle: (item['핸들'] || item['handle'] || "@unknown").toString().trim(),
                status: "미제출", result: "-"
            }));
            setInfluencers(prev => [...prev, ...formatted]);
            alert(`🎉 ${formatted.length}명의 인플루언서가 실시간 로드되었습니다.`);
        };
        reader.readAsBinaryString(file);
    };

    // 📊 [신규 고도화] 명단 상태값 기준 실시간 통계 변수 자동 연산
    const totalCount = influencers.length;
    const passCount = influencers.filter(i => i.result === "통과").length;
    const failCount = influencers.filter(i => i.result === "반려").length;
    const pendingCount = influencers.filter(i => i.result === "-").length;
    
    // 통과율 계산 (0명일 때 NaN 방지 처리)
    const passRate = totalCount > 0 ? Math.round((passCount / (passCount + failCount || 1)) * 100) : 0;

    return (
        <div>
            {/* 상단 바 */}
            <div className="bar">
                <div className="brand">REEL<em>CHECK</em></div>
                <div className="roles">
                    <button className={role === "marketer" ? "active" : ""} onClick={() => setRole("marketer")}>마케터 화면</button>
                    <button className={role === "influencer" ? "active" : ""} onClick={() => setRole("influencer")}>인플루언서 업로드</button>
                </div>
            </div>

            <div className="wrap">
                <h1 style={{ fontSize: "22px", margin: "10px 0" }}>콘텐츠 1차 자동 검수 대시보드</h1>
                
                {role === "marketer" ? (
                    <div>
                        {/* ⚡ [핵심 패치] 대시보드 최상단 실시간 검수 통계 스코어보드 그리드 */}
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "12px", marginBottom: "20px" }}>
                            <div className="card" style={{ padding: "15px", margin: 0, textAlign: "center", borderLeft: "4px solid #111" }}>
                                <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--mute)" }}>총 대상 인원</div>
                                <div style={{ fontSize: "22px", fontWeight: 700, margin: "4px 0 0" }}>{totalCount}명</div>
                            </div>
                            <div className="card" style={{ padding: "15px", margin: 0, textAlign: "center", borderLeft: "4px solid #4CAF50" }}>
                                <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--mute)" }}>AI 자동 통과</div>
                                <div style={{ fontSize: "22px", fontWeight: 700, color: "#4CAF50", margin: "4px 0 0" }}>{passCount}명</div>
                            </div>
                            <div className="card" style={{ padding: "15px", margin: 0, textAlign: "center", borderLeft: "4px solid #F44336" }}>
                                <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--mute)" }}>가이드 위반 (반려)</div>
                                <div style={{ fontSize: "22px", fontWeight: 700, color: "#F44336", margin: "4px 0 0" }}>{failCount}명</div>
                            </div>
                            <div className="card" style={{ padding: "15px", margin: 0, textAlign: "center", borderLeft: "4px solid #FF9800" }}>
                                <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--mute)" }}>검수 대기 (통과율)</div>
                                <div style={{ fontSize: "22px", fontWeight: 700, color: "#FF9800", margin: "4px 0 0" }}>{pendingCount}명 <span style={{ fontSize: "12px", color: "var(--graphite)" }}>({passRate}%)</span></div>
                            </div>
                        </div>

                        {/* 명단 대량 등록 섹션 */}
                        <div className="card" style={{ backgroundColor: "#F7F9F5", border: "2px dashed var(--stamp)", padding: "20px", marginBottom: "20px" }}>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
                                <h3 style={{ margin: 0, color: "var(--stamp)", fontSize: "14px" }}>📊 명단 대량 등록 매니저</h3>
                                <button onClick={handleDownloadSample} style={{ background: "#FFF", border: "1px solid var(--stamp)", color: "var(--stamp)", borderRadius: "4px", padding: "5px 10px", fontSize: "11px", fontWeight: "600", cursor: "pointer" }}>
                                    📥 양식 엑셀 다운로드
                                </button>
                            </div>
                            <div style={{ background: "#FFF", padding: "8px", border: "1px solid var(--line)", borderRadius: "4px", display: "inline-block" }}>
                                <input type="file" accept=".csv, .xlsx, .xls" onChange={handleFileUpload} style={{ fontSize: "13px", cursor: "pointer" }} />
                            </div>
                        </div>

                        {/* 라이브 테이블 현황판 */}
                        <div className="card">
                            <table className="tbl">
                                <thead>
                                    <tr><th>인플루언서 정보</th><th>제출 상태</th><th>AI 판정</th><th>작업</th></tr>
                                </thead>
                                <tbody>
                                    {influencers.map(inf => (
                                        <tr key={inf.id}>
                                            <td>
                                                <div style={{ fontWeight: 600 }}>{inf.name}</div>
                                                <div style={{ fontSize: '11px', color: 'var(--mute)' }}>{inf.handle}</div>
                                            </td>
                                            <td>{inf.status}</td>
                                            <td><span className={`st ${inf.result === '통과' ? 'pass' : inf.result === '-' ? 'none' : 'block'}`}>{inf.result}</span></td>
                                            <td><button className="btn sm" onClick={() => { setSelectedInf(inf); setFeedbackText(inf.feedback || ""); }}>상세 피드백</button></td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                ) : (
                    <div className="card" style={{ padding: "30px", textAlign: "center" }}>
                        <h3>📹 인플루언서 영상 제출 레이어</h3>
                        <p style={{ fontSize: "13px", color: "var(--mute)", marginTop: "10px" }}>광고 원본 비디오를 분석 서버로 안전하게 전송하는 컨트롤러 구역입니다.</p>
                    </div>
                )}

                {/* 피드백 모달창 */}
                {selectedInf && (
                    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
                        <div className="card" style={{ width: '400px', padding: '20px' }}>
                            <h3>{selectedInf.name} 피드백 작성</h3>
                            <textarea className="in" style={{ height: '80px', marginBottom: "12px" }} value={feedbackText} onChange={(e) => setFeedbackText(e.target.value)} />
                            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
                                <button className="btn" style={{ backgroundColor: "#858E88" }} onClick={() => setSelectedInf(null)}>닫기</button>
                                <button className="btn stamp" onClick={() => {
                                    setInfluencers(prev => prev.map(i => i.id === selectedInf.id ? { ...i, feedback: feedbackText, status: "피드백완료" } : i));
                                    setSelectedInf(null);
                                }}>저장</button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
