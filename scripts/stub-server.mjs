/**
 * 本地桩服务器：给自检脚本和手工调试提供可判定的假数据。
 *
 * 单独启动（会一直挂着，方便手工点界面看效果）：
 *   node scripts/stub-server.mjs
 *
 * 被 scripts/selftest.mjs 复用：
 *   import { createStub, BASE, MEDIA } from './stub-server.mjs'
 */
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

export const PORT = 8899
export const BASE = `http://127.0.0.1:${PORT}`
export const MEDIA = `${BASE}/media/live.m3u8`

/** 1x1 透明 PNG，兜底用（真实站点偶尔会给个 1x1 追踪像素） */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

/**
 * 海报占位图。用 SVG 而不是真图，是为了截图里能看出「这张图是哪部片的」，
 * 否则一片纯色块根本分不清是海报还是渲染坏了。
 */
const posterSvg = (title, n) => `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450" viewBox="0 0 300 450">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#F2F5FA"/><stop offset="1" stop-color="#D6DEEC"/>
    </linearGradient>
  </defs>
  <rect width="300" height="450" fill="url(#g)"/>
  <circle cx="150" cy="176" r="64" fill="#C2CDDE" opacity="0.5"/>
  <text x="150" y="202" font-size="60" text-anchor="middle" fill="#57667F" font-family="Microsoft YaHei, sans-serif">${n}</text>
  <text x="150" y="322" font-size="23" text-anchor="middle" fill="#3C4A61" font-family="Microsoft YaHei, sans-serif">${title}</text>
  <text x="150" y="356" font-size="14" text-anchor="middle" fill="#7B889D" font-family="Microsoft YaHei, sans-serif">本地自检 · 占位海报</text>
</svg>`

/** 注意：这里必须用字符串拼接而不是模板字面量，`$$$` 在模板里会被吃掉一个 `$` */
export const PLAY_A = ['自检第01集$' + MEDIA, '自检第02集$' + MEDIA, '自检第03集$' + MEDIA].join('#')
export const PLAY_B = ['自检第01集$' + MEDIA, '自检第02集$' + MEDIA].join('#')
export const PLAY_FROM = '自检线路1$$$自检线路2'
export const PLAY_URL = PLAY_A + '$$$' + PLAY_B

export const POSTER_1 = `${BASE}/poster-1.svg`
export const POSTER_2 = `${BASE}/poster-2.svg`

export const MEDIA_2 = `${BASE}/media/live2.m3u8`
/** 故意 404 的地址，用来验证线路体检能把死链标出来、并把整个频道藏起来 */
export const DEAD_MEDIA = `${BASE}/media/dead.m3u8`

/**
 * 直播源的两个变体，用来验证两种格式都能吃：
 *   · LIVE_TXT —— 国内常见的 txt（分组,#genre#）
 *   · LIVE_M3U —— 标准 #EXTM3U
 * 两边都放了「自检卫视」，用来验证同一频道跨源合并成一张卡、卡上列多条线路。
 * m3u 那边还多一个「自检停播台」，它唯一的线路指向 404，用来验证死频道会被藏起来。
 */
export const LIVE_TXT = [
  '央视频道,#genre#',
  `CCTV-1 综合,${MEDIA}`,
  `CCTV-2 财经,${MEDIA}`,
  '自检卫视,#genre#',
  `自检卫视,${MEDIA}`,
  `自检卫视,${MEDIA_2}`
].join('\n')

export const LIVE_M3U = [
  '#EXTM3U',
  `#EXTINF:-1 tvg-name="自检卫视" group-title="自检卫视",自检卫视`,
  MEDIA,
  `#EXTINF:-1 tvg-id="doc" tvg-name="自检纪录" group-title="纪录频道" tvg-logo="${POSTER_1}",自检纪录`,
  MEDIA,
  `#EXTINF:-1 tvg-name="自检停播台" group-title="自检停播",自检停播台`,
  DEAD_MEDIA
].join('\n')

