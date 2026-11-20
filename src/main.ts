/// <reference types="vite/client" />
import {Jam, type JamState} from './jam'
import {Deck} from './players'
import {fetchMeta, parseUrl, type Track} from './sources'
import {loadTurn} from './turn'

const app = document.getElementById('app')!

const NAME_KEY = 'kitete-jam:name'
const VOL_KEY = 'kitete-jam:volume'
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

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString('ja-JP', {hour: '2-digit', minute: '2-digit'})

const newRoomId = () => {
  const a = new Uint8Array(8)
  crypto.getRandomValues(a)
  return Array.from(a, b => (b % 36).toString(36)).join('')
}

const roomFromHash = () => new URLSearchParams(location.hash.slice(1)).get('r')

/* ---------- 入口 ---------- */

const renderEntry = () => {
  const roomId = roomFromHash()
  app.innerHTML = `
    <section class="entry">
      <h1 class="wordmark">kitete jam</h1>
      <p class="lede">${
        roomId
          ? '招待された部屋に入ります。名前を決めてください。'
          : 'URLを知っている人だけが入れる、身内のリスニングルームです。'
      }</p>
      <form class="entry-form" id="entry">
        <label for="name">表示する名前</label>
        <input id="name" name="name" required maxlength="20" autocomplete="nickname" placeholder="例: みかん" />
        <button class="primary" type="submit">${roomId ? 'この部屋に入る' : '部屋をつくる'}</button>
      </form>
      <p class="fine">サーバーは使いません。曲はそれぞれの端末が YouTube と SoundCloud から直接読み込み、再生位置だけを P2P で揃えます。</p>
    </section>`
  const input = app.querySelector<HTMLInputElement>('#name')!
  input.value = store.get(NAME_KEY) ?? ''
  input.focus()
  app.querySelector<HTMLFormElement>('#entry')!.addEventListener('submit', e => {
    e.preventDefault()
    const name = input.value.trim()
    if (!name) return
    store.set(NAME_KEY, name)
    let id = roomFromHash()
    if (!id) {
      id = newRoomId()
      history.replaceState(null, '', `#r=${id}`)
    }
    const btn = app.querySelector<HTMLButtonElement>('#entry button')!
    btn.disabled = true
    btn.textContent = '準備しています…'
    // このクリックで自動再生が許可される。中継サーバーの情報を取ってから部屋に入る
    void loadTurn().then(turn => enterRoom(id, name, turn))
  })
}

/* ---------- 部屋 ---------- */

