import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { ConfigSource, SourcePresetInfo } from '@shared/types'
import { addSource, listSources } from './sources'

/**
 * 内置推荐订阅。
 *
 * 按之前定的产品决策：「内置但默认关闭」——首启页与设置页会把它们列出来，
 * 用户点一下才写进配置源。不默认启用是因为这些公开采集接口随时可能失效，
 * 也可能有地区 / 合规方面的差异，让用户自己选更稳妥。
 *
 * 点「添加」时会把配置内容落到 <数据目录>/presets/<id>.json，
 * 而不是引用仓库里的 samples/，这样仓库删了、应用换台机器也能继续用。
 */
export interface SourcePreset {
  id: string
  name: string
  desc: string
  /** 给界面显示用：这个订阅里有几个站点 */
  siteCount: number
  /** 给界面显示用：这个订阅里有几个直播源 */
  liveCount: number
  config: {
    format: string
    name: string
    note: string
    sites: Record<string, unknown>[]
    lives: Record<string, unknown>[]
    tvboxDesktop?: Record<string, unknown>
  }
}

const PUBLIC_CMS: SourcePreset = {
  id: 'public-cms',
  name: '公开可用源（苹果CMS 采集站）',
  desc: '实测存活的 5 个公开采集接口 + 2 个公开直播源。这类源随时可能失效，失效后在「影视源」「电视直播」页一看便知。',
  siteCount: 5,
  liveCount: 2,
  config: {
    format: 'tvbox-desktop/1',
    name: '公开可用源（苹果CMS 采集站）',
    note: '实测存活的公开采集接口，全部是标准苹果CMS v10 的 /api.php/provide/vod。判断标准有三条：列表接口有数据、带 wd 的搜索有结果、详情能解析出剧集地址。直播源一 txt 一 m3u，用来覆盖两种解析格式。',
    sites: [
      {
        key: 'ffzy',
        name: '非凡资源',
        type: 'cms',
        api: 'https://api.ffzyapi.com/api.php/provide/vod',
        searchable: 1
      },
      {
        key: 'lzi',
        name: '量子资源',
        type: 'cms',
        api: 'https://cj.lziapi.com/api.php/provide/vod',
        searchable: 1
      },
      {
        key: 'dyttzy',
        name: '电影天堂资源',
        type: 'cms',
        api: 'https://caiji.dyttzyapi.com/api.php/provide/vod',
        searchable: 1
      },
      {
        key: 'guangsu',
        name: '光速资源',
        type: 'cms',
        api: 'https://api.guangsuapi.com/api.php/provide/vod',
        searchable: 1
      },
      {
        key: 'subo',
        name: '素博资源',
        type: 'cms',
        api: 'https://subocaiji.com/api.php/provide/vod',
        searchable: 1
      }
    ],
    // 只留 IPv4 那一条。实测 Gather.m3u 的 123 条线路里 108 条（88%）拉不起来，
    // 而且它和 iptv4.txt 一个重名的频道都没有（补不上线路），留着只会让频道列表
    // 里多出一堆点开就失败的卡。
    lives: [
      {
        name: '公开直播源·IPv4（txt）',
        type: 0,
        url: 'https://live.zbds.top/tv/iptv4.txt'
      }
    ],
    // 首页内容位。写在这里的行优先于「每个源一条最近更新」的默认行为，
    // 让首启就有几行带分类的内容，而不是五条一模一样的「最近更新」。
    // typeId 用的是苹果CMS v10 的默认分类 id（6=动作片、13=国产剧、42=日本动漫），
    // 这五条都在真实源上逐条验证过 20 条有内容。
    tvboxDesktop: {
      home: {
        sections: [
          { title: '电影 · 最近更新', site: 'dyttzy' },
          { title: '电影 · 动作片', site: 'ffzy', typeId: 6 },
          { title: '电视剧 · 国产剧', site: 'lzi', typeId: 13 },
          { title: '动漫 · 日本', site: 'guangsu', typeId: 42 },
          { title: '综艺 · 最近更新', site: 'subo' }
        ]
      }
    }
  }
}

export const SOURCE_PRESETS: SourcePreset[] = [PUBLIC_CMS]

export function listPresets(): SourcePresetInfo[] {
  return SOURCE_PRESETS.map(({ id, name, desc, siteCount, liveCount }) => ({
    id,
    name,
    desc,
    siteCount,
    liveCount
  }))
}

/** 把预设落成数据目录里的一个本地配置文件，再注册成配置源 */
export async function addPreset(id: string): Promise<ConfigSource> {
  const preset = SOURCE_PRESETS.find((p) => p.id === id)
  if (!preset) throw new Error('没有这个内置订阅')

  const dir = join(app.getPath('userData'), 'presets')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${preset.id}.json`)
  writeFileSync(file, JSON.stringify(preset.config, null, 2), 'utf8')

  const existing = await listSources()
  const already = existing.find((s) => s.url === file)
  if (already) throw new Error('这个内置订阅已经添加过了')
  return addSource({ name: preset.name, url: file, kind: 'file' })
}

