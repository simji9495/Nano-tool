import React from "react";
import Logo from "./Logo";

// 로그인 실패 원인(백엔드가 리다이렉트에 실어 보내는 authError 값)별 안내 문구.
const ERROR_MESSAGES = {
  not_whitelisted: "등록되지 않은 계정입니다. 담당자에게 문의해주세요.",
  google_failed: "구글 로그인 확인에 실패했습니다. 다시 시도해주세요.",
  invalid_request: "로그인 요청이 올바르지 않습니다. 다시 시도해주세요.",
};

// 구글 로그인은 스크립트를 전혀 불러오지 않는다("외부 CDN 스크립트 없음"
// 정책 준수) — 이 버튼은 그냥 페이지 이동(리다이렉트)이고, 실제 구글과의
// 교환은 전부 서버에서 처리한다.
export default function Login({ apiBase, error }) {
  return (
    <div className="home">
      <div className="bar">
        <Logo />
        <span className="spacer" />
        <span className="bar-sub">인플루언서 콘텐츠 1차 검수 솔루션</span>
      </div>
      <div className="home-body">
        <div className="eyebrow">Sign in</div>
        <h1>구글 계정으로 로그인해주세요</h1>
        {error && (
          <p style={{ color: "var(--block)", fontSize: 13, margin: "0 0 24px", maxWidth: "40ch", textAlign: "center" }}>
            {ERROR_MESSAGES[error] || "로그인에 실패했습니다. 다시 시도해주세요."}
          </p>
        )}
        <a className="btn" href={`${apiBase}/api/auth/google/start`} style={{ textDecoration: "none" }}>
          구글 계정으로 로그인
        </a>
      </div>
    </div>
  );
}
