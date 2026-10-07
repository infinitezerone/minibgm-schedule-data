#!/usr/bin/env node
/**
 * MiniBgm 时间表快照构建管线
 *
 * 数据口径（与 MiniBgm app 红线一致）：
 * - 排期真值只来自 AniList 已验证播出事件（airingSchedules + nextAiringEpisode 合并），不做算术预测；
 * - 名单剔除 countryOfOrigin=CN（国创收录链路薄弱，且播报节奏与周播栅格不同构）；
 * - bangumi-data (CC-BY-4.0) 仅作 bgmId 桥接与中文名来源，不污染播出时间。
 *
 * 流程：窗口扫描 → 国创过滤 → 三级映射（持久映射 → data.json 桥 → bgm.tv 老搜索唯一候选）
 *      → 校验门 → 内容哈希去重 → 提交发布 → jsDelivr 缓存失效。
 */

import { gzipSync } from "node:zlib";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { translateTags, GENRE_MAP } from "./tag-dict.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = join(ROOT, "data");
const MAPPINGS_FILE = join(DATA_DIR, "mappings.json");
const SNAPSHOT_FILE = join(DATA_DIR, "snapshot.json");

const UA = { "User-Agent": "minibgm-schedule-data/1.0 (github.com/infinitezerone/minibgm-schedule-data)" };
const SCAN_PER_PAGE = 50;
const SCAN_DELAY_MS = 2200;      // AniList 未认证限速 30 req/min，留足余量
const SEARCH_DELAY_MS = 900;     // bgm.tv 老搜索接口礼貌间隔
const LOOKBACK_DAYS = 21;        // 名单回看：覆盖跨周边界的刚开播/刚完结
const LOOKAHEAD_DAYS = 60;       // 前瞻：覆盖已公布的未来话
const ALIAS_CHUNK = 40;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowEpoch = () => Math.floor(Date.now() / 1000);

