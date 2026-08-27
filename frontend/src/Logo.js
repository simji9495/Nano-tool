import React from "react";

// 좌상단 로고: 재생 아이콘 + 프로그레스바가 담긴 영상 프레임 모양. onClick이
// 있으면 클릭 가능한 버튼(주로 "홈으로 이동")으로, 없으면 정적 표시로 쓴다.
export default function Logo({ onClick }) {
  const Wrapper = onClick ? "button" : "span";
  return (
    <Wrapper className="logo" onClick={onClick} type={onClick ? "button" : undefined}>
      <svg className="mark" viewBox="0 0 100 140" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <rect x="8" y="8" width="84" height="124" rx="26" stroke="currentColor" strokeWidth="9" />
        <path d="M40 42 L40 74 L67 58 Z" fill="currentColor" />
        <line x1="26" y1="98" x2="74" y2="98" stroke="#B7B7B4" strokeWidth="6" strokeLinecap="round" />
        <circle cx="40" cy="98" r="7" fill="currentColor" />
      </svg>
      <span className="word">InCensor</span>
    </Wrapper>
  );
}
