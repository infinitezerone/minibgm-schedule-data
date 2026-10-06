#!/usr/bin/env node
/**
 * MiniBgm 季度快照构建脚本
 *
 * 职责：
 * 扫描 AniList 历史/当前/未来各季度（WINTER/SPRING/SUMMER/FALL）的动漫条目，
 * 包含常规新番、成人番（里番）、剧场版、OVA/ONA 等全格式；
 * 结合 bangumi-data 与 mappings.json 补全 bgmId、中文名与播放源；
 * 产出静态按季 JSON 文件：data/seasons/${year}-${season}.json。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = join(ROOT, "data");
const SEASONS_DIR = join(DATA_DIR, "seasons");
const MAPPINGS_FILE = join(DATA_DIR, "mappings.json");

if (!existsSync(SEASONS_DIR)) {
  mkdirSync(SEASONS_DIR, { recursive: true });
}

const UA = { "User-Agent": "minibgm-schedule-data/1.0 (github.com/infinitezerone/minibgm-schedule-data)" };
const SCAN_PER_PAGE = 50;
const SCAN_DELAY_MS = 1500;
const SEARCH_DELAY_MS = 800;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const GENRE_MAP = {
  Action: "动作",
  Adventure: "冒险",
  Comedy: "搞笑",
  Drama: "剧情",
  Ecchi: "肉番",
  Fantasy: "奇幻",
  Hentai: "里番",
  Horror: "恐怖",
  "Mahou Shoujo": "魔法少女",
  Mecha: "机战",
  Music: "音乐",
  Mystery: "悬疑",
  Psychological: "心理",
  Romance: "恋爱",
  "Sci-Fi": "科幻",
  "Slice of Life": "日常",
  Sports: "运动",
  Supernatural: "超自然",
  Thriller: "惊悚",
};

const SEASONS = [
  { anilist: "WINTER", key: "winter" },
  { anilist: "SPRING", key: "spring" },
  { anilist: "SUMMER", key: "summer" },
  { anilist: "FALL", key: "autumn" },
];

async function gql(query, variables = {}) {
  const res = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...UA },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 429) {
    const retry = Number(res.headers.get("retry-after") ?? 60);
    console.error(`  AniList 429 限速，退避 ${retry}s...`);
    await sleep((retry + 2) * 1000);
    return gql(query, variables);
  }
  if (!res.ok) throw new Error(`AniList HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()).data;
}

const canonical = (s) =>
  (s ?? "").toLowerCase().replace(/[\s\-_:：·・!！?？~～'’"“”()（）[\]【】、,，.。]/g, "");

const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
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
    if (n > 0 && n < 20) season = n;
    return " ";
  });
  return { base: canonical(base), season };
}

function loadMappings() {
  if (!existsSync(MAPPINGS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(MAPPINGS_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function loadBridge() {
  const urls = [
    "https://unpkg.com/bangumi-data@latest/dist/data.json",
    "https://raw.githubusercontent.com/bangumi-data/bangumi-data/master/dist/data.json",
    "https://cdn.jsdelivr.net/gh/bangumi-data/bangumi-data@master/dist/data.json",
    "https://fastly.jsdelivr.net/npm/bangumi-data@latest/dist/data.json",
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
      console.log(`[bridge] 成功加载 bangumi-data 桥 (${bridge.size} 条)`);
      return { bridge, bridgeByBgm };
    } catch (e) {
      console.error(`  加载 ${url} 失败: ${e.message}`);
    }
  }
  return { bridge: new Map(), bridgeByBgm: new Map() };
}

async function searchBgmForMedia(m) {
  await sleep(SEARCH_DELAY_MS);
  const native = m.title.native?.trim() || "";
  const romaji = m.title.romaji?.trim() || "";
  const targetTitle = native || romaji;
  if (!targetTitle) return null;
  const qTarget = seasonParts(targetTitle);

  const keyword = targetTitle.replace(/[\/\-－]/g, " ").trim();
  try {
    const res = await fetch(
      `https://api.bgm.tv/search/subject/${encodeURIComponent(keyword)}?type=2&max_results=10&responseGroup=medium`,
      { headers: UA }
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
      return (baseMatch(p.base) && p.season === qTarget.season) || (baseMatch(pn.base) && pn.season === qTarget.season);
    });
    if (cands.length === 1) {
      return {
        bgmId: cands[0].id,
        titleCn: cands[0].name_cn?.trim() || null,
      };
    }
  } catch {}
  return null;
}

async function fetchSeasonMedias(seasonAnilist, year, isAdult) {
  const list = [];
  let page = 1;
  let hasNext = true;
  while (hasNext) {
    const query = `
      query ($season: MediaSeason, $year: Int, $isAdult: Boolean, $page: Int) {
        Page(page: $page, perPage: ${SCAN_PER_PAGE}) {
          pageInfo { hasNextPage }
          media(season: $season, seasonYear: $year, isAdult: $isAdult, type: ANIME) {
            id
            title { native romaji english }
            countryOfOrigin
            format
            status
            isAdult
            genres
            tags { name rank }
            coverImage { large }
            startDate { year month day }
            meanScore
            popularity
            episodes
          }
        }
      }
    `;
    const res = await gql(query, { season: seasonAnilist, year, isAdult, page });
    const medias = res?.Page?.media ?? [];
    list.push(...medias);
    hasNext = res?.Page?.pageInfo?.hasNextPage === true;
    page++;
    if (hasNext) await sleep(SCAN_DELAY_MS);
  }
  return list;
}

export async function buildSeason(year, seasonObj, { bridge, bridgeByBgm }, mappings) {
  const { anilist: seasonAnilist, key: seasonKey } = seasonObj;
  console.log(`\n=== 正在处理季度：${year} ${seasonKey.toUpperCase()} (${seasonAnilist}) ===`);

  // 1. 同时拉取常规番与成人番（里番）
  console.log(`  拉取常规动画...`);
  const regularMedias = await fetchSeasonMedias(seasonAnilist, year, false);
  console.log(`  拉取成人动画 (里番)...`);
  const adultMedias = await fetchSeasonMedias(seasonAnilist, year, true);

  const allRaw = [...regularMedias, ...adultMedias];
  // 去重 (以 anilistId)
  const uniqueMedias = Array.from(new Map(allRaw.map((m) => [m.id, m])).values());
  console.log(`  合计获取 ${uniqueMedias.length} 部条目 (常规 ${regularMedias.length}, 成人 ${adultMedias.length})`);

  // 2. 映射与字段规范化
  const items = [];
  let mappedCount = 0;

  for (const m of uniqueMedias) {
    let bgmId = null;
    let titleCn = null;
    let sites = [];
    let airDate = null;

    const mapped = mappings[m.id];
    if (mapped != null) {
      if (typeof mapped === "number") {
        bgmId = mapped;
      } else {
        bgmId = mapped.bgmId;
        titleCn = mapped.titleCn;
      }
    }

    if (bridge.has(m.id)) {
      const b = bridge.get(m.id);
      if (!bgmId) bgmId = b.bgmId;
      if (!titleCn) titleCn = b.titleCn;
      sites = b.sites ?? [];
      if (!airDate) airDate = b.airDate;
    }

    if (!bgmId && !titleCn) {
      const searched = await searchBgmForMedia(m);
      if (searched != null) {
        bgmId = searched.bgmId;
        titleCn = searched.titleCn;
        mappings[m.id] = { bgmId, titleCn };
      }
    }

    if (bgmId) mappedCount++;

    // 格式化开播日 YYYY-MM-DD
    if (!airDate && m.startDate?.year && m.startDate?.month) {
      const y = m.startDate.year;
      const mon = String(m.startDate.month).padStart(2, "0");
      const d = String(m.startDate.day || 1).padStart(2, "0");
      airDate = `${y}-${mon}-${d}`;
    }

    // 汇总标签：中文题材 + 高 Rank 英文标签 + 形式/成人标记
    const tags = new Set();
    if (m.isAdult) {
      tags.add("里番");
      tags.add("R18");
    }
    const fmt = m.format || "TV";
    if (fmt === "MOVIE") tags.add("剧场版");
    else if (fmt === "OVA") tags.add("OVA");
    else if (fmt === "ONA") tags.add("WEB");

    for (const g of m.genres || []) {
      const cnGenre = GENRE_MAP[g];
      if (cnGenre) tags.add(cnGenre);
      else tags.add(g);
    }
    for (const t of (m.tags || []).slice(0, 5)) {
      if (t.rank >= 70 && t.name) {
        tags.add(t.name);
      }
    }

    items.push({
      anilistId: m.id,
      bgmId: bgmId ?? null,
      title: m.title.native || m.title.romaji || m.title.english || "",
      titleCn: titleCn ?? null,
      countryOfOrigin: m.countryOfOrigin || "JP",
      format: m.format || "TV",
      status: m.status || "",
      isAdult: m.isAdult === true,
      coverUrl: m.coverImage?.large || null,
      airDate: airDate || null,
      ratingScore: m.meanScore ? Math.round((m.meanScore / 10.0) * 10) / 10 : 0.0,
      popularity: m.popularity || 0,
      episodes: m.episodes || 0,
      tags: Array.from(tags),
      sites: sites || [],
    });
  }

  // 排序：按热度降序
  items.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));

  const snapshot = {
    schema: "minibgm-season-snapshot/1",
    year,
    season: seasonKey,
    generatedAt: new Date().toISOString(),
    total: items.length,
    mappedTotal: mappedCount,
    items,
  };

  const outFile = join(SEASONS_DIR, `${year}-${seasonKey}.json`);
  writeFileSync(outFile, JSON.stringify(snapshot, null, 2), "utf8");
  console.log(`  -> 写入文件: ${outFile} (条目 ${items.length}, bgmId 映射率 ${Math.round((mappedCount / items.length) * 100)}%)`);
}

async function main() {
  const args = process.argv.slice(2);
  let targetYears = [2025, 2026];
  for (const arg of args) {
    if (arg.startsWith("--years=")) {
      targetYears = arg.substring("--years=".length).split(",").map(Number);
    }
  }

  console.log(`[build-seasons] 开始构建静态季度快照，目标年份: ${targetYears.join(", ")}`);
  const mappings = loadMappings();
  const bridgeData = await loadBridge();

  for (const year of targetYears) {
    for (const s of SEASONS) {
      await buildSeason(year, s, bridgeData, mappings);
      await sleep(1000);
    }
  }

  // 保存最新的映射
  writeFileSync(MAPPINGS_FILE, JSON.stringify(mappings, null, 2), "utf8");
  console.log(`\n[build-seasons] 全部季度构建完成！映射已更新到 ${MAPPINGS_FILE}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error("构建失败:", e);
    process.exit(1);
  });
}
