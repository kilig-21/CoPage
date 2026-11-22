import { App } from 'antd'

export function useCreationTrackingWarning() {
  const { message } = App.useApp()
  return result => {
    if (!result.creationTrackingWarning) return
    try { message.warning(result.creationTrackingWarning, 10) }
    catch { /* 提示失败不能改变已确认的创建结果。 */ }
  }
}
