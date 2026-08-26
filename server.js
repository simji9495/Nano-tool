/**
 * REELCHECK 검수 서버
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
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
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
import { createWorker } from "tesseract.js";
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
async function fetchOpenAIWithRetry(url, options, { retries = 6, baseDelayMs = 1500 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, options);
    if (r.status !== 429 || attempt >= retries) return r;
    const retryAfterSec = Number(r.headers.get("retry-after"));
    const waitMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
      ? retryAfterSec * 1000
      : baseDelayMs * (attempt + 1);
    console.warn(`[OpenAI] 429 요청 한도 초과 — ${waitMs}ms 대기 후 재시도 (${attempt + 1}/${retries})`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
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

async function cleanupOrphanedUploads() {
  if (!r2) return;
  try {
    const { Contents } = await r2.send(
      new ListObjectsV2Command({ Bucket: R2_BUCKET, Prefix: UPLOADS_PREFIX, MaxKeys: 1000 }),
    );
    const now = Date.now();
    const stale = (Contents || [])
      .filter((o) => o.Key && o.LastModified && now - new Date(o.LastModified).getTime() > ORPHAN_MAX_AGE_MS)
      .map((o) => ({ Key: o.Key }));
    if (stale.length) {
      await r2.send(new DeleteObjectsCommand({ Bucket: R2_BUCKET, Delete: { Objects: stale } }));
      console.log(`[R2] 고아 업로드 파일 ${stale.length}건 정리`);
    }
  } catch (e) {
    console.warn(`[R2] 고아 파일 정리 실패: ${e.message}`);
  }
}

app.use(cors({ origin: ALLOW_ORIGIN }));
app.use(express.json());
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

/* 자막 검수는 저해상도면 충분한데 원본(1080p 이상)을 그대로 crv/Tesseract에 넣으면
 * 해상도에 비례해서 CPU 부하가 커진다. 업로드 즉시 저해상도·고속 프리셋으로
 * 압축한 프록시 파일을 만들어, 이후 키프레임 추출은 이 작은 파일로만 진행한다.
 * 오디오는 화질과 무관하니 그대로 복사해서 STT 품질에 영향이 없게 한다.
 * 자막은 화면 폭 방향으로 놓이므로, 세로 영상(릴스/쇼츠)에서 높이만 고정해버리면
 * 폭이 과도하게 줄어 자막을 못 읽는다 — 가로/세로 중 "짧은 변"을 기준으로 고정해
 * 어느 방향이든 자막이 놓인 폭 방향 해상도가 보존되게 한다. */
