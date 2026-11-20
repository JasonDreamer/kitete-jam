export type Kind = 'yt' | 'sc' | 'sp'

export type Track = {
  id: string
  kind: Kind
  /** YouTube なら動画ID、SoundCloud なら曲ページのURL、Spotify なら spotify:track:ID */
  ref: string
  url: string
  title: string
  /** チャンネル名やアーティスト名。取れない時は空 */
  artist: string
  thumb: string
  addedBy: string
}

export type Parsed = {kind: Kind; ref: string; url: string}

const YT_ID = /^[\w-]{11}$/

const SP_ID = /^[0-9A-Za-z]{22}$/

export const parseUrl = (raw: string): Parsed | {error: string} => {
  const sp = raw.trim().match(/^spotify:track:([0-9A-Za-z]{22})$/)
  if (sp) return {kind: 'sp', ref: `spotify:track:${sp[1]}`, url: `https://open.spotify.com/track/${sp[1]}`}
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
  if (host === 'open.spotify.com' || host === 'play.spotify.com') {
    // /intl-ja/track/ID のような言語つきURLもある
    const m = u.pathname.match(/\/track\/([0-9A-Za-z]+)/)
    if (m && SP_ID.test(m[1])) {
      return {kind: 'sp', ref: `spotify:track:${m[1]}`, url: `https://open.spotify.com/track/${m[1]}`}
    }
    if (/\/(album|playlist|artist)\//.test(u.pathname)) {
      return {error: 'Spotify は曲のリンクを貼ってください（アルバムやプレイリストは未対応）'}
    }
    return {error: 'Spotify の曲のリンクが見つかりませんでした'}
  }
  return {error: 'YouTube・SoundCloud・Spotify のリンクに対応しています'}
}

/** oEmbed で曲名とサムネを取る。取れなくても追加はできる */
export const fetchMeta = async (p: Parsed): Promise<{title: string; artist: string; thumb: string}> => {
  const target = p.kind === 'yt' ? `https://www.youtube.com/watch?v=${p.ref}` : p.url
  const endpoint = {
    yt: 'https://www.youtube.com/oembed?format=json&url=',
    sc: 'https://soundcloud.com/oembed?format=json&url=',
    sp: 'https://open.spotify.com/oembed?url='
  }[p.kind] + encodeURIComponent(target)
  try {
    const res = await fetch(endpoint)
    if (!res.ok) throw new Error(String(res.status))
    const j = (await res.json()) as {title?: string; author_name?: string; thumbnail_url?: string}
    let title = j.title ?? p.url
    const artist = j.author_name ?? ''
    // SoundCloud の oEmbed は「曲名 by 名前」で返すので名前を取り除く
    if (artist && title.endsWith(` by ${artist}`)) title = title.slice(0, -` by ${artist}`.length)
    return {title, artist, thumb: j.thumbnail_url ?? ''}
  } catch {
    return {
      title:
        p.kind === 'yt'
          ? `YouTube ${p.ref}`
          : p.kind === 'sp'
            ? 'Spotify の曲'
            : decodeURIComponent(p.ref.split('/').slice(-2).join(' / ')),
      artist: '',
      thumb: p.kind === 'yt' ? `https://i.ytimg.com/vi/${p.ref}/mqdefault.jpg` : ''
    }
  }
}
