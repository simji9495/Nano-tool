import React from "react";

export default function LandingPage({ onGetStarted }) {
  return (
    <div className="landing">
      <header className="lp-bar">
        <span className="logo">
          <span className="mark" />
          <span className="word">InCensor</span>
        </span>
        <span className="spacer" />
        <nav className="lp-nav">
          <a href="#how">작동 방식</a>
          <a href="#screens">화면</a>
          <a href="#faq">FAQ</a>
        </nav>
        <button className="btn sm" onClick={onGetStarted}>
          Get Started
        </button>
      </header>

      <div className="lp-wrap">
        <section className="hero">
          <div>
            <div className="tag">음성 + 화면 자막 동시 검수</div>
            <h1>
              시딩 콘텐츠 검수,
              <br />
              1차는 AI가 끝내둡니다
            </h1>
            <p>
              브랜드·제품명, 필수 USP, 금칙어를 영상의 발화와 자막에서 함께
              확인합니다. 담당자는 반려·애매 건만 열어보면 됩니다.
            </p>
            <div className="cta-row">
              <button className="btn" onClick={onGetStarted}>
                Get Started
              </button>
              <a className="btn outline" href="#how">
                작동 방식 보기
              </a>
            </div>
          </div>
          <div className="panel">
            <div className="panel-hd">
              2026 봄 시딩 · 릴스
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: "11px", fontWeight: 400, color: "var(--mute)" }}>
                통과율 68%
              </span>
            </div>
            <div className="stats">
              <div>
                <div className="k">대상</div>
                <div className="v">124</div>
              </div>
              <div>
                <div className="k">자동 통과</div>
                <div className="v" style={{ color: "var(--pass)" }}>84</div>
              </div>
              <div>
                <div className="k">반려</div>
                <div className="v" style={{ color: "var(--block)" }}>17</div>
              </div>
              <div>
                <div className="k">대기</div>
                <div className="v" style={{ color: "var(--graphite)" }}>23</div>
              </div>
            </div>
            <div className="rows">
              <div className="row head">
                <span>인플루언서</span>
                <span>제출</span>
                <span>AI 판정</span>
              </div>
              <div className="row">
                <span>김지원 · @beauty_jiwon</span>
                <span style={{ color: "var(--mute)" }}>완료</span>
                <span>
                  <span className="st pass">통과</span>
                </span>
              </div>
              <div className="row">
                <span>박서연 · @daily_seoyeon</span>
                <span style={{ color: "var(--mute)" }}>완료</span>
                <span>
                  <span className="st block">반려</span>
                </span>
              </div>
              <div className="row">
                <span>이하늘 · @haneul.log</span>
                <span style={{ color: "var(--mute)" }}>완료</span>
                <span>
                  <span className="st none">자막 검수 중</span>
                </span>
              </div>
              <div className="row">
                <span>정민아 · @mina_daily</span>
                <span style={{ color: "var(--mute)" }}>미제출</span>
                <span style={{ color: "var(--mute)" }}>—</span>
              </div>
            </div>
          </div>
        </section>

        <section className="sec" id="how">
          <div className="rule">
            <h2 className="big">HOW IT WORKS</h2>
            <div className="process">
              <div>
                <span>STEP 1</span>
                <h3>업로드</h3>
                <p>MCN/에이전시가 인플루언서 영상 파일을 올립니다.</p>
              </div>
              <div>
                <span>STEP 2</span>
                <h3>음성 판정 (10~30초)</h3>
                <p>발화를 텍스트로 옮겨 가이드라인과 대조하고 즉시 결과를 띄웁니다.</p>
              </div>
              <div>
                <span>STEP 3</span>
                <h3>자막 판정 (백그라운드)</h3>
                <p>장면 전환 지점을 캡처해 화면 글자를 읽고, 의심 구간만 정밀 확인합니다.</p>
              </div>
              <div>
                <span>STEP 4</span>
                <h3>종합 → 사람 확정</h3>
                <p>둘을 합친 판정과 시간대별 근거를 보고 담당자가 최종 결정합니다.</p>
              </div>
            </div>
          </div>
        </section>

        <section className="sec" id="screens">
          <div className="duo">
            <div>
              <span className="eyebrow">FOR MARKETERS</span>
              <h3>마케터 화면</h3>
              <p>
                캠페인을 만들고 가이드라인을 저장한 뒤, 명단을 엑셀로 한 번에
                등록합니다. 통과·반려·대기 현황이 실시간으로 집계됩니다.
              </p>
              <div className="shot">
                <span>marketer dashboard</span>
              </div>
            </div>
            <div>
              <span className="eyebrow">FOR AGENCIES</span>
              <h3>MCN/에이전시 업로드 화면</h3>
              <p>
                별도 가입 없이 캠페인 링크에서 인플루언서 행에 영상을 올리면
                검수가 시작되고, 반려 사유를 바로 확인할 수 있습니다.
              </p>
              <div className="shot">
                <span>upload screen</span>
              </div>
            </div>
          </div>
        </section>

        <section className="sec" id="faq">
          <div className="faq">
            <h2>자주 묻는 질문</h2>
            <div className="list">
              <div className="item">
                <h3>AI 판정이 최종인가요?</h3>
                <p>아닙니다. 1차 스크리닝 결과이며, 근거를 확인한 담당자가 최종 확정합니다.</p>
              </div>
              <div className="item">
                <h3>발화를 잘못 알아듣지는 않나요?</h3>
                <p>신조어·특이한 제품명은 다르게 인식될 수 있어, 전사 원문과 시간대별 근거를 함께 제공합니다.</p>
              </div>
              <div className="item">
                <h3>캠페인끼리 데이터가 섞이나요?</h3>
                <p>캠페인은 완전히 독립적입니다. 명단과 가이드라인은 해당 캠페인 안에서만 쓰입니다.</p>
              </div>
              <div className="item">
                <h3>영상 원본은 보관되나요?</h3>
                <p>검수 후 삭제됩니다. 판정 결과와 근거 텍스트만 남습니다.</p>
              </div>
            </div>
          </div>
        </section>

        <section className="sec">
          <div className="closing">
            <div>
              <h2>우리 캠페인 기준으로 한 번 돌려볼까요</h2>
              <p>가이드라인과 영상 몇 개만 있으면 바로 결과를 보여드립니다.</p>
            </div>
            <button
              className="btn"
              style={{ flex: "none", padding: "14px 30px", fontWeight: 700 }}
              onClick={onGetStarted}
            >
              Get Started
            </button>
          </div>
        </section>
      </div>

      <footer>
        <span>© 2026 InCensor</span>
        <div className="links">
          <a href="#faq">이용약관</a>
          <a href="#faq">개인정보처리방침</a>
          <a href="#faq">문의</a>
        </div>
      </footer>
    </div>
  );
}
