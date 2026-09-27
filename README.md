# minibgm-schedule-data

[MiniBgm](https://github.com/infinitezerone/MiniBgm) 的放送时刻表快照数据源：GitHub Actions 定时扫描 AniList 播出事件，产出静态 JSON，供客户端一次请求整体消费。

## 数据口径

- **排期真值**只来自 [AniList](https://anilist.co) 已验证播出事件（`airingSchedules` ∪ `nextAiringEpisode`），**不做算术预测**。
- **剔除 `countryOfOrigin=CN`** 的国产动画（Bangumi 收录链路薄弱、播报节奏与周播栅格不同构；在追的番由客户端本地保留，不受此影响）。
- 条目元数据与 bgmId 映射来自 [bangumi-data](https://github.com/bangumi-data/bangumi-data)（CC-BY-4.0）。

## 更新节奏

每天 3 次（CST 06:00 / 12:00 / 18:00）扫描 + 内容哈希去重：AniList 数据无变化则不发布，因此仓库只在真值变化时产生提交。

## 消费方式

```
https://cdn.jsdelivr.net/gh/infinitezerone/minibgm-schedule-data@main/data/snapshot.json
https://fastly.jsdelivr.net/gh/infinitezerone/minibgm-schedule-data@main/data/snapshot.json
https://gcore.jsdelivr.net/gh/infinitezerone/minibgm-schedule-data@main/data/snapshot.json
```

每次发布后 CI 会调用 jsDelivr purge 接口失效缓存，延迟预算约 1 小时（AniList 编辑更新 + 扫描班次）。

## Schema（minibgm-schedule-snapshot/1）

```jsonc
{
  "schema": "minibgm-schedule-snapshot/1",
  "generatedAt": "2026-09-27T12:04:11.000Z",
  "window": { "from": 1789301785, "to": 1794399385 },   // 事件扫描窗口（秒级 UNIX）
  "items": [
    {
      "anilistId": 21459,
      "bgmId": 345678,            // 可空：bangumi-data 桥接 + 搜索兜底的并集，仍未映射时为 null
      "title": "ドラえもん (2005)",
      "titleCn": "哆啦A梦 (2005)", // 可空
      "countryOfOrigin": "JP",    // 快照内不会出现 "CN"
      "format": "TV",             // TV | ONA | OVA
      "status": "RELEASING",
      "episodes": [
        { "n": 1, "t": 1789567200 }  // n=集数, t=播出时刻（秒级 UNIX，AniList 已验证）
      ]
    }
  ]
}
```

`episodes` 含窗口内（回看 21 天 + 前瞻 60 天）的全部已验证事件，已合并 `nextAiringEpisode` 补洞。客户端拿全季数据自行切周窗口，整表原子替换，无需增量合并。

## 映射沉淀

`data/mappings.json` 持久累积 anilistId → bgmId 的搜索兜底结果（覆盖 bangumi-data 桥的缺口，当前桥接覆盖率约 70%）。映射只增不减，随运行单调逼近全覆盖。

## License

- 数据（`data/snapshot.json`）：[CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/)（继承上游 AniList / bangumi-data 的署名要求，使用时请注明来源）
- 脚本（`scripts/`）：MIT
