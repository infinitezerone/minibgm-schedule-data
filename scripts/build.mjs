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
          media { id countryOfOrigin format status title { native romaji } }
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
    .filter((m) => ["TV", "ONA", "OVA"].includes(m.format ?? ""))
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
    const d = await gql(`query { ${aliases} }`);
    for (let idx = 0; idx < chunk.length; idx++) {
      const media = d[`m${idx}`];
      if (media?.nextAiringEpisode) next.set(media.id, media.nextAiringEpisode);
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
    "https://cdn.jsdelivr.net/npm/bangumi-data@latest/dist/data.json",
    "https://fastly.jsdelivr.net/npm/bangumi-data@latest/dist/data.json",
    "https://gcore.jsdelivr.net/npm/bangumi-data@latest/dist/data.json",
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const j = await res.json();
      const bridge = new Map();
      for (const it of j.items) {
        const al = it.sites.find((s) => s.site === "aniList");
        if (!al) continue;
        bridge.set(Number(al.id), {
          bgmId: Number(it.sites.find((s) => s.site === "bangumi")?.id) || null,
          titleCn: it.titleTranslate?.["zh-Hans"]?.[0] ?? null,
        });
      }
      console.error(`[map] bangumi-data 桥 ${bridge.size} 条（${url}）`);
      return bridge;
    } catch (e) {
      console.error(`  ${url} 失败: ${e.message}`);
    }
  }
  throw new Error("bangumi-data 全部 CDN 不可用");
}

async function searchBgmId(title) {
  await sleep(SEARCH_DELAY_MS);
  const res = await fetch(
    `https://api.bgm.tv/search/subject/${encodeURIComponent(title)}?type=2&max_results=20&responseGroup=medium`,
    { headers: UA },
  );
  if (!res.ok) return null;
  const j = await res.json();
  const list = j.list ?? [];
  if (list.length === 0) return null;
  let cands = list;
  if (list.length > 1) {
    const key = canonical(title);
    if (!key) return null;
    cands = list.filter(
      (c) => canonical(c.name).startsWith(key) || canonical(c.name_cn).startsWith(key),
    );
  }
  return cands.length === 1 ? cands[0].id : null;
}

async function resolveMappings(roster, bridge, mappings) {
  let byOverride = 0, byBridge = 0, bySearch = 0, unresolved = [];
  const out = new Map();
  for (const m of roster) {
    let bgmId = null, titleCn = null;
    if (mappings[m.id] != null) {
      bgmId = mappings[m.id];
      byOverride++;
    } else if (bridge.has(m.id)) {
      const b = bridge.get(m.id);
      bgmId = b.bgmId;
      titleCn = b.titleCn;
      byBridge++;
    } else {
      const title = m.title.native || m.title.romaji;
      bgmId = await searchBgmId(title);
      if (bgmId != null) {
        bySearch++;
        mappings[m.id] = bgmId; // 沉淀进持久映射，下次免搜
      } else {
        unresolved.push({ id: m.id, title });
      }
    }
    out.set(m.id, { bgmId, titleCn });
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
  const items = roster.map((m) => {
    const r = resolved.get(m.id);
    const eps = (byId.get(m.id) ?? []).map((e) => ({ n: e.episode, t: e.airAt }));
    const next = nextMap.get(m.id);
    if (next && !eps.some((e) => e.n === next.episode)) {
      eps.push({ n: next.episode, t: next.airingAt });
    }
    eps.sort((a, b) => a.n - b.n);
    return {
      anilistId: m.id,
      bgmId: r.bgmId,
      title: m.title.native || m.title.romaji,
      titleCn: r.titleCn,
      countryOfOrigin: m.countryOfOrigin,
      format: m.format,
      status: m.status,
      episodes: eps,
    };
  });
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

// ---------- 7. 内容哈希（generatedAt 不参与，避免无变化重发） ----------

function contentHash(snapshot) {
  const core = JSON.stringify({ schema: snapshot.schema, window: snapshot.window, items: snapshot.items });
  return createHash("sha256").update(core).digest("hex");
}

// ---------- main ----------

const previous = existsSync(SNAPSHOT_FILE)
  ? JSON.parse(readFileSync(SNAPSHOT_FILE, "utf8"))
  : null;
const mappings = loadMappings();

const { events, medias, from, to } = await scanEvents();
const roster = buildRoster(medias);
console.error(`[roster] 原始 ${medias.size} 部，剔国创后 ${roster.length} 部`);
const nextMap = await fetchNextAiring(roster);
const bridge = await loadBridge();
const { out: resolved, unresolved } = await resolveMappings(roster, bridge, mappings);
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

if (hash === previousHash) {
  console.log(`UNCHANGED ${hash}`);
  process.exit(0);
}

writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2));
writeFileSync(MAPPINGS_FILE, JSON.stringify(mappings, null, 2));
console.log(`CHANGED ${hash}`);
console.log(`条目 ${snapshot.items.length} | 事件 ${totalEps} | 新沉淀映射 ${Object.keys(mappings).length} 条 | 本轮未映射 ${unresolved.length}`);
