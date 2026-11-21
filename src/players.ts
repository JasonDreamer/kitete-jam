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
  /** 自動再生が止められていた Spotify を、本人が埋め込みの再生ボタンで鳴らした */
  onUserStarted?: () => void
  /** 本人が Spotify の埋め込みを直接操作した（シークバー・再生・一時停止） */
  onUserSeek?: (sec: number) => void
  onUserPause?: (sec: number) => void
  onUserPlay?: (sec: number) => void
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

const SP_STALE_MS = 3000

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
  private spKickTarget: number | null = null
  private spKickAt = 0
  private spKicks = 0
  private spReadyWaiter: (() => void) | null = null
  private spBlocked = false
  /** 先読み中なら、止めて戻す位置 */
  private preparing: {at: number} | null = null
  private prepareDone: (() => void) | null = null
  /** 開始の予約時刻（performance.now 基準）。0 なら予約なし */
  private scheduledAt = 0
  private spPaused = true
  /** こちらから Spotify に最後に操作を送った時刻 */
  private spOurAt = 0
  private startedAt = 0
  private spEndedFor: string | null = null

  private active: Kind | null = null
  private trackId: string | null = null
  private volume = 80
  /** デバッグ用の記録先 */
  log: (msg: string) => void = () => {}
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
                this.log(`← yt state ${e.data}`)
                if (e.data === 0 && this.active === 'yt' && this.trackId) this.ev.onEnded(this.trackId)
                if (e.data === 1 && this.preparing && this.active === 'yt') {
                  // 先読みで鳴り始めた。止めて先頭に戻し、音を戻す
                  this.yt.pauseVideo()
                  this.yt.seekTo(this.preparing.at, true)
                  this.yt.unMute()
                  this.loading = false
                  this.finishLoad()
                  return
                }
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
            if (this.preparing && this.active === 'sc') {
              // 先読みで鳴り始めた。止めて先頭に戻し、音量を戻す
              this.sc.pause()
              this.sc.seekTo(this.preparing.at * 1000)
              this.scPos = this.preparing.at
              this.sc.setVolume(this.volume)
              this.loading = false
              this.finishLoad()
              return
            }
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
            // デバッグ用に、こちらから送った操作を記録する
            for (const m of ['loadEntity', 'loadUri', 'seek', 'play', 'resume', 'pause', 'togglePlay']) {
              if (typeof ctrl[m] !== 'function') continue
              const orig = ctrl[m].bind(ctrl)
              ctrl[m] = (...args: unknown[]) => {
                this.log(`→ sp.${m}(${args.map(a => JSON.stringify(a)).join(', ')})`)
                this.spOurAt = performance.now()
                return orig(...args)
              }
            }
            ctrl.addListener('playback_started', (e: {data?: {playingURI?: string}}) =>
              this.log(`← sp started ${e.data?.playingURI ?? ''}`)
            )
            // 既定の loading="lazy" だと裏のタブで読み込まれないので即時にする
            const f = this.hosts.sp.querySelector('iframe')
            if (f) f.loading = 'eager'
            ctrl.addListener('ready', () => {
              this.log('← sp ready')
              const w = this.spReadyWaiter
              this.spReadyWaiter = null
              w?.()
              resolve()
            })
            ctrl.addListener(
              'playback_update',
              (e: {data: {isPaused: boolean; isBuffering: boolean; position: number; duration: number}}) => {
                const d = e.data
                this.log(
                  `← sp update pos=${(d.position / 1000).toFixed(2)} dur=${(d.duration / 1000).toFixed(1)}` +
                    `${d.isPaused ? ' paused' : ''}${d.isBuffering ? ' buffering' : ''}`
                )
                // 前回の位置から予想される今の位置。これと大きく違えば誰かがシークした
                const now = performance.now()
                const predicted = this.spPos + (this.spPlaying ? (now - this.spPosAt) / 1000 : 0)
                const wasPaused = this.spPaused
                const pos = d.position / 1000
                this.spPos = pos
                this.spPosAt = now
                this.spPaused = d.isPaused
                if (d.duration) this.spDur = d.duration / 1000
                this.spPlaying = !d.isPaused && !d.isBuffering
                if (this.spPlaying) this.loading = false
                // 鳴らした直後に埋め込みが勝手に止まって0秒に戻ることがある。
                // 同じ送り方（resume の直後に seek）でもう1回だけ試す
                const sinceKick = performance.now() - this.spKickAt
                const reverted = d.isPaused && d.position === 0 && this.spKickTarget != null && sinceKick < 2500
                if (reverted && this.spKicks < 1) {
                  this.spKicks++
                  const target = this.spKickTarget! + sinceKick / 1000 + 0.3
                  this.log('  勝手に止まった → もう一度')
                  setTimeout(() => this.active === 'sp' && this.kickSp(target), 300)
                } else if (reverted && !this.spBlocked) {
                  // 2回続けて戻された。ブラウザが自動再生を止めているので、
                  // 本人が埋め込みの再生ボタンを押すまで外からは鳴らさない
                  this.spBlocked = true
                  this.spKickTarget = null
                  this.spSeekTarget = null
                  this.log('  自動再生が止められている → 再生ボタン待ち')
                } else if (this.spBlocked && this.spPlaying) {
                  // 止められている間はこちらから鳴らしていないので、鳴り出したら本人が押した
                  this.spBlocked = false
                  this.spSeekTarget = null
                  this.log('  再生ボタンが押された')
                  this.ev.onUserStarted?.()
                }
                // 最後まで行くと位置が長さに達して止まる（一時停止の印は立たない）
                const atEnd = d.duration > 0 && d.position >= d.duration - 500
                // こちらが操作していないのに状態が変わったら、本人が埋め込みを直接触った。
                // こちらの操作の直後1.5秒は、その結果なので無視する（跳ね返りで部屋を動かさない）
                const ours = now - this.spOurAt < 1500
                if (!ours && !reverted && !atEnd && this.active === 'sp' && !this.isPreview) {
                  if (Math.abs(pos - predicted) > 2) {
                    this.log(`  埋め込みでシークされた → ${pos.toFixed(2)}`)
                    this.ev.onUserSeek?.(pos)
                  } else if (!wasPaused && d.isPaused) {
                    this.log('  埋め込みで一時停止された')
                    this.ev.onUserPause?.(pos)
                  } else if (wasPaused && !d.isPaused) {
                    this.log('  埋め込みで再生された')
                    this.ev.onUserPlay?.(pos)
                  }
                }
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

  /**
   * 曲を読み込む。
   * - play: すぐ鳴らす（途中から入った時）
   * - pause: 止めた状態で読み込む
   * - prepare: 先頭まで読み込んで止めて待つ（新しい曲を全員で同時に始めるため）
   * 鳴らせる状態になったら解決する
   */
  async load(track: Track, startSec: number, mode: 'play' | 'pause' | 'prepare') {
    this.trackId = track.id
    this.startedAt = 0
    this.loading = true
    this.scheduledAt = 0
    this.pauseOther(track.kind)
    this.active = track.kind
    this.show(track.kind)
    const playing = mode === 'play'
    const prepare = mode === 'prepare'
    // 読み込みが極端に遅くても、ほかの人を待たせ続けないように8秒で打ち切る
    const done = new Promise<void>(resolve => {
      this.prepareDone = resolve
      setTimeout(resolve, 8000)
    })

    if (track.kind === 'yt') {
      await this.initYt()
      if (this.trackId !== track.id) return
      this.yt.setVolume(this.volume)
      if (prepare) {
        // 消音で鳴らし始め、鳴った瞬間に止めて先頭に戻す（onStateChange 側）
        this.preparing = {at: startSec}
        this.yt.mute()
        this.yt.loadVideoById({videoId: track.ref, startSeconds: startSec})
      } else if (playing) {
        this.yt.loadVideoById({videoId: track.ref, startSeconds: startSec})
        this.finishLoad()
      } else {
        this.yt.cueVideoById({videoId: track.ref, startSeconds: startSec})
        this.loading = false
        this.finishLoad()
      }
    } else if (track.kind === 'sc') {
      const fresh = !this.scReady
      await this.initSc(track.ref)
      if (this.trackId !== track.id) return
      const after = () => {
        if (this.trackId !== track.id) return
        this.sc.getDuration((ms: number) => (this.scDur = ms / 1000))
        this.scPos = startSec
        this.sc.seekTo(startSec * 1000)
        if (prepare) {
          // 音量0で鳴らし始め、鳴った瞬間に止めて先頭に戻す（PLAY イベント側）
          this.preparing = {at: startSec}
          this.sc.setVolume(0)
          this.sc.play()
          return
        }
        this.sc.setVolume(this.volume)
        if (playing) this.sc.play()
        else this.loading = false
        this.finishLoad()
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
      if (prepare) {
        // Spotify は先に鳴らしておけないので、読み込み直した後の ready を待つ
        this.startSpAt(startSec, false)
        this.loading = true
        const finish = () => {
          if (this.spReadyWaiter === finish) this.spReadyWaiter = null
          this.loading = false
          this.finishLoad()
        }
        this.spReadyWaiter = finish
        setTimeout(() => this.spReadyWaiter === finish && finish(), 2000)
      } else {
        this.startSpAt(startSec, playing)
        this.finishLoad()
      }
    }
    await done
  }

  /** 先読みが終わった。開始の予約がもう来ていれば鳴らす */
  private finishLoad() {
    this.preparing = null
    const resolve = this.prepareDone
    this.prepareDone = null
    resolve?.()
    if (this.scheduledAt && performance.now() >= this.scheduledAt) {
      this.scheduledAt = 0
      this.play()
    }
  }

  /**
   * delayMs 後に鳴らす。同じ時刻の予約が何度来ても1回だけ。
   * 先読み中に時刻が来たら、先読みが終わった時点で鳴らす
   */
  scheduleStart(delayMs: number) {
    const at = performance.now() + delayMs
    if (this.scheduledAt && Math.abs(this.scheduledAt - at) < 100) return
    this.scheduledAt = at
    const id = this.trackId
    setTimeout(() => {
      if (this.trackId !== id || this.scheduledAt !== at) return
      if (this.preparing || this.loading) return // finishLoad で鳴らす
      this.scheduledAt = 0
      this.play()
    }, Math.max(0, delayMs))
  }

  /**
   * 位置を指定して Spotify の曲を読み込む。
   * 公式の loadEntity は startAt（秒）を受け取り、play した時にそこから始まる
   */
  private startSpAt(sec: number, playing: boolean) {
    // 秒単位でしか指定できない。すぐ鳴らす時は読み込みにかかる分だけ少し先を指定し、
    // 予約して待つ時はその位置ちょうどにする
    const at = Math.max(0, Math.floor(sec))
    if (typeof this.sp.loadEntity === 'function') this.sp.loadEntity(this.spUri, false, at)
    else this.sp.loadUri(this.spUri)
    // 実際の位置は埋め込みから返ってくるまで分からないので、仮の値で「再生中」にはしない
    this.spPos = at
    this.spPosAt = performance.now()
    this.spPlaying = false
    if (!playing) {
      this.loading = false
      return
    }
    // 読み込み直すと ready がもう一度来る。それを待ってから鳴らす（来なければ1.5秒で鳴らす）
    const t0 = performance.now()
    const id = this.trackId
    const go = () => {
      if (this.spReadyWaiter === go) this.spReadyWaiter = null
      if (this.trackId !== id) return
      this.spKicks = 0
      this.kickSp(sec + (performance.now() - t0) / 1000)
    }
    this.spReadyWaiter = go
    setTimeout(() => this.spReadyWaiter === go && go(), 1500)
  }

  /**
   * Spotify を鳴らす。ログで続けて鳴ったのは「resume の直後に seek」の時だけだったので、
   * play/resume 単体ではなく必ずこの組み合わせで送る
   */
  private kickSp(target: number) {
    if (!this.sp) return
    this.sp.resume()
    this.sp.seek(Math.max(0, Math.round(target)))
    this.spKickTarget = target
    this.spKickAt = performance.now()
    this.spSeekTarget = target
    this.spSeekAt = performance.now()
  }

  /**
   * シークが効いたかを、埋め込みから返ってくる実際の位置で確かめる。
   * （デバッグの記録用）
   */
  private verifySpSeek() {
    if (this.spSeekTarget == null || !this.sp) return
    const since = (performance.now() - this.spSeekAt) / 1000
    if (since < 3) return
    const actual = this.spNow()
    const target = this.spSeekTarget
    this.spSeekTarget = null
    // シーク先からそのまま止まっている場合も、そこから鳴り進んでいる場合も「効いた」とみなす
    const ok = Math.abs(actual - target) < 2.5 || Math.abs(actual - (target + since)) < 2.5
    this.log(`  seek 確認: 実際 ${actual.toFixed(2)} / 送った位置 ${target.toFixed(2)}${ok ? '' : ' → 効いていない'}`)
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
    this.spBlocked = false
    this.hosts.sp.replaceChildren()
  }

  private pauseOther(next: Kind) {
    if (next !== 'yt' && this.yt) this.yt.stopVideo?.()
    if (next !== 'sc' && this.sc) this.sc.pause()
    if (next !== 'sp' && this.sp && this.spPlaying) this.sp.pause()
  }

  clear() {
    this.trackId = null
    this.preparing = null
    this.scheduledAt = 0
    this.yt?.stopVideo?.()
    this.sc?.pause()
    if (this.sp && this.spPlaying) this.sp.pause()
    this.active = null
    this.show(null)
  }

  /** at を渡すと、Spotify はその位置で鳴らす（止まっていた位置ではなく部屋の位置から再開するため） */
  play(at?: number) {
    if (this.active === 'yt') this.yt?.playVideo()
    if (this.active === 'sc') this.sc?.play()
    // 部屋の状態が変わるたびに呼ばれるので、鳴らした直後は送り直さない
    if (this.active === 'sp' && !this.spPlaying && !this.spBlocked && performance.now() - this.spKickAt > 2500) {
      this.kickSp(at ?? this.spNow())
    }
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
      // 確かめている最中でも新しいシークは捨てない（以前は捨てていて、シークバーとずれた）
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
      this.verifySpSeek()
      const t = this.spNow()
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
    return this.active === 'sp' ? 2 : 0.8
  }

  /** 位置合わせをしてよい最短の間隔（ms）。Spotify は操作を重ねると固まるので長めに */
  get correctionInterval() {
    return this.active === 'sp' ? 8000 : 2000
  }

  /** 実際に音が出ているか（自動再生ブロックの検出用） */
  isPlaying(): boolean {
    if (this.active === 'yt') return this.yt?.getPlayerState?.() === 1
    if (this.active === 'sc') return this.scPlaying
    if (this.active === 'sp') return this.spPlaying && !this.spStale()
    return false
  }

  /** 再生中の Spotify は約1秒ごとに位置を返す。3秒以上来なければ埋め込みが止まっている */
  private spStale() {
    // 裏のタブでは更新が間引かれるので、止まったとは判定しない
    if (document.hidden) return false
    return performance.now() - this.spPosAt > SP_STALE_MS
  }

  /** 最後に返ってきた位置から、止まっていなければ経過時間を足す（足すのは最大3秒まで） */
  private spNow() {
    if (!this.spPlaying) return this.spPos
    return this.spPos + Math.min(performance.now() - this.spPosAt, SP_STALE_MS) / 1000
  }

  /**
   * 「合流する」ボタンから呼ぶ。クリックの中で呼ぶので自動再生の制限にかからない。
   * Spotify は位置を指定して読み込み直し、ほかは再生して位置を合わせる
   */
  rejoin(sec: number) {
    if (this.active === 'sp' && this.sp) {
      this.spRetries = 0
      this.startSpAt(sec, true)
      return
    }
    this.play()
    this.seek(sec)
  }

  /** Spotify の自動再生がブラウザに止められていて、埋め込みの再生ボタン待ち */
  get autoplayBlocked() {
    return this.active === 'sp' && this.spBlocked
  }

  /** 再生が始まってからの経過秒（始まっていなければ 0） */
  get playingFor() {
    if (!this.isPlaying()) return 0
    if (!this.startedAt) this.startedAt = performance.now()
    return (performance.now() - this.startedAt) / 1000
  }
}
