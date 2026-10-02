# V0.4.0 URL 与浏览器历史契约

状态：已实现基础契约与首批“思绪列表 / 详情”切片
日期：2026-10-02

## 1. 边界

- 页面使用 canonical path。
- 对象详情使用 path；筛选、排序和分页使用 query。
- 页面切换、进入详情和从详情返回列表使用 `pushState`。
- 同页筛选、排序和分页使用 `replaceState`。
- 浏览器前进 / 后退恢复页面、query 与窗口滚动位置。
- 旧入口只做兼容解析，随后以 `replaceState` 归一为 canonical URL。
- URL 不作为授权边界；Owner 页面仍必须通过服务端 capability 保护。
- API v1 `1.0.0` 的包络、游标、ETag、幂等和错误码不因页面路由改变。

部署基路径不是页面路径的一部分。例如部署于 `/now` 时，思绪详情完整地址为
`/now/thoughts/:id`，其应用内 canonical path 仍是 `/thoughts/:id`。

## 2. 页面路径

| view | canonical path |
| --- | --- |
| `today` | `/today` |
| `together` | `/today/together` |
| `daily` | `/today/daily` |
| `captures` | `/seen/captures` |
| `books` | `/seen/books` |
| `quotes` | `/seen/quotes` |
| `keepsakes` | `/seen/keepsakes` |
| `thoughts` | `/thoughts` |
| `discovery` | `/thoughts/discovery` |
| `journals` | `/journals` |
| `review` | `/review` |
| `mine` | `/mine` |
| `personal-context` | `/mine/personal-context` |
| `statistics` | `/mine/statistics` |
| `feedback` | `/mine/feedback` |
| `export` | `/mine/export` |
| `notifications` | `/mine/notifications` |
| `trash` | `/mine/trash` |
| `account` | `/mine/account` |
| `settings` | `/mine/settings` |
| `about` | `/mine/about` |
| `ai-cost` | `/owner/ai-cost` |
| `architecture` | `/owner/architecture` |
| `commercialization` | `/owner/commercialization` |

Owner 路径的登记只定义地址，不授予访问权限。

## 3. 首批对象与 query

首批完整对象路由：

```text
/thoughts
/thoughts/:thoughtChainId
```

思绪 query：

| 参数 | 含义 | 默认值 |
| --- | --- | --- |
| `tag` | 标签筛选 | 全部 |
| `sort` | `occurred` 或 `created` | `occurred` |
| `page` | 正整数页码，最大 10000 | `1` |

默认值不写入 URL，参数顺序固定为 `tag`、`sort`、`page`。未知参数会在
canonical 化时移除。首批页面尚未启用服务端分页，`page` 先固定地址契约，
实际分页接入必须与 API v1 opaque cursor 分开：页面可分享页码，客户端不得解析
API cursor。

## 4. 历史与滚动

每个历史项在 `history.state.__forNowRoute` 保存：

```text
version
route: kind, view, resourceType, resourceId, query
scroll: x, y
result
```

- push 前先用 `replaceState` 保存当前项滚动位置。
- 新页面和详情从顶部开始。
- query 更新保留当前滚动位置且不增加历史项。
- `popstate` 先恢复页面和 query，再在两帧后以 `behavior: auto` 恢复滚动。
- 浏览器原生滚动恢复设为 `manual`，避免与应用恢复重复竞争。
- history state 只保存路由元数据，不保存用户正文、附件或对象快照。

## 5. 兼容与直接打开

- 部署根入口（生产为 `/now/`）兼容进入今日，并归一为 `/today`。
- 根入口 `/`、`?view=<view>`、`#<view>`、`#view=<view>` 兼容旧入口。
- `/view/<view>` 与旧的 `/<view>` 形式兼容后归一到页面 canonical path。
- 服务端只对已登记页面和详情 path 返回 SPA shell；未知 path 保持 404。
- 深链 shell 使用部署基路径加载 CSS、模块、manifest 和 service worker。

## 6. 不可用对象

思绪详情在数据完成账户级加载后校验目标。目标不存在、已删除或当前账户不可见时：

1. 不显示旧对象正文或缓存快照。
2. 以 `replaceState` 返回带原 query 的 `/thoughts` 安全列表，避免 Back 再进入
   已失效详情。
3. 页面显示一个可关闭的稳定结果：

```json
{
  "data": null,
  "error": {
    "code": "RESOURCE_UNAVAILABLE",
    "message": "这条思绪已不可用",
    "details": {
      "resourceType": "thought-chain",
      "resourceId": "<id>"
    }
  },
  "meta": {
    "fallback": {
      "view": "thoughts",
      "path": "/thoughts"
    }
  }
}
```

该结构说明页面恢复结果，不替代 API v1 的资源详情 404。

## 7. 后续迁移

页面 path 已全部登记，以下对象级详情和页面专用 query 尚未迁移：

- 念起、日记、书目 / 读书记录、拾句和小物详情。
- 状态、每日健康记录、对话、通知、回收条目和个人概要来源定位。
- 寻迹搜索条件与 cursor 到可分享分页 query 的映射。
- 回顾时间范围、图表指标和其他页面内排序。
- 书目、小物现有页内详情返回时的展开与局部滚动。
- 编辑器、弹窗和批注面板的可恢复 UI 上下文；正文草稿继续由现有持久草稿契约负责。
- Owner capability 完成后的 `/owner/*` 服务端鉴权与权限页回归。
