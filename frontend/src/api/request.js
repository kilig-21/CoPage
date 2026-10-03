import axios from 'axios'
import { expireSession } from '../auth/session'

const request = axios.create({
  baseURL: `${(import.meta.env.VITE_BACKEND_HTTP_ORIGIN ?? '').replace(/\/$/, '')}/api`,
  timeout: 10_000,
})

request.interceptors.request.use((config) => {
  const token = localStorage.getItem('collab-token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
    config.copageSessionToken = token
  }
  return config
})

request.interceptors.response.use(
  (response) => response.data,
  (error) => {
    if (error.response?.status === 401 && !error.config?.url?.startsWith('/auth/')) {
      expireSession(localStorage, error.config?.copageSessionToken,
        () => window.dispatchEvent(new Event('copage-auth-expired')))
    }
    return Promise.reject(error.response?.data ?? error)
  },
)

export default request
