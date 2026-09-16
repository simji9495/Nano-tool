/**
 * InCensor 검수 서버
 *  POST /api/transcribe  영상/오디오 → 타임코드 붙은 전사 (OpenAI)
 *  POST /api/frames      영상 → 장면 단위 키프레임 (claude-real-video)
 *  POST /api/inspect     위 둘을 한 번에 (프론트엔드가 쓰는 엔드포인트)
 *  GET  /api/health      의존성 설치 상태 확인
 *
 * 필요한 환경변수: OPENAI_API_KEY
 * 선택: PORT, STT_MODEL, STT_LANG, CRV_BIN, ALLOW_ORIGIN
 */

import express from "express";
import multer from "multer";
import cors from "cors";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import {
  generateOAuthState,
  buildGoogleAuthUrl,
  exchangeCodeForEmail,
  signSessionToken,
  resolveAccess,
  requireAuth,
  requireMarketer,
  requireCampaignAccess,
  verifyOrigin,
  devOnly,
  SESSION_MAX_AGE_MS,
  OAUTH_STATE_MAX_AGE_MS,
} from "./auth.js";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutBucketCorsCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createWorker, PSM } from "tesseract.js";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

dotenv.config();

// 사내망처럼 프록시를 거쳐야 외부 인터넷(Supabase/OpenAI)에 나갈 수 있는 환경 대응.
// HTTPS_PROXY가 없으면 (예: 클라우드 배포 환경) 아무 영향 없이 그대로 직접 연결한다.
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
if (proxyUrl) setGlobalDispatcher(new ProxyAgent(proxyUrl));

const run = promisify(execFile);
const app = express();

/* OpenAI 요청 한도(429)는 대개 짧으면 수백ms~수초 안에 풀리지만, 의심 프레임이
 * 많아 짧은 시간에 호출이 몰리면(예: 60장 중 56장 검증) 계정 분당 토큰 한도가
 * 통째로 바닥나 10초 넘게도 안 풀릴 수 있다 — 재시도 없이 바로 실패시키면
 * 잠깐만 더 기다리면 될 일에 자막 검수 전체를 놓치게 된다. */
/* 429(한도 초과)를 맞은 요청이 그 자리에서 대기하며 동시 실행 자리를 계속
 * 붙들고 있으면, 뒤에 줄 서 있는 다른 영상들까지 덩달아 막혀버린다. 그래서
 * 429가 나면 자리를 즉시 비우고(withOpenAISlot, 아래에서 정의) 대기 시간만큼
 * 기다린 뒤 큐 맨 뒤로 다시 줄을 세운다 — 순서 보장보다 전체 처리량을
 * 우선한다. */
async function fetchOpenAIWithRetry(url, options, { retries = 6, baseDelayMs = 1500 } = {}) {
  const attempt = async (n) => {
    const r = await withOpenAISlot(() => fetch(url, options));
    if (r.status !== 429 || n >= retries) return r;
    const retryAfterSec = Number(r.headers.get("retry-after"));
    const waitMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
      ? retryAfterSec * 1000
      : baseDelayMs * (n + 1);
    console.warn(`[OpenAI] 429 요청 한도 초과 — ${waitMs}ms 후 다시 줄을 섭니다 (${n + 1}/${retries})`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return attempt(n + 1);
  };
  return attempt(0);
}

const PORT = process.env.PORT || 8787;
const STT_MODEL = process.env.STT_MODEL || "whisper-1";
const STT_LANG = process.env.STT_LANG || "ko";
// 브라우저의 Origin 헤더는 절대 끝에 "/"가 붙지 않는다. 배포 URL을 복사해
// 붙여넣을 때 슬래시가 딸려오는 실수가 흔해서, CORS 비교 전에 미리 제거한다.
const ALLOW_ORIGIN = (process.env.ALLOW_ORIGIN || "*").replace(/\/+$/, "");
const CRV_BIN = process.env.CRV_BIN || "crv";
const MAX_UPLOAD_MB = 500;
const CHUNK_LIMIT = 24 * 1024 * 1024; // OpenAI 업로드 한도 25MB보다 살짝 아래

const supabase =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
    : null;

const requireSupabase = (_req, res, next) => {
  if (!supabase) {
    return res.status(503).json({
      error: "Supabase가 설정되지 않았습니다. SUPABASE_URL / SUPABASE_SERVICE_KEY를 확인해주세요.",
    });
  }
  next();
};

/* 브라우저가 대용량 영상을 Render 서버가 아니라 Cloudflare R2에 직접 올릴 수
 * 있게 쓰는 버킷. 업로드 자체는 Render의 요청 처리 시간 한도(~300초)를 타지
 * 않는다. Supabase Storage는 무료 티어 기준 파일 1개당 50MB로 제한돼있어
 * 대용량 영상엔 못 써서, R2(개별 파일 사실상 무제한, 전송량 무료)를 쓴다. */
const R2_BUCKET = process.env.R2_BUCKET_NAME || "reelcheck-uploads";
const UPLOADS_PREFIX = "uploads/";

const r2 =
  process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY
    ? new S3Client({
        region: "auto",
        endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: process.env.R2_ACCESS_KEY_ID,
          secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        },
      })
    : null;

const requireR2 = (_req, res, next) => {
  if (!r2) {
    return res.status(503).json({
      error: "R2가 설정되지 않았습니다. R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET_NAME을 확인해주세요.",
    });
  }
  next();
};

async function verifyR2Connection() {
  if (!r2) return;
  try {
    await r2.send(new ListObjectsV2Command({ Bucket: R2_BUCKET, MaxKeys: 1 }));
    console.log(`[R2] "${R2_BUCKET}" 버킷 연결 확인 완료`);
  } catch (e) {
    console.warn(`[R2] 버킷 연결 확인 실패: ${e.message}`);
  }
}

/* 브라우저가 프리사인드 URL로 R2에 "직접" PUT을 보내려면 R2 버킷에 CORS 설정이
 * 있어야 한다(없으면 브라우저가 막는다 — curl은 CORS를 안 지켜서 여기서
 * 안 걸린다). R2는 대시보드가 아니라 S3 API로만 CORS를 설정할 수 있어서
 * 서버가 시작할 때마다 원하는 설정으로 맞춰둔다(멱등). */
async function configureR2Cors() {
  if (!r2) return;
  const allowedOrigins = Array.from(new Set([ALLOW_ORIGIN, "http://localhost:3000"]));
  try {
    await r2.send(
      new PutBucketCorsCommand({
        Bucket: R2_BUCKET,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedOrigins: allowedOrigins,
              AllowedMethods: ["PUT", "GET"],
              // R2는 AllowedHeaders에 "*"를 지원하지 않는다 — content-type만 명시해야 한다.
              AllowedHeaders: ["content-type"],
              MaxAgeSeconds: 3600,
            },
          ],
        },
      }),
    );
    console.log(`[R2] CORS 설정 완료 (허용 origin: ${allowedOrigins.join(", ")})`);
  } catch (e) {
    console.warn(`[R2] CORS 설정 실패: ${e.message}`);
  }
}

/* 브라우저가 R2 업로드까지만 끝내고(창을 닫는 등) 서버에 "처리 시작"을
 * 알리지 못하면, 파일이 R2에 고아로 남는다. 일정 시간 지난 파일은
 * 주기적으로 정리한다. */
const ORPHAN_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2시간
const ORPHAN_CLEANUP_INTERVAL_MS = 30 * 60 * 1000; // 30분마다 확인

/* Supabase 무료 플랜은 7일간 API 요청이 없으면 프로젝트를 자동으로
 * 일시정지시킨다. 실제 검수 없이도 하루 한 번 가벼운 조회만 보내
 * "비활성"으로 분류되지 않게 한다 — 새 테이블 없이 기존 테이블을
 * 1행만 읽는 정도라 비용·부하가 사실상 없다. */
const SUPABASE_HEARTBEAT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 하루 한 번

async function cleanupOrphanedUploads() {
  if (!r2) return;
  try {
    const { Contents } = await r2.send(
      new ListObjectsV2Command({ Bucket: R2_BUCKET, Prefix: UPLOADS_PREFIX, MaxKeys: 1000 }),
    );
    const now = Date.now();
    const staleCandidates = (Contents || []).filter(
      (o) => o.Key && o.LastModified && now - new Date(o.LastModified).getTime() > ORPHAN_MAX_AGE_MS,
    );
    if (!staleCandidates.length) return;

    // 검수 완료 후 마케터 최종 판정을 기다리며 "의도적으로" 남겨둔 영상은
    // reelcheck_influencers.video_path에 그대로 남아있다 — 오래됐다고
    // 지우면 안 된다(마케터가 통과를 누를 때 별도로 지워진다).
    let keepKeys = new Set();
    if (supabase) {
      const { data } = await supabase
        .from("reelcheck_influencers")
        .select("video_path")
        .not("video_path", "is", null);
      keepKeys = new Set((data || []).map((r) => r.video_path));
    }
    const stale = staleCandidates.filter((o) => !keepKeys.has(o.Key)).map((o) => ({ Key: o.Key }));
    if (stale.length) {
      await r2.send(new DeleteObjectsCommand({ Bucket: R2_BUCKET, Delete: { Objects: stale } }));
      console.log(`[R2] 고아 업로드 파일 ${stale.length}건 정리`);
    }
  } catch (e) {
    console.warn(`[R2] 고아 파일 정리 실패: ${e.message}`);
  }
}

async function pingSupabaseHeartbeat() {
  if (!supabase) return;
  const { error } = await supabase.from("reelcheck_influencers").select("id").limit(1);
  if (error) console.warn(`[Supabase] 하트비트 실패: ${error.message}`);
}

/* 화면 자막 검수가 백그라운드로 넘어간 뒤(status: "검수완료(음성)") 서버가
 * 재시작되거나 크래시되면, 그 작업은 아무 기록 없이 그냥 사라진다 — 처리
 * 중이던 로컬 임시 영상도, R2에 있던 원본도 이미 지워진 뒤라 이어서
 * 재개할 방법이 없다. 그렇다고 "완료"로 얼버무려두면 자막을 실제로는
 * 확인 안 했다는 사실이 마케터 눈에 묻혀버리므로, 일정 시간(기본 30분)
 * 넘게 멈춰있으면 명확하게 실패로 표시해 재업로드를 유도한다. */
const STUCK_CAPTION_TIMEOUT_MS = Number(process.env.STUCK_CAPTION_TIMEOUT_MS) || 20 * 60 * 1000;
const STUCK_CAPTION_CHECK_INTERVAL_MS = 10 * 60 * 1000; // 10분마다 확인

