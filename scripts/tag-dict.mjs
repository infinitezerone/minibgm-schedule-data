/**
 * AniList 题材 (Genres) 与高频标签 (Tags) 中文化字典
 * 用于将 AniList 英文标签映射为符合中文动漫社区（Bangumi/B站）习惯的标签。
 */

export const GENRE_MAP = {
  Action: "动作",
  Adventure: "冒险",
  Comedy: "搞笑",
  Drama: "剧情",
  Ecchi: "限制级",
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

export const TAG_MAP = {
  // 核心受众与分类
  Shounen: "少年向",
  Shoujo: "少女向",
  Seinen: "青年向",
  Josei: "女性向",
  Kids: "少儿向",

  // 设定与世界观
  Isekai: "异世界",
  Reincarnation: "转生",
  "Time Manipulation": "时间回溯",
  "Time Travel": "时空穿越",
  "Alternative Past": "架空历史",
  Historical: "历史",
  Mythology: "神话",
  Space: "太空",
  Cyberpunk: "赛博朋克",
  Steampunk: "蒸汽朋克",
  "Post-Apocalyptic": "末日废土",
  Dystopian: "反乌托邦",
  "Urban Fantasy": "都市奇幻",
  "Dark Fantasy": "暗黑奇幻",
  "Virtual World": "虚拟世界",
  VRMMO: "网游",
  "Video Games": "游戏",
  "Card Battle": "卡牌对决",
  Dungeon: "地下城",

  // 舞台与场景
  School: "校园",
  "School Club": "社团活动",
  College: "大学",
  Workplace: "职场",
  Office: "办公室",
  Countryside: "乡村",
  Wilderness: "荒野",
  Camping: "露营",
  Travel: "旅行",
  Military: "军事",
  War: "战争",
  Prison: "监狱",
  Hospital: "医院",

  // 角色类型与身份
  "Male Protagonist": "男主",
  "Female Protagonist": "女主",
  "Ensemble Cast": "群像",
  "Anti-Hero": "反英雄",
  Superhero: "超级英雄",
  "Childhood Friends": "青梅竹马",
  "Childhood Friend": "青梅竹马",
  "Tsundere": "傲娇",
  "Yandere": "病娇",
  "Kuudere": "无口/三无",
  Idol: "偶像",
  Band: "乐队",
  Maid: "女仆",
  Butler: "执事",
  Detective: "侦探",
  Police: "警察",
  Delinquents: "不良少年",
  Yakuza: "极道/黑帮",
  Mafia: "黑手党",
  Spy: "间谍",
  Assassin: "刺客/杀手",
  Ninja: "忍者",
  Samurai: "武士",
  Knight: "骑士",
  Witch: "魔女",
  Wizard: "魔法师",
  Alchemist: "炼金术士",
  "Monster Girl": "魔物娘",
  Dragon: "龙",
  Elf: "精灵",
  Vampire: "吸血鬼",
  Zombie: "丧尸",
  Ghost: "幽灵",
  Ghosts: "幽灵",
  Youkai: "妖怪",
  Deity: "神明",
  Gods: "神明",
  Demons: "恶魔",
  Angels: "天使",
  Aliens: "外星人",
  Android: "人造人/仿生人",
  Robot: "机器人",
  Cyborg: "半机械人",
  Kemonomimi: "兽耳",
  Pets: "宠物",
  Animal: "动物",

  // 关系与情感
  "Love Triangle": "三角恋",
  Cohabitation: "同居",
  "Fake Relationship": "契约恋爱",
  "Age Gap": "年龄差",
  Marriage: "婚姻",
  Parenting: "育儿",
  "Family Life": "家庭",
  "Found Family": "拟似家庭",
  Yuri: "百合",
  Bara: "耽美",
  "Boys' Love": "BL",

  // 风格与氛围
  Iyashikei: "治愈",
  Parody: "恶搞/梗番",
  Satire: "讽刺",
  Slapstick: "搞笑滑稽",
  Surrealism: "超现实",
  "Coming of Age": "青春成长",
  Philosophical: "哲学/思辨",
  Tragedy: "悲剧",
  Melodrama: "家庭伦理",
  "Battle Royale": "大逃杀",
  Survival: "生存",
  "Slow Life": "慢生活",
  Gore: "猎奇/血腥",
  "Body Horror": "肉体恐怖",

  // 竞技与爱好
  "Martial Arts": "武术格斗",
  Swordplay: "剑术",
  Archery: "弓道",
  Boxing: "拳击",
  Baseball: "棒球",
  Basketball: "篮球",
  Football: "足球",
  Volleyball: "排球",
  Swimming: "游泳",
  Tennis: "网球",
  Running: "跑步/田径",
  Motorsport: "赛车",
  Fishing: "钓鱼",
  Cooking: "美食料理",
  Food: "美食料理",
  "Board Game": "桌游",
  Mahjong: "麻将",
  Shogi: "将棋",
  "Otaku Culture": "御宅文化",
  Cosplay: "Cosplay",
  Drawing: "绘画/创作",
};

/**
 * 翻译 AniList 题材
 */
export function translateGenre(genre) {
  if (!genre) return null;
  return GENRE_MAP[genre] || genre;
}

/**
 * 翻译并筛选 AniList 标签
 * @param {Array<string>} genres - AniList 原生题材
 * @param {Array<{name: string, rank?: number}>} rawTags - AniList 标签列表
 * @param {boolean} isAdult - 是否为成人条目
 * @returns {Array<string>} 规范化后的中文标签数组
 */
export function translateTags(genres = [], rawTags = [], isAdult = false) {
  const result = new Set();

  // 1. 处理 Genre
  for (const g of genres) {
    const cn = translateGenre(g);
    if (cn) result.add(cn);
  }

  // 2. 处理 Tags (过滤 rank < 60 的弱关联标签)
  for (const t of rawTags) {
    const name = typeof t === "string" ? t : t.name;
    const rank = typeof t === "object" && t.rank != null ? t.rank : 100;
    if (!name || rank < 60) continue;

    const cn = TAG_MAP[name];
    if (cn) {
      result.add(cn);
    }
  }

  // 3. 里番补充标记
  if (isAdult) {
    result.add("里番");
  }

  return Array.from(result);
}
