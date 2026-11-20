import type {Kind, Track} from './sources'

/* 外部プレイヤー API の最小限の型 */
declare global {
  interface Window {
    YT?: any
    SC?: any
    onYouTubeIframeAPIReady?: () => void
  }
}

export type PlayerEvents = {
  onEnded: (trackId: string) => void
  onError: (trackId: string, reason: string) => void
}

const loadScript = (src: string) =>
  new Promise<void>((resolve, reject) => {
    const s = document.createElement('script')
    s.src = src
    s.onload = () => resolve()
    s.onerror = () => reject(new Error(`読み込み失敗: ${src}`))
    document.head.append(s)
  })

let ytApi: Promise<void> | null = null
const ensureYt = () =>
  (ytApi ??= new Promise<void>((resolve, reject) => {
    if (window.YT?.Player) return resolve()
    window.onYouTubeIframeAPIReady = () => resolve()
    loadScript('https://www.youtube.com/iframe_api').catch(reject)
  }))

let scApi: Promise<void> | null = null
const ensureSc = () => (scApi ??= window.SC?.Widget ? Promise.resolve() : loadScript('https://w.soundcloud.com/player/api.js'))

/**
 * YouTube と SoundCloud の埋め込みを同じ操作で扱う。
 * どちらの iframe も一度だけ作り、曲が変わったら中身だけ差し替える。
 */
export class Deck {
  private yt: any = null
  private ytReady: Promise<void> | null = null
  private sc: any = null
  private scReady: Promise<void> | null = null
  private scPos = 0
  private scDur = 0
  private scPlaying = false
  private active: Kind | null = null
  private trackId: string | null = null
  private volume = 80
  /** 曲の読み込み中は時刻が当てにならないので同期補正を止める */
  loading = false

  constructor(
    private ytHost: HTMLElement,
    private scHost: HTMLElement,
    private ev: PlayerEvents
  ) {}

  get currentId() {
    return this.trackId
  }

  private initYt() {
    return (this.ytReady ??= ensureYt().then(
      () =>
        new Promise<void>(resolve => {
          const el = document.createElement('div')
          this.ytHost.append(el)
          this.yt = new window.YT.Player(el, {
            width: '100%',
            height: '100%',
            playerVars: {playsinline: 1, rel: 0, disablekb: 1, modestbranding: 1},
            events: {
              onReady: () => resolve(),
              onStateChange: (e: {data: number}) => {
                if (e.data === 0 && this.active === 'yt' && this.trackId) this.ev.onEnded(this.trackId)
                if (e.data === 1) this.loading = false
              },
              onError: (e: {data: number}) => {
                if (this.active !== 'yt' || !this.trackId) return
                const reason =
                  e.data === 101 || e.data === 150
                    ? '投稿者が埋め込み再生を許可していない動画でした'
                    : e.data === 100
                      ? '削除されたか非公開の動画でした'
                      : `YouTube のエラー ${e.data}`
                this.ev.onError(this.trackId, reason)
              }
            }
          })
        })
    ))
  }

  private initSc(firstUrl: string) {
    return (this.scReady ??= ensureSc().then(
      () =>
        new Promise<void>(resolve => {
          const f = document.createElement('iframe')
          f.allow = 'autoplay'
          f.title = 'SoundCloud プレイヤー'
          f.src = `https://w.soundcloud.com/player/?url=${encodeURIComponent(firstUrl)}&auto_play=false&visual=true&show_comments=false&hide_related=true`
          this.scHost.append(f)
          const W = window.SC.Widget
          this.sc = W(f)
          this.sc.bind(W.Events.READY, () => resolve())
          this.sc.bind(W.Events.PLAY_PROGRESS, (e: {currentPosition: number}) => {
            this.scPos = e.currentPosition / 1000
          })
          this.sc.bind(W.Events.PLAY, () => {
            this.loading = false
            this.scPlaying = true
          })
          this.sc.bind(W.Events.PAUSE, () => (this.scPlaying = false))
          this.sc.bind(W.Events.FINISH, () => {
            this.scPlaying = false
            if (this.active === 'sc' && this.trackId) this.ev.onEnded(this.trackId)
          })
          this.sc.bind(W.Events.ERROR, () => {
            if (this.active === 'sc' && this.trackId) this.ev.onError(this.trackId, 'SoundCloud で再生できない曲でした')
          })
        })
    ))
  }

  private show(kind: Kind | null) {
    this.ytHost.hidden = kind !== 'yt'
    this.scHost.hidden = kind !== 'sc'
  }

  async load(track: Track, startSec: number, playing: boolean) {
    this.trackId = track.id
    this.loading = true
    this.pauseOther(track.kind)
    this.active = track.kind
    this.show(track.kind)

    if (track.kind === 'yt') {
      await this.initYt()
      if (this.trackId !== track.id) return
      this.yt.setVolume(this.volume)
      if (playing) this.yt.loadVideoById({videoId: track.ref, startSeconds: startSec})
      else {
        this.yt.cueVideoById({videoId: track.ref, startSeconds: startSec})
        this.loading = false
      }
    } else {
      const fresh = !this.scReady
      await this.initSc(track.ref)
      if (this.trackId !== track.id) return
      const after = () => {
        if (this.trackId !== track.id) return
        this.sc.setVolume(this.volume)
        this.sc.getDuration((ms: number) => (this.scDur = ms / 1000))
        this.scPos = startSec
        this.sc.seekTo(startSec * 1000)
        if (playing) this.sc.play()
        else this.loading = false
      }
      if (fresh) after()
      else this.sc.load(track.ref, {auto_play: false, visual: true, show_comments: false, hide_related: true, callback: after})
    }
  }

  private pauseOther(next: Kind) {
    if (next !== 'yt' && this.yt) this.yt.stopVideo?.()
    if (next !== 'sc' && this.sc) this.sc.pause()
  }

  clear() {
    this.trackId = null
    this.yt?.stopVideo?.()
    this.sc?.pause()
    this.active = null
    this.show(null)
  }

  play() {
    if (this.active === 'yt') this.yt?.playVideo()
    if (this.active === 'sc') this.sc?.play()
  }

  pause() {
    if (this.active === 'yt') this.yt?.pauseVideo()
    if (this.active === 'sc') this.sc?.pause()
  }

  seek(sec: number) {
    if (this.active === 'yt') this.yt?.seekTo(sec, true)
    if (this.active === 'sc') {
      this.scPos = sec
      this.sc?.seekTo(sec * 1000)
    }
  }

  /** 0 から 100 */
  setVolume(v: number) {
    this.volume = v
    this.yt?.setVolume?.(v)
    this.sc?.setVolume?.(v)
  }

  time(): number {
    if (this.active === 'yt') return this.yt?.getCurrentTime?.() ?? 0
    if (this.active === 'sc') return this.scPos
    return 0
  }

  duration(): number {
    if (this.active === 'yt') return this.yt?.getDuration?.() ?? 0
    if (this.active === 'sc') return this.scDur
    return 0
  }

  /** 実際に音が出ているか（自動再生ブロックの検出用） */
  isPlaying(): boolean {
    if (this.active === 'yt') return this.yt?.getPlayerState?.() === 1
    if (this.active === 'sc') return this.scPlaying
    return false
  }
}
