const STATE_KEY = 'cx_player_state';

let state = {
  autoEnabled: false,
  hasVideo: false,
  videoInfo: null,
  switchCount: 0,
  captchaActive: false,
  disguiseActive: false,
  behaviorActive: false
};

const tabStates = {};
const tabFrameVideos = {};

function persistState() {
  chrome.storage.local.set({ [STATE_KEY]: state });
}

function restoreState() {
  chrome.storage.local.get(STATE_KEY, (data) => {
    if (data[STATE_KEY]) {
      state = { ...state, ...data[STATE_KEY] };
    }
    updateBadge();
  });
}

function getTabAggregatedState() {
  let hasAnyVideo = false;
  let hasAnyCaptcha = false;
  for (const ts of Object.values(tabStates)) {
    if (ts.hasVideo) hasAnyVideo = true;
    if (ts.captchaActive) hasAnyCaptcha = true;
  }
  // 也检查 per-frame 追踪
  for (const frames of Object.values(tabFrameVideos)) {
    if (frames.size > 0) hasAnyVideo = true;
  }
  return { hasAnyVideo, hasAnyCaptcha };
}

function updateBadge() {
  const agg = getTabAggregatedState();

  if (agg.hasAnyCaptcha) {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#FF8C00' });
  } else if (agg.hasAnyVideo && state.autoEnabled) {
    chrome.action.setBadgeText({ text: 'ON' });
    chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });
  } else if (agg.hasAnyVideo && !state.autoEnabled) {
    chrome.action.setBadgeText({ text: 'OFF' });
    chrome.action.setBadgeBackgroundColor({ color: '#FF8C00' });
  } else {
    chrome.action.setBadgeText({ text: 'OFF' });
    chrome.action.setBadgeBackgroundColor({ color: '#888' });
  }
}

chrome.runtime.onInstalled.addListener(() => {
  restoreState();
  chrome.storage.local.get(STATE_KEY, (data) => {
    if (!data[STATE_KEY]) {
      state = {
        autoEnabled: false,
        hasVideo: false,
        videoInfo: null,
        switchCount: 0,
        captchaActive: false,
        disguiseActive: false,
        behaviorActive: false
      };
      persistState();
    }
  });
  updateBadge();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabStates[tabId];
  delete tabFrameVideos[tabId];
  updateBadge();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading') {
    delete tabStates[tabId];
    delete tabFrameVideos[tabId];
    updateBadge();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab ? sender.tab.id : null;

  switch (message.type) {
    case 'video_detected':
      if (tabId) {
        const frameId = sender.frameId || 0;
        if (!tabFrameVideos[tabId]) tabFrameVideos[tabId] = new Set();
        tabFrameVideos[tabId].add(frameId);
        tabStates[tabId] = { hasVideo: true, captchaActive: tabStates[tabId]?.captchaActive || false };
      }
      state.hasVideo = true;
      state.videoInfo = message.info || null;
      persistState();
      updateBadge();
      sendResponse({ success: true });
      break;

    case 'video_lost':
      if (tabId) {
        const frameId = sender.frameId || 0;
        if (tabFrameVideos[tabId]) {
          tabFrameVideos[tabId].delete(frameId);
          if (tabFrameVideos[tabId].size === 0) {
            delete tabFrameVideos[tabId];
            tabStates[tabId] = { hasVideo: false, captchaActive: false };
            state.hasVideo = false;
            state.videoInfo = null;
          }
        } else {
          tabStates[tabId] = { hasVideo: false, captchaActive: false };
          state.hasVideo = false;
          state.videoInfo = null;
        }
      }
      persistState();
      updateBadge();
      sendResponse({ success: true });
      break;

    case 'popup_detected':
      state.captchaActive = true;
      if (tabId) {
        tabStates[tabId] = { ...tabStates[tabId], captchaActive: true };
      }
      persistState();
      updateBadge();
      chrome.notifications.create({
        type: 'basic',
        title: '验证弹窗检测',
        message: '检测到学习通验证弹窗，请手动处理'
      });
      sendResponse({ success: true });
      break;

    case 'popup_gone':
      state.captchaActive = false;
      if (tabId) {
        tabStates[tabId] = { ...tabStates[tabId], captchaActive: false };
      }
      persistState();
      updateBadge();
      sendResponse({ success: true });
      break;

    case 'status_report':
      if (tabId) {
        tabStates[tabId] = {
          hasVideo: message.hasVideo || false,
          captchaActive: message.captchaActive || false
        };
      }
      state.disguiseActive = message.disguiseActive || false;
      state.behaviorActive = message.behaviorActive || false;
      state.switchCount = message.switchCount || 0;
      updateBadge();
      sendResponse({ success: true });
      break;

    case 'get_status':
      sendResponse({
        autoEnabled: state.autoEnabled,
        hasVideo: state.hasVideo,
        videoInfo: state.videoInfo,
        switchCount: state.switchCount,
        captchaActive: state.captchaActive,
        disguiseActive: state.disguiseActive,
        behaviorActive: state.behaviorActive
      });
      break;

    case 'toggle_switch':
      state.autoEnabled = message.value;
      persistState();
      updateBadge();

      chrome.tabs.query({}, (tabs) => {
        for (const tab of tabs) {
          try {
            const url = tab.url || '';
            if (url.includes('chaoxing.com') || url.includes('edu.cn')) {
              chrome.tabs.sendMessage(tab.id, {
                type: 'toggle_auto',
                value: message.value
              }).catch(() => {});
            }
          } catch (e) {}
        }
      });

      sendResponse({ success: true });
      break;

    case 'increment_switch':
      state.switchCount += 1;
      persistState();
      sendResponse({ success: true });
      break;

    default:
      sendResponse({ success: false, error: '未知消息类型' });
      break;
  }

  return true;
});

restoreState();
