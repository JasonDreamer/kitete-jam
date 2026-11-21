/// <reference types="vite/client" />
import {Jam, PREVIEW_ENDED, type JamState, type LogEntry} from './jam'
import {Deck} from './players'
import {fetchMeta, parseUrl, type Kind, type Track} from './sources'
import {loadTurn} from './turn'

const app = document.getElementById('app')!

const NAME_KEY = 'kitete-jam:name'
const VOL_KEY = 'kitete-jam:volume'
const TAB_KEY = 'kitete-jam:tab'
const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k)
    } catch {
      return null
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v)
    } catch {
      /* プライベートウィンドウなどでは保存しない */
    }
  }
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]!)

const fmt = (sec: number) => {
  if (!isFinite(sec) || sec < 0) sec = 0
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}


const SOURCE: Record<Kind, string> = {yt: 'YouTube', sc: 'SoundCloud', sp: 'Spotify'}

/* アイコンは操作の意味が一目でわかる最小限の形だけ */
const icon = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>',
  next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5.5v13l9-6.5zM16 5.5h2.5v13H16z"/></svg>',
  volume:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M15 9a4 4 0 0 1 0 6M17.5 6.5a7.5 7.5 0 0 1 0 11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  close:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  up: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6l-6 7h12z"/></svg>'
}

/* ---------- 招待コード ---------- */

// 読み間違えやすい 0/O、1/I/L を除いた31文字から8文字。部屋IDと暗号の合言葉を兼ねる
const CODE_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
const CODE_LEN = 8

const newCode = () => {
  const a = new Uint32Array(CODE_LEN)
  crypto.getRandomValues(a)
  return Array.from(a, n => CODE_CHARS[n % CODE_CHARS.length]).join('')
}

const normalizeCode = (raw: string) => raw.toUpperCase().replace(/[^0-9A-Z]/g, '')
const isValidCode = (c: string) => c.length === CODE_LEN && [...c].every(ch => CODE_CHARS.includes(ch))
const showCode = (c: string) => `${c.slice(0, 4)}-${c.slice(4)}`

const roomFromHash = () => {
  const r = new URLSearchParams(location.hash.slice(1)).get('r')
  return r ? normalizeCode(r) : null
}

const art = (t: Track | null | undefined, cls: string) =>
  t?.thumb
    ? `<img class="${cls}" src="${esc(t.thumb)}" alt="" loading="lazy" />`
    : `<span class="${cls} art-none" aria-hidden="true"></span>`

const initial = (name: string) => [...name.trim()][0]?.toUpperCase() ?? '?'

/* ---------- 入口 ---------- */

const renderEntry = () => {
  const fromLink = roomFromHash()
  app.innerHTML = `
    <section class="entry">
      <h1 class="brand brand-lg">kitete jam</h1>
      <form class="entry-form" id="entry" novalidate>
        <label class="field">
          <span>名前</span>
          <input id="name" maxlength="20" autocomplete="nickname" />
        </label>
        <label class="field">
          <span>招待コード</span>
          <input id="code" class="code-input" maxlength="12" autocomplete="off" autocapitalize="characters"
            spellcheck="false" placeholder="XXXX-XXXX" />
        </label>
        <p id="entry-msg" class="form-msg" role="alert"></p>
        <button class="btn btn-primary" type="submit" value="join">参加する</button>
        <button class="btn btn-quiet" type="submit" value="create">新しい部屋をつくる</button>
      </form>
    </section>`
  const nameIn = app.querySelector<HTMLInputElement>('#name')!
  const codeIn = app.querySelector<HTMLInputElement>('#code')!
  const msg = app.querySelector<HTMLElement>('#entry-msg')!
  nameIn.value = store.get(NAME_KEY) ?? ''
  if (fromLink) codeIn.value = showCode(fromLink)
  ;(nameIn.value ? codeIn : nameIn).focus()

  app.querySelector<HTMLFormElement>('#entry')!.addEventListener('submit', e => {
    e.preventDefault()
    const action = (e.submitter as HTMLButtonElement | null)?.value ?? 'join'
    const name = nameIn.value.trim()
    if (!name) {
      msg.textContent = '名前を入れてください'
      nameIn.focus()
      return
    }
    let code: string
    if (action === 'create') code = newCode()
    else {
      code = normalizeCode(codeIn.value)
      if (!isValidCode(code)) {
        msg.textContent = codeIn.value.trim() ? 'コードが正しくありません' : '招待コードを入れてください'
        codeIn.focus()
        return
      }
    }
    store.set(NAME_KEY, name)
    const debug = new URLSearchParams(location.hash.slice(1)).has('debug')
    history.replaceState(null, '', `#r=${code}${debug ? '&debug' : ''}`)
    app.querySelectorAll<HTMLButtonElement>('#entry button').forEach(b => (b.disabled = true))
    msg.textContent = ''
    // このクリックで自動再生が許可される。中継サーバーの情報を取ってから部屋に入る
    void loadTurn().then(turn => enterRoom(code, name, turn))
  })
}

