export type Kind = 'yt' | 'sc'

export type Track = {
  id: string
  kind: Kind
  /** YouTube なら動画ID、SoundCloud なら曲ページのURL */
  ref: string
  url: string
  title: string
  thumb: string
  addedBy: string
}

export type Parsed = {kind: Kind; ref: string; url: string}

const YT_ID = /^[\w-]{11}$/

export const parseUrl = (raw: string): Parsed | {error: string} => {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return {error: 'URLとして読めませんでした'}
  }
  const host = u.hostname.replace(/^(www|m|music)\./, '')

  if (host === 'youtu.be') {
    const id = u.pathname.slice(1, 12)
    if (YT_ID.test(id)) return {kind: 'yt', ref: id, url: raw.trim()}
  }
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const v = u.searchParams.get('v')
    if (v && YT_ID.test(v)) return {kind: 'yt', ref: v, url: raw.trim()}
    const m = u.pathname.match(/^\/(shorts|embed|live)\/([\w-]{11})/)
    if (m) return {kind: 'yt', ref: m[2], url: raw.trim()}
    if (u.searchParams.get('list')) {
      return {error: 'プレイリストはまだ未対応です。曲ごとのURLを貼ってください'}
    }
    return {error: 'YouTube の動画URLが見つかりませんでした'}
  }
  if (host === 'soundcloud.com' || host === 'on.soundcloud.com') {
    if (u.pathname.includes('/sets/')) {
      return {error: 'SoundCloud のプレイリスト（sets）はまだ未対応です。曲ごとのURLを貼ってください'}
    }
    if (u.pathname.split('/').filter(Boolean).length < (host === 'on.soundcloud.com' ? 1 : 2)) {
      return {error: 'SoundCloud の曲ページのURLを貼ってください'}
    }
    const clean = `${u.origin}${u.pathname}`
    return {kind: 'sc', ref: clean, url: clean}
  }
  return {error: 'いまは YouTube と SoundCloud のURLに対応しています'}
}

/** oEmbed で曲名とサムネを取る。取れなくても追加はできる */
export const fetchMeta = async (p: Parsed): Promise<{title: string; thumb: string}> => {
  const endpoint =
    p.kind === 'yt'
      ? `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(
          `https://www.youtube.com/watch?v=${p.ref}`
        )}`
      : `https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(p.ref)}`
  try {
    const res = await fetch(endpoint)
    if (!res.ok) throw new Error(String(res.status))
    const j = (await res.json()) as {title?: string; thumbnail_url?: string}
    return {title: j.title ?? p.url, thumb: j.thumbnail_url ?? ''}
  } catch {
    return {
      title: p.kind === 'yt' ? `YouTube ${p.ref}` : decodeURIComponent(p.ref.split('/').slice(-2).join(' / ')),
      thumb: p.kind === 'yt' ? `https://i.ytimg.com/vi/${p.ref}/mqdefault.jpg` : ''
    }
  }
}
