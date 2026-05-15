(function () {
  'use strict';

  const led = document.getElementById('led');
  const statusText = document.getElementById('statusText');
  const videoTitle = document.getElementById('videoTitle');
  const videoInfoRow = document.getElementById('videoInfoRow');
  const autoToggle = document.getElementById('autoToggle');
  const toggleState = document.getElementById('toggleState');
  const switchCount = document.getElementById('switchCount');
  const nextChapterRow = document.getElementById('nextChapterRow');
  const nextChapter = document.getElementById('nextChapter');
  const warningBar = document.getElementById('warningBar');
  const disguiseIcon = document.getElementById('disguiseIcon');
  const disguiseStatus = document.getElementById('disguiseStatus');
  const behaviorIcon = document.getElementById('behaviorIcon');
  const behaviorStatus = document.getElementById('behaviorStatus');

  let updatingUI = false;

  function updateUI(status) {
    updatingUI = true;

    const hasVideo = status.hasVideo;
    const autoEnabled = status.autoEnabled;
    const captchaActive = status.captchaActive;
    const videoInfo = status.videoInfo;
    const count = status.switchCount || 0;
    const disguiseActive = status.disguiseActive;
    const behaviorActive = status.behaviorActive;

    // 开关状态
    autoToggle.checked = autoEnabled;
    toggleState.textContent = autoEnabled ? '开' : '关';

    // LED 和状态文字
    led.classList.remove('green', 'green-blink', 'orange', 'orange-blink', 'gray');

    if (captchaActive) {
      led.classList.add('orange-blink');
      statusText.textContent = '等待手动处理验证';
      statusText.className = 'value warn';
      warningBar.style.display = 'flex';
    } else if (hasVideo && autoEnabled) {
      led.classList.add('green');
      statusText.textContent = '自动播放中';
      statusText.className = 'value';
      warningBar.style.display = 'none';
    } else if (hasVideo && !autoEnabled) {
      led.classList.add('orange');
      statusText.textContent = '已检测到视频（已暂停）';
      statusText.className = 'value';
      warningBar.style.display = 'none';
    } else {
      led.classList.add('gray');
      statusText.textContent = '未检测到视频';
      statusText.className = 'value idle';
      warningBar.style.display = 'none';
    }

    // 视频信息
    if (videoInfo && videoInfo.title && hasVideo) {
      videoInfoRow.style.display = 'flex';
      videoTitle.textContent = videoInfo.title;
    } else {
      videoInfoRow.style.display = 'none';
    }

    // 切换次数
    switchCount.textContent = count;

    // 功能状态
    if (disguiseActive) {
      disguiseIcon.textContent = '✓';
      disguiseIcon.className = 'check-icon active';
      disguiseStatus.textContent = '已激活';
      disguiseStatus.className = 'feature-status active';
    } else {
      disguiseIcon.textContent = '○';
      disguiseIcon.className = 'check-icon';
      disguiseStatus.textContent = '未激活';
      disguiseStatus.className = 'feature-status';
    }

    if (behaviorActive) {
      behaviorIcon.textContent = '✓';
      behaviorIcon.className = 'check-icon active';
      behaviorStatus.textContent = '运行中';
      behaviorStatus.className = 'feature-status active';
    } else {
      behaviorIcon.textContent = '○';
      behaviorIcon.className = 'check-icon';
      behaviorStatus.textContent = '已停止';
      behaviorStatus.className = 'feature-status';
    }

    updatingUI = false;
  }

  function requestStatus() {
    chrome.runtime.sendMessage({ type: 'get_status' }, (response) => {
      if (chrome.runtime.lastError) return;
      if (response) {
        updateUI(response);
      }
    });
  }

  autoToggle.addEventListener('change', () => {
    if (updatingUI) return;

    const value = autoToggle.checked;
    toggleState.textContent = value ? '开' : '关';

    chrome.runtime.sendMessage({ type: 'toggle_switch', value }, () => {
      // 切换后重新获取状态
      setTimeout(requestStatus, 300);
    });
  });

  // 打开时获取状态
  requestStatus();

  // 定期刷新（Popup 打开期间）
  const refreshInterval = setInterval(requestStatus, 2000);

  // Popup 关闭时清理
  window.addEventListener('unload', () => {
    clearInterval(refreshInterval);
  });
})();
