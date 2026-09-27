import type { ReactNode } from 'react'

interface RoadmapProps {
  /** 里程碑编号，例如 M2 */
  milestone: string
  title: string
  desc: string
  /** 这个页面最终会有的能力 */
  points: { title: string; desc: string }[]
  /** 依赖的前置能力，用于解释为什么现在还不能用 */
  depends?: string[]
  extra?: ReactNode
}

/** 尚未开发的页面的统一占位：说清楚「现在是什么、以后是什么、为什么现在不能用」 */
export function Roadmap({ milestone, title, desc, points, depends, extra }: RoadmapProps): JSX.Element {
  return (
    <div className="plan-card">
      <div className="plan-head">
        <span className="tag tag-accent">{milestone}</span>
        <div>
          <div className="plan-title">{title}</div>
          <div className="plan-desc">{desc}</div>
        </div>
      </div>

      <div className="plan-list">
        {points.map((p, i) => (
          <div className="plan-item" key={p.title}>
            <span className="plan-num">{i + 1}</span>
            <div>
              <b>{p.title}</b>
              <div className="fs-12 text-3">{p.desc}</div>
            </div>
          </div>
        ))}
      </div>

      {depends?.length ? (
        <div className="banner banner-info" style={{ marginTop: 14 }}>
          <b>前置条件：</b>
          {depends.join('；')}
        </div>
      ) : null}

      {extra}
    </div>
  )
}
