import {joinRoom, type TurnServerConfig} from 'trystero'
import type {Track} from './sources'

/** 再生位置は「書いた人の時計で at の瞬間に pos 秒」で持つ */
export type Play = {playing: boolean; pos: number; at: number}

export type LogEntry = {at: number; text: string; trackId?: string; kind: 'played' | 'event'}

export type JamState = {
  now: Track | null
  play: Play
  queue: Track[]
  log: LogEntry[]
}

const EMPTY: JamState = {now: null, play: {playing: false, pos: 0, at: 0}, queue: [], log: []}
const LOG_MAX = 60
const START_DELAY_MS = 2000

/** Spotify の試聴（30秒）が終わったことを知らせる時の印 */
export const PREVIEW_ENDED = 'preview-ended'

export type Route = '直接' | 'TURN経由' | 'ほかの人経由' | '確認中'

export const APP_ID = 'kitete-jam/v1'

export class Jam {
  readonly room
  readonly state
  readonly profile
  private clock
  private cantPlay
  /** trackId ごとに「再生できなかった」と言ってきた peerId */
  private failures = new Map<string, {peers: Set<string>; reason: string}>()
  /** peerId ごとの時計のずれ（相手の時計 − 自分の時計, ms） */
  private offsets = new Map<string, {offset: number; rtt: number}>()
  selfPeerId = ''

  readonly hasTurn: boolean

  constructor(roomId: string, turnConfig: TurnServerConfig[] = []) {
    this.hasTurn = turnConfig.length > 0
    this.room = joinRoom(
      // 部屋IDを合言葉にも使う。URLを知らない人は同じ部屋を見つけられない
      {appId: APP_ID, password: roomId, identity: 'none', ...(this.hasTurn ? {turnConfig} : {})},
      roomId
    )
    this.state = this.room.makeState<JamState>('jam', EMPTY, {maxBytes: 65536})
    this.profile = this.room.makeUserState<{name: string}>('profile', {name: ''})
    this.clock = this.room.makeAction<number, number>('clock', {kind: 'request'})
    this.clock.onRequest(() => Date.now())
    this.cantPlay = this.room.makeAction<{trackId: string; reason: string}>('cant-play')
    this.cantPlay.onMessage(({trackId, reason}, {peerId}) => this.noteFailure(trackId, reason, peerId))

    this.room.getSelf().then(s => (this.selfPeerId = s.peerId))
    this.room.onPeerJoin(({peerId}) => void this.measure(peerId))
    this.room.onPeerLeave(({peerId}) => this.offsets.delete(peerId))
    setInterval(() => Object.keys(this.room.getPeers()).forEach(p => void this.measure(p)), 20_000)
  }

  /** NTP と同じ考え方で相手の時計のずれを測る。RTT が一番短かった測定を採用 */
  private async measure(peerId: string) {
    for (let i = 0; i < 3; i++) {
      try {
        const t0 = Date.now()
        const remote = await this.clock.request(0, {target: peerId, timeoutMs: 3000})
        const t1 = Date.now()
        const rtt = t1 - t0
        const offset = remote + rtt / 2 - t1
        const prev = this.offsets.get(peerId)
        if (!prev || rtt <= prev.rtt) this.offsets.set(peerId, {offset, rtt})
      } catch {
        return
      }
    }
  }

  /** 最後に state を書いた人の時計を自分の時計に直すためのずれ */
  authorOffset(): number {
    const meta = this.state.getMeta()
    if (!meta || meta.peerId === this.selfPeerId) return 0
    return this.offsets.get(meta.peerId)?.offset ?? 0
  }

  /** いま何秒の位置にいるべきか */
  /** 曲の開始が予約されている時、開始までの残り ms（予約がなければ 0） */
  startDelay(s: JamState = this.state.get()): number {
    if (!s.play.playing) return 0
    return Math.max(0, s.play.at - this.authorOffset() - Date.now())
  }

  /**
   * 再生位置を自分の時計で書き直す。
   * 開始が予約されている間は、予約時刻を残したまま自分の時計に直す
   */
  private rebase(s: JamState): Play {
    const p = s.play
    const atLocal = p.at - this.authorOffset()
    if (p.playing && atLocal > Date.now()) return {...p, at: atLocal}
    return {...p, pos: this.expectedPos(s), at: Date.now()}
  }

  expectedPos(s: JamState = this.state.get()): number {
    const p = s.play
    if (!p.playing) return p.pos
    const atLocal = p.at - this.authorOffset()
    return p.pos + Math.max(0, Date.now() - atLocal) / 1000
  }

  /** 自動で次の曲へ送る係。全員が同時に送らないよう、peerId が一番小さい人が担当 */
  isLeader(): boolean {
    const ids = [this.selfPeerId, ...Object.keys(this.room.getPeers())].filter(Boolean).sort()
    return ids[0] === this.selfPeerId
  }

