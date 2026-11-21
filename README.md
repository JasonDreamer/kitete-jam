# kitete jam

身内で同じ曲を同時に聴くための部屋。YouTube・SoundCloud・Spotify の曲URLに対応。

公開URL: https://jasondreamer.github.io/kitete-jam/

## 仕組み

- 音は各端末が公式の埋め込みプレイヤーで鳴らす。端末間で送るのは再生位置・キュー・履歴だけ。
- 端末どうしは WebRTC で直接つながる（[Trystero](https://github.com/dmotz/trystero)）。相手探しだけ公開の Nostr リレーを使う。
- 8文字の招待コードが部屋IDと暗号の鍵を兼ねる。
- 新しい曲は全員の準備（先読み）がそろってから同時に始める。YouTube は次の曲を裏で先読みする。
- 部屋の中身は参加者が持っている。全員抜けると消える。

## 開発

```powershell
npm install
npm run dev
```

master に push すると GitHub Actions が Pages に公開する。

## 中継サーバー（TURN）

携帯回線どうしなどで直接つながらない時に使う。リポジトリの Settings > Secrets and variables > Actions > Variables に入れる。

- `VITE_TURN_CREDENTIALS_URL`: 認証情報を返すURL（例: Metered の `https://<app>.metered.live/api/v1/turn/credentials?apiKey=...`）
- または `VITE_TURN_URLS`（カンマ区切り）、`VITE_TURN_USERNAME`、`VITE_TURN_CREDENTIAL`

値はビルド後の JS に入るので、ページを開いた人には見える。

## Spotify の制限

- 最後まで流れるのは PC の Chromium 系ブラウザで Premium にログインしている人だけ。それ以外は30秒の試聴。
- Firefox 系（Zen など）はサイトのトラッキング防止を切る必要があり、自動再生も止められる。止められた時は埋め込みの再生ボタンを押す。
- 埋め込みに音量の API がないので、Spotify の間は音量バーを出さない。

## デバッグ表示

画面左下に出る。「ログをコピー」でプレイヤーへの操作と応答の記録を取り出せる。URL に `&nodebug` を付けると消える。

## ファイル

- `src/jam.ts` 部屋、共有状態、時計のずれ補正、準備待ち
- `src/players.ts` 各埋め込みプレイヤーの操作
- `src/sources.ts` URLの判定と曲情報の取得
- `src/turn.ts` TURN の設定読み込み
- `src/main.ts` 画面
