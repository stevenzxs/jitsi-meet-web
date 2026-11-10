import axios, { AxiosHeaders, type AxiosRequestConfig, type AxiosResponse } from 'axios'

import { appConfig } from '../config/appConfig'

const SUCCESS_CODE = 200
const REPEAT_SUBMIT_INTERVAL = 1000
const REPEAT_SUBMIT_MAX_SIZE = 5 * 1024 * 1024
const REPEAT_SUBMIT_KEY = 'cloudmeet_repeat_submit'
const TOKEN_STORAGE_KEY = 'cloudmeet_token'

type ApiEnvelope<T> = {
  code?: number
  msg?: string
  message?: string
  data?: T
}

type RepeatSubmitCache = {
  url?: string
  data?: string
  time?: number
}

type RequestHeaders = AxiosHeaders & {
  isToken?: boolean
  repeatSubmit?: boolean
}

type RequestOptions = Omit<AxiosRequestConfig, 'url' | 'method' | 'params' | 'data'>

/**
 * 统一拼出 API 根路径：
 * - 开发同源：/mapi，由 Vite 代理转发到后端；
 * - 独立域名：VITE_API_BASE_URL + /mapi，便于 Nginx 只配置一个前缀。
 */
function buildApiBaseUrl(): string | undefined {
  if (!appConfig.apiBaseUrl && !appConfig.apiPrefix) return undefined
  return `${appConfig.apiBaseUrl}${appConfig.apiPrefix}`
}

const service = axios.create({
  baseURL: buildApiBaseUrl(),
  timeout: 10000,
})

axios.defaults.headers.common['Content-Type'] = 'application/json;charset=utf-8'

/**
 * 读取本地 token。
 * 当前会议系统暂未接入登录，先集中预留读取位置，后续只需要在这里对齐登录模块即可。
 */
function getToken(): string {
  return localStorage.getItem(TOKEN_STORAGE_KEY) || sessionStorage.getItem(TOKEN_STORAGE_KEY) || ''
}

/** 将 GET 参数拼到 URL 上，兼容后端网关对 query string 的直接解析。 */
function tansParams(params: Record<string, unknown>): string {
  const searchParams = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return
    if (Array.isArray(value)) {
      value.forEach((item) => searchParams.append(key, String(item)))
      return
    }
    searchParams.append(key, String(value))
  })
  return searchParams.toString()
}

/** 读取重复提交缓存，缓存损坏时主动清理，避免阻塞后续正常请求。 */
function getRepeatSubmitCache(): RepeatSubmitCache | null {
  try {
    const value = sessionStorage.getItem(REPEAT_SUBMIT_KEY)
    return value ? (JSON.parse(value) as RepeatSubmitCache) : null
  } catch {
    sessionStorage.removeItem(REPEAT_SUBMIT_KEY)
    return null
  }
}

/** 写入最近一次提交信息，用于拦截短时间内的重复 POST/PUT。 */
function setRepeatSubmitCache(cache: RepeatSubmitCache): void {
  sessionStorage.setItem(REPEAT_SUBMIT_KEY, JSON.stringify(cache))
}

/** 判断当前 POST/PUT 是否为重复提交，避免连续点击造成重复创建会议。 */
function isRepeatSubmit(config: AxiosRequestConfig): boolean {
  const requestObj = {
    url: config.url,
    data: typeof config.data === 'object' ? JSON.stringify(config.data) : String(config.data ?? ''),
    time: Date.now(),
  }
  const requestSize = JSON.stringify(requestObj).length
  if (requestSize >= REPEAT_SUBMIT_MAX_SIZE) {
    console.warn(`[${config.url}]: 请求数据大小超出允许的 5M 限制，跳过防重复提交验证。`)
    return false
  }
  const sessionObj = getRepeatSubmitCache()
  if (!sessionObj?.url || !sessionObj?.time) {
    setRepeatSubmitCache(requestObj)
    return false
  }
  const isSameRequest = sessionObj.url === requestObj.url && sessionObj.data === requestObj.data
  const isTooFast = requestObj.time - sessionObj.time < REPEAT_SUBMIT_INTERVAL
  if (isSameRequest && isTooFast) return true
  setRepeatSubmitCache(requestObj)
  return false
}

