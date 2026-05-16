// background service worker — forwards messages between popup and content script

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // store latest status and text so popup can retrieve even if it was closed
  if (msg.type === 'STATUS') {
    chrome.storage.session.set({ lastStatus: msg });
  }
  if (msg.type === 'COLLECTED_TEXT') {
    chrome.storage.session.set({ collectedText: msg.text, collectedPages: msg.pages });
  }
  return false;
});
