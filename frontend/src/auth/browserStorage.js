export function canReadBrowserStorage(browser) {
  try {
    browser.localStorage.getItem('collab-token')
    browser.localStorage.getItem('collab-user')
    browser.sessionStorage.getItem('copage-tab-client:0')
    return true
  } catch {
    return false
  }
}