async function finalizeStuckCaptionJobs() {
  if (!supabase) return;
  try {
    const cutoff = new Date(Date.now() - STUCK_CAPTION_TIMEOUT_MS).toISOString();
    // audio_done_at이 비어있는 건(이 컬럼이 생기기 전에 처리된 옛 건, 혹은
    // 기록 자체가 실패한 건)도 언제까지고 방치되지 않도록 같이 잡는다.
    const { data, error } = await supabase
      .from("reelcheck_influencers")
      .select("id")
      .eq("status", "검수완료(음성)")
      .or(`audio_done_at.is.null,audio_done_at.lt.${cutoff}`);
    if (error) return console.warn(`[감시] 멈춘 작업 조회 실패: ${error.message}`);
    if (!data?.length) return;

    await supabase
      .from("reelcheck_influencers")
      .update({
        // 마케터가 상세 팝업을 열지 않고 목록만 봐도 다음 행동(재업로드)을
        // 바로 알 수 있도록, 안내 문구를 feedback이 아니라 status 자체에
        // 담는다 — 목록 화면은 status를 그대로 보여주기 때문이다.
        status: "검수실패 — 화면 자막 확인이 중단되었습니다. 영상을 다시 업로드해주세요.",
        result: "-",
        feedback: "화면 자막 확인이 오래 걸려 중단되었습니다. 영상을 다시 업로드해주세요.",
      })
      .in("id", data.map((r) => r.id));
    console.log(`[감시] 멈춘 자막 검수 ${data.length}건을 실패로 정리`);
  } catch (e) {
    console.warn(`[감시] 멈춘 작업 정리 실패: ${e.message}`);
  }
}

const IS_PRODUCTION = process.env.NODE_ENV === "production";
// 세션 쿠키를 설정할 때/지울 때 공통으로 쓰는 속성. 프론트(Vercel)와
// 백엔드(Render)가 서로 다른 도메인이라 sameSite=none이 필요한데, 이건
// HTTPS(secure)에서만 브라우저가 허용한다 — 로컬(HTTP)은 lax로 낮춘다.
const sessionCookieOptions = () => ({
  httpOnly: true,
  secure: IS_PRODUCTION,
  sameSite: IS_PRODUCTION ? "none" : "lax",
});