export const CMS_ITEMS = [
  {
    vod_id: 1,
    vod_name: '自检影片甲',
    vod_pic: POSTER_1,
    vod_remarks: '更新至 03',
    vod_year: '2024',
    type_name: '自检剧'
  },
  {
    vod_id: 2,
    vod_name: '自检影片乙',
    vod_pic: POSTER_2,
    vod_remarks: '完结',
    vod_year: '2023',
    type_name: '自检片'
  }
]

/**
 * 只在「真关键词搜索」时多塞两条解说条目，用来验证渲染层的解说过滤。
 * 连通性测试（wd 为空或「测试」）不带它们，否则会把「正常，返回 2 条」的断言搞乱。
 *
 * 两条分别覆盖两种识别线索：
 *   · COMMENTARY_ITEM     片名里就带「电影解说」
 *   · COMMENTARY_ITEM_2   片名完全干净，只有 vod_class 是「影视解说」
 */
export const COMMENTARY_ITEM = {
  vod_id: 99,
  vod_name: '自检影片甲[电影解说]',
  vod_pic: POSTER_1,
  vod_remarks: '解说',
  vod_year: '2024',
  type_name: '影视解说'
}

export const COMMENTARY_ITEM_2 = {
  vod_id: 98,
  // 片名刻意避开 COMMENTARY_RE 里的每一个词（「解读」不等于「解说」/「拆解」），
  // 只有 type_name 能识破它
  vod_name: '自检影片乙深度解读',
  vod_pic: POSTER_2,
  vod_remarks: '解说',
  vod_year: '2024',
  type_name: '影视解说'
}

/** 桩里的全部条目（含解说），供详情页兜底 */
const ALL_ITEMS = [...CMS_ITEMS, COMMENTARY_ITEM, COMMENTARY_ITEM_2]

export const DETAIL_EXTRA = {
  vod_content: '自检简介：这是一部用于端到端验证的假影片。',
  vod_play_from: PLAY_FROM,
  vod_play_url: PLAY_URL
}

/** 最近一次请求的请求头，用于断言自定义 header 透传 */
export const state = { lastHeaders: null, lastTypes: [], lastPage: 0, classHits: 0, pageCalls: [], typeCalls: [] }

/**
 * 分类树。故意做成两层，而且把真实采集站里那几个「坑」照着搬了进来：
 *   - 电影片(1) 自己不返回任何东西，必须展开成叶子（动作片 6 / 喜剧片 7）；
 *   - `记录片`(20) 挂在电影片下面，写的是「记录」不是「纪录」——归并时不能漏，
 *     也不能让它留在电影里；
 *   - `伦理片`(34) 也挂在电影片下面，是子分类而不是顶层，SKIP 必须沿着祖先链生效，
 *     整棵子树都要被丢掉；
 *   - `短剧`(36) 挂在连续剧(2) 下面，要归到短剧而不是电视剧；
 *   - `动画片`(49) 挂在动漫片(4) 下面，要归到动漫；
 *   - `电影解说`(35) 是顶层，命中 SKIP 的「解说」。
 */
export const CLASS_TREE = [
  { type_id: 1, type_name: '电影片', type_pid: 0 },
  { type_id: 6, type_name: '动作片', type_pid: 1 },
  { type_id: 7, type_name: '喜剧片', type_pid: 1 },
  { type_id: 20, type_name: '记录片', type_pid: 1 },
  { type_id: 34, type_name: '伦理片', type_pid: 1 },
  { type_id: 2, type_name: '连续剧', type_pid: 0 },
  { type_id: 13, type_name: '国产剧', type_pid: 2 },
  { type_id: 36, type_name: '短剧', type_pid: 2 },
  { type_id: 3, type_name: '综艺片', type_pid: 0 },
  { type_id: 25, type_name: '大陆综艺', type_pid: 3 },
  { type_id: 4, type_name: '动漫片', type_pid: 0 },
  { type_id: 49, type_name: '动画片', type_pid: 4 },
  { type_id: 35, type_name: '电影解说', type_pid: 0 }
]

const TYPE_NAME = new Map(CLASS_TREE.map((c) => [c.type_id, c.type_name]))

/**
 * 分类浏览每页给两条。vod_id 里带上 type_id，这样「全部」（每叶子各发一次请求）
 * 拿回来的条目不会因为 id 相同被去重掉；片名里也带 type_id，方便断言
 * 「这一条到底是哪个子分类查出来的」。
 */
