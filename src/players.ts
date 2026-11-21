import type {Kind, Track} from './sources'

/* 外部プレイヤー API の最小限の型 */
declare global {
  interface Window {
    YT?: any
    SC?: any
    onYouTubeIframeAPIReady?: () => void
    onSpotifyIframeApiReady?: (api: any) => void
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
    s.async = true
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

let spApi: Promise<any> | null = null
const ensureSp = () =>
  (spApi ??= new Promise<any>((resolve, reject) => {
    // スクリプトより先にコールバックを置かないと呼ばれない
    window.onSpotifyIframeApiReady = api => resolve(api)
    loadScript('https://open.spotify.com/embed/iframe-api/v1').catch(reject)
  }))

/** Spotify の埋め込みは未ログインだと30秒以内の試聴になる */
const PREVIEW_MAX_SEC = 31

/**
 * YouTube・SoundCloud・Spotify の埋め込みを同じ操作で扱う。
 * それぞれの iframe は一度だけ作り、曲が変わったら中身だけ差し替える。
 */
export class Deck {
  private yt: any = null
  private ytReady: Promise<void> | null = null

  private sc: any = null
  private scReady: Promise<void> | null = null
  private scPos = 0
  private scDur = 0
  private scPlaying = false

  private sp: any = null
  private spReady: Promise<void> | null = null
  private spPos = 0
  private spPosAt = 0
  private spDur = 0
  private spPlaying = false
  private spUri = ''
  /** 送ったシークが本当に効いたか確かめるための目標位置と、送った時刻 */
  private spSeekTarget: number | null = null
  private spSeekAt = 0
  private spSeekPlaying = false
  private spRetries = 0
  private spEndedFor: string | null = null

  private active: Kind | null = null
  private trackId: string | null = null
  private volume = 80
  /** 曲の読み込み中は時刻が当てにならないので同期補正を止める */
  loading = false

  constructor(
    private hosts: Record<Kind, HTMLElement>,
    private ev: PlayerEvents
  ) {}

  get currentId() {
    return this.trackId
  }

  get kind() {
    return this.active
  }

  /** Spotify が30秒の試聴になっているか（ログインしていない） */
  get isPreview() {
    return this.active === 'sp' && this.spDur > 0 && this.spDur <= PREVIEW_MAX_SEC
  }

  /** 音量を変えられるか（Spotify の埋め込みは音量 API が無い） */
  get canSetVolume() {
    return this.active !== 'sp'
  }

  private initYt() {
    return (this.ytReady ??= ensureYt().then(
      () =>
        new Promise<void>(resolve => {
          const el = document.createElement('div')
          this.hosts.yt.append(el)
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
                    ? '埋め込み再生できない動画です'
                    : e.data === 100
                      ? '削除されたか非公開の動画です'
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
          f.title = 'SoundCloud'
          f.src = `https://w.soundcloud.com/player/?url=${encodeURIComponent(firstUrl)}&auto_play=false&visual=true&show_comments=false&hide_related=true`
          this.hosts.sc.append(f)
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
            if (this.active === 'sc' && this.trackId) this.ev.onError(this.trackId, 'SoundCloud で再生できない曲です')
          })
        })
    ))
  }

  private initSp(firstUri: string) {
    return (this.spReady ??= ensureSp().then(
      api =>
        new Promise<void>(resolve => {
          const el = document.createElement('div')
          this.hosts.sp.append(el)
          api.createController(el, {uri: firstUri, width: '100%', height: '100%'}, (ctrl: any) => {
            this.sp = ctrl
            // 既定の loading="lazy" だと裏のタブで読み込まれないので即時にする
            const f = this.hosts.sp.querySelector('iframe')
            if (f) f.loading = 'eager'
            ctrl.addListener('ready', () => resolve())
            ctrl.addListener(
              'playback_update',
              (e: {data: {isPaused: boolean; isBuffering: boolean; position: number; duration: number}}) => {
                const d = e.data
                this.spPos = d.position / 1000
                this.spPosAt = performance.now()
                if (d.duration) this.spDur = d.duration / 1000
                this.spPlaying = !d.isPaused && !d.isBuffering
                if (this.spPlaying) this.loading = false
                // 最後まで行くと位置が長さに達して止まる（一時停止の印は立たない）
                const atEnd = d.duration > 0 && d.position >= d.duration - 500
                if (atEnd) this.spPlaying = false
                if (atEnd && this.active === 'sp' && this.trackId && this.spEndedFor !== this.trackId) {
                  this.spEndedFor = this.trackId
                  this.ev.onEnded(this.trackId)
                }
              }
            )
          })
        })
    ))
  }

  private show(kind: Kind | null) {
    for (const k of Object.keys(this.hosts) as Kind[]) this.hosts[k].hidden = k !== kind
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
    } else if (track.kind === 'sc') {
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
    } else {
      this.spDur = 0
      this.spPos = startSec
      this.spPosAt = performance.now()
      await this.initSp(track.ref)
      if (this.trackId !== track.id) return
      this.spUri = track.ref
      this.spRetries = 0
      this.startSpAt(startSec, playing)
    }
  }

  /**
   * 位置を指定して Spotify の曲を読み込む。
   * 公式の loadEntity は startAt（秒）を受け取り、play した時にそこから始まる
   */
  private startSpAt(sec: number, playing: boolean) {
    // 秒単位でしか指定できず、読み込みにも少しかかるので、切り捨てずに少し先を指定する
    const at = Math.max(0, Math.round(sec + 0.5))
    if (typeof this.sp.loadEntity === 'function') this.sp.loadEntity(this.spUri, false, at)
    else this.sp.loadUri(this.spUri)
    this.spPos = at
    this.spPosAt = performance.now()
    if (playing) {
      this.sp.play()
      this.spSeekTarget = at
      this.spSeekAt = performance.now()
      this.spSeekPlaying = true
    } else {
      this.loading = false
    }
  }

  /**
   * シークが効いたかを、埋め込みから返ってくる実際の位置で確かめる。
   * 3秒たってもずれていたら、位置を指定して読み込み直す（2回まで）
   */
  private verifySpSeek() {
    if (this.spSeekTarget == null || !this.sp) return
    const since = (performance.now() - this.spSeekAt) / 1000
    if (since < 3) return
    const want = this.spSeekTarget + (this.spSeekPlaying ? since : 0)
    const actual = this.spPos + (this.spPlaying ? (performance.now() - this.spPosAt) / 1000 : 0)
    this.spSeekTarget = null
    if (Math.abs(actual - want) > 2.5 && this.spRetries < 2) {
      this.spRetries++
      this.startSpAt(want, this.spSeekPlaying)
    }
  }

  /**
   * Spotify の埋め込みは、読み込んだ瞬間のログイン状態でフル再生か試聴かを決める。
   * ログインし直した後は、プレイヤーを作り直さないと試聴のまま変わらない
   */
  resetSpotify() {
    try {
      this.sp?.destroy()
    } catch {
      /* すでに消えていても構わない */
    }
    this.sp = null
    this.spReady = null
    this.spPlaying = false
    this.spDur = 0
    this.spEndedFor = null
    this.spSeekTarget = null
    this.hosts.sp.replaceChildren()
  }

  private pauseOther(next: Kind) {
    if (next !== 'yt' && this.yt) this.yt.stopVideo?.()
    if (next !== 'sc' && this.sc) this.sc.pause()
    if (next !== 'sp' && this.sp && this.spPlaying) this.sp.pause()
  }

  clear() {
    this.trackId = null
    this.yt?.stopVideo?.()
    this.sc?.pause()
    if (this.sp && this.spPlaying) this.sp.pause()
    this.active = null
    this.show(null)
  }

  play() {
    if (this.active === 'yt') this.yt?.playVideo()
    if (this.active === 'sc') this.sc?.play()
    if (this.active === 'sp' && !this.spPlaying) this.sp?.resume()
  }

  pause() {
    if (this.active === 'yt') this.yt?.pauseVideo()
    if (this.active === 'sc') this.sc?.pause()
    if (this.active === 'sp' && this.spPlaying) this.sp?.pause()
  }

  seek(sec: number) {
    if (this.active === 'yt') this.yt?.seekTo(sec, true)
    if (this.active === 'sc') {
      this.scPos = sec
      this.sc?.seekTo(sec * 1000)
    }
    if (this.active === 'sp' && this.sp) {
      // 確かめている最中は重ねて送らない
      if (this.spSeekTarget != null) return
      this.sp.seek(Math.round(sec))
      this.spSeekTarget = sec
      this.spSeekAt = performance.now()
      this.spSeekPlaying = this.spPlaying
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
    if (this.active === 'sp') {
      // playback_update は間隔があくので、再生中は経過時間で補う
      this.verifySpSeek()
      const t = this.spPos + (this.spPlaying ? (performance.now() - this.spPosAt) / 1000 : 0)
      return this.spDur ? Math.min(t, this.spDur) : t
    }
    return 0
  }

  duration(): number {
    if (this.active === 'yt') return this.yt?.getDuration?.() ?? 0
    if (this.active === 'sc') return this.scDur
    if (this.active === 'sp') return this.spDur
    return 0
  }

  /** 位置合わせの許容差。Spotify は秒単位でしか seek できない */
  get tolerance() {
    return this.active === 'sp' ? 1.5 : 0.8
  }

  /** 実際に音が出ているか（自動再生ブロックの検出用） */
  isPlaying(): boolean {
    if (this.active === 'yt') return this.yt?.getPlayerState?.() === 1
    if (this.active === 'sc') return this.scPlaying
    if (this.active === 'sp') return this.spPlaying
    return false
  }
}