// credentials:true와 origin:"*"는 브라우저가 함께 허용하지 않으므로,
// 쿠키 기반 로그인을 쓰는 이상 ALLOW_ORIGIN은 반드시 실제 프론트 주소로
// 좁혀야 한다(배포 시 README·환경변수 설정 참고).
app.use(cors({ origin: ALLOW_ORIGIN, credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use(verifyOrigin(ALLOW_ORIGIN));
const upload = multer({
  dest: path.join(os.tmpdir(), "reelcheck-up"),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
});

/* ───────────── 공통 유틸 ───────────── */

const workdir = async () => {
  const d = path.join(os.tmpdir(), "reelcheck", crypto.randomUUID());
  await fs.mkdir(d, { recursive: true });
  return d;
};

const cleanup = async (...dirs) => {
  for (const d of dirs) {
    if (d) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  }
};

/* 동시에 실행되는 ffmpeg 압축 프로세스 수를 제한한다. 업로드가 짧은 시간에
 * 몰리면 1 CPU 서버에서 압축 작업끼리 CPU를 나눠 먹어 전부 같이 느려지므로,
 * 초과분은 큐에서 기다렸다가 순서대로 처리한다. */
function createSemaphore(limit) {
  let active = 0;
  const queue = [];
  const runNext = () => {
    if (active >= limit || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn()
      .then(resolve, reject)
      .finally(() => {
        active--;
        runNext();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      runNext();
    });
}
const withCompressionSlot = createSemaphore(Number(process.env.MAX_CONCURRENT_COMPRESSIONS) || 2);

/* 키프레임 추출(crv)과 Tesseract OCR도 ffmpeg 압축과 마찬가지로 CPU를 많이
 * 쓴다. 두 단계를 한 세마포어 슬롯 안에 묶어서, 한 영상이 이 구간을 도는
 * 동안에는 다른 영상이 같은 CPU를 두고 끼어들지 못하게 한다(따로 슬롯을
 * 나누면 A영상 키프레임 + B영상 OCR처럼 여러 개가 동시에 겹쳐 돌면서 원래
 * 의도한 "동시 1~2개" 제한이 무력화된다). */
const withCpuSlot = createSemaphore(Number(process.env.MAX_CONCURRENT_CPU_JOBS) || 2);

/* OpenAI(gpt-4o-mini) 호출도 영상이 한꺼번에 몰리면 분당 토큰 한도를 순식간에
 * 넘긴다. 동시 실행 개수를 제한해두면, 한도 안에서 최대한 빠르게 흘려보내면서도
 * 순간적으로 요청이 몰려 대부분 429로 튕기는 상황을 막을 수 있다. */
const withOpenAISlot = createSemaphore(Number(process.env.MAX_CONCURRENT_OPENAI_CALLS) || 4);

/* 자막 검수는 저해상도면 충분한데 원본(1080p 이상)을 그대로 crv/Tesseract에 넣으면
 * 해상도에 비례해서 CPU 부하가 커진다. 업로드 즉시 저해상도·고속 프리셋으로
 * 압축한 프록시 파일을 만들어, 이후 키프레임 추출은 이 작은 파일로만 진행한다.
 * 오디오는 화질과 무관하니 그대로 복사해서 STT 품질에 영향이 없게 한다.
 * 자막은 화면 폭 방향으로 놓이므로, 세로 영상(릴스/쇼츠)에서 높이만 고정해버리면
 * 폭이 과도하게 줄어 자막을 못 읽는다 — 가로/세로 중 "짧은 변"을 기준으로 고정해
 * 어느 방향이든 자막이 놓인 폭 방향 해상도가 보존되게 한다.
 * 이 프록시는 판정 상세 팝업의 재생용 영상으로도 그대로 재사용된다(아래
 * processUploadedVideo 참고) — 원본을 그대로 올리면 휴대폰 촬영 포맷(.mov 등)을
 * 브라우저가 재생 못 할 수 있고 용량도 커서 로딩이 느린데, mp4/H.264로 다시
 * 인코딩된 이 프록시는 항상 재생 가능하고 훨씬 가볍다. 그래서 OCR에 필요한
 * 수준보다 비트레이트를 살짝 높여(600k→900k) 사람이 보기에도 무난하게 맞췄다. */
async function compressForOcr(videoPath) {
  const dir = await workdir();
  const out = path.join(dir, "proxy.mp4");
  await run("ffmpeg", [
    "-y", "-i", videoPath,
    // 컴퓨트를 2CPU/4GB로 올린 뒤로 CPU 여유가 생겨, 자막 인식률을 위해 화질을
    // 한 단계 올린다(720→1080, 900k→2000k, ultrafast→veryfast) — 예전 1CPU
    // 사양에서는 부하를 줄이려고 타이트하게 잡았던 값이다.
    "-vf", "scale='if(gt(iw,ih),-2,1080)':'if(gt(iw,ih),1080,-2)'",
    "-preset", "veryfast",
    "-b:v", "2000k",
    "-c:a", "copy",
    out,
  ]);
  return { path: out, dir };
}

async function probeDuration(file) {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=nw=1:nk=1", file,
  ]);
  const d = parseFloat(stdout.trim());
  return Number.isFinite(d) ? d : 0;
}

/* 영상 → 전사용 오디오. 16kHz 모노 32kbps면 1분에 약 240KB. */
async function extractAudio(src, dir) {
  const out = path.join(dir, "audio.mp3");
  await run("ffmpeg", [
    "-y", "-i", src, "-vn",
    "-ac", "1", "-ar", "16000", "-b:a", "32k",
    out,
  ]);
  return out;
}

/* 25MB를 넘으면 시간 단위로 잘라서 보내고 타임코드를 이어 붙인다. */
async function splitAudio(file, dir, duration) {
  const { size } = await fs.stat(file);
  if (size <= CHUNK_LIMIT) return [{ file, offset: 0 }];

  const parts = Math.ceil(size / CHUNK_LIMIT);
  const span = duration / parts;
  const chunks = [];
  for (let i = 0; i < parts; i++) {
    const out = path.join(dir, `part-${i}.mp3`);
    await run("ffmpeg", [
      "-y", "-i", file,
      "-ss", String(i * span), "-t", String(span),
      "-ac", "1", "-ar", "16000", "-b:a", "32k",
      out,
    ]);
    chunks.push({ file: out, offset: i * span });
  }
  return chunks;
}

/* ───────────── 1. 음성 → 텍스트 ───────────── */

async function transcribeChunk(file, offset) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY가 설정되지 않았습니다.");

  const form = new FormData();
  form.append("file", new Blob([await fs.readFile(file)], { type: "audio/mpeg" }), path.basename(file));
  form.append("model", STT_MODEL);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");
  if (STT_LANG && STT_LANG !== "auto") form.append("language", STT_LANG);
  // prompt는 비워둔다. 브랜드명을 힌트로 주면 Whisper가 잘못 말한 이름을
  // 알아서 고쳐 적어버려서, 정작 잡아야 할 오기입이 사라진다.

  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    throw new Error(`전사 실패 (${r.status}) ${detail.slice(0, 300)}`);
  }
  const d = await r.json();
  const segments = (d.segments || []).map((s) => ({
    start: +(s.start + offset).toFixed(2),
    end: +(s.end + offset).toFixed(2),
    text: (s.text || "").trim(),
  }));
  return { text: (d.text || "").trim(), segments, language: d.language || STT_LANG };
}

async function transcribe(videoPath) {
  const dir = await workdir();
  try {
    const duration = await probeDuration(videoPath);
    const audio = await extractAudio(videoPath, dir);
    const chunks = await splitAudio(audio, dir, duration || 60);
    const results = [];
    for (const c of chunks) results.push(await transcribeChunk(c.file, c.offset));
    return {
      duration,
      language: results[0]?.language || STT_LANG,
      text: results.map((r) => r.text).filter(Boolean).join(" "),
      segments: results.flatMap((r) => r.segments),
    };
  } finally {
    await cleanup(dir);
  }
}

/* 자막(OCR) 요약과 같은 [12.3s] 문구 형식으로 맞춰야 검수 LLM이 음성/자막
 * 어느 쪽에서 나온 언급인지, 몇 초 지점인지를 정확히 인용할 수 있다. */
function formatTimestampedSegments(segments) {
  return (segments || [])
    .filter((s) => s.text)
    .map((s) => `[${s.start}s] ${s.text}`)
    .join("\n");
}

/* ───────────── 2. 장면 단위 키프레임 (crv) ───────────── */

/* crv 버전에 따라 프레임 시각을 알아내는 방법이 달라서 3단계로 시도한다. */
async function frameTimes(files, outDir, duration) {
  // (1) 파일명에 초가 들어 있는 경우: frame_0007_12.34s.jpg
  const fromName = files.map((f) => {
    const m = f.match(/(\d+(?:[._]\d+)?)s(?=\.[a-z]+$)/i) || f.match(/_t(\d+(?:[._]\d+)?)/i);
    return m ? parseFloat(m[1].replace("_", ".")) : null;
  });
  if (fromName.every((t) => t !== null)) return { times: fromName, via: "filename" };

  // (2) MANIFEST.txt에서 파일명과 같은 줄의 타임코드를 읽는다.
  try {
    const man = await fs.readFile(path.join(outDir, "MANIFEST.txt"), "utf8");
    const table = new Map();
    for (const line of man.split("\n")) {
      const name = files.find((f) => line.includes(f));
      if (!name) continue;
      const hms = line.match(/(\d{1,2}):(\d{2}):(\d{2}(?:\.\d+)?)/);
      const ms = line.match(/(\d{1,3}):(\d{2}(?:\.\d+)?)/);
      if (hms) table.set(name, +hms[1] * 3600 + +hms[2] * 60 + parseFloat(hms[3]));
      else if (ms) table.set(name, +ms[1] * 60 + parseFloat(ms[2]));
    }
    if (table.size === files.length) {
      return { times: files.map((f) => table.get(f)), via: "manifest" };
    }
  } catch {}

  // (3) 최후: 균등 분배. 타임코드가 근사치임을 응답에 표시한다.
  return {
    times: files.map((_, i) => (duration * (i + 0.5)) / files.length),
    via: "estimated",
  };
}

async function keyframes(videoPath, opts = {}) {
  const out = await workdir();
  try {
    const duration = await probeDuration(videoPath);
    const args = [
      videoPath,
      "-o", out,
      "--no-transcribe",                                  // 전사는 위에서 처리
      "--scene", String(opts.scene ?? 0.22),              // 릴스 컷 편집 대응
      "--fps-floor", String(opts.fpsFloor ?? 0.5),        // 자막 교체 놓치지 않게
      "--dedup-threshold", String(opts.dedup ?? 4),       // 자막만 바뀌면 픽셀 변화가 작다
      "--dedup-window", String(opts.window ?? 2),
      "--max-frames", String(opts.maxFrames ?? 60),
    ];
    if (opts.report) args.push("--report");

    await run(CRV_BIN, args, { maxBuffer: 1 << 26 });

    const framesDir = path.join(out, "frames");
    let files = (await fs.readdir(framesDir))
      .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
      .sort();
    if (!files.length) throw new Error("키프레임이 추출되지 않았습니다. 영상 파일을 확인해주세요.");

    const { times, via } = await frameTimes(files, out, duration);
    const frames = await Promise.all(
      files.map(async (f, i) => ({
        t: +Number(times[i] || 0).toFixed(2),
        file: f,
        dataUrl: `data:image/jpeg;base64,${(await fs.readFile(path.join(framesDir, f))).toString("base64")}`,
      }))
    );
    frames.sort((a, b) => a.t - b.t);
    return { duration, frames, timeSource: via };
  } finally {
    await cleanup(out);
  }
}

/* ───────────── 1.5 가이드라인 준수 검수 ───────────── */

/* [Ns] 텍스트 태그가 붙은 한 소스(음성 또는 자막)의 텍스트를 줄 단위로 스캔해
 * 대상 문구가 등장하는지 찾는다. 공백만 무시하고 완전히 일치하면 확정
 * 매치, 편집거리로 근접하지만 완전히 일치하지는 않으면(OCR/STT 오독인지
 * 실제 오탈자인지 자동으로 구분할 수 없음) 근접 매치로 따로 모은다. */
function scanExactOccurrences(taggedText, target, source, type) {
  const exact = [];
  const near = [];
  if (!target) return { exact, near };
  const normTarget = target.replace(/\s+/g, "");
  // 브랜드/제품명은 우리 쪽 STT·OCR 오독으로 근접 매치조차 못 잡으면
  // "언급 안 됨"으로 취급돼 부당하게 반려된다 — 짧은 이름에서 글자
  // 하나 이상 틀어지는 오독도 잡아야 하므로 관대한 쪽으로 기운다.
  // *주의*: 3까지 넓혀봤더니(distance 3 / 4글자 = 75% 불일치 허용)
  // "실리콘 성분 X !"처럼 완전히 무관한 문장까지 근접 매치로 잡히는
  // 노이즈가 실측으로 확인돼 되돌렸다 — 편집거리 상한을 target 길이
  // 대비 너무 크게 잡으면 사실상 아무 문자열이나 매치되므로, 2를
  // 안전한 상한으로 유지한다. 경쟁 브랜드는 근접 매치를 넓히면 없는
  // 위반을 의심하게 되므로 기존 기준(minDist=1)을 그대로 유지한다.
  const minDist = type === "brand" || type === "product" ? 2 : 1;
  for (const line of String(taggedText || "").split("\n")) {
    const m = line.match(/^\[([\d.]+)s\]\s*(.*)$/);
    if (!m) continue;
    const timestamp = Number(m[1]) || 0;
    const quote = m[2] || "";
    const normQuote = quote.replace(/\s+/g, "");
    if (!normQuote) continue;
    if (normQuote.includes(normTarget)) {
      exact.push({ timestamp, source, quote, type });
    } else if (fuzzyContains(normQuote, normTarget, 0.3, minDist)) {
      // 근접 매치는 등록된 표기를 그대로 "수정방향"으로 제안한다 — 이미 정답을
      // 알고 있는 항목(마케터가 직접 등록한 브랜드/제품 표기)이라 AI 호출 없이도
      // 바로 만들 수 있다.
      near.push({ timestamp, source, quote, type, needsReview: true, fix: `등록된 표기 "${target}"로 수정` });
    }
  }
  return { exact, near };
}

/* 브랜드명·제품명·경쟁 브랜드명은 등록된 표기와 공백만 무시하고 정확히
 * 일치하는지를 결정론적으로(문자열 비교로) 판정한다 — LLM에게 맡기면
 * "표기가 살짝 달라도 같은 대상"이라며 관대하게 인정하는데, 그 판단
 * 근거가 우리 OCR/STT의 오독인지 실제 정확한 표기인지 LLM 스스로도 구분할
 * 수 없어 신뢰할 수 없다("요자식"을 경쟁 브랜드 언급으로 오판한 사례).
 * 정확히 일치하지 않지만 편집거리상 근접한 경우는 자동으로 통과/위반을
 * 단정하지 않고 "확인 필요"로만 표시해 마케터가 직접 판단하게 한다.
 * 반대로 USP 충족 여부·그 외 금칙 항목(문맥/부정어 이해가 필요)은 여전히
 * LLM에게 맡긴다 — 이건 정확한 문자열 비교로는 판단할 수 없는 영역이다. */
async function reviewAgainstGuidelines({ audioText, captionText }, campaign) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY가 설정되지 않았습니다.");

  const model = process.env.REVIEW_MODEL || "gpt-4o-mini";
  const guideline = {
    brand: campaign?.brand || "",
    product: campaign?.product || "",
    usps: Array.isArray(campaign?.usps) ? campaign.usps.filter(Boolean) : [],
    bans: Array.isArray(campaign?.bans) ? campaign.bans.filter(Boolean) : [],
    competitorBrands: Array.isArray(campaign?.competitorBrands) ? campaign.competitorBrands.filter(Boolean) : [],
    // AI가 발음을 잘못 알아듣는 경우(예: "우르오스"를 "우로스"로 인식)를 대비해
    // 마케터가 미리 등록해둔 "이것도 언급으로 인정" 표기 — 음성에만 적용한다
    // (자막은 화면에 실제로 쓰인 글자를 그대로 정확히 대조해야 하므로 제외).
    brandAudioAliases: Array.isArray(campaign?.brandAudioAliases) ? campaign.brandAudioAliases.filter(Boolean) : [],
    productAudioAliases: Array.isArray(campaign?.productAudioAliases) ? campaign.productAudioAliases.filter(Boolean) : [],
  };

  const audioTagged = audioText || "";
  const captionTagged = captionText || "";
  const combinedForPrompt = `[음성 전사]\n${audioTagged || "(없음)"}\n\n[화면 자막/텍스트]\n${captionTagged || "(없음)"}`;

  const brandAudio = scanExactOccurrences(audioTagged, guideline.brand, "음성", "brand");
  const brandCaption = scanExactOccurrences(captionTagged, guideline.brand, "자막", "brand");
  const productAudio = scanExactOccurrences(audioTagged, guideline.product, "음성", "product");
  const productCaption = scanExactOccurrences(captionTagged, guideline.product, "자막", "product");

  // 마케터가 미리 등록해둔 "음성 인식 허용 표기"는 이미 검증된 대체 표기이므로
  // 정확 매치로 취급해 "확인 필요" 배지 없이 바로 언급된 것으로 인정한다 —
  // 자막에는 적용하지 않는다(화면 글자는 그대로 정확히 대조해야 함).
  const brandAudioAliasExact = guideline.brandAudioAliases.flatMap(
    (alias) => scanExactOccurrences(audioTagged, alias, "음성", "brand").exact,
  );
  const productAudioAliasExact = guideline.productAudioAliases.flatMap(
    (alias) => scanExactOccurrences(audioTagged, alias, "음성", "product").exact,
  );

  // 근접 매치가 등록된 허용 표기와 정확히 일치하는 경우(예: "우로스"를
  // 이미 허용 표기로 등록)는 위의 aliasExact에서 이미 확정 매치로 처리됐으므로,
  // "확인 필요" 근접 매치 목록에 중복으로 남기지 않는다.
  const stripAliased = (nearList, aliases) => {
    const normAliases = aliases.map((a) => a.replace(/\s+/g, "")).filter(Boolean);
    return nearList.filter((item) => {
      const normQuote = item.quote.replace(/\s+/g, "");
      return !normAliases.some((na) => normQuote.includes(na));
    });
  };

  const brandExact = [...brandAudio.exact, ...brandCaption.exact, ...brandAudioAliasExact];
  const brandNear = [...stripAliased(brandAudio.near, guideline.brandAudioAliases), ...brandCaption.near];
  const productExact = [...productAudio.exact, ...productCaption.exact, ...productAudioAliasExact];
  const productNear = [...stripAliased(productAudio.near, guideline.productAudioAliases), ...productCaption.near];

  const competitorExact = [];
  const competitorNear = [];
  for (const name of guideline.competitorBrands) {
    const a = scanExactOccurrences(audioTagged, name, "음성", "ban");
    const c = scanExactOccurrences(captionTagged, name, "자막", "ban");
    competitorExact.push(...a.exact.map((o) => ({ ...o, note: name })), ...c.exact.map((o) => ({ ...o, note: name })));
    // 경쟁 브랜드 근접 매치는 "오타를 고치라"는 게 아니라 "정말 경쟁 브랜드를
    // 언급한 게 맞는지 확인이 필요하다"는 뜻이라, 등록 표기로의 치환 제안은
    // 맞지 않는다 — fix를 비운다.
    competitorNear.push(
      ...a.near.map((o) => ({ ...o, note: name, fix: "" })),
      ...c.near.map((o) => ({ ...o, note: name, fix: "" })),
    );
  }

  const prompt = `다음은 인플루언서 광고 영상에서 추출한 텍스트다. 대괄호 [숫자s]는 영상 내 등장 시각(초)이다.
"[음성 전사]" 구간에서 나온 내용은 출처를 "음성"으로, "[화면 자막/텍스트]" 구간에서 나온 내용은 출처를 "자막"으로 표시하라.
아래 캠페인 가이드라인 기준으로 이 텍스트가 규정을 준수하는지 검수하라. 브랜드명·제품명·경쟁 브랜드 언급 여부는
이미 별도 로직으로 판정을 마쳤으니 너는 신경 쓰지 않아도 된다 — 오직 USP 충족 여부와 아래 "그 외 금칙 항목"만 판단하라.

USP는 문맥을 고려해 판단하라 — 표현이 달라도 같은 의미면 충족으로 인정한다(예: "쿨링감"이 USP라면 "청량한 느낌"이라는
표현도 충족으로 인정).

"그 외 금칙 항목"을 판단할 때 아래 규칙을 순서대로, 반드시 지켜라. 이 규칙들은 예외가 아니라 판단 절차 그 자체다.

[규칙 1] 금칙 항목에 등장하는 단어가 문구에 있다고 곧바로 위반으로 표시하지 마라. 반드시 그 문장이 "실제로 나쁜
방향(불쾌·악화·발생)"을 말하는지, 아니면 "좋은 방향(개선·해소·없음)"을 말하는지부터 확인하고, 나쁜 방향일 때만
위반으로 표시한다. 좋은 방향이면 금칙 단어가 그대로 등장해도 절대 위반이 아니다.

[규칙 2] 부정어 처리: "자극감 언급"이 금칙이고 "화끈거리는 느낌"처럼 실제 불쾌감을 나타내면 위반이지만, "화끈거림
없이"처럼 부정된 표현은 위반이 아니다.

[규칙 3] 부정 접두사: "저자극", "무자극", "저자극성"은 "자극"이라는 글자가 들어있어도 자극이 없다는 좋은 방향의
주장이므로 위반이 아니다. 예: "이게 저자극인데도 두피가 편안해요" → 위반 아님.

[규칙 4] 증상 개선 표현: 금칙 항목이 "OO이 생긴다", "OO이 심해진다/떡진다"처럼 증상의 발생·악화를 금지하는
형태라면, 이는 "이 제품 때문에 그 증상이 생기거나 악화됐다"는 후기만 금지하려는 것이다. 같은 증상 단어(OO)가
나와도 "OO 개선(효과)", "OO 없이 깨끗해졌어요"처럼 좋아졌다는 방향이면 절대 위반으로 표시하지 마라. 예:
금칙이 "비듬이 생긴다, 떡진다 등의 부정적인 사용 후기 언급"일 때 — "비듬 개선 효과"는 "비듬"이라는 단어가
있어도 개선(좋은 방향)이므로 위반이 아니다. "비듬이 심해졌어요"는 악화(나쁜 방향)이므로 위반이다.

[규칙 5] 서사 구조: 인플루언서 후기는 보통 "기존 문제 → 이 제품으로 해결" 구조다. "두피에서 떨어진 비듬",
"미용실 다녀온 듯 푸석했던 머릿결"처럼 제품을 쓰기 "전"의 문제 상황을 설명하는 도입부는 부정적 언급이 아니라
긍정적 후기의 일부다. 전후 문맥에서 이 제품을 쓴 뒤 개선·해결됐다고 말하는지 확인한 뒤 판단하라.

[규칙 6] 일관성: "[음성 전사]"와 "[화면 자막/텍스트]"에 같은 취지의 문장이 반복해서 나올 수 있다(예: 음성으로
말한 내용을 자막으로도 띄우는 경우). 같은 개념·같은 방향(둘 다 개선을 말하는 등)의 문장이면 출처(음성/자막)가
다르다는 이유만으로 판정을 다르게 내리지 마라 — 규칙 1~5를 두 출처 모두에 동일하게 적용하라.

"typo"(오탈자 의심)는 아주 제한적으로만 써라 — 실제로 글자가 깨져 있어 의미를 알 수 없거나(예: 인식
오류로 나온 의미 불명의 문자 나열), 문장 자체가 한국어로 성립하지 않을 때만 typo로 표시한다. 문장이
짧거나 구어체거나 수사의문문("근데 이렇게 묽은데 씻기나?")이어도, 뜻이 통하는 정상적인 발화라면 절대
typo로 표시하지 마라.

긍정적인 관능 표현("쿨링감", "시원함", "산뜻함", "청량감" 등 — 대체로 USP로 쓰이는 좋은 의미의 표현)과 부정적인
자극/불쾌 표현("따가움", "화끈거림", "쓰라림", "붉어짐" 등)을 혼동하지 마라. 피부 감각을 묘사한다는 점만으로
자동으로 "자극적 사용감"이라고 단정하지 말고, 문장 전체의 어조(칭찬·만족 vs 불만·경고)로 판단하라. 예를 들어
"쿨링감이 짱짱!!"은 만족을 표현하는 긍정적 문장이므로 "자극적 사용감 언급" 위반이 아니다.

의미가 불분명하거나 애매한 문구만으로 단정하지 말고, 확신이 설 때만 violatedBans로 표시한다.

type이 "ban"인 occurrence는 반드시 "direction" 필드를 채워라 — 규칙 1~6에 따라 그 문장이 실제로 나쁜
방향(불쾌·악화·발생)이면 "worsen", 좋은 방향(개선·해소·없음)이거나 판단이 애매하면 "other"로 표시한다.
direction이 "other"인 항목은 위반이 아니라는 뜻이므로, 이 항목은 애초에 violatedBans에도 넣지 말고
occurrences에도 포함하지 마라 — 정말로 나쁜 방향(direction="worsen")일 때만 occurrences에 넣고
violatedBans에도 반영한다. 또한 type이 "ban"인 occurrence에는 "banText" 필드에 아래 [캠페인 가이드라인]의
"그 외 금칙 항목" 중 실제로 위반된 항목의 원문 그대로를 넣어라.

[캠페인 가이드라인]
- 필수 포함 USP: ${guideline.usps.join(", ") || "(없음)"}
- 그 외 금칙 항목: ${guideline.bans.join(", ") || "(없음)"}

[텍스트]
"""${combinedForPrompt}"""

아래 JSON 형식으로만 답하라:
{"matchedUsps":string[],"missingUsps":string[],"feedback":"한글 2~3문장","occurrences":[{"timestamp":숫자(초),"source":"음성"|"자막","quote":"실제 언급되거나 문제된 문구","type":"usp"|"ban"|"typo","note":"간단 설명(선택, 없으면 빈 문자열)","suggestion":"수정방향(선택, 없으면 빈 문자열)","direction":"worsen"|"other"(type이 "ban"일 때만, 그 외엔 빈 문자열)","banText":"위반된 금칙 항목 원문(type이 "ban"이고 direction이 "worsen"일 때만, 그 외엔 빈 문자열)"}]}
occurrences는 USP 충족, 그 외 금칙 위반(direction이 "worsen"인 경우만), 오탈자로 의심되는 부분마다 하나씩
만들어라. 해당 없으면 빈 배열로 답하라.
suggestion은 type이 "ban"(금지 사항 위반) 또는 "typo"(오탈자 의심)일 때만 채운다 — 마케터가 바로 반영할 수 있게
"이 문구를 어떻게 고치면 문제가 없어지는지" 한국어로 짧게 제안하라(예: 표현을 빼거나 다른 말로 바꾸는 구체적인 문장).
type이 "usp"(이미 충족된 USP)일 때는 고칠 게 없으니 suggestion을 빈 문자열로 둔다.`;

  const r = await fetchOpenAIWithRetry("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: "너는 인플루언서 광고 콘텐츠 가이드라인 준수 여부를 검수하는 꼼꼼한 검수자다. 반드시 JSON만 출력한다." },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
    }),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    throw new Error(`가이드라인 검수 실패 (${r.status}) ${detail.slice(0, 300)}`);
  }
  const d = await r.json();
  let parsed;
  try { parsed = JSON.parse(d.choices?.[0]?.message?.content || "{}"); }
  catch { throw new Error("검수 결과 파싱 실패"); }

  const missingUsps = Array.isArray(parsed.missingUsps) ? parsed.missingUsps : [];
  // "그 외 금칙 항목" 위반 여부는 모델이 별도로 답하는 violatedBans 배열을 그대로
  // 믿지 않고, occurrence 단위의 direction 필드로 다시 한번 걸러 직접 계산한다 —
  // 규칙 1~6을 프롬프트로만 강제해도 "비듬 개선 효과"처럼 명백히 좋은 방향인
  // 문장을 위반으로 잘못 답하는 경우가 실측으로 확인됐다. direction이 "other"
  // (개선·중립·애매함)인 후보는 애초에 위반 목록/화면 어디에도 남기지 않는다.
  //
  // direction 필드 자체도 모델이 잘못 답할 수 있어(자기 불일치가 아니라 처음부터
  // 방향을 오판하는 근본 오류), "개선/해소" 계열 표현이 문구에 그대로 있으면
  // 모델의 direction 답변과 무관하게 코드에서 한 번 더 걸러낸다.
  const POSITIVE_OVERRIDE_WORDS = ["개선", "해소", "완화", "해결", "좋아졌", "좋아지", "나아졌", "나아지"];
  const hasPositiveOverride = (quote) => POSITIVE_OVERRIDE_WORDS.some((w) => quote.includes(w));
  const llmOccurrences = Array.isArray(parsed.occurrences)
    ? parsed.occurrences
        .filter((o) => o?.type === "usp" || o?.type === "ban" || o?.type === "typo")
        .map((o) => ({
          timestamp: Number(o?.timestamp) || 0,
          source: o?.source === "자막" ? "자막" : "음성",
          quote: String(o?.quote || ""),
          type: String(o?.type || ""),
          note: String(o?.note || ""),
          fix: String(o?.suggestion || ""),
          direction: String(o?.direction || ""),
          banText: String(o?.banText || ""),
        }))
        .filter((o) => o.type !== "ban" || (o.direction === "worsen" && !hasPositiveOverride(o.quote)))
    : [];
  const contextualViolatedBans = llmOccurrences
    .filter((o) => o.type === "ban")
    .map((o) => o.banText || o.note)
    .filter(Boolean);

  // 근접 매치(정확히는 아니지만 편집거리상 가까움)만 있고 정확 매치가 없는 경우도
  // "언급됨"으로 인정한다 — 화면에 정확히 쓰여 있는데 우리 OCR이 오독했을 가능성이
  // 있는 상태에서 자동으로 반려시키면 안 된다. 근접 매치는 자동 판정에 영향을 주지
  // 않고 needsReview 배지로만 마케터에게 확인을 맡긴다. 반대로 확실한 정확 매치도,
  // 근접 매치도 전혀 없을 때만 "언급 안 됨"으로 취급해 반려에 반영한다.
  const brandMentioned = brandExact.length > 0 || brandNear.length > 0;
  const productMentioned = productExact.length > 0 || productNear.length > 0;
  // 경쟁 브랜드는 반대 방향으로 보수적이다 — 확실한 정확 매치만 위반으로 취급하고,
  // 근접 매치(오독일 수도 있음)는 위반으로 단정하지 않고 확인 필요 배지로만 남긴다.
  const violatedBans = [...competitorExact.map((o) => o.note), ...contextualViolatedBans];

  const occurrences = [
    ...brandExact,
    ...brandNear,
    ...productExact,
    ...productNear,
    ...competitorExact.map((o) => ({ ...o, note: `타 브랜드 언급 (${o.note})` })),
    ...competitorNear.map((o) => ({ ...o, note: `근접 표기 — 실제 위반인지 확인 필요 (${o.note})` })),
    ...llmOccurrences,
  ].sort((a, b) => a.timestamp - b.timestamp);

  const result =
    brandMentioned && productMentioned && missingUsps.length === 0 && violatedBans.length === 0
      ? "통과"
      : "반려";

  return {
    result,
    brandMentioned,
    productMentioned,
    matchedUsps: Array.isArray(parsed.matchedUsps) ? parsed.matchedUsps : [],
    missingUsps,
    violatedBans,
    feedback: String(parsed.feedback || ""),
    occurrences,
    reviewNeeded: occurrences.some((o) => o.needsReview),
  };
}

