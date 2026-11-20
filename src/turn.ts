/// <reference types="vite/client" />
import type {TurnServerConfig} from 'trystero'

/**
 * 直接つながれない回線どうし（携帯回線、会社や学校のネットワークなど）のための中継サーバー設定。
 * ビルド時の環境変数から読む。どれも無ければ TURN 無しで動く。
 *
 * VITE_TURN_CREDENTIALS_URL  Metered などの「認証情報を返すURL」（JSON で RTCIceServer[] を返すもの）
 * VITE_TURN_URLS             静的に指定する場合。カンマ区切り（turn:host:3478,turns:host:443?transport=tcp）
 * VITE_TURN_USERNAME
 * VITE_TURN_CREDENTIAL
 */
export const loadTurn = async (): Promise<TurnServerConfig[]> => {
  const env = import.meta.env
  const servers: TurnServerConfig[] = []

  const credUrl = env.VITE_TURN_CREDENTIALS_URL as string | undefined
  if (credUrl) {
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 5000)
      const res = await fetch(credUrl, {signal: ctrl.signal})
      clearTimeout(timer)
      if (res.ok) {
        const list = (await res.json()) as TurnServerConfig[]
        // STUN は Trystero 側で持っているので TURN だけ足す
        servers.push(...list.filter(s => [s.urls].flat().some(u => /^turns?:/.test(u))))
      }
    } catch {
      /* 取れなくても TURN 無しで続ける */
    }
  }

  const urls = (env.VITE_TURN_URLS as string | undefined)?.split(',').map(s => s.trim()).filter(Boolean)
  if (urls?.length) {
    servers.push({
      urls,
      username: env.VITE_TURN_USERNAME as string | undefined,
      credential: env.VITE_TURN_CREDENTIAL as string | undefined
    })
  }
  return servers
}