async function gql(query, variables = {}) {
  const res = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...UA },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 429) {
    const retry = Number(res.headers.get("retry-after") ?? 60);
    console.error(`  429 限速，退避 ${retry}s`);
    await sleep((retry + 2) * 1000);
    return gql(query, variables);
  }
  if (!res.ok) throw new Error(`AniList HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()).data;
}

const canonical = (s) =>
  (s ?? "").toLowerCase().replace(/[\s\-_:：·・!！?？~～'’"“”()（）[\]【】、,，.。]/g, "");

// 季标记归一化：从标题中剥离季标记并提取季数。
// 认识 第N期/第N季/第Nクール/第N話/Season N/N期（含中文数字）；
// 同串出现多个标记时取最后一个（"第3期 第2クール" → season 2），
// 无标记视为第 1 季。配合 base 前缀匹配，可识别
// "アオアシ 第2期" ≡ "アオアシ Season2" 这类跨站命名差异，同时保持防跨季误配。
const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
// 认识 第N期/第N季/第Nクール/第N話/Season N/N期，以及标题末尾直接以空格+纯数字标识的季数（如 "Cyberpunk: Edgerunners 2"）
const SEASON_RE = /第\s*([0-9一二三四五六七八九十]+)\s*[期季クール話]|season\s*([0-9]+)|([0-9]+)\s*期|[\s_]+([0-9]+)$|([0-9]+)$/gi;

function seasonParts(title) {
  if (!title) return { base: "", season: 1 };
  let season = 1;
  const base = title.replace(SEASON_RE, (_, a, b, c, d, e) => {
    const raw = a ?? b ?? c ?? d ?? e;
    let n = 0;
    if (raw != null) {
      if (/^[0-9]+$/.test(raw)) n = parseInt(raw, 10);
      else n = [...raw].reduce((acc, ch) => (ch === "十" ? (acc === 0 ? 10 : acc * 10) : acc + (CN_NUM[ch] ?? 0)), 0);
    }
    // 只有小于 20 的合理季数才作为 season，避免将类似 "2005" 年份或巨大编号当成季数
    if (n > 0 && n < 20) season = n;
    return " ";
  });
  return { base: canonical(base), season };
}

// ---------- 1. 窗口扫描 ----------

async function scanEvents() {
  const from = nowEpoch() - LOOKBACK_DAYS * 86400;
  const to = nowEpoch() + LOOKAHEAD_DAYS * 86400;
  const events = [];
  const medias = new Map();
  let page = 1;
  let hasMore = true;
  console.error(`[scan] airingSchedules 窗口 ${from} ~ ${to}`);
  while (hasMore) {
    const d = await gql(
      `query { Page(page: ${page}, perPage: ${SCAN_PER_PAGE}) { pageInfo { hasNextPage }
        airingSchedules(airingAt_greater: ${from}, airingAt_lesser: ${to}) {
          episode airingAt
          media { id countryOfOrigin format status isAdult
            coverImage { large } startDate { year month }
            title { native romaji }
            genres tags { name rank } meanScore popularity episodes }
        } } }`,
    );
    for (const s of d.Page.airingSchedules) {
      events.push({ id: s.media.id, episode: s.episode, airAt: s.airingAt });
      if (!medias.has(s.media.id)) medias.set(s.media.id, s.media);
    }
    hasMore = d.Page.pageInfo.hasNextPage;
    console.error(`  page ${page}: 事件 ${events.length},条目 ${medias.size}`);
    page++;
    if (hasMore) await sleep(SCAN_DELAY_MS);
  }
  if (hasMore === false && page > 100) throw new Error("扫描分页异常：超过 100 页");
  return { events, medias, from, to };
}

// ---------- 2. 名单过滤 ----------

function buildRoster(medias) {
  return [...medias.values()]
    .filter((m) => ["TV", "TV_SHORT", "ONA", "OVA"].includes(m.format ?? ""))
    .filter((m) => m.countryOfOrigin !== "CN");
}

// ---------- 3. 下一话指针（补 schedule 索引空洞） ----------

async function fetchNextAiring(roster) {
  const next = new Map();
  for (let i = 0; i < roster.length; i += ALIAS_CHUNK) {
    const chunk = roster.slice(i, i + ALIAS_CHUNK);
    const aliases = chunk
      .map((m, idx) => `m${idx}: Media(id: ${m.id}) { id nextAiringEpisode { episode airingAt } }`)
      .join(" ");
    try {
      const d = await gql(`query { ${aliases} }`);
      for (let idx = 0; idx < chunk.length; idx++) {
        const media = d[`m${idx}`];
        if (media?.nextAiringEpisode) next.set(media.id, media.nextAiringEpisode);
      }
    } catch (e) {
      console.error(`  next 指针批次 ${i} 失败，降级跳过: ${e.message}`);
    }
    console.error(`  next 指针 ${Math.min(i + ALIAS_CHUNK, roster.length)}/${roster.length}`);
    await sleep(SCAN_DELAY_MS);
  }
  return next;
}

// ---------- 4. 三级映射 ----------

function loadMappings() {
  if (!existsSync(MAPPINGS_FILE)) return {};
  return JSON.parse(readFileSync(MAPPINGS_FILE, "utf8"));
}

async function loadBridge() {
  const urls = [
    "https://unpkg.com/bangumi-data@latest/dist/data.json",
    "https://raw.githubusercontent.com/bangumi-data/bangumi-data/master/dist/data.json",
    "https://cdn.jsdelivr.net/gh/bangumi-data/bangumi-data@master/dist/data.json",
    "https://fastly.jsdelivr.net/npm/bangumi-data@latest/dist/data.json",
    "https://cdn.jsdelivr.net/npm/bangumi-data@latest/dist/data.json",
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const j = await res.json();
      const bridge = new Map();
      const bridgeByBgm = new Map();
      for (const it of j.items) {
        const al = it.sites?.find((s) => s.site === "aniList");
        const bgm = it.sites?.find((s) => s.site === "bangumi");
        const bgmId = Number(bgm?.id) || null;
        const entry = {
          bgmId,
          titleCn: it.titleTranslate?.["zh-Hans"]?.[0] ?? null,
          airDate: it.begin ? it.begin.substring(0, 10) : null,
          sites: (it.sites ?? []).filter((s) => s.site !== "aniList" && s.site !== "bangumi"),
        };
        if (al) bridge.set(Number(al.id), entry);
        if (bgmId) bridgeByBgm.set(bgmId, entry);
      }
      console.error(`[map] bangumi-data 桥 ${bridge.size} 条（${url}）`);
      return { bridge, bridgeByBgm };
    } catch (e) {
      console.error(`  ${url} 失败: ${e.message}`);
    }
  }
  throw new Error("bangumi-data 全部 CDN 不可用");
}

function parseMappingEntry(val) {
  if (val == null) return null;
  if (typeof val === "number") return { bgmId: val, titleCn: null, isLegacy: true };
  if (typeof val === "object") {
    return {
      bgmId: Number(val.bgmId) || null,
      titleCn: val.titleCn?.trim() || null,
      isLegacy: false,
    };
  }
  return null;
}

async function fetchBgmSubject(bgmId) {
  await sleep(500); // 礼貌请求间隔，遵守 Bangumi 社区规范
  try {
    const res = await fetch(`https://api.bgm.tv/v0/subjects/${bgmId}`, { headers: UA });
    if (!res.ok) return null;
    const j = await res.json();
    return {
      bgmId: j.id,
      titleCn: j.name_cn?.trim() || null,
    };
  } catch {
    return null;
  }
}