/** 从业务响应或 HTTP 错误中取出页面可读的错误文案。 */
function getResponseMessage(data: unknown, fallback: string): string {
  if (typeof data === 'string') return data
  if (data && typeof data === 'object') {
    const envelope = data as ApiEnvelope<unknown>
    return envelope.msg || envelope.message || fallback
  }
  return fallback
}

/** 判断响应是否为后端统一响应体，兼容当前直接返回数组/对象的接口。 */
function isApiEnvelope<T>(data: unknown): data is ApiEnvelope<T> {
  return !!data && typeof data === 'object' && ('code' in data || 'msg' in data || 'message' in data)
}

service.interceptors.request.use(
  (config) => {
    const headers = AxiosHeaders.from(config.headers) as RequestHeaders
    const isToken = headers.isToken === false
    const isRepeatSubmitDisabled = headers.repeatSubmit === false
    config.headers = headers
    headers.delete('isToken')
    headers.delete('repeatSubmit')

    const token = getToken()
    if (token && !isToken) {
      headers.set('Authorization', `Bearer ${token}`)
    }

    if (config.method?.toLowerCase() === 'get' && config.params) {
      const query = tansParams(config.params as Record<string, unknown>)
      config.url = query ? `${config.url}${config.url?.includes('?') ? '&' : '?'}${query}` : config.url
      config.params = {}
    }

    if (!isRepeatSubmitDisabled && ['post', 'put'].includes(config.method?.toLowerCase() || '')) {
      if (isRepeatSubmit(config)) {
        return Promise.reject(new Error('数据正在处理，请勿重复提交'))
      }
    }
    return config
  },
  (error) => Promise.reject(error),
)

service.interceptors.response.use(
  (response: AxiosResponse) => {
    const responseType = response.request?.responseType
    if (responseType === 'blob' || responseType === 'arraybuffer') return response.data
    if (response.status === 204) return undefined

    const data = response.data
    if (!isApiEnvelope(data)) return data

    const code = Number(data.code ?? SUCCESS_CODE)
    if (code === SUCCESS_CODE) return data.data ?? data
    if (code === 401) {
      throw new Error('无效的会话，或者会话已过期，请重新登录。')
    }
    throw new Error(getResponseMessage(data, `请求失败：${code}`))
  },
  (error) => {
    let message = error.message || '系统接口异常'
    if (message === 'Network Error') {
      message = '后端接口连接异常'
    } else if (message.includes('timeout')) {
      message = '系统接口请求超时'
    } else if (message.includes('Request failed with status code')) {
      message = `系统接口 ${error.response?.status ?? ''} 异常`.trim()
    }
    return Promise.reject(new Error(getResponseMessage(error.response?.data, message)))
  },
)

/** 私有请求入口，避免业务模块绕过 get/post/del 这类语义化方法直接拼 axios 配置。 */
function send<T>(config: AxiosRequestConfig): Promise<T> {
  return service.request(config) as unknown as Promise<T>
}

/** GET 请求封装，统一承载查询参数和额外 axios 配置。 */
export function get<T>(url: string, params?: Record<string, unknown>, config?: RequestOptions): Promise<T> {
  return send<T>({
    url,
    method: 'GET',
    params,
    ...config,
  })
}

/** POST 请求封装，统一承载请求体和额外 axios 配置。 */
export function post<T, D = unknown>(url: string, data?: D, config?: RequestOptions): Promise<T> {
  return send<T>({
    url,
    method: 'POST',
    data,
    ...config,
  })
}

/** PUT request for binary uploads and other idempotent writes. */
export function put<T, D = unknown>(url: string, data?: D, config?: RequestOptions): Promise<T> {
  return send<T>({ url, method: 'PUT', data, ...config })
}

/** DELETE 请求封装，当前会议取消接口仍使用 RESTful 删除语义。 */
export function del<T>(url: string, config?: RequestOptions): Promise<T> {
  return send<T>({
    url,
    method: 'DELETE',
    ...config,
  })
}
