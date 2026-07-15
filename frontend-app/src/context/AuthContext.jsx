import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react'
import * as api from '@/lib/api'

// Порт оригинального AuthContext (frontend/app/src/context/AuthContext.jsx) —
// сессионная часть (/api/vs/auth/{login,logout,me,register}, кука vs_sid)
// + WMS access/refresh-токен (localStorage), нужный браузерному сбору
// данных (wmsFetch.js/FetchModal.jsx — реальный код, не мок, читает те же
// ключи localStorage, что этот контекст пишет).
//
// НЕ перенесён `putConfig({ token, refreshToken })` оригинала — там он
// сохранял токен в конфиг Node-бэкенда для серверного планировщика
// (scheduler.js/data-collector.js), которого в новом стеке ещё нет вообще
// (сам сбор данных подтверждённо работает только браузерным путём, см.
// PLAN.md) — сохранять токен туда, где его некому читать, незачем.
const LS_ACCESS_KEY = 'wms_access_token'
const LS_EXPIRY_KEY = 'wms_access_token_expiry'
const LS_REFRESH_KEY = 'wms_refresh_token'
const EXPIRY_MARGIN = 60_000

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  const accessTokenRef = useRef(null)
  const accessTokenExpiryRef = useRef(null)
  const refreshTokenRef = useRef(null)
  const refreshTimerRef = useRef(null)
  const retryCountRef = useRef(0)

  function saveAccessToken(token, expiryMs) {
    accessTokenRef.current = token
    accessTokenExpiryRef.current = expiryMs || null
    try {
      if (token) {
        localStorage.setItem(LS_ACCESS_KEY, token)
        localStorage.setItem(LS_EXPIRY_KEY, String(expiryMs || 0))
      } else {
        localStorage.removeItem(LS_ACCESS_KEY)
        localStorage.removeItem(LS_EXPIRY_KEY)
      }
    } catch { /* ignore */ }
  }

  function saveRefreshToken(token) {
    refreshTokenRef.current = token
    try {
      if (token) localStorage.setItem(LS_REFRESH_KEY, token)
      else localStorage.removeItem(LS_REFRESH_KEY)
    } catch { /* ignore */ }
  }

  function clearTokens() {
    saveAccessToken(null, null)
    saveRefreshToken(null)
  }

  const doRefresh = useCallback(async () => {
    if (!refreshTokenRef.current) return false
    try {
      const data = await api.refreshSamokatToken(refreshTokenRef.current)
      const val = data?.value ?? data
      if (!val?.accessToken) return false
      const expiry = Date.now() + (val.expiresIn || 300) * 1000
      saveAccessToken(val.accessToken, expiry)
      if (val.refreshToken) saveRefreshToken(val.refreshToken)
      return true
    } catch {
      return false
    }
  }, [])

  const scheduleRefresh = useCallback((expiryMs) => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
    if (!expiryMs) return
    const delay = Math.max(10_000, expiryMs - Date.now() - EXPIRY_MARGIN)
    refreshTimerRef.current = setTimeout(async () => {
      const ok = await doRefresh()
      if (ok) {
        retryCountRef.current = 0
        scheduleRefresh(accessTokenExpiryRef.current)
      } else {
        retryCountRef.current += 1
        const retryDelay = Math.min(retryCountRef.current * 30_000, 10 * 60_000)
        refreshTimerRef.current = setTimeout(() => scheduleRefresh(expiryMs), retryDelay)
      }
    }, delay)
  }, [doRefresh])

  const restore = useCallback(async () => {
    setLoading(true)
    try {
      const me = await api.getVsMe()
      setUser(me || null)
      if (!me || me.allowWithoutToken) return

      const storedAccess = localStorage.getItem(LS_ACCESS_KEY)
      const storedExpiry = parseInt(localStorage.getItem(LS_EXPIRY_KEY) || '0', 10)
      if (storedAccess && storedExpiry > Date.now() + EXPIRY_MARGIN) {
        saveAccessToken(storedAccess, storedExpiry)
        const storedRefresh = localStorage.getItem(LS_REFRESH_KEY)
        if (storedRefresh) saveRefreshToken(storedRefresh)
        scheduleRefresh(storedExpiry)
        return
      }

      const storedRefresh = localStorage.getItem(LS_REFRESH_KEY)
      if (!storedRefresh) return
      saveRefreshToken(storedRefresh)
      const ok = await doRefresh()
      if (ok) {
        retryCountRef.current = 0
        scheduleRefresh(accessTokenExpiryRef.current)
      }
    } finally {
      setLoading(false)
    }
  }, [doRefresh, scheduleRefresh])

  useEffect(() => { restore() }, [restore])

  // Ответ бэкенда не вложен в data.user (role/modules/actions/name/... лежат
  // прямо в теле) — как и в оригинале. accessToken присутствует только если
  // WMS-пароль совпал (см. 4-ветвистую логику /api/vs/auth/login).
  const login = useCallback(async (loginValue, password) => {
    const data = await api.loginVs(loginValue, password)
    setUser(data)
    if (data.accessToken) {
      const expiry = Date.now() + (data.expiresIn || 300) * 1000
      saveAccessToken(data.accessToken, expiry)
      saveRefreshToken(data.refreshToken || null)
      scheduleRefresh(expiry)
    }
    return data
  }, [scheduleRefresh])

  const logout = useCallback(async () => {
    await api.logoutVs()
    setUser(null)
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
    clearTokens()
  }, [])

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