/* ---------- 部屋 ---------- */

const enterRoom = (roomId: string, name: string, turn: Awaited<ReturnType<typeof loadTurn>>) => {
  document.body.classList.add('in-room')
  app.innerHTML = `
    <header class="top">
      <span class="brand">kitete jam</span>
      <div class="top-right">
        <button class="people" id="people" type="button" aria-label="参加している人"></button>
        <button class="btn btn-small" id="invite" type="button">招待 <span class="code">${showCode(roomId)}</span></button>
      </div>
    </header>

    <div class="room">
      <section class="stage" aria-label="再生中">
        <div class="media" id="media">
          <div id="host-yt" class="embed" hidden></div>
          <div id="host-sc" class="embed" hidden></div>
          <div id="host-sp" class="embed" hidden></div>
          <p id="empty" class="media-empty">再生中の曲はありません</p>
        </div>
        <div class="np">
          <h1 id="np-title" class="np-title"></h1>
          <p id="np-sub" class="np-sub"></p>
        </div>
        <div id="notice" class="notice" hidden>
          <span id="notice-text"></span>
          <button id="notice-btn" class="btn btn-small" type="button"></button>
        </div>
      </section>

      <aside class="panel">
        <form id="add" class="add">
          <input id="url" type="url" inputmode="url" aria-label="曲のURL"
            placeholder="YouTube・SoundCloud・Spotify のURL" required />
          <button class="btn btn-primary" type="submit" id="add-btn">追加</button>
        </form>
        <p id="add-msg" class="form-msg" role="status"></p>

        <div class="tabs" role="tablist" aria-label="リスト">
          <button role="tab" id="tab-queue" aria-controls="queue" type="button">次に再生<span id="q-count" class="count"></span></button>
          <button role="tab" id="tab-history" aria-controls="history" type="button">履歴</button>
        </div>
        <ol id="queue" class="list" role="tabpanel" aria-labelledby="tab-queue"></ol>
        <ol id="history" class="list" role="tabpanel" aria-labelledby="tab-history" hidden></ol>
      </aside>
    </div>

    <footer class="player" aria-label="プレイヤー">
      <div class="pl-track">
        <span id="pl-art"></span>
        <div class="pl-text">
          <p id="pl-title" class="pl-title"></p>
          <p id="pl-sub" class="pl-sub"></p>
        </div>
      </div>
      <div class="pl-center">
        <div class="pl-buttons">
          <button id="toggle" class="round" type="button" aria-label="再生" disabled>${icon.play}</button>
          <button id="skip" class="icon-btn" type="button" aria-label="次の曲へ" disabled>${icon.next}</button>
        </div>
        <div class="pl-progress">
          <span id="t-cur" class="t">0:00</span>
          <input id="seek" class="range" type="range" min="0" max="1" step="0.1" value="0" aria-label="再生位置" disabled />
          <span id="t-dur" class="t">0:00</span>
        </div>
      </div>
      <div class="pl-volume">
        <span class="vol-icon">${icon.volume}</span>
        <input id="vol" class="range" type="range" min="0" max="100" step="1" aria-label="自分の音量" />
      </div>
    </footer>

    <p id="toast" class="toast" role="status" hidden></p>

    <dialog id="people-dlg" class="dlg" aria-labelledby="people-h">
      <div class="dlg-head">
        <h2 id="people-h">参加中</h2>
        <form method="dialog"><button class="icon-btn" aria-label="閉じる">${icon.close}</button></form>
      </div>
      <ul id="people-list" class="people-list"></ul>
      <p id="people-turn" class="dlg-note"></p>
    </dialog>

    <dialog id="invite-dlg" class="dlg" aria-labelledby="invite-h">
      <div class="dlg-head">
        <h2 id="invite-h">招待</h2>
        <form method="dialog"><button class="icon-btn" aria-label="閉じる">${icon.close}</button></form>
      </div>
      <textarea id="invite-text" readonly rows="3"></textarea>
    </dialog>`

  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
  const els = {
    people: $('people'),
    empty: $('empty'),
    media: $('media'),
    npTitle: $('np-title'),
    npSub: $('np-sub'),
    notice: $('notice'),
    noticeText: $('notice-text'),
    noticeBtn: $<HTMLButtonElement>('notice-btn'),
    plArt: $('pl-art'),
    plTitle: $('pl-title'),
    plSub: $('pl-sub'),
    cur: $('t-cur'),
    dur: $('t-dur'),
    seek: $<HTMLInputElement>('seek'),
    toggle: $<HTMLButtonElement>('toggle'),
    skip: $<HTMLButtonElement>('skip'),
    vol: $<HTMLInputElement>('vol'),
    volWrap: document.querySelector<HTMLElement>('.pl-volume')!,
    url: $<HTMLInputElement>('url'),
    addBtn: $<HTMLButtonElement>('add-btn'),
    addMsg: $('add-msg'),
    queue: $('queue'),
    history: $('history'),
    qCount: $('q-count'),
    toast: $('toast')
  }

  let toastTimer = 0
  const toast = (text: string) => {
    els.toast.textContent = text
    els.toast.hidden = false
    clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => (els.toast.hidden = true), 2800)
  }

  /** range の塗りつぶし位置を CSS に渡す */
  const paintRange = (r: HTMLInputElement) => {
    const min = Number(r.min)
    const max = Number(r.max) || 1
    r.style.setProperty('--p', `${Math.min(100, ((Number(r.value) - min) / (max - min)) * 100)}%`)
  }

  const jam = new Jam(roomId, turn)
  jam.profile.set({name})

  const failed = new Set<string>()
  const deck = new Deck(
    {yt: $('host-yt'), sc: $('host-sc'), sp: $('host-sp')},
    {
      onEnded: id => {
        // 試聴（30秒）で終わった人は送らない。最後まで聴けた人が送れば全員進む。
        // 全員が試聴だった時だけ、試聴の終わりで次へ進む
        if (deck.isPreview) jam.reportFailure(id, PREVIEW_ENDED)
        else void jam.next(id, null)
      },
      onUserStarted: () => {
        const want = jam.expectedPos()
        dlog(`部屋の位置へ合わせる: seek ${want.toFixed(2)}`)
        deck.seek(want)
      },
      onPreloaded: trackId => {
        // 次の曲の準備は先に済んだと知らせておく。曲が変わった瞬間に全員そろう
        dlog('次の曲の準備できた（先読み）')
        jam.markReady(trackId)
      },
      onUserSeek: sec => {
        dlog(`部屋へ反映: シーク ${sec.toFixed(2)}`)
        void jam.seek(sec)
      },
      onUserPause: sec => {
        dlog(`部屋へ反映: 一時停止 ${sec.toFixed(2)}`)
        void jam.setPlaying(false, sec)
      },
      onUserPlay: sec => {
        dlog(`部屋へ反映: 再生 ${sec.toFixed(2)}`)
        void jam.setPlaying(true, sec)
      },
      onError: (id, reason) => {
        if (failed.has(id)) return
        failed.add(id)
        toast(reason)
        jam.reportFailure(id, reason)
      }
    }
  )

  if (import.meta.env.DEV) Object.assign(window, {__kj: {deck, jam}})

  /* --- デバッグ表示（リリースまでは常に出す。#...&nodebug で消せる） --- */
  const NL = String.fromCharCode(10)
  const logLines: string[] = []
  const t0 = performance.now()
  const debug = new URLSearchParams(location.hash.slice(1)).has('nodebug')
    ? null
    : (() => {
        const box = document.createElement('div')
        box.className = 'debug'
        box.innerHTML = `<pre class="debug-live"></pre><pre class="debug-log"></pre>
          <button class="btn btn-small" type="button">ログをコピー</button>`
        document.body.append(box)
        return {
          live: box.querySelector<HTMLElement>('.debug-live')!,
          log: box.querySelector<HTMLElement>('.debug-log')!,
          copy: box.querySelector<HTMLButtonElement>('button')!
        }
      })()
  const dlog = (msg: string) => {
    logLines.push(`${((performance.now() - t0) / 1000).toFixed(1).padStart(6)} ${msg}`)
    if (logLines.length > 500) logLines.shift()
    if (debug) debug.log.textContent = logLines.slice(-10).join(NL)
  }
  deck.log = dlog
  debug?.copy.addEventListener('click', async () => {
    const text = [navigator.userAgent, ...logLines].join(NL)
    try {
      await navigator.clipboard.writeText(text)
      toast('ログをコピーしました')
    } catch {
      const dlg = $<HTMLDialogElement>('invite-dlg')
      $('invite-h').textContent = 'ログ'
      const ta = $<HTMLTextAreaElement>('invite-text')
      ta.value = text
      dlg.showModal()
      ta.select()
    }
  })

  const vol = Number(store.get(VOL_KEY) ?? 80)
  els.vol.value = String(vol)
  paintRange(els.vol)
  deck.setVolume(vol)
  els.vol.addEventListener('input', () => {
    deck.setVolume(Number(els.vol.value))
    store.set(VOL_KEY, els.vol.value)
    paintRange(els.vol)
  })

  /* --- タブ --- */
  const tabs = {queue: $('tab-queue'), history: $('tab-history')}
  const selectTab = (which: 'queue' | 'history', focus = false) => {
    for (const k of ['queue', 'history'] as const) {
      const on = k === which
      tabs[k].setAttribute('aria-selected', String(on))
      tabs[k].tabIndex = on ? 0 : -1
      $(k).hidden = !on
    }
    if (focus) tabs[which].focus()
    store.set(TAB_KEY, which)
  }
  tabs.queue.addEventListener('click', () => selectTab('queue'))
  tabs.history.addEventListener('click', () => selectTab('history'))
  for (const t of Object.values(tabs)) {
    t.addEventListener('keydown', e => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') selectTab(t === tabs.queue ? 'history' : 'queue', true)
    })
  }
  selectTab(store.get(TAB_KEY) === 'history' ? 'history' : 'queue')

  /* --- 状態を画面と再生に反映 --- */

  let seeking = false
  let lastCorrection = 0
  let seenLog = -1

  const apply = (s: JamState) => {
    const t = s.now
    dlog(
      `部屋: ${t ? `${t.kind} ${t.title.slice(0, 20)}` : 'なし'} ${s.play.playing ? '再生' : '停止'} ` +
        `本来=${jam.expectedPos(s).toFixed(2)} 予約=${jam.startDelay(s)}ms` +
        (jam.isPending(s) ? ` 準備中 ${jam.readiness(s).ready}/${jam.readiness(s).total}` : '')
    )
    const pending = jam.isPending(s)
    const delay = jam.startDelay(s)
    if (!t) {
      if (deck.currentId) deck.clear()
    } else if (deck.currentId !== t.id) {
      // 準備中なら先読みして待つ。途中から入った時はその位置ですぐ鳴らす
      const mode = pending ? 'prepare' : s.play.playing && delay === 0 ? 'play' : 'pause'
      const id = t.id
      void deck.load(t, jam.expectedPos(s), mode).then(() => {
        if (deck.currentId !== id) return
        dlog('準備できた')
        jam.markReady(id)
      })
      if (!pending && s.play.playing && delay > 0) deck.scheduleStart(delay)
    } else if (pending) {
      // 全員の準備待ち
    } else if (s.play.playing && delay > 0) {
      // 開始の予約。時刻が来たら deck が鳴らす
      deck.scheduleStart(delay)
    } else if (s.play.playing) {
      const want = jam.expectedPos(s)
      deck.play(want)
      // Spotify は play(want) が位置合わせも兼ねるので、鳴っている時だけ追加で合わせる
      const canSeek = deck.kind !== 'sp' || deck.isPlaying()
      if (!deck.loading && canSeek && Math.abs(deck.time() - want) > deck.tolerance) {
        lastCorrection = Date.now()
        dlog(`補正(部屋の変化): seek ${want.toFixed(2)} 実際=${deck.time().toFixed(2)}`)
        deck.seek(want)
      }
    } else {
      deck.pause()
      deck.seek(s.play.pos)
    }
    renderNow(s)
    renderQueue(s)
    renderHistory(s)
    announce(s)
  }

  /** ほかの人の操作だけ短く知らせる */
  const announce = (s: JamState) => {
    const last = s.log.length ? s.log[s.log.length - 1].at : 0
    if (seenLog >= 0 && last > seenLog && jam.state.getMeta()?.peerId !== jam.selfPeerId) {
      const fresh = s.log.filter((e: LogEntry) => e.at > seenLog && e.kind === 'event')
      if (fresh.length) toast(fresh[fresh.length - 1].text)
    }
    seenLog = last
  }

  const renderNow = (s: JamState) => {
    const t = s.now
    els.empty.hidden = !!t
    els.media.dataset.kind = t?.kind ?? ''
    els.npTitle.textContent = t?.title ?? ''
    els.npSub.textContent = t ? [t.artist, SOURCE[t.kind]].filter(Boolean).join(' · ') : ''
    els.plArt.innerHTML = art(t, 'pl-art')
    els.plTitle.textContent = t?.title ?? '再生していません'
    els.plSub.textContent = t ? `${t.addedBy}さんが追加` : ''
    for (const b of [els.toggle, els.skip]) b.disabled = !t
    els.seek.disabled = !t
    els.toggle.innerHTML = s.play.playing ? icon.pause : icon.play
    els.toggle.setAttribute('aria-label', s.play.playing ? '一時停止' : '再生')
  }

  const renderQueue = (s: JamState) => {
    els.qCount.textContent = s.queue.length ? String(s.queue.length) : ''
    if (!s.queue.length) {
      els.queue.innerHTML = `<li class="list-empty">キューは空です</li>`
      return
    }
    els.queue.innerHTML = s.queue
      .map(
        (t, i) => `
        <li class="row">
          ${art(t, 'row-art')}
          <div class="row-text">
            <p class="row-title">${esc(t.title)}</p>
            <p class="row-sub">${esc([t.artist || SOURCE[t.kind], `${t.addedBy}さん`].join(' · '))}</p>
          </div>
          <div class="row-act">
            ${i > 0 ? `<button class="icon-btn small" data-up="${t.id}" type="button" aria-label="「${esc(t.title)}」を前へ">${icon.up}</button>` : ''}
            <button class="icon-btn small" data-rm="${t.id}" type="button" aria-label="「${esc(t.title)}」を外す">${icon.close}</button>
          </div>
        </li>`
      )
      .join('')
  }

  // 履歴は流れた曲を時刻つきで並べる。曲の情報は追加された時のものを覚えておいて引く
  const known = new Map<string, Track>()
  const renderHistory = (s: JamState) => {
    for (const t of [s.now, ...s.queue]) if (t) known.set(t.id, t)
    const played = s.log.filter((e: LogEntry) => e.kind === 'played').reverse()
    if (!played.length) {
      els.history.innerHTML = `<li class="list-empty">履歴はありません</li>`
      return
    }
    els.history.innerHTML = played
      .map(e => {
        const t = e.trackId ? known.get(e.trackId) : undefined
        const isNow = e.trackId === s.now?.id
        return `<li class="row${isNow ? ' is-now' : ''}">
          ${art(t, 'row-art')}
          <div class="row-text">
            <p class="row-title">${esc(e.text)}</p>
            <p class="row-sub">${esc([t?.artist, t ? `${t.addedBy}さん` : ''].filter(Boolean).join(' · '))}</p>
          </div>
          ${isNow ? '<span class="row-time">再生中</span>' : '<span></span>'}
        </li>`
      })
      .join('')
  }

  els.queue.addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest('button')
    if (!b) return
    if (b.dataset.rm) void jam.remove(b.dataset.rm)
    if (b.dataset.up) void jam.moveUp(b.dataset.up)
  })

  jam.state.onChange(s => apply(s))
  apply(jam.state.get())

  /* --- お知らせ（試聴中・自分だけ止まった時） --- */
  let noticeAction: () => void = () => {}
  const showNotice = (text: string, btn: string, action: () => void) => {
    els.noticeText.textContent = text
    els.noticeBtn.textContent = btn
    els.noticeBtn.hidden = !btn
    noticeAction = action
    els.notice.hidden = false
  }
  els.noticeBtn.addEventListener('click', () => noticeAction())
  // Spotify のプレイヤーを作り直して、いまの位置から読み込み直す
  let spReloaded = false
  const reloadSpotify = () => {
    deck.resetSpotify()
    spReloaded = true
    const s = jam.state.get()
    if (s.now?.kind === 'sp') void deck.load(s.now, jam.expectedPos(s), s.play.playing ? 'play' : 'pause')
  }
  const loginSpotify = () => {
    // ログイン画面は別ウィンドウで開き、閉じたら作り直す。
    // continue を status にしておくと、ログイン後にほかのページへ移らない
    const w = window.open(
      'https://accounts.spotify.com/login?continue=https%3A%2F%2Faccounts.spotify.com%2Fstatus',
      'spotify-login',
      'popup,width=480,height=720'
    )
    if (!w) return reloadSpotify()
    const timer = setInterval(() => {
      if (!w.closed) return
      clearInterval(timer)
      reloadSpotify()
    }, 500)
  }
  // Firefox 系（Zen・Floorp・LibreWolf など）はサードパーティ Cookie を隔離するので、
  // ログインしていても埋め込みに伝わらない。サイトごとにトラッキング防止を外せば届く
  const isFirefoxFamily = /Firefox\//.test(navigator.userAgent)
  const showPreviewNotice = () =>
    isFirefoxFamily
      ? showNotice(
          'このブラウザでは試聴になります。アドレスバー左の盾アイコンから、このサイトのトラッキング防止をオフにしてください',
          '再読み込み',
          reloadSpotify
        )
      : spReloaded
      ? showNotice(
          '試聴のままです。PC の Chrome / Edge、Premium アカウント、サードパーティ Cookie の許可が必要です',
          '再読み込み',
          reloadSpotify
        )
      : showNotice('Spotify が試聴（30秒）になっています', 'ログインして再読み込み', loginSpotify)

  /* --- 0.25 秒ごとに位置表示と同期補正 --- */
  let lastResume = 0
  /** 再生（または開始の予約時刻）がいつ始まったか。自分の時計で */
  const lastStart = (s: JamState) => s.play.at - jam.authorOffset()
  setInterval(() => {
    const s = jam.state.get()
    if (!s.now) {
      els.cur.textContent = els.dur.textContent = '0:00'
      els.seek.value = '0'
      paintRange(els.seek)
      els.notice.hidden = true
      return
    }
    // Spotify の埋め込みは外から音量を変えられないので、その間は音量バーを出さない
    els.volWrap.hidden = !deck.canSetVolume
    const want = jam.expectedPos(s)
    if (debug) {
      const actual = deck.time()
      debug.live.textContent = [
        `種類 ${deck.kind ?? '-'}  再生中 ${deck.isPlaying()}  試聴 ${deck.isPreview}`,
        `実際 ${actual.toFixed(2)}  本来 ${want.toFixed(2)}  差 ${(actual - want).toFixed(2)}`,
        `長さ ${deck.duration().toFixed(1)}  読込中 ${deck.loading}  予約 ${jam.startDelay(s)}ms`
      ].join(NL)
    }
    // 試聴中の長さ（30秒）は曲の本当の長さではないので出さない
    const dur = deck.isPreview ? 0 : deck.duration() || 0
    const shown = Math.min(want, dur || want)
    if (!seeking) {
      els.seek.max = String(dur || Math.max(1, want))
      els.seek.value = String(shown)
      paintRange(els.seek)
      els.cur.textContent = fmt(shown)
    }
    els.dur.textContent = dur ? fmt(dur) : '--:--'

    if (deck.autoplayBlocked) {
      showNotice('ブラウザが自動再生を止めています。Spotify の再生ボタンを押してください', '', () => {})
      return
    }
    if (deck.isPreview) showPreviewNotice()
    if (!s.play.playing || deck.loading || deck.currentId !== s.now.id || jam.startDelay(s) > 0 || jam.isPending(s)) {
      if (!deck.isPreview) els.notice.hidden = true
      return
    }
    const now = Date.now()
    // 鳴り始めて少したったら、次の曲を裏で先読みしておく（鳴り始めの読み込みと取り合わないように）
    if (deck.playingFor > 5) void deck.preloadNext(s.queue[0])
    // 試聴の範囲を過ぎた位置には合わせられない
    const reachable = !deck.isPreview || want < deck.duration()
    const drift = Math.abs(deck.time() - want)
    // 鳴り始めの数秒は位置が安定しないので、大きくずれた時だけ直す
    const settling = deck.playingFor < 3 && drift < 3
    if (
      reachable &&
      !settling &&
      deck.isPlaying() &&
      now - lastCorrection > deck.correctionInterval &&
      drift > deck.tolerance
    ) {
      lastCorrection = now
      dlog(`補正(定期): seek ${want.toFixed(2)} 実際=${deck.time().toFixed(2)}`)
      deck.seek(want)
    }
    // 広告やバッファで止まったままなら再開を試みる。
    // Spotify は再開を重ねると最初からになったり固まったりするので、ボタンに任せる
    const stalled = !deck.isPlaying() && Date.now() - lastStart(s) > 4000 && !deck.isPreview
    if (stalled && deck.kind !== 'sp' && now - lastResume > 5000) {
      lastResume = now
      deck.play()
    }
    if (stalled) {
      if (els.notice.hidden) dlog('止まっていると判定')
      showNotice('この端末だけ止まっています', '合流する', () => {
        dlog('「合流する」を押した')
        deck.rejoin(jam.expectedPos())
      })
    } else if (!deck.isPreview) els.notice.hidden = true
    // 終了イベントを取りこぼしたときの保険
    if (dur && want > dur + 3 && jam.isLeader()) void jam.next(s.now.id, null)
  }, 250)

  /* --- 操作 --- */

  els.toggle.addEventListener('click', () => void jam.setPlaying(!jam.state.get().play.playing))
  els.skip.addEventListener('click', () => void jam.next(jam.state.get().now?.id ?? null))

  els.seek.addEventListener('input', () => {
    seeking = true
    els.cur.textContent = fmt(Number(els.seek.value))
    paintRange(els.seek)
  })
  els.seek.addEventListener('change', () => {
    seeking = false
    void jam.seek(Number(els.seek.value))
  })

  $<HTMLFormElement>('add').addEventListener('submit', async e => {
    e.preventDefault()
    const p = parseUrl(els.url.value)
    if ('error' in p) {
      els.addMsg.textContent = p.error
      return
    }
    els.addBtn.disabled = true
    els.addMsg.textContent = ''
    const meta = await fetchMeta(p)
    const track: Track = {id: crypto.randomUUID(), ...p, ...meta, addedBy: jam.myName()}
    await jam.add(track)
    els.addBtn.disabled = false
    els.url.value = ''
    toast(`「${meta.title}」を追加しました`)
  })
  els.url.addEventListener('input', () => (els.addMsg.textContent = ''))

  const inviteText = `kitete jam\n招待コード: ${showCode(roomId)}\n${location.origin}${location.pathname}#r=${roomId}`
  $('invite').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(inviteText)
      toast('招待をコピーしました')
    } catch {
      // クリップボードが使えないブラウザでは、選択した状態で見せる
      const dlg = $<HTMLDialogElement>('invite-dlg')
      $('invite-h').textContent = '招待'
      const ta = $<HTMLTextAreaElement>('invite-text')
      ta.value = inviteText
      dlg.showModal()
      ta.select()
    }
  })

  /* --- 参加者と接続 --- */

  const renderPeople = () => {
    const names = jam.names()
    els.people.innerHTML =
      names
        .slice(0, 4)
        .map(n => `<span class="avatar" aria-hidden="true">${esc(initial(n))}</span>`)
        .join('') + `<span class="people-count">${Math.max(1, names.length)}人</span>`
  }
  jam.room.onPeerJoin(renderPeople)
  jam.room.onPeerLeave(renderPeople)
  jam.profile.onChange(renderPeople)
  renderPeople()

  const peopleDlg = $<HTMLDialogElement>('people-dlg')
  $('people-turn').textContent = `中継サーバー: ${jam.hasTurn ? 'あり' : 'なし'}`
  const renderConnections = async () => {
    const list = await jam.connections()
    $('people-list').innerHTML =
      `<li><span class="avatar">${esc(initial(name))}</span><span class="pname">${esc(name)}</span><span class="pnet">自分</span></li>` +
      list
        .map(
          c => `<li><span class="avatar">${esc(initial(c.name))}</span><span class="pname">${esc(c.name)}</span>
            <span class="pnet">${c.route}${c.rtt == null ? '' : ` · ${c.rtt} ms`}</span></li>`
        )
        .join('')
  }
  els.people.addEventListener('click', () => {
    void renderConnections()
    peopleDlg.showModal()
  })
  setInterval(() => peopleDlg.open && void renderConnections(), 3000)

  jam.room.onError(err => {
    if (err.code === 'peer-connect-failed') {
      toast(err.turnConfigured ? '1人とつながりませんでした' : '直接つながれない人がいます（中継サーバーが必要です）')
    } else if (err.code === 'decrypt-failed') {
      toast('違うコードで入ろうとした人がいます')
    }
  })
}

/* ---------- 起動 ---------- */

renderEntry()
window.addEventListener('hashchange', () => location.reload())