async function searchBgmQuery(keywordStr, qTarget) {
  await sleep(SEARCH_DELAY_MS);
  // 老搜索接口对 "/" 会失效，对 "-" 会被当作 NOT 排除关键字（如 PSYREN -サイレン-），统一换成空格
  const keyword = keywordStr.replace(/[\/\-－]/g, " ").trim();
  if (!keyword || !qTarget.base) return null;
  try {
    const res = await fetch(
      `https://api.bgm.tv/search/subject/${encodeURIComponent(keyword)}?type=2&max_results=20&responseGroup=medium`,
      { headers: UA },
    );
    if (!res.ok) return null;
    const j = await res.json();
    const list = j.list ?? [];
    if (list.length === 0) return null;

    const cands = list.filter((c) => {
      if (canonical(c.name) === qTarget.base || canonical(c.name_cn) === qTarget.base) return true;
      const p = seasonParts(c.name);
      const pn = seasonParts(c.name_cn);
      const baseMatch = (b) => b.length > 0 && (b.startsWith(qTarget.base) || qTarget.base.startsWith(b));
      return (
        (baseMatch(p.base) && p.season === qTarget.season) ||
        (baseMatch(pn.base) && pn.season === qTarget.season)
      );
    });
    if (cands.length !== 1) return null;
    const cand = cands[0];
    return {
      bgmId: cand.id,
      titleCn: cand.name_cn?.trim() || null,
    };
  } catch (e) {
    console.error(`  search 失败 (${keyword}): ${e.message}`);
    return null;
  }
}

async function searchBgmForMedia(m) {
  const native = m.title.native?.trim() || "";
  const romaji = m.title.romaji?.trim() || "";
  const primarySeason = seasonParts(native || romaji).season;

  const attempts = [];
  if (native) {
    const qNative = { ...seasonParts(native), season: primarySeason };
    attempts.push({ query: native, target: qNative });
    // 对日轻超长副标题（带 ～ / 〜 / ~），尝试截取主标题二次搜索
    const sub = native.split(/[～〜~]/)[0].trim();
    if (sub && sub !== native && sub.length >= 3) {
      attempts.push({ query: sub, target: { ...seasonParts(sub), season: primarySeason } });
    }
  }
  // 若日文原名为外来语/全英文（如 Cyberpunk: Edgerunners），native 是片假名而 Bangumi 录入英文主标题，fallback 到 romaji
  if (romaji && canonical(romaji) !== canonical(native)) {
    const qRomaji = { ...seasonParts(romaji), season: primarySeason };
    attempts.push({ query: romaji, target: qRomaji });
    const subRomaji = romaji.split(/[～〜~:]/)[0].trim();
    if (subRomaji && subRomaji !== romaji && subRomaji.length >= 3) {
      attempts.push({ query: subRomaji, target: { ...seasonParts(subRomaji), season: primarySeason } });
    }
  }

  for (const { query, target } of attempts) {
    const res = await searchBgmQuery(query, target);
    if (res != null) return res;
  }
  return null;
}