/* ───────────── 3. 화면 자막 OCR: Tesseract 1차 필터 + GPT-4o 정밀검증 ───────────── */

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/* Tesseract worker는 초기화가 무거워서 프로세스당 하나만 만들어 재사용한다. */
let tesseractWorkerPromise = null;
function getTesseractWorker() {
  if (!tesseractWorkerPromise) {
    const cachePath = path.join(os.tmpdir(), "reelcheck-tesseract-cache");
    tesseractWorkerPromise = fs
      .mkdir(cachePath, { recursive: true })
      .then(() =>
        createWorker("kor+eng", 1, {
          // 기본값(현재 작업 디렉터리)에 언어 데이터가 다운로드되어 저장소에 실수로
          // 커밋되는 걸 막기 위해 임시 디렉터리로 캐시 경로를 명시한다.
          cachePath,
        }),
      )
      .then(async (worker) => {
        // 기본 PSM(문서 전체 자동 분석)은 자막처럼 화면 여기저기 흩어진 짧은
        // 텍스트에는 잘 안 맞는다 — 흩어진 텍스트를 읽는 모드로 바꾼다.
        await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
        return worker;
      });
  }
  return tesseractWorkerPromise;
}

/* 프레임마다 Tesseract로 텍스트만 빠르게 뽑는다. 실패한 프레임은 빈 텍스트로 넘어간다. */
async function ocrFramesTesseract(frames) {
  if (!frames.length) return [];
  const worker = await getTesseractWorker();
  const results = [];
  for (const f of frames) {
    try {
      const { data } = await worker.recognize(f.dataUrl);
      results.push({ t: f.t, text: (data.text || "").trim(), confidence: data.confidence ?? 0 });
    } catch {
      results.push({ t: f.t, text: "", confidence: 0 });
    }
  }
  return results;
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

/* 오탈자/우회 표기(예: "화 학 성 분")까지 잡기 위한 편집거리 기반 유사 포함 검사.
 * phrase 길이 ± maxDist 범위의 모든 부분 문자열을 실제로 비교한다 — 고정
 * 오프셋 윈도우만 보면 문장 중간 임의 위치에 있는 오독 문구를 놓칠 수 있다
 * (브랜드/제품명이 짧은 문구 하나가 아니라 긴 문장 속 어딘가에 등장하는
 * 실제 자막/음성 텍스트를 스캔해야 하는 용도이므로 정확도가 중요하다). */
function fuzzyContains(text, phrase, maxRatio = 0.3, minDist = 1) {
  if (!text || !phrase) return false;
  if (text.includes(phrase)) return true;
  const maxDist = Math.max(minDist, Math.floor(phrase.length * maxRatio));
  for (let len = Math.max(1, phrase.length - maxDist); len <= phrase.length + maxDist; len++) {
    for (let i = 0; i + len <= text.length; i++) {
      if (levenshtein(text.slice(i, i + len), phrase) <= maxDist) return true;
    }
  }
  return false;
}

/* 릴스 자막은 보통 같은 문구가 여러 프레임에 걸쳐 그대로 유지된다 — 그런
 * 프레임을 전부 따로 검증하면 사실상 같은 걸 여러 번 확인하는 셈이라
 * 낭비다. 텍스트가 사실상 동일한 프레임은 하나만 남긴다. */
function dedupeByText(frames) {
  const seen = [];
  const out = [];
  for (const f of frames) {
    const norm = (f.text || "").replace(/\s+/g, "");
    if (!norm) {
      out.push(f);
      continue;
    }
    const isDup = seen.some(
      (s) => s === norm || levenshtein(s, norm) <= Math.max(1, Math.floor(norm.length * 0.15)),
    );
    if (isDup) continue;
    seen.push(norm);
    out.push(f);
  }
  return out;
}

/* 1차 필터: 금칙어 의심 단어가 걸렸거나, Tesseract 신뢰도가 낮아 오인식이 의심되는
 * 프레임을 골라낸다. 금칙어 의심은 실제 위반 신호라 전부 검증하지만, 단순 저신뢰
 * (영상 자체가 인식하기 어려워서 그런 경우가 대부분)는 상위 몇 개로만 제한한다 —
 * 안 그러면 프레임 대부분이 여기 걸리는 영상에서 GPT-4o Vision 호출이 한꺼번에
 * 몰려 계정 분당 토큰 한도(TPM)를 넘어버리고, 그러면 동시 호출 수를 줄이거나
 * 재시도를 늘려도 소용이 없다(전체 요청량 자체가 한도를 넘기 때문). 중복 제거로
 * 확보한 여유는 해상도(정확도)를 올리는 데 쓴다 — verifySuspiciousVision 참고. */
const MAX_LOW_CONFIDENCE_VERIFY = 8;

function findSuspiciousFrames(zipped, bans, ownNames) {
  const cleanBans = (bans || []).filter(Boolean);
  const cleanOwnNames = (ownNames || []).filter(Boolean);
  const banMatches = [];
  const ownNameNearMiss = [];
  const lowConfidence = [];
  for (const r of zipped) {
    if (!r.text) continue;
    const normText = r.text.replace(/\s+/g, "");
    if (cleanBans.some((b) => fuzzyContains(r.text, b))) {
      banMatches.push(r);
    } else if (
      // 우리 브랜드/제품명이 정확히는 아니지만 근접하게 읽힌 프레임 —
      // Tesseract가 우리 이름 자체를 오독한 것일 수 있어, "확인 필요" 배지로
      // 남겨두는 대신 여기서 Vision으로 실제로 뭐라고 쓰여있는지 확인한다.
      // (등록된 브랜드/제품명을 이미 정확히 읽었다면 여기 걸릴 이유가 없다.)
      cleanOwnNames.some((n) => {
        const normName = n.replace(/\s+/g, "");
        return normName && !normText.includes(normName) && fuzzyContains(normText, normName, 0.3, 2);
      })
    ) {
      ownNameNearMiss.push(r);
    } else if (r.confidence < 60) {
      lowConfidence.push(r);
    }
  }
  // 금칙어 의심(ban)·브랜드/제품명 오독 의심(ownName)은 실제 위반이거나
  // 정확도가 중요한 신호라 전부 고해상도로, 단순 저신뢰(lowConfidence)는
  // 대부분 노이즈고 오독이 나와도 "확인 필요" 배지 + 보수적 판정 프롬프트가
  // 안전망이 되어주니 저해상도로 — 검증 비용(TPM)을 위험도에 맞게 차등
  // 배분한다. verifySuspiciousVision 참고.
  const dedupedBans = dedupeByText(banMatches).map((f) => ({ ...f, reason: "ban" }));
  const dedupedOwnName = dedupeByText(ownNameNearMiss).map((f) => ({ ...f, reason: "ownName" }));
  const dedupedLow = dedupeByText(lowConfidence)
    .sort((a, b) => a.confidence - b.confidence)
    .map((f) => ({ ...f, reason: "lowConfidence" }));
  const capped = dedupedLow.slice(0, MAX_LOW_CONFIDENCE_VERIFY);
  if (dedupedLow.length > capped.length) {
    console.warn(
      `[자막 검수] 저신뢰 프레임 ${dedupedLow.length}개(중복 제거 후) 중 ${capped.length}개만 정밀검증 (나머지는 건너뜀)`,
    );
  }
  return [...dedupedBans, ...dedupedOwnName, ...capped];
}

/* 2차 정밀검증: 의심 프레임만 GPT-4o 비전으로 보내 오탈자/오인식인지 실제 위반인지 판정한다. */
async function verifySuspiciousVision(frames, bans, ownNames) {
  const key = process.env.OPENAI_API_KEY;
  if (!key || !frames.length) return [];
  const model = process.env.OCR_MODEL || "gpt-4o-mini";
  const banList = (bans || []).filter(Boolean).join(", ") || "(지정된 금칙어 없음)";
  const ownNameList = (ownNames || []).filter(Boolean).join(", ");

  // 의심 프레임이 많으면(예: 60장 중 56장) 동시에 5개씩 쏘는 것만으로도
  // 계정 분당 토큰 한도(TPM)를 순식간에 다 써버려서, 재시도로도 못 버틸 만큼
  // 429가 몰린다. 동시 호출을 줄여 소모 속도를 늦춘다.
  return mapWithConcurrency(frames, 2, async (f) => {
    try {
      // ownName 프레임은 금칙어 위반 여부가 아니라 "우리 브랜드/제품명을
      // 정확히 뭐라고 썼는지"가 궁금한 경우라 질문 자체를 다르게 한다 —
      // 그래도 반환 형식(JSON 스키마)은 같게 유지해 아래 처리 로직을 그대로 쓴다.
      const prompt = f.reason === "ownName"
        ? `이 이미지의 자막에 브랜드/제품명(${ownNameList})이 실제로 어떻게 쓰여있는지 확인해라.
로컬 OCR(Tesseract)이 이 프레임에서 "${f.text}"라고 읽었는데, 등록된 브랜드/제품명과 정확히 일치하지 않아 오독일 가능성이 있다. 이미지를 직접 보고 실제 정확한 텍스트를 확인해라.
아래 JSON 형식으로만 답하라: {"correctedText":"이미지에 실제로 보이는 텍스트를 있는 그대로 적어라. 읽을 수 있는 글자가 전혀 없으면 빈 문자열 \"\"로 답하라(설명을 쓰지 마라).","violates":false,"matchedBan":null}`
        : `이 이미지의 자막에서 다음 금칙어 목록 위반 소지가 있는지 검수해라: ${banList}.
로컬 OCR(Tesseract)이 이 프레임에서 "${f.text}"라고 읽었다. 이게 실제로 금칙어를 포함한 문맥인지, 아니면 OCR의 오인식/오탈자인지 이미지를 직접 보고 판단해라.
아래 JSON 형식으로만 답하라: {"correctedText":"이미지에 실제로 보이는 텍스트를 있는 그대로 적어라. 읽을 수 있는 글자가 전혀 없으면 빈 문자열 \"\"로 답하라(설명을 쓰지 마라).","violates":boolean,"matchedBan":"위반한 금칙어 또는 null"}`;
      const r = await fetchOpenAIWithRetry("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                // 저신뢰(노이즈) 프레임은 detail:"low"로 토큰을 아낀다 — 이 프레임들만
                // 8개(중복 제거 후 상한)로도 기본 해상도 기준 분당 토큰 한도를 다 써서
                // 이어지는 최종 판정 호출까지 429로 막히는 사례를 실측으로 확인했다.
                // 반대로 금칙어 의심(ban)은 실제 위반일 수 있어 판독력이 중요하므로
                // 기본 해상도를 유지한다. 저신뢰 프레임의 오독은 "확인 필요" 배지와
                // 보수적 판정 프롬프트가 안전망 역할을 한다.
                {
                  type: "image_url",
                  image_url: f.reason === "lowConfidence" ? { url: f.dataUrl, detail: "low" } : { url: f.dataUrl },
                },
              ],
            },
          ],
          response_format: { type: "json_object" },
          temperature: 0,
        }),
      });
      if (!r.ok) return { t: f.t, correctedText: f.text, violates: false, matchedBan: null };
      const d = await r.json();
      const parsed = JSON.parse(d.choices?.[0]?.message?.content || "{}");
      return {
        t: f.t,
        // 모델이 "필드를 아예 안 줌"과 "읽을 텍스트가 없어서 빈 문자열로 답함"을
        // 구분해야 한다 — ||로 합치면 명시적 빈 문자열까지 f.text로 되돌아가서
        // 아래 buildOcrSummary의 "텍스트 없음" 판정이 무력화된다.
        correctedText: typeof parsed.correctedText === "string" ? parsed.correctedText : f.text,
        violates: Boolean(parsed.violates),
        matchedBan: parsed.matchedBan || null,
      };
    } catch {
      return { t: f.t, correctedText: f.text, violates: false, matchedBan: null };
    }
  });
}