const enterRoom = (roomId: string, name: string, turn: Awaited<ReturnType<typeof loadTurn>>) => {
  app.innerHTML = `
    <header class="bar">
      <span class="wordmark small">kitete jam</span>
      <p class="presence" id="presence" aria-live="polite">部屋につないでいます…</p>
      <button class="ghost" id="invite" type="button">招待リンクをコピー</button>
    </header>

    <div class="room">
      <section class="stage" aria-labelledby="now-title">
        <div class="screen">
          <div id="yt" class="embed" hidden></div>
          <div id="sc" class="embed sc" hidden></div>
          <div id="idle" class="idle">
            <p>まだ何も流れていません。</p>
            <p>下の欄に YouTube か SoundCloud のURLを貼ると、最初の1曲がすぐ始まります。</p>
          </div>
        </div>

        <div class="now">
          <h2 id="now-title" class="now-title">　</h2>
          <p id="now-by" class="now-by"></p>
        </div>

        <div class="scrub">
          <span id="t-cur" class="t">0:00</span>
          <input id="seek" type="range" min="0" max="1" step="0.1" value="0" aria-label="再生位置（全員に反映）" disabled />
          <span id="t-dur" class="t">0:00</span>
        </div>

        <div class="controls">
          <button id="toggle" class="primary" type="button" disabled>再生</button>
          <button id="skip" class="ghost" type="button" disabled>次の曲へ</button>
          <label class="vol">
            <span>自分の音量</span>
            <input id="vol" type="range" min="0" max="100" step="1" />
          </label>
        </div>
        <p id="blocked" class="notice" hidden>
          この端末だけ再生が止まっています（ブラウザの自動再生ブロックなど）。<button id="unblock" class="link" type="button">ここを押すと合流します</button>
        </p>

        <form id="add" class="add">
          <label for="url">曲を足す</label>
          <div class="add-row">
            <input id="url" type="url" inputmode="url" placeholder="https://youtu.be/… または https://soundcloud.com/…" required />
            <button class="primary" type="submit" id="add-btn">キューに入れる</button>
          </div>
          <p id="add-msg" class="add-msg" role="status"></p>
        </form>
      </section>

      <aside class="side">
        <section aria-labelledby="q-h">
          <h2 id="q-h" class="side-h">キュー <span id="q-count" class="count"></span></h2>
          <ol id="queue" class="queue"></ol>
        </section>
        <section aria-labelledby="tl-h">
          <h2 id="tl-h" class="side-h">タイムライン</h2>
          <ol id="timeline" class="timeline"></ol>
        </section>
        <details class="net" id="net">
          <summary>接続の様子</summary>
          <ul id="net-list" class="net-list"></ul>
          <p id="net-turn" class="net-note"></p>
        </details>
      </aside>
    </div>
    <p id="toast" class="toast" role="status" hidden></p>`

  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
  const els = {
    presence: $('presence'),
    idle: $('idle'),
    title: $('now-title'),
    by: $('now-by'),
    cur: $('t-cur'),
    dur: $('t-dur'),
    seek: $<HTMLInputElement>('seek'),
    toggle: $<HTMLButtonElement>('toggle'),
    skip: $<HTMLButtonElement>('skip'),
    vol: $<HTMLInputElement>('vol'),
    blocked: $('blocked'),
    url: $<HTMLInputElement>('url'),
    addBtn: $<HTMLButtonElement>('add-btn'),
    addMsg: $('add-msg'),
    queue: $('queue'),
    qCount: $('q-count'),
    timeline: $('timeline'),
    toast: $('toast')
  }

  let toastTimer = 0
  const toast = (text: string) => {
    els.toast.textContent = text
    els.toast.hidden = false
    clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => (els.toast.hidden = true), 2600)
  }

  const jam = new Jam(roomId, turn)
  jam.profile.set({name})

  const failed = new Set<string>()
  const deck = new Deck($('yt'), $('sc'), {
    onEnded: id => {
      if (jam.isLeader()) void jam.next(id, '曲が終わった')
    },
    onError: (id, reason) => {
      if (failed.has(id)) return
      failed.add(id)
      toast(`${reason}。ほかの人が聴けていれば、この曲が終わるまで待ちます`)
      jam.reportFailure(id, reason)
    }
  })

  // 開発中だけコンソールから中身を確認できるようにする
  if (import.meta.env.DEV) Object.assign(window, {__kj: {deck, jam}})

  const vol = Number(store.get(VOL_KEY) ?? 80)
  els.vol.value = String(vol)
  deck.setVolume(vol)
  els.vol.addEventListener('input', () => {
    deck.setVolume(Number(els.vol.value))
    store.set(VOL_KEY, els.vol.value)
  })

  /* --- 状態を画面と再生に反映 --- */

  let seeking = false

  const apply = (s: JamState) => {
    const t = s.now
    if (!t) {
      if (deck.currentId) deck.clear()
    } else if (deck.currentId !== t.id) {
      void deck.load(t, jam.expectedPos(s), s.play.playing)
    } else if (s.play.playing) {
      deck.play()
      const want = jam.expectedPos(s)
      if (Math.abs(deck.time() - want) > 0.8) deck.seek(want)
    } else {
      deck.pause()
      deck.seek(s.play.pos)
    }
    renderNow(s)
    renderQueue(s)
    renderTimeline(s)
  }

  const renderNow = (s: JamState) => {
    const t = s.now
    els.idle.hidden = !!t
    els.title.textContent = t ? t.title : '　'
    els.by.textContent = t ? `${t.addedBy}さんが入れた曲 · ${t.kind === 'yt' ? 'YouTube' : 'SoundCloud'}` : ''
    els.toggle.disabled = !t
    els.skip.disabled = !t
    els.seek.disabled = !t
    els.toggle.textContent = s.play.playing ? '一時停止' : '再生'
    els.toggle.setAttribute('aria-pressed', String(s.play.playing))
  }

  const renderQueue = (s: JamState) => {
    els.qCount.textContent = s.queue.length ? `${s.queue.length}曲` : ''
    if (!s.queue.length) {
      els.queue.innerHTML = `<li class="empty">キューは空です。曲を足すと、いまの曲のあとに順番に流れます。</li>`
      return
    }
    els.queue.innerHTML = s.queue
      .map(
        (t, i) => `
        <li class="q-item">
          ${t.thumb ? `<img src="${esc(t.thumb)}" alt="" loading="lazy" />` : `<span class="noart" aria-hidden="true">${t.kind === 'yt' ? 'YT' : 'SC'}</span>`}
          <div class="q-text">
            <p class="q-title">${esc(t.title)}</p>
            <p class="q-by">${esc(t.addedBy)}</p>
          </div>
          <div class="q-act">
            ${i > 0 ? `<button class="mini" data-up="${t.id}" type="button" aria-label="「${esc(t.title)}」を1つ前へ">前へ</button>` : ''}
            <button class="mini" data-rm="${t.id}" type="button" aria-label="「${esc(t.title)}」をキューから外す">外す</button>
          </div>
        </li>`
      )
      .join('')
  }

  const renderTimeline = (s: JamState) => {
    if (!s.log.length) {
      els.timeline.innerHTML = `<li class="empty">誰かが曲をかけると、ここに時刻つきで残っていきます。</li>`
      return
    }
    els.timeline.innerHTML = [...s.log]
      .reverse()
      .map(e => {
        const isNow = e.kind === 'played' && e.trackId === s.now?.id
        return `<li class="tl ${e.kind}${isNow ? ' is-now' : ''}">
          <time class="tl-time">${isNow ? 'いま' : clock(e.at)}</time>
          <span class="tl-text">${esc(e.text)}</span>
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

  /* --- 毎フレームではなく 0.25 秒ごとに位置表示と同期補正 --- */
  let lastCorrection = 0
  let lastResume = 0
  setInterval(() => {
    const s = jam.state.get()
    if (!s.now) return
    const want = jam.expectedPos(s)
    const dur = deck.duration() || 0
    if (!seeking) {
      els.seek.max = String(dur || Math.max(1, want))
      els.seek.value = String(Math.min(want, dur || want))
    }
    els.cur.textContent = fmt(Math.min(want, dur || want))
    els.dur.textContent = dur ? fmt(dur) : '--:--'

    if (!s.play.playing || deck.loading || deck.currentId !== s.now.id) return
    const now = Date.now()
    if (now - lastCorrection > 2000 && Math.abs(deck.time() - want) > 0.8) {
      lastCorrection = now
      deck.seek(want)
    }
    // 広告やバッファで止まったままなら、こちらから再開を試みる
    const stalled = !deck.isPlaying() && now - s.play.at > 4000
    if (stalled && now - lastResume > 5000) {
      lastResume = now
      deck.play()
    }
    // それでも鳴らないとき（自動再生ブロックや、埋め込み側の一時停止ボタン）は案内を出す
    els.blocked.hidden = !stalled
    // 終了イベントを取りこぼしたときの保険
    if (dur && want > dur + 3 && jam.isLeader()) void jam.next(s.now.id, '曲が終わった')
  }, 250)

  $('unblock').addEventListener('click', () => {
    const s = jam.state.get()
    deck.play()
    deck.seek(jam.expectedPos(s))
  })

  /* --- 操作 --- */

  els.toggle.addEventListener('click', () => void jam.setPlaying(!jam.state.get().play.playing))
  els.skip.addEventListener('click', () => void jam.next(jam.state.get().now?.id ?? null))

  els.seek.addEventListener('input', () => {
    seeking = true
    els.cur.textContent = fmt(Number(els.seek.value))
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
      els.addMsg.dataset.tone = 'error'
      return
    }
    els.addBtn.disabled = true
    els.addMsg.dataset.tone = ''
    els.addMsg.textContent = '曲の情報を読み込んでいます…'
    const meta = await fetchMeta(p)
    const track: Track = {id: crypto.randomUUID(), ...p, ...meta, addedBy: jam.myName()}
    await jam.add(track)
    els.addBtn.disabled = false
    els.url.value = ''
    els.addMsg.textContent = `「${meta.title}」を入れました`
  })

  $('invite').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(location.href)
      toast('招待リンクをコピーしました。身内にだけ送ってください')
    } catch {
      window.prompt('このリンクを送ってください', location.href)
    }
  })

  /* --- 接続状況 --- */

  const renderPresence = () => {
    const others = Object.keys(jam.room.getPeers()).length
    const names = jam.names()
    els.presence.textContent = others
      ? `${names.length}人で聴いています: ${names.join('、')}`
      : 'ほかに誰もいません。招待リンクを送ってください'
  }
  jam.room.onPeerJoin(renderPresence)
  jam.room.onPeerLeave(renderPresence)
  jam.profile.onChange(renderPresence)
  jam.room.ready.then(renderPresence)
  jam.room.onError(err => {
    if (err.code === 'peer-connect-failed') {
      toast(
        err.turnConfigured
          ? '1人とつながりませんでした。相手にページを開き直してもらってください'
          : '回線の組み合わせのせいで直接つながれない人がいます。README の「TURN の設定」を見てください'
      )
    } else if (err.code === 'decrypt-failed') {
      toast('招待リンクが違う人が入ろうとしました。リンクをもう一度送り直してください')
    }
    // relay-failed などは、ほかの経路でつながっていれば問題ないので出さない
  })

  /* --- 接続の様子（離れた友だちとつながらない時の確認用） --- */
  const netList = $('net-list')
  $('net-turn').textContent = jam.hasTurn
    ? 'TURN（中継サーバー）設定あり。直接つながれない相手とも中継でつながります。'
    : 'TURN（中継サーバー）は未設定です。携帯回線どうしなどで、つながらない相手が出ることがあります。'
  const renderNet = async () => {
    if (!($('net') as HTMLDetailsElement).open) return
    const list = await jam.connections()
    netList.innerHTML = list.length
      ? list
          .map(
            c => `<li><span class="net-name">${esc(c.name)}</span><span>${c.route}</span><span class="net-rtt">${
              c.rtt == null ? '測定中' : `${c.rtt} ms`
            }</span></li>`
          )
          .join('')
      : '<li class="empty">まだ誰ともつながっていません。招待リンクを送ってから、少し待ってください。</li>'
  }
  $('net').addEventListener('toggle', () => void renderNet())
  setInterval(() => void renderNet(), 3000)
}

/* ---------- 起動 ---------- */

renderEntry()
window.addEventListener('hashchange', () => location.reload())