async function resolveMappings(roster, { bridge, bridgeByBgm }, mappings) {
  let byOverride = 0, byBridge = 0, bySearch = 0, unresolved = [];
  const out = new Map();
  for (const m of roster) {
    let bgmId = null, titleCn = null, sites = [], airDate = null;
    const mapped = parseMappingEntry(mappings[m.id]);
    if (mapped != null) {
      bgmId = mapped.bgmId;
      titleCn = mapped.titleCn;
      // 1. 如果缺少 titleCn，先看 bridge 是否有
      if (!titleCn && bridge.has(m.id)) {
        titleCn = bridge.get(m.id).titleCn;
      }
      // 2. 如果是旧纯数字格式且依然缺少 titleCn，尝试通过 bgmId 补全一次
      if (!titleCn && bgmId != null && mapped.isLegacy) {
        const sub = await fetchBgmSubject(bgmId);
        if (sub?.titleCn) titleCn = sub.titleCn;
      }
      sites = bridge.get(m.id)?.sites ?? (bgmId ? bridgeByBgm.get(bgmId)?.sites : null) ?? [];
      airDate = bridge.get(m.id)?.airDate ?? (bgmId ? bridgeByBgm.get(bgmId)?.airDate : null) ?? null;
      // 沉淀/升级持久映射
      mappings[m.id] = { bgmId, titleCn };
      byOverride++;
    } else if (bridge.has(m.id)) {
      const b = bridge.get(m.id);
      bgmId = b.bgmId;
      titleCn = b.titleCn;
      sites = b.sites ?? [];
      airDate = b.airDate ?? null;
      byBridge++;
    } else {
      const s = await searchBgmForMedia(m);
      if (s != null) {
        bySearch++;
        bgmId = s.bgmId;
        titleCn = s.titleCn;
        sites = bgmId ? (bridgeByBgm.get(bgmId)?.sites ?? []) : [];
        airDate = bgmId ? (bridgeByBgm.get(bgmId)?.airDate ?? null) : null;
        mappings[m.id] = { bgmId, titleCn }; // 沉淀进持久映射，下次免搜
      } else {
        const title = m.title.native || m.title.romaji;
        unresolved.push({ id: m.id, title });
      }
    }
    out.set(m.id, { bgmId, titleCn, sites, airDate });
  }
  console.error(`[map] 持久映射 ${byOverride} | data.json 桥 ${byBridge} | 搜索兜底 ${bySearch} | 未映射 ${unresolved.length}`);
  for (const u of unresolved) console.error(`  未映射: [${u.id}] ${u.title}`);
  return { out, byOverride, byBridge, bySearch, unresolved };
}

// ---------- 5. 组装快照 ----------

function assemble(roster, events, nextMap, resolved, from, to) {
  const byId = new Map();
  for (const e of events) {
    if (!byId.has(e.id)) byId.set(e.id, []);
    byId.get(e.id).push(e);
  }
  const items = roster
    .map((m) => {
      const r = resolved.get(m.id);
      if (!r || !r.bgmId || r.bgmId <= 0) return null;
      const eps = (byId.get(m.id) ?? []).map((e) => ({ n: e.episode, t: e.airAt }));
      const next = nextMap.get(m.id);
      if (next && !eps.some((e) => e.n === next.episode)) {
        eps.push({ n: next.episode, t: next.airingAt });
      }
      eps.sort((a, b) => a.n - b.n);
      const translatedTags = translateTags(m.genres || [], m.tags || [], m.isAdult ?? false);
      return {
        anilistId: m.id,
        bgmId: r.bgmId,
        title: m.title.native || m.title.romaji,
        titleCn: r.titleCn,
        countryOfOrigin: m.countryOfOrigin,
        format: m.format,
        status: m.status,
        coverUrl: m.coverImage?.large ?? null,
        airDate: r.airDate ?? (m.startDate?.year && m.startDate?.month ? `${m.startDate.year}-${String(m.startDate.month).padStart(2, '0')}-01` : null),
        ratingScore: m.meanScore ? Math.round((m.meanScore / 10.0) * 10) / 10 : 0.0,
        popularity: m.popularity || 0,
        totalEpisodes: m.episodes || 0,
        genres: (m.genres || []).map((g) => GENRE_MAP[g] || g),
        tags: translatedTags,
        sites: r.sites ?? [],
        isAdult: m.isAdult ?? false,
        startYear: m.startDate?.year ?? 0,
        startMonth: m.startDate?.month ?? 0,
        episodes: eps,
      };
    })
    .filter(Boolean);
  items.sort((a, b) => a.anilistId - b.anilistId);
  return {
    schema: "minibgm-schedule-snapshot/1",
    generatedAt: new Date().toISOString(),
    window: { from, to },
    items,
  };
}

// ---------- 6. 校验门 ----------