/* Tesseract 텍스트 전체(USP/브랜드 매칭용) + 검증된 의심 프레임 판정을 합쳐서 최종 검수용 요약을 만든다. */
function buildOcrSummary(zipped, verifications) {
  const verByT = new Map(verifications.map((v) => [v.t, v]));
  const lines = [];
  for (const r of zipped) {
    if (!r.text) continue;
    const v = verByT.get(r.t);
    if (v) {
      // v.correctedText가 빈 문자열이면 Vision이 이 프레임에서 실제로 읽을 수
      // 있는 텍스트가 없다고 답한 것 — 줄 자체를 건너뛴다. 예전엔 이 경우에도
      // "OCR 오인식/오탈자로 확인됨" 같은 내부 판정 문구를 그대로 캡션 텍스트에
      // 섞어 넣어서, 하류 LLM이 그 문장 자체를 화면 자막으로 착각해 "의미불명
      // 오탈자"로 오판하는 사고로 이어졌다(Vision이 아예 답을 못 찾을 때
      // "이미지에 텍스트가 없습니다" 식으로 즉흥적으로 설명을 쓰는 경우도 마찬가지).
      const text = v.correctedText.trim();
      if (text) {
        lines.push(v.violates ? `[${r.t}s] ${text} (금칙어 위반 확인됨: ${v.matchedBan})` : `[${r.t}s] ${text}`);
      }
    } else {
      lines.push(`[${r.t}s] ${r.text}`);
    }
  }
  return lines.join("\n");
}

