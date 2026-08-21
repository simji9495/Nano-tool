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
import { createWorker } from "tesseract.js";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
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

const PORT = process.env.PORT || 8787;
const STT_MODEL = process.env.STT_MODEL || "whisper-1";
const STT_LANG = process.env.STT_LANG || "ko";
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

app.use(cors({ origin: process.env.ALLOW_ORIGIN || "*" }));
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

  const prompt = `다음은 인플루언서 광고 영상에서 추출한 음성 전사 및 화면 자막(OCR) 텍스트다. 아래 캠페인 가이드라인 기준으로 이 텍스트가 규정을 준수하는지 검수하라.

[캠페인 가이드라인]
- 정확한 브랜드명: ${guideline.brand || "(미지정)"}
- 정확한 제품명: ${guideline.product || "(미지정)"}
- 필수 포함 USP: ${guideline.usps.join(", ") || "(없음)"}
- 금칙어/금기사항: ${guideline.bans.join(", ") || "(없음)"}

[발화 텍스트]
"""${text}"""

아래 JSON 형식으로만 답하라:
{"result":"통과"|"반려","brandMentioned":boolean,"productMentioned":boolean,"matchedUsps":string[],"missingUsps":string[],"violatedBans":string[],"feedback":"한글 2~3문장"}`;

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
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

/* 1차 필터: 금칙어 의심 단어가 걸렸거나, Tesseract 신뢰도가 낮아 오인식이 의심되는 프레임만 골라낸다. */
function findSuspiciousFrames(zipped, bans) {
  const cleanBans = (bans || []).filter(Boolean);
  return zipped.filter((r) => {
    if (!r.text) return false;
    if (r.confidence < 60) return true; // 글자는 있는데 잘 못 읽었을 가능성
    return cleanBans.some((b) => fuzzyContains(r.text, b));
  });
}

/* 2차 정밀검증: 의심 프레임만 GPT-4o 비전으로 보내 오탈자/오인식인지 실제 위반인지 판정한다. */
async function verifySuspiciousVision(frames, bans) {
  const key = process.env.OPENAI_API_KEY;
  if (!key || !frames.length) return [];
  const model = process.env.OCR_MODEL || "gpt-4o-mini";
  const banList = (bans || []).filter(Boolean).join(", ") || "(지정된 금칙어 없음)";

  return mapWithConcurrency(frames, 5, async (f) => {
    try {
      const prompt = `이 이미지의 자막에서 다음 금칙어 목록 위반 소지가 있는지 검수해라: ${banList}.
로컬 OCR(Tesseract)이 이 프레임에서 "${f.text}"라고 읽었다. 이게 실제로 금칙어를 포함한 문맥인지, 아니면 OCR의 오인식/오탈자인지 이미지를 직접 보고 판단해라.
아래 JSON 형식으로만 답하라: {"correctedText":"이미지에서 실제로 보이는 정확한 텍스트","violates":boolean,"matchedBan":"위반한 금칙어 또는 null"}`;
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
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
async function continueOcrInBackground({ videoPath, influencerId, campaign, audioText }) {
  try {
    let frames = [];
    try {
      const kf = await keyframes(videoPath, { maxFrames: 60 });
      frames = kf.frames;
    } catch (e) {
      console.warn(`[백그라운드] 키프레임 추출 실패, 화면 자막 검수 스킵: ${e.message}`);
      return;
    }
    if (!frames.length) return;

    const ocrResults = await ocrFramesTesseract(frames);
    const zipped = frames.map((f, i) => ({ ...f, ...ocrResults[i] }));

    const suspicious = findSuspiciousFrames(zipped, campaign.bans);
    const verifications = suspicious.length ? await verifySuspiciousVision(suspicious, campaign.bans) : [];

    const ocrSummary = buildOcrSummary(zipped, verifications);
    const combinedText = `[음성 전사]\n${audioText}\n\n[화면 자막/텍스트 (OCR: Tesseract${verifications.length ? " + GPT-4o 검증" : ""})]\n${ocrSummary || "(감지된 텍스트 없음)"}`;

    const review = await reviewAgainstGuidelines(combinedText, campaign);

    if (supabase && influencerId) {
      await supabase
        .from("reelcheck_influencers")
        .update({
          status: "검수완료",
          result: review.result,
          feedback: review.feedback,
          transcript: audioText,
          review,
        })
        .eq("id", influencerId);
    }
  } finally {
    fs.rm(videoPath, { force: true }).catch(() => {});
  }
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
    const result = await transcribe(videoPath);

    let review = null;
    if (campaign) {
      try {
        const audioOnlyText = `[음성 전사]\n${result.text}\n\n[화면 자막/텍스트 (OCR)]\n(화면 자막 검수 진행 중 — 잠시 후 결과가 갱신됩니다)`;
        review = await reviewAgainstGuidelines(audioOnlyText, campaign);
      } catch (e) {
        review = { error: String(e.message || e) };
      }
    }

    const canContinue = Boolean(campaign && !review?.error && influencerId);

    if (supabase && influencerId) {
      await supabase
        .from("reelcheck_influencers")
        .update({
          status: canContinue ? "검수완료(음성)" : "검수완료",
          result: review?.result || "-",
          feedback: review?.feedback || "",
          transcript: result.text,
        })
        .eq("id", influencerId)
        .then(() => {}, () => {});
    }

    res.json({ ...result, ocrPending: canContinue, review });

    if (canContinue) {
      continueOcrInBackground({ videoPath, influencerId, campaign, audioText: result.text }).catch((e) => {
        console.error("[백그라운드] 화면 자막 검수 실패:", e);
      });
    } else {
      fs.rm(videoPath, { force: true }).catch(() => {});
    }
  } catch (e) {
    fail(res, e);
    fs.rm(videoPath, { force: true }).catch(() => {});
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

app.listen(PORT, () => {
  console.log(`REELCHECK 검수 서버 실행 중 → http://localhost:${PORT}`);
  console.log(`설치 상태 확인 → http://localhost:${PORT}/api/health`);
});