export const categoryItems = (page, typeId) =>
  [1, 2].map((n) => ({
    vod_id: 600 + typeId * 100 + page * 10 + n,
    vod_name: `自检分类片${typeId}第${page}页之${n}`,
    vod_pic: n === 1 ? POSTER_1 : POSTER_2,
    vod_remarks: `第 ${page} 页`,
    type_name: TYPE_NAME.get(typeId) ?? String(typeId)
  }))

const listItems = (items) =>
  items
    .map(
      (i) =>
        `<li><h3><a href="/detail/${i.vod_id}">${i.vod_name}</a></h3>` +
        `<img src="/poster-${i.vod_id}.svg"><span class="note">${i.vod_remarks}</span></li>`
    )
    .join('')

export function createStub() {
  return createServer((req, res) => {
    const url = new URL(req.url, BASE)
    state.lastHeaders = req.headers
    const json = (payload) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(payload))
    }
    const html = (body) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        `<!doctype html><html><head><meta charset="utf-8"><title>自检页面</title></head><body>${body}</body></html>`
      )
    }

    /**
     * 苹果CMS 搜索用的条目集合。走真关键词时额外带上两条解说条目，
     * 让「无 ids 的探测请求」和「真搜索」拿到不同的结果。
     */
    const searchHits = (wd) => {
      if (!wd || wd === '测试') return [...CMS_ITEMS]
      const base = CMS_ITEMS.filter((i) => i.vod_name.includes(wd))
      return base.length ? [...base, COMMENTARY_ITEM, COMMENTARY_ITEM_2] : base
    }

    /**
     * 网页规则站的列表页没有分类字段，应用那边也拿不到 type_name
     * （searchHtml 写的是 type_name: ''），所以这里不放解说条目——
     * 放了就是在测一个现实中不存在的场景。
     */
    const htmlHits = (wd) => {
      if (!wd || wd === '测试') return [...CMS_ITEMS]
      return CMS_ITEMS.filter((i) => i.vod_name.includes(wd))
    }

    if (url.pathname === '/api.php/provide/vod') {
      const ids = url.searchParams.get('ids') ?? ''
      if (ids) {
        json({
          code: 1,
          msg: 'ok',
          list: CMS_ITEMS.filter((i) => String(i.vod_id) === ids).map((i) => ({ ...i, ...DETAIL_EXTRA }))
        })
        return
      }

      const ac = url.searchParams.get('ac') ?? ''
      const types = url.searchParams.getAll('t').filter(Boolean)

      // 分类列表：不带 t 的 ac=list 才是要分类树
      if (ac === 'list' && !types.length) {
        state.classHits += 1
        json({ code: 1, msg: 'ok', class: CLASS_TREE })
        return
      }

      // 分类浏览：带 t 的请求。真实采集站每页固定 20 条而应用 limit 是 30，
      // 所以桩必须自己报 pagecount —— 应用要读这个字段，不能靠「本页满没满」猜。
      if (types.length) {
        const pg = Number(url.searchParams.get('pg') ?? '1') || 1
        // 真实苹果CMS 对同一个 t 只认一个值（重复 t 是「最后一个生效」而不是 OR），
        // 所以桩也按第一个 t 决定返回哪一批条目——多个 t 同时出现就说明
        // 调用方搞错了，自检会因此拿到不匹配的片名而失败。
        const typeId = Number(types[0])
        const list = categoryItems(pg, typeId)
        state.lastTypes = types
        state.lastPage = pg
        state.pageCalls.push(pg)
        state.typeCalls.push([...types])
        json({
          code: 1,
          msg: 'ok',
          page: pg,
          pagecount: 3,
          limit: 20,
          total: 6,
          list
        })
        return
      }

      // 无 ids 的请求既用于连通性测试也用于搜索；桩不真按关键词过滤，
      // 否则「用测试关键词发探测请求」会因为桩里没有这个片名而误判失败。
      const wd = url.searchParams.get('wd') ?? ''
      json({ code: 1, msg: 'ok', page: 1, list: searchHits(wd) })
      return
    }

    if (url.pathname === '/api-bad.php/provide/vod') {
      json({ code: 0, msg: '接口已停用', list: [] })
      return
    }

    if (url.pathname === '/search') {
      const wd = decodeURIComponent(url.searchParams.get('wd') ?? '')
      html(`<ul class="result-list">${listItems(htmlHits(wd))}</ul>`)
      return
    }

    // ---------- 解析接口相关的桩 ----------
    // /share/easy：一个「DPlayer 壳」分享页，地址明文写在脚本里 —— 应用自己读一遍就能拿到，
    //   根本用不到解析接口。素博的真实分享页就是这种。
    if (url.pathname === '/share/easy') {
      html(
        '<div id="dplayer"></div>' +
          '<script>' +
          `const vid = '${MEDIA}';` +
          "const player = new DPlayer({ container: document.getElementById('dplayer'), video: { url: vid } });" +
          '</script>'
      )
      return
    }

    // /share/hard：什么都读不出来的分享页（只有一句外链脚本），必须靠解析接口兜底
    if (url.pathname === '/share/hard') {
      html('<div id="player"></div><script src="/player.js"></script>')
      return
    }

    if (url.pathname === '/player.js') {
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' })
      res.end("console.log('nothing to see here')\n")
      return
    }

    // /parse-api?url=…：一个「好」的解析接口，回 JSON
    if (url.pathname === '/parse-api') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ code: 1, msg: 'ok', url: MEDIA_2 }))
      return
    }

    // /parse-bad?url=…：一个「坏」的解析接口，用来验证失败的会排到后面
    if (url.pathname === '/parse-bad') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ code: 0, msg: '接口已停用' }))
      return
    }

    if (/^\/detail\/\d+$/.test(url.pathname)) {
      const id = Number(url.pathname.slice('/detail/'.length))
      const item = ALL_ITEMS.find((i) => i.vod_id === id)
      html(
        `<h1 class="detail-title">${item ? item.vod_name : '未知影片'}</h1>` +
          '<div class="detail-content">自检简介：网页规则站的详情页。</div>' +
          `<div class="playlist"><a href="${MEDIA}">第01集</a><a href="${MEDIA}">第02集</a></div>`
      )
      return
    }

    if (url.pathname === '/live.txt') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end(LIVE_TXT)
      return
    }

    if (url.pathname === '/live.m3u') {
      res.writeHead(200, { 'content-type': 'audio/x-mpegurl; charset=utf-8', 'cache-control': 'no-store' })
      res.end(LIVE_M3U)
      return
    }

    if (url.pathname === '/media/live.m3u8' || url.pathname === '/media/live2.m3u8') {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' })
      res.end(
        '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:6.0,\nseg0.ts\n#EXT-X-ENDLIST\n'
      )
      return
    }

    if (url.pathname === '/poster-1.svg' || url.pathname === '/poster-2.svg') {
      const n = url.pathname.endsWith('1.svg') ? 1 : 2
      const item = CMS_ITEMS.find((i) => i.vod_id === n)
      res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-store' })
      res.end(posterSvg(item.vod_name, n === 1 ? '甲' : '乙'))
      return
    }

    if (url.pathname === '/p1.png' || url.pathname === '/p2.png') {
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
      res.end(PNG)
      return
    }

    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })
}

export const listen = (server) => new Promise((r) => server.listen(PORT, '127.0.0.1', r))

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createStub()
  await listen(server)
  console.log(`本地桩服务器已启动：${BASE}`)
  console.log(`  苹果CMS 接口   ${BASE}/api.php/provide/vod`)
  console.log(`  分类树         ${BASE}/api.php/provide/vod?ac=list`)
  console.log(`  分类浏览       ${BASE}/api.php/provide/vod?ac=detail&t=6&t=7&pg=1`)
  console.log(`  网页规则站     ${BASE}/search?wd=自检`)
  console.log(`  详情页         ${BASE}/detail/1`)
  console.log(`  假直播流       ${MEDIA}`)
  console.log(`  直播源 txt     ${BASE}/live.txt`)
  console.log(`  直播源 m3u     ${BASE}/live.m3u`)
  console.log('按 Ctrl+C 结束。')
}