async function compressForOcr(videoPath) {
  const dir = await workdir();
  const out = path.join(dir, "proxy.mp4");
  await run("ffmpeg", [
    "-y", "-i", videoPath,
    "-vf", "scale='if(gt(iw,ih),-2,720)':'if(gt(iw,ih),720,-2)'",
    "-preset", "ultrafast",
    "-b:v", "600k",
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

async function reviewAgainstGuidelines(text, campaign) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY가 설정되지 않았습니다.");

  const model = process.env.REVIEW_MODEL || "gpt-4o-mini";
  const guideline = {
    brand: campaign?.brand || "",
    product: campaign?.product || "",
    usps: Array.isArray(campaign?.usps) ? campaign.usps.filter(Boolean) : [],
    bans: Array.isArray(campaign?.bans) ? campaign.bans.filter(Boolean) : [],
  };

  const prompt = `다음은 인플루언서 광고 영상에서 추출한 텍스트다. 대괄호 [숫자s]는 영상 내 등장 시각(초)이다.
"[음성 전사]" 구간에서 나온 내용은 출처를 "음성"으로, "[화면 자막/텍스트]" 구간에서 나온 내용은 출처를 "자막"으로 표시하라.
아래 캠페인 가이드라인 기준으로 이 텍스트가 규정을 준수하는지 검수하라.

brandMentioned/productMentioned는 실제로 지정된 브랜드명·제품명과 (표기가 살짝
다르더라도) 명확히 같은 대상을 가리킬 때만 true로 판단하라. 음성 전사는 STT
오인식으로 다른 단어로 잘못 인식되는 경우가 흔하다 — 문맥상 브랜드/제품과
무관해 보이는 단어("이 제품", "그거", 오인식된 엉뚱한 단어 등)는 실제 언급으로
인정하지 말고, 그런 부분을 발견하면 occurrences에 type "typo"로 남겨라.

금칙어 위반(violatedBans)은 텍스트에 그 의미가 명확하고 뚜렷하게 나타날 때만
표시하라. 화면 자막(OCR)은 오인식이 흔해서, 무슨 뜻인지 불분명하거나 애매한
문구만으로 "타사 브랜드 언급"처럼 해석이 필요한 금칙어를 단정하지 말고, 그런
경우는 occurrences에 type "typo"로만 남겨라 — 위반으로 확신이 설 때만
violatedBans/type "ban"으로 표시한다.

brandMentioned/productMentioned/violatedBans는 서로 완전히 독립적으로
판단하라 — 예를 들어 어딘가에서 금칙어 위반이 의심된다고 해서 브랜드/제품이
언급되지 않은 것으로 끌어내리지 말고, 브랜드/제품 언급 여부는 오직 그 자체의
실제 언급 여부만 보고 판단하라.

[캠페인 가이드라인]
- 정확한 브랜드명: ${guideline.brand || "(미지정)"}
- 정확한 제품명: ${guideline.product || "(미지정)"}
- 필수 포함 USP: ${guideline.usps.join(", ") || "(없음)"}
- 금칙어/금기사항: ${guideline.bans.join(", ") || "(없음)"}

[텍스트]
"""${text}"""

아래 JSON 형식으로만 답하라:
{"result":"통과"|"반려","brandMentioned":boolean,"productMentioned":boolean,"matchedUsps":string[],"missingUsps":string[],"violatedBans":string[],"feedback":"한글 2~3문장","occurrences":[{"timestamp":숫자(초),"source":"음성"|"자막","quote":"실제 언급되거나 오탈자가 있었던 문구","type":"brand"|"product"|"usp"|"ban"|"typo","note":"간단 설명(선택, 없으면 빈 문자열)"}]}
occurrences는 브랜드/제품/USP 언급, 금칙어 위반, 오탈자로 의심되는 부분마다 하나씩 만들어라. 해당 없으면 빈 배열로 답하라.`;

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

  return {
    result: parsed.result === "통과" ? "통과" : "반려",
    brandMentioned: Boolean(parsed.brandMentioned),
    productMentioned: Boolean(parsed.productMentioned),
    matchedUsps: Array.isArray(parsed.matchedUsps) ? parsed.matchedUsps : [],
    missingUsps: Array.isArray(parsed.missingUsps) ? parsed.missingUsps : [],
    violatedBans: Array.isArray(parsed.violatedBans) ? parsed.violatedBans : [],
    feedback: String(parsed.feedback || ""),
    occurrences: Array.isArray(parsed.occurrences)
      ? parsed.occurrences.map((o) => ({
          timestamp: Number(o?.timestamp) || 0,
          source: o?.source === "자막" ? "자막" : "음성",
          quote: String(o?.quote || ""),
          type: String(o?.type || ""),
          note: String(o?.note || ""),
        }))
      : [],
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
      );
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

/* 오탈자/우회 표기(예: "화 학 성 분")까지 잡기 위한 편집거리 기반 유사 포함 검사 */
function fuzzyContains(text, phrase, maxRatio = 0.3) {
  if (!text || !phrase) return false;
  if (text.includes(phrase)) return true;
  const maxDist = Math.max(1, Math.floor(phrase.length * maxRatio));
  for (let i = 0; i <= Math.max(0, text.length - phrase.length + maxDist); i++) {
    const window = text.slice(i, i + phrase.length + maxDist);
    if (window.length >= phrase.length - maxDist && levenshtein(window, phrase) <= maxDist) return true;
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

function findSuspiciousFrames(zipped, bans) {
  const cleanBans = (bans || []).filter(Boolean);
  const banMatches = [];
  const lowConfidence = [];
  for (const r of zipped) {
    if (!r.text) continue;
    if (cleanBans.some((b) => fuzzyContains(r.text, b))) {
      banMatches.push(r);
    } else if (r.confidence < 60) {
      lowConfidence.push(r);
    }
  }
  const dedupedBans = dedupeByText(banMatches);
  const dedupedLow = dedupeByText(lowConfidence).sort((a, b) => a.confidence - b.confidence);
  const capped = dedupedLow.slice(0, MAX_LOW_CONFIDENCE_VERIFY);
  if (dedupedLow.length > capped.length) {
    console.warn(
      `[자막 검수] 저신뢰 프레임 ${dedupedLow.length}개(중복 제거 후) 중 ${capped.length}개만 정밀검증 (나머지는 건너뜀)`,
    );
  }
  return [...dedupedBans, ...capped];
}

/* 2차 정밀검증: 의심 프레임만 GPT-4o 비전으로 보내 오탈자/오인식인지 실제 위반인지 판정한다. */
async function verifySuspiciousVision(frames, bans) {
  const key = process.env.OPENAI_API_KEY;
  if (!key || !frames.length) return [];
  const model = process.env.OCR_MODEL || "gpt-4o-mini";
  const banList = (bans || []).filter(Boolean).join(", ") || "(지정된 금칙어 없음)";

  // 의심 프레임이 많으면(예: 60장 중 56장) 동시에 5개씩 쏘는 것만으로도
  // 계정 분당 토큰 한도(TPM)를 순식간에 다 써버려서, 재시도로도 못 버틸 만큼
  // 429가 몰린다. 동시 호출을 줄여 소모 속도를 늦춘다.
  return mapWithConcurrency(frames, 2, async (f) => {
    try {
      const prompt = `이 이미지의 자막에서 다음 금칙어 목록 위반 소지가 있는지 검수해라: ${banList}.
로컬 OCR(Tesseract)이 이 프레임에서 "${f.text}"라고 읽었다. 이게 실제로 금칙어를 포함한 문맥인지, 아니면 OCR의 오인식/오탈자인지 이미지를 직접 보고 판단해라.
아래 JSON 형식으로만 답하라: {"correctedText":"이미지에서 실제로 보이는 정확한 텍스트","violates":boolean,"matchedBan":"위반한 금칙어 또는 null"}`;
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
                // detail:"low"로 토큰을 아끼려 했더니 "브리지"→"브리저"처럼 오인식이
                // 늘어 오히려 엉뚱한 위반 판정을 만들었다. 대신 중복 프레임 제거 +
                // 검증 상한 축소(findSuspiciousFrames)로 요청 수 자체를 줄여서
                // 예산을 확보하고, 해상도는 기본값(auto)으로 되돌려 판독력을 살린다.
                { type: "image_url", image_url: { url: f.dataUrl } },
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
        correctedText: String(parsed.correctedText || f.text),
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
      lines.push(
        v.violates
          ? `[${r.t}s] "${v.correctedText}" → 금칙어 위반 확인됨 (${v.matchedBan})`
          : `[${r.t}s] "${v.correctedText}" → OCR 오인식/오탈자로 확인됨 (금칙어 아님)`,
      );
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

/* ───────────── 캠페인 / 인플루언서 (Supabase) ───────────── */

app.get("/api/campaigns", requireSupabase, async (_req, res) => {
  const { data, error } = await supabase
    .from("reelcheck_campaigns")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

const monthDate = (year, month) => {
  const y = Number(year);
  const m = Number(month);
  if (!y || !m || m < 1 || m > 12) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-01`;
};

app.post("/api/campaigns", requireSupabase, async (req, res) => {
  const { advertiser, name, startDate, endDate, startYear, startMonth, endMonth, manager, brand, product, usps, bans } = req.body || {};
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
    })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put("/api/campaigns/:id", requireSupabase, async (req, res) => {
  const { advertiser, name, startDate, endDate, manager, brand, product, usps, bans } = req.body || {};
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

  const { data, error } = await supabase
    .from("reelcheck_campaigns")
    .update(patch)
    .eq("id", req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get("/api/campaigns/:id/influencers", requireSupabase, async (req, res) => {
  const { data, error } = await supabase
    .from("reelcheck_influencers")
    .select("*")
    .eq("campaign_id", req.params.id)
    .order("created_at", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

/* 엑셀 대량 업로드 → 해당 캠페인의 기존 명단을 통째로 교체 */
app.post("/api/campaigns/:id/influencers/bulk", requireSupabase, async (req, res) => {
  const campaignId = req.params.id;
  const list = Array.isArray(req.body?.influencers) ? req.body.influencers : [];

  const del = await supabase.from("reelcheck_influencers").delete().eq("campaign_id", campaignId);
  if (del.error) return res.status(500).json({ error: del.error.message });
  if (!list.length) return res.json([]);

  const rows = list.map((inf) => ({
    campaign_id: campaignId,
    name: inf.name,
    handle: inf.handle,
    status: "미제출",
    result: "-",
  }));
  const { data, error } = await supabase.from("reelcheck_influencers").insert(rows).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get("/api/influencers/:id", requireSupabase, async (req, res) => {
  const { data, error } = await supabase
    .from("reelcheck_influencers")
    .select("*")
    .eq("id", req.params.id)
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch("/api/influencers/:id", requireSupabase, async (req, res) => {
  const { status, result, feedback, videoName, transcript, review } = req.body || {};
  const patch = {};
  if (status !== undefined) patch.status = status;
  if (result !== undefined) patch.result = result;
  if (feedback !== undefined) patch.feedback = feedback;
  if (videoName !== undefined) patch.video_name = videoName;
  if (transcript !== undefined) patch.transcript = transcript;
  if (review !== undefined) patch.review = review;

  const { data, error } = await supabase
    .from("reelcheck_influencers")
    .update(patch)
    .eq("id", req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

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
    try {
      const kf = await keyframes(videoPath, { maxFrames: 60 });
      frames = kf.frames;
    } catch (e) {
      await finalizeAsAudioOnly(`키프레임 추출 실패: ${e.message}`);
      return;
    }
    timings.keyframesMs = Date.now() - t0;
    timings.frameCount = frames.length;
    if (!frames.length) {
      await finalizeAsAudioOnly("추출된 프레임 없음");
      return;
    }

    const t1 = Date.now();
    const ocrResults = await ocrFramesTesseract(frames);
    timings.tesseractMs = Date.now() - t1;
    const zipped = frames.map((f, i) => ({ ...f, ...ocrResults[i] }));

    const suspicious = findSuspiciousFrames(zipped, campaign.bans);
    timings.suspiciousCount = suspicious.length;

    const t2 = Date.now();
    const verifications = suspicious.length ? await verifySuspiciousVision(suspicious, campaign.bans) : [];
    timings.visionVerifyMs = Date.now() - t2;

    const ocrSummary = buildOcrSummary(zipped, verifications);
    const captionText = ocrSummary || "(감지된 텍스트 없음)";
    const combinedText = `[음성 전사]\n${audioText}\n\n[화면 자막/텍스트 (OCR: Tesseract${verifications.length ? " + GPT-4o 검증" : ""})]\n${captionText}`;

    const t3 = Date.now();
    // 종합 판정(음성+자막)과 자막 단독 판정을 동시에 구해서, 마케터가 팝업에서
    // "종합/음성/자막" 탭으로 나눠 볼 수 있게 한다. 음성 단독 판정은 1단계에서
    // 이미 계산해둔 것을 그대로 쓴다(중복 호출 방지).
    const [combinedReview, captionReview] = await Promise.all([
      reviewAgainstGuidelines(combinedText, campaign),
      ocrSummary
        ? reviewAgainstGuidelines(`[화면 자막/텍스트]\n${captionText}`, campaign)
        : Promise.resolve({
            result: "반려",
            brandMentioned: false,
            productMentioned: false,
            matchedUsps: [],
            missingUsps: campaign.usps || [],
            violatedBans: [],
            feedback: "화면에서 인식된 자막이 없습니다.",
            occurrences: [],
          }),
    ]);
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

  const audioTimestamped = formatTimestampedSegments(result.segments) || result.text;

  let audioReview = null;
  if (campaign) {
    try {
      const audioOnlyText = `[음성 전사]\n${audioTimestamped}\n\n[화면 자막/텍스트]\n(화면 자막 검수 진행 중 — 잠시 후 결과가 갱신됩니다)`;
      audioReview = await reviewAgainstGuidelines(audioOnlyText, campaign);
    } catch (e) {
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
    await supabase
      .from("reelcheck_influencers")
      .update({
        status: canContinue ? "검수완료(음성)" : "검수완료",
        result: review?.result || "-",
        feedback: review?.feedback || "",
        transcript: result.text,
        review,
      })
      .eq("id", influencerId)
      .then(() => {}, () => {});
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

app.post("/api/transcribe", upload.single("video"), async (req, res) => {
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
});

/* 대용량 영상용 경로: 브라우저가 이미 스토리지에 직접 업로드를 끝낸 뒤,
 * 어디에 올렸는지(storagePath)만 알려주면 서버가 받아와서 검수를 시작한다. */
app.post("/api/uploads/presign", requireR2, async (req, res) => {
  const influencerId = req.body?.influencerId || "misc";
  const filename = String(req.body?.filename || "video").replace(/[^\w.-]+/g, "_");
  const objectKey = `${UPLOADS_PREFIX}${Date.now()}-${influencerId}-${filename}`;
  try {
    const command = new PutObjectCommand({ Bucket: R2_BUCKET, Key: objectKey });
    const signedUrl = await getSignedUrl(r2, command, { expiresIn: 3600 });
    res.json({ path: objectKey, signedUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* 스토리지에서 파일을 내려받아 검수를 시작하는 것 자체가 대용량 영상 기준으로
 * 꽤 걸릴 수 있다(다운로드 + 전사 + 압축). 이 요청을 동기로 끝까지 붙잡고
 * 있으면, 업로드 전송 시간을 피하려고 만든 구조인데 이번엔 "응답 생성 시간"
 * 쪽에서 Render의 요청 처리 한도에 다시 걸릴 수 있다. 그래서 요청을 받으면
 * 바로 응답부터 하고, 실제 다운로드·검수는 백그라운드로 넘긴다 — 프론트는
 * 자막 검수와 동일하게 폴링으로 결과를 받는다. */
app.post("/api/transcribe/from-storage", requireR2, async (req, res) => {
  const { storagePath, influencerId, campaign } = req.body || {};
  if (!storagePath) return res.status(400).json({ error: "storagePath가 필요합니다." });

  res.json({ started: true });

  try {
    const dir = await workdir();
    const videoPath = path.join(dir, `source${path.extname(storagePath) || ".mp4"}`);
    try {
      const { Body } = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: storagePath }));
      await pipeline(Body, createWriteStream(videoPath));
      // 로컬로 잘 받았으니 R2엔 더 필요 없다 — 바로 정리한다.
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
});

app.post("/api/frames", upload.single("video"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "video 필드에 파일을 담아 보내주세요." });
  try {
    res.json(await keyframes(req.file.path, req.body || {}));
  } catch (e) { fail(res, e); }
  finally { fs.rm(req.file.path, { force: true }).catch(() => {}); }
});

/* 프론트엔드가 호출하는 통합 엔드포인트 */
app.post("/api/inspect", upload.single("video"), async (req, res) => {
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

app.listen(PORT, async () => {
  console.log(`REELCHECK 검수 서버 실행 중 → http://localhost:${PORT}`);
  console.log(`설치 상태 확인 → http://localhost:${PORT}/api/health`);

  await verifyR2Connection();
  await configureR2Cors();
  cleanupOrphanedUploads();
  setInterval(cleanupOrphanedUploads, ORPHAN_CLEANUP_INTERVAL_MS);
});
