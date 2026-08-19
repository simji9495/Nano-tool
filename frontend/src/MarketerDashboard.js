import React from 'react';

export default function MarketerDashboard({ loadingList, influencers, handleFileUpload, setSelectedInf, setFeedbackText }) {
    return (
        <div>
            {/* 📊 요구사항: 명확하고 선명한 파일 업로드 버튼 레이아웃 */}
            <div className="card" style={{ backgroundColor: "#F7F9F5", border: "1px dashed var(--line)", padding: "26px" }}>
                <div className="card-hd" style={{ border: "0", padding: "0", marginBottom: "6px" }}>
                    <h2 style={{ fontSize: "15px", color: "var(--stamp)" }}>📊 명단 대량 등록 (CSV / Excel 파일 선택)</h2>
                </div>
                <p style={{ fontSize: "12.5px", color: "var(--graphite)", margin: "0 0 16px" }}>
                    엑셀의 첫 번째 행에 <b>이름</b>과 <b>핸들</b> 컬럼 제목을 입력하고 작성한 뒤, 아래 버튼을 클릭하여 업로드하세요.
                </p>
                
                <div style={{
                    display: "inline-block", background: "#FFFFFF", border: "1px solid var(--stamp)", 
                    borderRadius: "4px", padding: "12px 20px", cursor: "pointer", boxShadow: "0 2px 4px rgba(0,0,0,0.05)"
                }}>
                    <input 
                        type="file" 
                        accept=".csv, .xlsx, .xls" 
                        onChange={handleFileUpload} 
                        style={{ fontSize: "14px", cursor: "pointer", fontWeight: "500" }} 
                    />
                </div>
            </div>

            {/* Supabase 연동 라이브 현황판 */}
            <div className="card">
                <div className="card-hd"><h2>전체 콘텐츠 라이브 검수 현황 (실시간 DB 동기화)</h2></div>
                {loadingList ? <div style={{ padding: "20px", fontSize: "13px" }}>Supabase 데이터 불러오는 중...</div> : (
                    <table className="tbl">
                        <thead>
                            <tr>
                                <th>인플루언서 식별정보</th>
                                <th>제출 및 가동 여부</th>
                                <th>AI 판정</th>
                                <th>액션</th>
                            </tr>
                        </thead>
                        <tbody>
                            {influencers.map(inf => (
                                <tr key={inf.id}>
                                    <td>
                                        <div style={{ fontWeight: 600, color: 'var(--ink)' }}>{inf.name}</div>
                                        <div style={{ fontSize: '11px', color: 'var(--mute)' }}>{inf.handle}</div>
                                    </td>
                                    <td>{inf.status}</td>
                                    <td>
                                        <span className={`st ${inf.result === '통과' ? 'pass' : inf.result === '-' ? 'none' : 'block'}`}>
                                            {inf.result}
                                        </span>
                                    </td>
                                    <td>
                                        <button className="btn sm" onClick={() => { setSelectedInf(inf); setFeedbackText(inf.feedback || ""); }}>상세 검수 / 피드백</button>
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
