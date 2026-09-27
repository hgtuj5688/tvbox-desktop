import { connect } from 'node:net'
import { session } from 'electron'

/** 拿什么地址去问系统代理 —— 只需要一个 http(s) 目标，不需要真能连上。 */
const PROBE_TARGET = 'https://www.example.com'
/** 代理端口探测超时。本地代理要么在要么不在，给太长会拖慢启动。 */
const CONNECT_TIMEOUT = 800

interface ProxyTarget {
  host: string
  port: number
}

/**
 * resolveProxy 返回的是 Chromium 的代理规则串，形如：
 *   "DIRECT"
 *   "PROXY 127.0.0.1:7897"
 *   "HTTPS 127.0.0.1:7897; DIRECT"
 *   "SOCKS5 127.0.0.1:1080"
 * 取出里面所有带端口的候选，按出现顺序保留。
 */
function parseProxyChain(rule: string): ProxyTarget[] {
  const out: ProxyTarget[] = []
  const re = /\b(?:PROXY|HTTPS|SOCKS4|SOCKS5)\s+([^\s;:]+):(\d+)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(rule))) {
    const port = Number(m[2])
    if (port > 0 && port < 65536) out.push({ host: m[1], port })
  }
  return out
}

function canConnect({ host, port }: ProxyTarget): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    const finish = (ok: boolean): void => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(CONNECT_TIMEOUT)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

/**
 * 系统代理开着、代理软件却没在跑的时候，Chromium 会把**每一个**请求都打成
 * net::ERR_PROXY_CONNECTION_FAILED —— 海报、m3u8、分片全军覆没，界面看起来
 * 就是「视频全播放不了」。而主进程的 Node fetch 不读系统代理，搜索 / 详情
 * 一切正常，所以特别容易误判成播放器坏了。
 *
 * 启动时探一次：规则里只要有一个代理端口真的在监听就照旧走系统代理，
 * 一个都连不上才把这个会话切成直连。代理真在跑时行为完全不变。
 */
export async function ensureReachableProxy(): Promise<void> {
  try {
    const rule = await session.defaultSession.resolveProxy(PROBE_TARGET)
    const chain = parseProxyChain(rule)
    if (!chain.length) return

    for (const target of chain) {
      if (await canConnect(target)) return
    }

    await session.defaultSession.setProxy({ mode: 'direct' })
    console.warn(
      `[proxy] 系统代理 ${chain.map((t) => `${t.host}:${t.port}`).join(' / ')} 都连不上，本次运行改为直连`
    )
  } catch (err) {
    console.warn('[proxy] 检查系统代理失败，保持默认设置：', err)
  }
}
