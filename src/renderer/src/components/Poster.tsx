import { useEffect, useState } from 'react'

interface PosterProps {
  src?: string
  name: string
  className?: string
}

/**
 * 海报图。第三方站点的图床经常挂，必须给失败兜底，
 * 否则海报墙会出现一片破图。
 */
export function Poster({ src, name, className = '' }: PosterProps): JSX.Element {
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setFailed(false)
  }, [src])

  const usable = Boolean(src) && !failed

  return (
    <div className={`poster ${className}`}>
      {usable ? (
        <img src={src} alt="" loading="lazy" draggable={false} onError={() => setFailed(true)} />
      ) : (
        <span className="poster-fallback">{(name || '?').trim().slice(0, 1)}</span>
      )}
    </div>
  )
}