/* ───────────── 라우트 ───────────── */

const fail = (res, e) => {
  const msg = String(e?.message || e);
  const notFound = /ENOENT|not found|not recognized/i.test(msg);
  res.status(notFound ? 503 : 500).json({
    error: notFound
      ? "서버에 ffmpeg 또는 crv가 설치되지 않았습니다. README의 설치 단계를 확인해주세요."
      : msg,
  });
};

app.get("/api/health", async (_req, res) => {
  const check = async (bin, args) => {
    try { await run(bin, args); return true; } catch { return false; }
  };
  res.json({
    ffmpeg: await check("ffmpeg", ["-version"]),
    ffprobe: await check("ffprobe", ["-version"]),
    crv: await check(CRV_BIN, ["--help"]),
    openaiKey: Boolean(process.env.OPENAI_API_KEY),
    supabase: Boolean(supabase),
    r2: Boolean(r2),
    sttModel: STT_MODEL,
  });
});

/* ───────────── 로그인 / 권한 ─────────────
 * 프론트에 구글 스크립트를 전혀 불러오지 않는다("외부 CDN 스크립트 일절
 * 없음" 정책 준수) — 로그인 버튼은 그냥 아래 /start 주소로 이동만 하고,
 * 구글과의 실제 교환은 서버 대 서버로만 이뤄진다. */

/* state를 짧게 사는 쿠키에도 심어둔다 — 콜백에서 쿼리의 state와 대조해
 * 이 로그인 시도가 정말 우리 /start에서 시작된 게 맞는지 확인한다. */
app.get("/api/auth/google/start", (_req, res) => {
  const state = generateOAuthState();
  res.cookie("oauth_state", state, { ...sessionCookieOptions(), maxAge: OAUTH_STATE_MAX_AGE_MS });
  try {
    res.redirect(buildGoogleAuthUrl(state));
  } catch (e) {
    res.status(503).send(e.message);
  }
});

app.get("/api/auth/google/callback", requireSupabase, async (req, res) => {
  const { code, state } = req.query;
  const savedState = req.cookies?.oauth_state;
  res.clearCookie("oauth_state", sessionCookieOptions());

  if (!code || !state || state !== savedState) {
    return res.redirect(`${ALLOW_ORIGIN}/?authError=invalid_request`);
  }
  let email;
  try {
    email = await exchangeCodeForEmail(code);
  } catch (e) {
    console.error("[구글 로그인] code 교환 실패:", e.message);
    return res.redirect(`${ALLOW_ORIGIN}/?authError=google_failed`);
  }
  const access = await resolveAccess(email, supabase);
  if (!access) {
    return res.redirect(`${ALLOW_ORIGIN}/?authError=not_whitelisted`);
  }
  const token = signSessionToken(email);
  res.cookie("session", token, { ...sessionCookieOptions(), maxAge: SESSION_MAX_AGE_MS });
  res.redirect(ALLOW_ORIGIN);
});

app.post("/api/auth/logout", (_req, res) => {
  res.clearCookie("session", sessionCookieOptions());
  res.json({ ok: true });
});

app.get("/api/auth/me", requireAuth, requireSupabase, async (req, res) => {
  const access = await resolveAccess(req.user.email, supabase);
  if (!access) return res.status(403).json({ error: "등록되지 않은 계정입니다." });
  res.json({ email: req.user.email, ...access });
});

/* requireCampaignAccess에 넘기는 campaign_id 조회 함수들. 클라이언트가 보낸
 * campaignId를 그대로 믿지 않고, influencerId가 있는 요청은 항상 DB에서
 * 그 인플루언서가 실제로 속한 캠페인을 역조회한다(위조 방지). */
const campaignIdFromParams = async (req) => req.params.id;
const campaignIdFromInfluencerIdParam = async (req, sb) => {
  const { data } = await sb.from("reelcheck_influencers").select("campaign_id").eq("id", req.params.id).maybeSingle();
  return data?.campaign_id || null;
};
const campaignIdFromInfluencerIdBody = async (req, sb) => {
  const { data } = await sb
    .from("reelcheck_influencers")
    .select("campaign_id")
    .eq("id", req.body?.influencerId)
    .maybeSingle();
  return data?.campaign_id || null;
};

/* ───────────── 캠페인 / 인플루언서 (Supabase) ───────────── */

