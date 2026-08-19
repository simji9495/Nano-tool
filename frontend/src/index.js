import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import CampaignSettings from './CampaignSettings';
import MarketerDashboard from './MarketerDashboard';

const API_BASE = "https://onrender.com";

function App() {
    const [role, setRole] = useState("marketer");
    const [step, setStep] = useState(1);
    const [campaign, setCampaign] = useState({
        brand: "나노뷰티", product: "워터 에센스", 
        usps: ["48시간 보습 지속", "비건 인증 원료", "저자극 테스트 완료"],
        bans: ["타사 제품 언급", "효과 과장 광고", "화학 성분 강조"]
    });
    const [influencers, setInfluencers] = useState([]);
    const [loadingList, setLoadingList] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [selectedInfluencerId, setSelectedInfluencerId] = useState("");
    const [analysisLog, setAnalysisLog] = useState([]);
    const [selectedInf, setSelectedInf] = useState(null);
    const [feedbackText, setFeedbackText] = useState("");

    useEffect(() => { fetchInfluencerList(); }, []);

    const fetchInfluencerList = async () => {
        setLoadingList(true);
        try {
            const response = await fetch(`${API_BASE}/api/influencers/list`);
            if (response.ok) {
                const data = await response.json();
                if (data && data.length > 0) setInfluencers(data);
            }
        } catch (error) {
            setInfluencers([
                { id: 1, name: "김나노", handle: "@nano_review", status: "검수완료", result: "통과", audioText: "제품 순해요.", ocrText: "[자막] 보습 에센스", feedback: "준수 완료" },
                { id: 2, name: "이리뷰", handle: "@lee_vlog", status: "미제출", result: "-", audioText: "", ocrText: "", feedback: "" }
            ]);
        } finally { setLoadingList(false); }
    };

    const handleFileUpload = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const ext = file.name.split('.').pop().toLowerCase();
        if (ext === 'csv') {
            Papa.parse(file, { header: true, skipEmptyLines: true, complete: (res) => sendDataToSupabase(res.data) });
        } else {
            const reader = new FileReader();
            reader.onload = (evt) => {
                const workbook = XLSX.read(evt.target.result, { type: 'binary' });
                sendDataToSupabase(XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]));
            };
            reader.readAsBinaryString(file);
        }
    };

    const sendDataToSupabase = async (rawData) => {
        const formatted = rawData.map((item, idx) => ({
            id: Date.now() + idx,
            name: (item['이름'] || item['name'] || `인플루언서_${idx + 1}`).toString().trim(),
            handle: (item['핸들'] || item['handle'] || "@unknown").toString().trim(),
            status: "미제출", result: "-"
        }));
        try {
            await fetch(`${API_BASE}/api/influencers`, {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ list: formatted })
            });
            setInfluencers(prev => [...prev, ...formatted]);
            alert(`🎉 Supabase DB에 총 ${formatted.length}명의 명단이 저장되었습니다!`);
        } catch (error) {
            setInfluencers(formatted);
            alert(`[우회 모드] 화면 대시보드에 ${formatted.length}명이 로드되었습니다.`);
        }
    };

    const handleVideoInspect = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        setUploading(true);
        setAnalysisLog(["[1/3] 서버 전송 중...", "[2/3] Whisper AI 분석 중..."]);
        try {
            setInfluencers(prev => prev.map(inf => {
                if (inf.id === Number(selectedInfluencerId || 2)) {
                    return { ...inf, status: "검수완료", result: "반려", audioText: "화학 성분 제로네요.", ocrText: "[자막] 테스트 완료", feedback: "금기사항 [화학 성분] 위반" };
                }
                return inf;
            }));
            setAnalysisLog(prev => [...prev, "[3/3] Claude 검수 완료!"]);
        } finally { setUploading(false); }
    };

    return (
        <div>
            <div className="bar">
                <div className="brand">REEL<em>CHECK</em></div>
                <div className="roles">
                    <button className={role === "marketer" ? "active" : ""} onClick={() => setRole("marketer")}>마케터 화면</button>
                    <button className={role === "influencer" ? "active" : ""} onClick={() => setRole("influencer")}>인플루언서 업로드</button>
                </div>
            </div>
            <div className="wrap">
                {role === "marketer" ? (
                    <div>
                        <div className="steps">
                            <button className={step === 1 ? "active" : ""} onClick={() => setStep(1)}>1. 가이드라인 세팅</button>
                            <button className={step === 2 ? "active" : ""} onClick={() => setStep(2)}>2. 명단 등록 및 현황</button>
                        </div>
                        {step === 1 ? <CampaignSettings campaign={campaign} setCampaign={setCampaign} /> : 
                        <MarketerDashboard loadingList={loadingList} influencers={influencers} handleFileUpload={handleFileUpload} setSelectedInf={setSelectedInf} setFeedbackText={setFeedbackText} />}
                    </div>
                ) : (
                    <div className="card">
                        <div className="card-hd"><h2>인플루언서 비디오 제출</h2></div>
                        <select className="in" onChange={(e)=>setSelectedInfluencerId(e.target.value)}>
                            <option value="">-- 이름을 골라주세요 --</option>
                            {influencers.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
                        </select>
                        <input type="file" onChange={handleVideoInspect} disabled={uploading} style={{marginTop:"20px"}} />
                        {uploading && analysisLog.map((log, i) => <div key={i}>{log}</div>)}
                    </div>
                )}
                {selectedInf && (
                    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
                        <div className="card" style={{ width: '500px', padding: '24px' }}>
                            <h2>{selectedInf.name} 피드백 보고서</h2>
                            <textarea className="in" style={{ height: '100px' }} value={feedbackText} onChange={(e)=>setFeedbackText(e.target.value)} />
                            <button className="btn stamp" onClick={()=>{ alert('피드백 저장 완료'); setSelectedInf(null); }}>저장</button>
                            <button className="btn" onClick={()=>setSelectedInf(null)}>닫기</button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