  /** 接続の様子。相手ごとの往復時間と、直接か中継（TURN）か */
  async connections(): Promise<{name: string; rtt: number | null; route: Route}[]> {
    const names = this.profile.getAll()
    return Promise.all(
      Object.entries(this.room.getPeers()).map(async ([peerId, info]) => {
        let route: Route = '確認中'
        try {
          const stats = await info.connection?.getStats()
          stats?.forEach(r => {
            if (r.type !== 'candidate-pair' || r.state !== 'succeeded' || r.nominated === false) return
            const local = stats.get(r.localCandidateId)
            const remote = stats.get(r.remoteCandidateId)
            route = local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'TURN経由' : '直接'
          })
        } catch {
          /* 取れなければ確認中のまま */
        }
        // 人数が多いと Trystero がほかの参加者を経由して届けることがある
        if (!info.direct) route = 'ほかの人経由'
        return {
          name: names[info.userId]?.name || '名無し',
          rtt: this.offsets.get(peerId)?.rtt ?? null,
          route
        }
      })
    )
  }

  /**
   * 再生できなかったことを全員に知らせる。
   * 地域制限のように一部の人だけ再生できない曲もあるので、半数以上が再生できない時だけ飛ばす
   */
  reportFailure(trackId: string, reason: string) {
    void this.cantPlay.send({trackId, reason})
    this.noteFailure(trackId, reason, this.selfPeerId)
  }

  private noteFailure(trackId: string, reason: string, peerId: string) {
    const f = this.failures.get(trackId) ?? {peers: new Set<string>(), reason}
    f.peers.add(peerId)
    this.failures.set(trackId, f)
    const total = 1 + Object.keys(this.room.getPeers()).length
    // 試聴で終わっただけなら、最後まで聴けている人がいる限り進めない
    const enough = reason === PREVIEW_ENDED ? f.peers.size >= total : f.peers.size * 2 >= total
    if (this.isLeader() && enough && this.state.get().now?.id === trackId) {
      void this.next(trackId, reason === PREVIEW_ENDED ? null : `スキップしました: ${f.reason}`)
    }
  }

  myName(): string {
    return this.profile.get()?.name || '名無し'
  }

  names(): string[] {
    return Object.values(this.profile.getAll())
      .map(p => p?.name)
      .filter((n): n is string => !!n)
  }

  private update(fn: (s: JamState) => JamState) {
    // 他の人の書き込みの時刻をそのまま引き継ぐと時計のずれが混ざるので、
    // 書き換えるたびに再生位置を自分の時計で書き直す
    return this.state.set(prev => {
      const base: JamState = {
        ...prev,
        play: this.rebase(prev)
      }
      const out = fn(base)
      return out === base ? prev : out
    })
  }

  private log(s: JamState, text: string, extra: Partial<LogEntry> = {}): LogEntry[] {
    return [...s.log, {at: Date.now(), text, kind: 'event' as const, ...extra}].slice(-LOG_MAX)
  }

  private startTrack(s: JamState, t: Track, queue: Track[], note: string | null): JamState {
    return {
      ...s,
      now: t,
      queue,
      // 各端末が読み込み終わるまで待ってから全員で同時に始める
      play: {playing: true, pos: 0, at: Date.now() + START_DELAY_MS},
      log: [
        ...(note ? this.log(s, note) : s.log),
        {at: Date.now(), text: t.title, trackId: t.id, kind: 'played' as const}
      ].slice(-LOG_MAX)
    }
  }

  add(t: Track) {
    return this.update(s => {
      if (!s.now) return this.startTrack(s, t, s.queue, `${t.addedBy}さんが「${t.title}」を追加`)
      return {...s, queue: [...s.queue, t], log: this.log(s, `${t.addedBy}さんが「${t.title}」を追加`)}
    })
  }

  /** fromId が今の曲のときだけ次へ進む。複数人が同時に押しても二曲飛ばない */
  /** reason が null の時は、曲が終わって自然に進んだだけなので知らせない */
  next(fromId: string | null, reason?: string | null) {
    return this.update(s => {
      if ((s.now?.id ?? null) !== fromId) return s
      const [head, ...rest] = s.queue
      const note = reason === undefined ? `${this.myName()}さんがスキップ` : reason
      if (!head) {
        return {...s, now: null, play: {playing: false, pos: 0, at: Date.now()}, log: note ? this.log(s, note) : s.log}
      }
      return this.startTrack(s, head, rest, note)
    })
  }

  /** pos を渡すと、その位置で再生／停止する（埋め込みを直接操作された時の位置を使う） */
  setPlaying(playing: boolean, pos?: number) {
    return this.update(s => {
      if (!s.now || s.play.playing === playing) return s
      return {
        ...s,
        play: {...s.play, playing, ...(pos == null ? {} : {pos, at: Date.now()})},
        log: this.log(s, `${this.myName()}さんが${playing ? '再生' : '一時停止'}`)
      }
    })
  }

  seek(pos: number) {
    return this.update(s => (s.now ? {...s, play: {...s.play, pos, at: Date.now()}} : s))
  }

  remove(id: string) {
    return this.update(s => {
      const t = s.queue.find(q => q.id === id)
      if (!t) return s
      return {...s, queue: s.queue.filter(q => q.id !== id), log: this.log(s, `${this.myName()}さんが「${t.title}」を外しました`)}
    })
  }

  moveUp(id: string) {
    return this.update(s => {
      const i = s.queue.findIndex(q => q.id === id)
      if (i <= 0) return s
      const q = [...s.queue]
      ;[q[i - 1], q[i]] = [q[i], q[i - 1]]
      return {...s, queue: q}
    })
  }
}