app.get("/api/campaigns", requireSupabase, requireAuth, async (req, res) => {
  const access = await resolveAccess(req.user.email, supabase);
  if (!access) return res.status(403).json({ error: "접근 권한이 없습니다." });

  let query = supabase.from("reelcheck_campaigns").select("*").order("created_at", { ascending: false });
  if (access.role === "agency") {
    // 화이트리스트된 캠페인이 하나도 없을 수 있다 — 그 경우 in()에 빈
    // 배열을 넘기는 대신 절대 존재할 수 없는 id로 대체해 "0건"을 확실히 한다.
    const ids = access.campaignIds.length ? access.campaignIds : ["00000000-0000-0000-0000-000000000000"];
    query = query.in("id", ids);
  }
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get("/api/campaigns/:id/agencies", requireSupabase, requireAuth, requireMarketer(supabase), async (req, res) => {
  const { data, error } = await supabase
    .from("reelcheck_campaign_agencies")
    .select("email, created_at")
    .eq("campaign_id", req.params.id)
    .order("created_at", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post("/api/campaigns/:id/agencies", requireSupabase, requireAuth, requireMarketer(supabase), async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!email) return res.status(400).json({ error: "이메일을 입력해주세요." });
  const { data, error } = await supabase
    .from("reelcheck_campaign_agencies")
    .upsert({ campaign_id: req.params.id, email })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete("/api/campaigns/:id/agencies/:email", requireSupabase, requireAuth, requireMarketer(supabase), async (req, res) => {
  const email = decodeURIComponent(req.params.email).trim().toLowerCase();
  const { error } = await supabase
    .from("reelcheck_campaign_agencies")
    .delete()
    .eq("campaign_id", req.params.id)
    .eq("email", email);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

const monthDate = (year, month) => {
  const y = Number(year);
  const m = Number(month);
  if (!y || !m || m < 1 || m > 12) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-01`;
};

app.post("/api/campaigns", requireSupabase, requireAuth, requireMarketer(supabase), async (req, res) => {
  const { advertiser, name, startDate, endDate, startYear, startMonth, endMonth, manager, brand, product, usps, bans, competitorBrands, brandAudioAliases, productAudioAliases } = req.body || {};
  if (!advertiser || !name) {
    return res.status(400).json({ error: "광고주명과 프로젝트명은 필수입니다." });
  }
  const { data, error } = await supabase
    .from("reelcheck_campaigns")
    .insert({
      advertiser,
      name,
      start_date: startDate || monthDate(startYear, startMonth),
      end_date: endDate || monthDate(startYear, endMonth),
      manager: manager || null,
      brand: brand || "",
      product: product || "",
      usps: Array.isArray(usps) ? usps : [],
      bans: Array.isArray(bans) ? bans : [],
      competitor_brands: Array.isArray(competitorBrands) ? competitorBrands : [],
      brand_audio_aliases: Array.isArray(brandAudioAliases) ? brandAudioAliases : [],
      product_audio_aliases: Array.isArray(productAudioAliases) ? productAudioAliases : [],
    })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put("/api/campaigns/:id", requireSupabase, requireAuth, requireMarketer(supabase), async (req, res) => {
  const { advertiser, name, startDate, endDate, manager, brand, product, usps, bans, competitorBrands, brandAudioAliases, productAudioAliases } = req.body || {};
  const patch = {};
  if (advertiser !== undefined) patch.advertiser = advertiser;
  if (name !== undefined) patch.name = name;
  if (startDate !== undefined) patch.start_date = startDate || null;
  if (endDate !== undefined) patch.end_date = endDate || null;
  if (manager !== undefined) patch.manager = manager;
  if (brand !== undefined) patch.brand = brand;
  if (product !== undefined) patch.product = product;
  if (usps !== undefined) patch.usps = usps;
  if (bans !== undefined) patch.bans = bans;
  if (competitorBrands !== undefined) patch.competitor_brands = competitorBrands;
  if (brandAudioAliases !== undefined) patch.brand_audio_aliases = brandAudioAliases;
  if (productAudioAliases !== undefined) patch.product_audio_aliases = productAudioAliases;

  const { data, error } = await supabase
    .from("reelcheck_campaigns")
    .update(patch)
    .eq("id", req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get(
  "/api/campaigns/:id/influencers",
  requireSupabase,
  requireAuth,
  requireCampaignAccess(supabase, campaignIdFromParams),
  async (req, res) => {
    const { data, error } = await supabase
      .from("reelcheck_influencers")
      .select("*")
      .eq("campaign_id", req.params.id)
      .order("created_at", { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  },
);

/* 엑셀 대량 업로드 → 해당 캠페인의 기존 명단을 통째로 교체 */
app.post(
  "/api/campaigns/:id/influencers/bulk",
  requireSupabase,
  requireAuth,
  requireMarketer(supabase),
  async (req, res) => {
  const campaignId = req.params.id;
  const list = Array.isArray(req.body?.influencers) ? req.body.influencers : [];

  const del = await supabase.from("reelcheck_influencers").delete().eq("campaign_id", campaignId);
  if (del.error) return res.status(500).json({ error: del.error.message });
  if (!list.length) return res.json([]);

  const rows = list.map((inf) => ({
    campaign_id: campaignId,
    // 이름은 더 이상 수집하지 않는다 — name 컬럼이 NOT NULL 제약을 가질 수
    // 있어 안전하게 핸들로 대체한다(화면에는 노출되지 않음).
    name: inf.name || inf.handle || "",
    handle: inf.handle,
    status: "미제출",
    result: "-",
  }));
  const { data, error } = await supabase.from("reelcheck_influencers").insert(rows).select();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  },
);

app.get(
  "/api/influencers/:id",
  requireSupabase,
  requireAuth,
  requireCampaignAccess(supabase, campaignIdFromInfluencerIdParam),
  async (req, res) => {
    const { data, error } = await supabase
      .from("reelcheck_influencers")
      .select("*")
      .eq("id", req.params.id)
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  },
);

/* 마케터가 원본 영상을 재생해볼 수 있도록, R2에 남겨둔 영상의 임시 재생
 * URL을 발급한다. 마케터가 최종 "통과" 판정을 내리면 영상 자체가
 * 삭제되므로(아래 PATCH 참고) 그 전까지만 유효하다. */
app.get(
  "/api/influencers/:id/video-url",
  requireSupabase,
  requireR2,
  requireAuth,
  requireCampaignAccess(supabase, campaignIdFromInfluencerIdParam),
  async (req, res) => {
    const { data, error } = await supabase
      .from("reelcheck_influencers")
      .select("video_path")
      .eq("id", req.params.id)
      .single();
    if (error) return res.status(500).json({ error: error.message });
    if (!data?.video_path) return res.status(404).json({ error: "보관된 영상이 없습니다." });
    try {
      const url = await getSignedUrl(r2, new GetObjectCommand({ Bucket: R2_BUCKET, Key: data.video_path }), {
        expiresIn: 3600,
      });
      res.json({ url });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

/* 실제로는 saveMarketerFeedback(frontend/src/index.js) 한 곳에서만
 * feedback/marketerResult 필드로 호출된다 — 사실상 마케터가 최종 판정을
 * 남기는 전용 라우트라, 이름을 명시하고 처리 필드도 그 용도로 좁힌다. */
app.patch(
  "/api/influencers/:id/marketer-result",
  requireSupabase,
  requireAuth,
  requireMarketer(supabase),
  async (req, res) => {
  const { feedback, review, marketerResult } = req.body || {};
  const patch = {};
  if (feedback !== undefined) patch.feedback = feedback;
  if (review !== undefined) patch.review = review;
  if (marketerResult !== undefined) patch.marketer_result = marketerResult;

  const { data, error } = await supabase
    .from("reelcheck_influencers")
    .update(patch)
    .eq("id", req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  // 마케터가 최종 "통과" 판정을 내리면, 더 이상 원본 영상을 보관할 이유가
  // 없다 — 스토리지에서 지우고 참조도 비운다.
  if (marketerResult === "통과" && r2 && data?.video_path) {
    const stalePath = data.video_path;
    r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: stalePath }))
      .then(() =>
        supabase.from("reelcheck_influencers").update({ video_path: null }).eq("id", req.params.id),
      )
      .catch((e) => console.warn(`[R2] 통과 처리 후 영상 삭제 실패: ${e.message}`));
    data.video_path = null;
  }

    res.json(data);
  },
);

/*
 * 화면 자막 검수는 crv 스캔 + Tesseract + (의심 프레임만) GPT-4o 검증까지 거치면
 * 오래 걸릴 수 있어 Cloudflare/Render의 응답 대기 한도(~100초)를 넘길 수 있다.
 * 그래서 음성 검수 결과는 즉시 응답하고, 화면 자막 검수는 응답 이후 백그라운드에서
 * 계속 진행해 끝나면 Supabase의 해당 인플루언서 행을 갱신한다.
 */
async function continueOcrInBackground({ videoPath, influencerId, campaign, audioText, audioReview }) {
  const t0 = Date.now();
  const timings = {};

  // 화면 자막 검수가 어디서 실패하든(키프레임 추출/OCR/API 요청 한도 등) 여기서 반드시
  // "검수완료"로 확정해야 한다. 안 그러면 프론트엔드가 "검수완료(음성)" 상태에서 폴링을
  // 계속하다가 조용히 멈춰버려서, 사용자에게는 원인 모를 무한 대기로 보인다.
  // 이미 1단계에서 저장해둔 음성 기준 결과가 있으니 그걸 최종 결과로 그대로 확정한다.
  const finalizeAsAudioOnly = async (reason) => {
    console.warn(`[백그라운드] 화면 자막 검수 중단 (${reason}) — 음성 기준 결과로 확정합니다.`);
    if (supabase && influencerId) {
      const patch = { status: "검수완료" };
      // caption을 null로 남겨두면 프론트가 "아직 진행 중"으로 오인한다 — 이미
      // 최종 상태(검수완료)로 확정되는 것이므로, 실패했다는 사실 자체를 명시한다.
      if (audioReview && !audioReview.error) {
        patch.review = { ...audioReview, audio: audioReview, caption: { failed: true, reason } };
      }
      await supabase
        .from("reelcheck_influencers")
        .update(patch)
        .eq("id", influencerId)
        .then(() => {}, () => {});
    }
  };

  try {
    let frames = [];
    let ocrResults = [];
    try {
      // 키프레임 추출과 OCR을 한 CPU 슬롯 안에서 순서대로 처리한다(위
      // withCpuSlot 설명 참고) — 30개가 몰려도 실제로 CPU를 쓰는 시점은
      // 항상 1~2개 영상으로 제한된다.
      await withCpuSlot(async () => {
        const kf = await keyframes(videoPath, { maxFrames: 60 });
        frames = kf.frames;
        timings.keyframesMs = Date.now() - t0;
        timings.frameCount = frames.length;
        if (!frames.length) return;

        const t1 = Date.now();
        ocrResults = await ocrFramesTesseract(frames);
        timings.tesseractMs = Date.now() - t1;
      });
    } catch (e) {
      await finalizeAsAudioOnly(`화면 자막 분석 실패: ${e.message}`);
      return;
    }
    if (!frames.length) {
      await finalizeAsAudioOnly("추출된 프레임 없음");
      return;
    }

    const zipped = frames.map((f, i) => ({ ...f, ...ocrResults[i] }));

    // 프레임을 정밀검증(Vision) 대상으로 고를 땐 경쟁 브랜드명 목록과 우리
    // 브랜드/제품명 근접 오독을 본다 — "그 외 금칙 항목"은 문맥 판단이
    // 필요해 프레임 단위가 아니라 전체 텍스트 단위로(reviewAgainstGuidelines)
    // 판단한다.
    const suspicious = findSuspiciousFrames(zipped, campaign.competitorBrands, [campaign.brand, campaign.product]);
    timings.suspiciousCount = suspicious.length;

    const t2 = Date.now();
    const verifications = suspicious.length
      ? await verifySuspiciousVision(suspicious, campaign.competitorBrands, [campaign.brand, campaign.product])
      : [];
    timings.visionVerifyMs = Date.now() - t2;

    const ocrSummary = buildOcrSummary(zipped, verifications);
    const captionText = ocrSummary || "(감지된 텍스트 없음)";

    const t3 = Date.now();
    // 종합 판정(음성+자막)과 자막 단독 판정을 순차로 구한다. 직전 비전 검증
    // 호출들로 분당 토큰 한도가 거의 소진된 상태라, 큰 요청 2개를 동시에
    // 쏘면(Promise.all) 예산이 회복될 새 없이 둘 다 429로 실패해 자막 검수
    // 전체가 무산되는 사례가 있었다 — 순차 실행으로 순간 최대 요청량을
    // 절반으로 줄인다. 음성 단독 판정은 1단계에서 이미 계산해둔 것을 그대로
    // 쓴다(중복 호출 방지).
    const combinedReview = await reviewAgainstGuidelines({ audioText, captionText }, campaign);
    const captionReview = ocrSummary
      ? await reviewAgainstGuidelines({ captionText }, campaign)
      : {
          result: "반려",
          brandMentioned: false,
          productMentioned: false,
          matchedUsps: [],
          missingUsps: campaign.usps || [],
          violatedBans: [],
          feedback: "화면에서 인식된 자막이 없습니다.",
          occurrences: [],
        };
    timings.finalReviewMs = Date.now() - t3;
    timings.totalMs = Date.now() - t0;

    console.log("[백그라운드 타이밍]", JSON.stringify(timings));

    if (supabase && influencerId) {
      await supabase
        .from("reelcheck_influencers")
        .update({
          status: "검수완료",
          result: combinedReview.result,
          feedback: combinedReview.feedback,
          transcript: audioText,
          // _timingsMs는 병목 진단용 임시 디버그 필드 (프론트엔드는 사용하지 않음)
          review: {
            ...combinedReview,
            audio: audioReview || null,
            caption: captionReview,
            _timingsMs: timings,
          },
        })
        .eq("id", influencerId);
    }
  } catch (e) {
    console.log("[백그라운드 타이밍 (실패 전까지)]", JSON.stringify(timings));
    await finalizeAsAudioOnly(`오류: ${e.message}`);
  } finally {
    fs.rm(videoPath, { force: true }).catch(() => {});
  }
}

/* 업로드 경로(멀티파트 직접 업로드 / 스토리지 경유)와 무관하게, 로컬 디스크에
 * 영상 파일이 준비된 이후의 검수 로직은 완전히 동일하다. */
/* 음성 판정까지만 하고 반환한다(자막은 continueOcrInBackground가 이어서 담당).
 * 호출부가 res.json으로 바로 응답하든, 백그라운드에서 Supabase만 갱신하든
 * 선택할 수 있도록 res를 직접 건드리지 않고 결과 객체를 그대로 돌려준다. */
async function processUploadedVideo({ videoPath, influencerId, campaign }) {
  // 음성 전사(Whisper API 호출, 네트워크 대기)와 화면 자막용 저해상도 압축(로컬 CPU)을
  // 동시에 진행한다 — 압축이 Whisper 응답을 기다리는 시간에 "묻혀서" 거의 공짜가 된다.
  const [result, proxy] = await Promise.all([
    transcribe(videoPath),
    withCompressionSlot(() => compressForOcr(videoPath)).catch((e) => {
      console.warn(`[다운샘플링] 압축 실패, 원본으로 대체: ${e.message}`);
      return null;
    }),
  ]);
  const ocrVideoPath = proxy?.path || videoPath;
  if (proxy) fs.rm(videoPath, { force: true }).catch(() => {}); // 압축 성공했으면 원본은 더 필요 없음

  // 마케터가 최종 판정 전까지 원본과 대조해볼 수 있도록, 위에서 만든 프록시를
  // 재생용으로 R2에 올려둔다(추가 인코딩 없음). 압축이 실패해 프록시가 없으면
  // (원본 그대로 OCR을 진행하는 드문 경우) 재생용 업로드는 건너뛴다 — 원본은
  // 용량·포맷 문제가 재발할 수 있어서 그대로 올리지 않는다.
  let videoPathForPlayback = null;
  if (r2 && influencerId && proxy) {
    try {
      const buf = await fs.readFile(ocrVideoPath);
      const reviewKey = `${UPLOADS_PREFIX}review-${influencerId}-${Date.now()}.mp4`;
      await r2.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: reviewKey, Body: buf, ContentType: "video/mp4" }));
      videoPathForPlayback = reviewKey;
    } catch (e) {
      console.warn(`[R2] 재생용 영상 업로드 실패: ${e.message}`);
    }
  }

  const audioTimestamped = formatTimestampedSegments(result.segments) || result.text;

  let audioReview = null;
  if (campaign) {
    try {
      audioReview = await reviewAgainstGuidelines({ audioText: audioTimestamped }, campaign);
    } catch (e) {
      console.error("[1단계] 음성 기준 가이드라인 검수 실패:", e.message || e);
      audioReview = { error: String(e.message || e) };
    }
  }

  const canContinue = Boolean(campaign && !audioReview?.error && influencerId);
  // 종합/음성 탭을 나눠 보여줄 수 있게, 1단계에서는 음성 판정을 audio로 담아둔다.
  // 자막(caption)은 2단계가 끝나야 나오므로 아직 null.
  const review = audioReview?.error
    ? audioReview
    : audioReview
      ? { ...audioReview, audio: audioReview, caption: null }
      : null;

  if (supabase && influencerId) {
    // 핵심 필드(status/result/feedback 등) 저장은 이 한 번의 업데이트가
    // 반드시 성공해야 한다 — audio_done_at처럼 부가적인 진단용 필드를 같은
    // 요청에 같이 넣으면, 그 컬럼이 아직 없을 때(예: 마이그레이션 누락)
    // PostgREST가 요청 전체를 실패시켜서 핵심 필드까지 저장이 안 되는
    // 사고로 이어질 수 있다 — 그래서 별도 요청으로 분리한다.
    await supabase
      .from("reelcheck_influencers")
      .update({
        status: canContinue ? "검수완료(음성)" : "검수완료",
        result: review?.result || "-",
        feedback: review?.feedback || "",
        transcript: result.text,
        review,
        ...(videoPathForPlayback ? { video_path: videoPathForPlayback } : {}),
      })
      .eq("id", influencerId)
      .then(() => {}, () => {});

    // 자막 검수가 백그라운드로 넘어가는 시점을 남겨둔다 — 서버가 재시작/
    // 크래시되면 이 시점 이후로 아무 진행도 없을 텐데, 그걸 감지하는 데
    // 쓴다(finalizeStuckCaptionJobs 참고). 실패해도(컬럼 누락 등) 위 핵심
    // 업데이트에는 영향 없다.
    if (canContinue) {
      supabase
        .from("reelcheck_influencers")
        .update({ audio_done_at: new Date().toISOString() })
        .eq("id", influencerId)
        .then(({ error }) => {
          if (error) console.warn(`[audio_done_at 기록 실패] ${error.message}`);
        });
    }
  }

  if (canContinue) {
    continueOcrInBackground({
      videoPath: ocrVideoPath,
      influencerId,
      campaign,
      audioText: audioTimestamped,
      audioReview,
    }).catch((e) => {
      console.error("[백그라운드] 화면 자막 검수 실패:", e);
    });
  } else {
    fs.rm(ocrVideoPath, { force: true }).catch(() => {});
  }

  return { ...result, ocrPending: canContinue, review };
}

/* 화면(마케터/에이전시 UI)에서는 쓰지 않는, curl로 빠르게 확인하는 개발용
 * 경로다 — 배포 환경에서만 로그인·권한을 강제한다(devOnly, auth.js 참고). */
app.post(
  "/api/transcribe",
  upload.single("video"),
  devOnly(requireAuth),
  devOnly(requireCampaignAccess(supabase, campaignIdFromInfluencerIdBody)),
  async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "video 필드에 파일을 담아 보내주세요." });
  const videoPath = req.file.path;
  const influencerId = req.body?.influencerId || null;
  let campaign = null;
  try {
    campaign = req.body?.campaign ? JSON.parse(req.body.campaign) : null;
  } catch {
    /* 잘못된 캠페인 JSON은 무시하고 음성 전사만 진행 */
  }
  try {
    res.json(await processUploadedVideo({ videoPath, influencerId, campaign }));
  } catch (e) {
    fail(res, e);
    fs.rm(videoPath, { force: true }).catch(() => {});
  }
  },
);

/* 대용량 영상용 경로: 브라우저가 이미 스토리지에 직접 업로드를 끝낸 뒤,
 * 어디에 올렸는지(storagePath)만 알려주면 서버가 받아와서 검수를 시작한다. */
app.post(
  "/api/uploads/presign",
  requireR2,
  requireAuth,
  requireCampaignAccess(supabase, campaignIdFromInfluencerIdBody),
  async (req, res) => {
  const influencerId = req.body?.influencerId;
  if (!influencerId) return res.status(400).json({ error: "influencerId가 필요합니다." });
  const filename = String(req.body?.filename || "video").replace(/[^\w.-]+/g, "_");
  const objectKey = `${UPLOADS_PREFIX}${Date.now()}-${influencerId}-${filename}`;
  try {
    const command = new PutObjectCommand({ Bucket: R2_BUCKET, Key: objectKey });
    const signedUrl = await getSignedUrl(r2, command, { expiresIn: 3600 });
    res.json({ path: objectKey, signedUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
  },
);

/* 스토리지에서 파일을 내려받아 검수를 시작하는 것 자체가 대용량 영상 기준으로
 * 꽤 걸릴 수 있다(다운로드 + 전사 + 압축). 이 요청을 동기로 끝까지 붙잡고
 * 있으면, 업로드 전송 시간을 피하려고 만든 구조인데 이번엔 "응답 생성 시간"
 * 쪽에서 Render의 요청 처리 한도에 다시 걸릴 수 있다. 그래서 요청을 받으면
 * 바로 응답부터 하고, 실제 다운로드·검수는 백그라운드로 넘긴다 — 프론트는
 * 자막 검수와 동일하게 폴링으로 결과를 받는다. */
app.post(
  "/api/transcribe/from-storage",
  requireR2,
  requireAuth,
  requireCampaignAccess(supabase, campaignIdFromInfluencerIdBody),
  async (req, res) => {
  const { storagePath, influencerId, campaign } = req.body || {};
  if (!storagePath) return res.status(400).json({ error: "storagePath가 필요합니다." });

  // 이후 단계가 어디서 실패하든 최소한 "요청이 들어왔다"는 흔적은 항상 남겨서,
  // 배포 전환 시점에 구 인스턴스로 요청이 가 로그가 안 보이는 것인지, 아니면
  // 요청 자체가 서버에 닿지 않은 것인지 구분할 수 있게 한다.
  console.log(`[스토리지 경유 검수] 요청 접수 (influencerId=${influencerId || "-"}, path=${storagePath})`);

  // 무거운 다운로드/전사 작업을 시작하기 전에 DB 상태부터 "검수 중..."으로
  // 바꿔둔다 — 안 그러면 실제로는 처리 중이어도 DB엔 여전히 "미제출"이라,
  // 그 사이 새로고침하면 아무 것도 안 한 것처럼 보이는 문제가 있었다.
  if (supabase && influencerId) {
    await supabase.from("reelcheck_influencers").update({ status: "검수 중..." }).eq("id", influencerId);
  }

  res.json({ started: true });

  try {
    const dir = await workdir();
    const videoPath = path.join(dir, `source${path.extname(storagePath) || ".mp4"}`);
    try {
      const { Body } = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: storagePath }));
      await pipeline(Body, createWriteStream(videoPath));
      // 원본 그대로는 용량이 크고(전송 느림) 휴대폰 촬영본 특유의 포맷(.mov 등)을
      // 브라우저가 재생 못 할 수도 있다 — processUploadedVideo가 OCR용으로 만드는
      // 저해상도 프록시를 마케터 재생용으로도 그대로 재사용해서 올리고, 원본은
      // 로컬로 잘 받았으니 R2에서 바로 지운다.
      r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: storagePath })).catch(() => {});
    } catch (e) {
      throw new Error(`스토리지에서 파일을 받지 못했습니다: ${e.message}`);
    }

    await processUploadedVideo({
      videoPath,
      influencerId: influencerId || null,
      campaign: campaign || null,
    });
  } catch (e) {
    console.error("[스토리지 경유 검수] 실패:", e);
    if (supabase && influencerId) {
      await supabase
        .from("reelcheck_influencers")
        .update({ status: "검수완료", result: "-", feedback: `검수 요청 실패: ${e.message}` })
        .eq("id", influencerId)
        .then(() => {}, () => {});
    }
  }
  },
);

/* 아래 두 라우트는 화면(마케터/에이전시 UI)에서 쓰지 않는 개발용 디버그
 * 엔드포인트다 — 배포 환경에서만 로그인·마케터 권한을 강제한다. */
app.post("/api/frames", upload.single("video"), devOnly(requireAuth), devOnly(requireMarketer(supabase)), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "video 필드에 파일을 담아 보내주세요." });
  try {
    res.json(await keyframes(req.file.path, req.body || {}));
  } catch (e) { fail(res, e); }
  finally { fs.rm(req.file.path, { force: true }).catch(() => {}); }
});

app.post("/api/inspect", upload.single("video"), devOnly(requireAuth), devOnly(requireMarketer(supabase)), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "video 필드에 파일을 담아 보내주세요." });
  try {
    const [vis, aud] = await Promise.allSettled([
      keyframes(req.file.path, req.body || {}),
      transcribe(req.file.path),
    ]);
    if (vis.status === "rejected" && aud.status === "rejected") throw vis.reason;
    res.json({
      duration: (vis.value?.duration || aud.value?.duration) ?? 0,
      frames: vis.value?.frames || [],
      timeSource: vis.value?.timeSource || null,
      transcript: aud.value?.text || "",
      segments: aud.value?.segments || [],
      language: aud.value?.language || null,
      warnings: [
        vis.status === "rejected" && `키프레임 추출 실패: ${vis.reason.message}`,
        aud.status === "rejected" && `음성 전사 실패: ${aud.reason.message}`,
      ].filter(Boolean),
    });
  } catch (e) { fail(res, e); }
  finally { fs.rm(req.file.path, { force: true }).catch(() => {}); }
});

// 테스트(node --test)에서는 서버를 실제로 띄우지 않고 app만 import해서
// supertest로 호출한다.
if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, async () => {
    console.log(`InCensor 검수 서버 실행 중 → http://localhost:${PORT}`);
    console.log(`설치 상태 확인 → http://localhost:${PORT}/api/health`);

    await verifyR2Connection();
    await configureR2Cors();
    cleanupOrphanedUploads();
    setInterval(cleanupOrphanedUploads, ORPHAN_CLEANUP_INTERVAL_MS);
    pingSupabaseHeartbeat();
    setInterval(pingSupabaseHeartbeat, SUPABASE_HEARTBEAT_INTERVAL_MS);
    finalizeStuckCaptionJobs();
    setInterval(finalizeStuckCaptionJobs, STUCK_CAPTION_CHECK_INTERVAL_MS);
  });
}

export default app;