function validate(snapshot, previous) {
  const errors = [];
  const n = snapshot.items.length;
  if (n < 20) errors.push(`条目过少: ${n}`);
  const totalEps = snapshot.items.reduce((s, i) => s + i.episodes.length, 0);
  if (totalEps < 100) errors.push(`事件过少: ${totalEps}`);
  for (const it of snapshot.items) {
    if (!it.title) errors.push(`[${it.anilistId}] 标题为空`);
    const bad = it.episodes.find((e) => e.t < 1_500_000_000 || e.t > 2_500_000_000);
    if (bad) errors.push(`[${it.anilistId}] 事件时间戳异常: ep${bad.n}@${bad.t}`);
    const dup = it.episodes.length - new Set(it.episodes.map((e) => e.n)).size;
    if (dup > 0) errors.push(`[${it.anilistId}] ${dup} 个重复集数`);
  }
  if (previous) {
    const pn = previous.items.length;
    const pe = previous.items.reduce((s, i) => s + i.episodes.length, 0);
    if (Math.abs(n - pn) > Math.max(20, pn * 0.3)) errors.push(`条目数突变: ${pn} -> ${n}`);
    if (Math.abs(totalEps - pe) > Math.max(50, pe * 0.4)) errors.push(`事件数突变: ${pe} -> ${totalEps}`);
  }
  return errors;
}

// ---------- 7. 内容哈希 ----------
// 只对 items 计算：window 是随运行时间滚动的生成参数，纳入会导致每班必判"变化"，
// 去重失效；items 才是真值本体（窗口滑动造成的增量会如实反映在 items 里）。

function contentHash(snapshot) {
  const core = JSON.stringify({ schema: snapshot.schema, items: snapshot.items });
  return createHash("sha256").update(core).digest("hex");
}

// ---------- main ----------

const previous = existsSync(SNAPSHOT_FILE)
  ? JSON.parse(readFileSync(SNAPSHOT_FILE, "utf8"))
  : null;
const rawPreviousMappings = existsSync(MAPPINGS_FILE)
  ? readFileSync(MAPPINGS_FILE, "utf8").trim()
  : "";
const mappings = loadMappings();

const { events, medias, from, to } = await scanEvents();
const roster = buildRoster(medias);
console.error(`[roster] 原始 ${medias.size} 部，剔国创后 ${roster.length} 部`);
const nextMap = await fetchNextAiring(roster);
const bridge = await loadBridge();
const { out: resolved, unresolved } = await resolveMappings(roster, bridge, mappings);

// 对 mappings 中不在本轮 roster 的历史遗留数字条目做规范化补全
for (const [k, v] of Object.entries(mappings)) {
  if (typeof v === "number") {
    const sub = await fetchBgmSubject(v);
    mappings[k] = { bgmId: v, titleCn: sub?.titleCn || null };
  }
}

const snapshot = assemble(roster, events, nextMap, resolved, from, to);

const errors = validate(snapshot, previous);
if (errors.length > 0) {
  console.error(`[validate] 校验未通过，拒绝发布:`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

const hash = contentHash(snapshot);
const previousHash = previous ? contentHash(previous) : null;
const totalEps = snapshot.items.reduce((s, i) => s + i.episodes.length, 0);
const json = JSON.stringify(snapshot);
console.error(`[build] 条目 ${snapshot.items.length}，事件 ${totalEps}，体积 ${(json.length / 1024).toFixed(1)} KB（gzip ${(gzipSync(json).length / 1024).toFixed(1)} KB）`);

// 排序 mappings key，保证 diff 稳定
const sortedMappings = {};
for (const k of Object.keys(mappings).sort((a, b) => Number(a) - Number(b))) {
  sortedMappings[k] = mappings[k];
}
const serializedMappings = JSON.stringify(sortedMappings, null, 2);
const mappingsChanged = serializedMappings !== rawPreviousMappings;

if (mappingsChanged) {
  writeFileSync(MAPPINGS_FILE, serializedMappings);
}

if (hash === previousHash && !mappingsChanged) {
  console.log(`UNCHANGED ${hash}`);
  process.exit(0);
}

writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2));
if (!mappingsChanged) {
  writeFileSync(MAPPINGS_FILE, serializedMappings);
}
console.log(`条目 ${snapshot.items.length} | 事件 ${totalEps} | 新沉淀映射 ${Object.keys(sortedMappings).length} 条 | 本轮未映射 ${unresolved.length}`);
// 机器可读结果行必须最后输出（CI 以 tail -1 提取 CHANGED/UNCHANGED）
console.log(`CHANGED ${hash}`);
