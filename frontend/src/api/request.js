import axios from 'axios'

const request = axios.create({
  baseURL: `${(import.meta.env.VITE_BACKEND_HTTP_ORIGIN ?? '').replace(/\/$/, '')}/api`,
  timeout: 10_000,
})

request.interceptors.request.use((config) => {
  const token = localStorage.getItem('collab-token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

request.interceptors.response.use(
  (response) => response.data,
  (error) => Promise.reject(error.response?.data ?? error),
)

export default request
