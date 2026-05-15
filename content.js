(function () {
  'use strict';

  if (window.__CX_PLAYER_INITIALIZED__) return;
  window.__CX_PLAYER_INITIALIZED__ = true;

  // ======================== 配置 ========================
  const CONFIG = {
    DEBOUNCE_MS: 200,
    VIDEO_LOST_THRESHOLD_MS: 3000,
    AUTO_SWITCH_DELAY_MS: 2000,
    PIP_RETRY_MAX: 3,
    BEHAVIOR_MOUSE_MIN_INTERVAL: 25000,
    BEHAVIOR_MOUSE_MAX_INTERVAL: 50000,
    BEHAVIOR_CLICK_MIN_INTERVAL: 60000,
    BEHAVIOR_CLICK_MAX_INTERVAL: 180000,
    BEHAVIOR_VOLUME_INTERVAL_MS: 600000,
    BEHAVIOR_KEY_MIN_INTERVAL: 40000,
    BEHAVIOR_KEY_MAX_INTERVAL: 80000,
    BEHAVIOR_VISIBILITY_MIN_IDLE: 3000,
    BEHAVIOR_VISIBILITY_MAX_IDLE: 8000
  };

  // ======================== 状态 ========================
  let videoElement = null;
  let autoEnabled = false;
  let captchaActive = false;
  let switchCount = 0;
  let isSwitching = false;
  let disguiseSetupDone = false;
  let behaviorRunning = false;
  let behaviorTimers = {};
  let chapterList = [];
  let currentChapterIndex = -1;
  let videoObserver = null;
  let captchaObserver = null;
  let videoPageObserver = null;
  let videoLostTimer = null;
  let pipRetryCount = 0;
  let isPageVisible = true;
  let heartbeatIntervalId = null;
  let heartbeatRafId = null;

  // ======================== 工具函数 ========================
  function log(...args) {
    console.log('[助手]', ...args);
  }

  function rand(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function randFloat(min, max) {
    return Math.random() * (max - min) + min;
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function sendToSW(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (response) => {
          resolve(response);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  // ======================== 前台伪装 ========================
  function setupDisguise() {
    if (disguiseSetupDone) return;
    disguiseSetupDone = true;

    try {
      // 重写 document.hidden
      Object.defineProperty(document, 'hidden', {
        get: () => false,
        configurable: true
      });
    } catch (e) {}

    try {
      // 重写 document.visibilityState
      Object.defineProperty(document, 'visibilityState', {
        get: () => 'visible',
        configurable: true
      });
    } catch (e) {}

    // 拦截 visibilitychange 事件
    const origAddEventListener = document.addEventListener.bind(document);
    document.addEventListener = function (type, listener, options) {
      if (type === 'visibilitychange') {
        return;
      }
      return origAddEventListener(type, listener, options);
    };

    // 尝试画中画
    attemptPIP();

    // 心跳保持活跃
    startHeartbeat();

    sendToSW({ type: 'status_report', disguiseActive: true, behaviorActive: true, hasVideo: !!videoElement, captchaActive, switchCount });
  }

  function attemptPIP() {
    if (!videoElement || pipRetryCount >= CONFIG.PIP_RETRY_MAX) return;

    if (document.pictureInPictureElement) return;

    try {
      videoElement.requestPictureInPicture().then(() => {
        log('PIP 已激活');
        pipRetryCount = 0;
      }).catch(() => {
        pipRetryCount++;
        setTimeout(attemptPIP, 3000);
      });
    } catch (e) {
      pipRetryCount++;
      setTimeout(attemptPIP, 3000);
    }
  }

  function startHeartbeat() {
    stopHeartbeat();

    function beat() {
      if (!disguiseSetupDone) {
        heartbeatRafId = requestAnimationFrame(beat);
        return;
      }
      heartbeatRafId = requestAnimationFrame(beat);
    }

    heartbeatRafId = requestAnimationFrame(beat);

    heartbeatIntervalId = setInterval(() => {
      sendToSW({
        type: 'status_report',
        disguiseActive: disguiseSetupDone,
        behaviorActive: behaviorRunning,
        hasVideo: !!videoElement,
        captchaActive,
        switchCount
      });
    }, 30000);
  }

  function stopHeartbeat() {
    if (heartbeatIntervalId) {
      clearInterval(heartbeatIntervalId);
      heartbeatIntervalId = null;
    }
    if (heartbeatRafId) {
      cancelAnimationFrame(heartbeatRafId);
      heartbeatRafId = null;
    }
  }

  // ======================== 视频检测 ========================
  function setupVideoDetection() {
    if (videoObserver) {
      videoObserver.disconnect();
    }

    let debounceTimer = null;

    videoPageObserver = new MutationObserver((mutations) => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        checkForVideo();
      }, CONFIG.DEBOUNCE_MS);
    });

    videoPageObserver.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true
    });

    checkForVideo();
  }

  function checkForVideo() {
    if (videoElement && document.contains(videoElement) && videoElement.duration > 0) {
      return;
    }

    const videos = document.querySelectorAll('video');

    for (const v of videos) {
      if (isValidVideo(v)) {
        if (v !== videoElement) {
          attachToVideo(v);
        }
        return;
      }
    }

    // 未找到有效视频
    if (videoElement) {
      if (!videoLostTimer) {
        videoLostTimer = setTimeout(() => {
          detachFromVideo();
          sendToSW({ type: 'video_lost' });
          videoLostTimer = null;
        }, CONFIG.VIDEO_LOST_THRESHOLD_MS);
      }
    }
  }

  function isValidVideo(video) {
    if (video.duration <= 0) return false;
    if (video.offsetWidth < 100 || video.offsetHeight < 100) return false;

    // 检查是否在学习通播放器容器内
    const parent = video.closest('.video-js, .vjs-poster, .ans-attach-online, #video, [class*="player"], [id*="player"], [class*="video"], [id*="video"]');
    if (!parent) return false;

    return true;
  }

  function attachToVideo(video) {
    if (videoElement) {
      detachFromVideo();
    }

    videoElement = video;
    if (videoLostTimer) {
      clearTimeout(videoLostTimer);
      videoLostTimer = null;
    }

    // 安装事件监听
    videoElement.addEventListener('play', onVideoPlay);
    videoElement.addEventListener('pause', onVideoPause);
    videoElement.addEventListener('ended', onVideoEnded);
    videoElement.addEventListener('error', onVideoError);

    // 监听移除
    if (videoObserver) videoObserver.disconnect();
    videoObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.removedNodes) {
          if (node === videoElement || (node.contains && node.contains(videoElement))) {
            detachFromVideo();
            checkForVideo();
            return;
          }
        }
      }
    });

    const parent = videoElement.parentElement;
    if (parent) {
      videoObserver.observe(parent, { childList: true, subtree: true });
    }

    const info = getVideoInfo();
    log('检测到视频:', info.title);
    sendToSW({ type: 'video_detected', info });

    // 获取章节列表
    fetchChapterList();

    // 设置伪装
    if (!disguiseSetupDone) {
      setupDisguise();
    }

    // 视频就绪后重试画中画
    pipRetryCount = 0;
    attemptPIP();

    // 尝试自动播放
    if (videoElement.paused || videoElement.ended) {
      tryPlay();
    }

    // 初始化行为仿真
    startBehaviorSimulation();
  }

  function detachFromVideo() {
    if (!videoElement) return;

    videoElement.removeEventListener('play', onVideoPlay);
    videoElement.removeEventListener('pause', onVideoPause);
    videoElement.removeEventListener('ended', onVideoEnded);
    videoElement.removeEventListener('error', onVideoError);

    videoElement = null;
    stopBehaviorSimulation();
    stopHeartbeat();

    if (videoObserver) {
      videoObserver.disconnect();
      videoObserver = null;
    }
  }

  function onVideoPlay() {
    sendToSW({ type: 'video_detected', info: getVideoInfo() });
  }

  function onVideoPause() {
    if (!isSwitching && autoEnabled && videoElement && !videoElement.ended) {
      tryPlay();
    }
  }

  function onVideoEnded() {
    log('视频播放结束');
    if (autoEnabled && !isSwitching) {
      switchToNextChapter();
    }
  }

  function onVideoError() {
    log('视频播放出错');
    // 延迟后重试
    setTimeout(() => {
      if (videoElement && autoEnabled) {
        tryPlay();
      }
    }, 5000);
  }

  function getVideoInfo() {
    let title = '';
    const titleEl = document.querySelector('.chapter-title, .tit, h1, h2, .prev_title, [class*="chapter"], [id*="chapter"]');
    if (titleEl) {
      title = titleEl.textContent.trim().substring(0, 50);
    }
    if (!title) {
      title = document.title.substring(0, 50);
    }
    return {
      title: title || '未知视频',
      duration: videoElement ? videoElement.duration : 0
    };
  }

  function tryPlay() {
    if (!videoElement) return;
    const p = videoElement.play();
    if (p && p.catch) {
      p.catch((e) => {
        if (e.name === 'NotAllowedError') {
          // 自动播放被阻止，先静音尝试
          const wasMuted = videoElement.muted;
          videoElement.muted = true;
          videoElement.play().then(() => {
            // 延迟后恢复音量（如果之前未静音）
            if (!wasMuted) {
              setTimeout(() => {
                if (videoElement && videoElement.playing) {
                  videoElement.muted = false;
                  videoElement.play().catch(() => {});
                }
              }, 1500);
            }
          }).catch(() => {});
        }
      });
    }
  }

  // ======================== 章节导航 ========================
  function fetchChapterList() {
    chapterList = [];
    currentChapterIndex = -1;

    // 方式1：从侧边栏获取
    const chapterItems = document.querySelectorAll('.chapter_item, .catalog_item, li[class*="chapter"], li[class*="catalog"]');
    for (const item of chapterItems) {
      const link = item.querySelector('a[href]');
      if (link) {
        chapterList.push({ title: item.textContent.trim().substring(0, 50), href: link.href });
      }
    }

    // 方式2：从目录树获取
    if (chapterList.length === 0) {
      const nodes = document.querySelectorAll('.catalog_title, .chapter_tit, [onclick*="chapter"]');
      for (const node of nodes) {
        const link = node.closest('a') || node.querySelector('a');
        if (link && link.href && link.href !== window.location.href) {
          chapterList.push({ title: node.textContent.trim().substring(0, 50), href: link.href });
        }
      }
    }

    // 找到当前章节索引
    for (let i = 0; i < chapterList.length; i++) {
      if (chapterList[i].href === window.location.href) {
        currentChapterIndex = i;
        break;
      }
    }

    log('获取到', chapterList.length, '个章节');
  }


  function findNextButton() {
    // 多策略查找下一节按钮
    const selectors = [
      '.next_btn', '.nextBtn', '.btn_next',
      '.prev_next a:last-child',
      '.chapter_next',
      '[title*="下一节"]', '[title*="下一讲"]', '[title*="下一章"]',
      'a:has(span:text("下一节"))',
    ];

    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null) return el;
      } catch (e) {}
    }

    // 文本匹配查找
    const buttons = document.querySelectorAll('a, button, span, div[onclick]');
    const keywords = ['下一节', '下一讲', '下一章', '继续', 'next', '下一步'];
    for (const btn of buttons) {
      const text = (btn.textContent || '').trim().toLowerCase();
      for (const kw of keywords) {
        if (text.includes(kw.toLowerCase())) {
          return btn;
        }
      }
    }

    return null;
  }

  function simulateClick(el) {
    // 对于 <a> 链接，直接用 el.click() 触发原生导航，避免重复
    if (el.tagName === 'A' && el.href && el.href !== window.location.href) {
      try { el.click(); } catch (e) {}
      return;
    }

    // 普通按钮：模拟鼠标事件
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2 + randFloat(-5, 5);
    const cy = rect.top + rect.height / 2 + randFloat(-3, 3);

    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: cx, clientY: cy }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: cx, clientY: cy }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: cx, clientY: cy }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: cx, clientY: cy }));
  }

  async function waitForNavigation(timeoutMs) {
    const startUrl = window.location.href;
    let navigating = false;

    const onUnload = () => { navigating = true; };
    window.addEventListener('beforeunload', onUnload);

    const urlCheck = setInterval(() => {
      if (window.location.href !== startUrl) navigating = true;
    }, 50);

    const start = Date.now();
    while (!navigating && Date.now() - start < timeoutMs) {
      await delay(100);
    }

    clearInterval(urlCheck);
    window.removeEventListener('beforeunload', onUnload);
    return navigating;
  }

  async function switchToNextChapter() {
    if (isSwitching || captchaActive) return;
    isSwitching = true;

    switchCount++;
    sendToSW({ type: 'increment_switch' });
    sendToSW({
      type: 'status_report',
      disguiseActive: disguiseSetupDone,
      behaviorActive: true,
      hasVideo: !!videoElement,
      captchaActive,
      switchCount
    });

    const startUrl = window.location.href;

    // 策略1：点击"下一节"按钮
    const nextBtn = findNextButton();
    if (nextBtn) {
      log('策略1：点击"下一节"按钮');
      nextBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await delay(300);
      simulateClick(nextBtn);
      if (await waitForNavigation(4000)) return;
    }

    // 策略2：模拟键盘（仅当页面没变化时执行）
    log('策略2：模拟键盘 Enter');
    const enterEvent = new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', keyCode: 13,
      bubbles: true, cancelable: true
    });
    document.dispatchEvent(enterEvent);
    if (await waitForNavigation(4000)) return;

    // 策略3：直接导航到下一章
    if (chapterList.length > 0 && currentChapterIndex >= 0 && currentChapterIndex < chapterList.length - 1) {
      const next = chapterList[currentChapterIndex + 1];
      log('策略3：直接导航 ->', next.title);
      window.location.href = next.href;
      return;
    }

    log('无下一章可切换');
    isSwitching = false;
  }

  // ======================== 验证弹窗检测 ========================
  function setupCaptchaDetection() {
    if (captchaObserver) captchaObserver.disconnect();

    captchaObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (isCaptchaElement(node)) {
            onCaptchaDetected(node);
            return;
          }
        }
      }

      // 检查是否有弹窗被移除
      if (captchaActive) {
        checkCaptchaGone();
      }
    });

    captchaObserver.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  function isCaptchaElement(el) {
    if (!el.textContent) return false;
    const text = el.textContent.toLowerCase();

    const captchaKeywords = [
      '滑块验证', '请完成验证', '验证码', '计算结果',
      '以下哪个选项正确', '请选择正确的', '拖动滑块',
      '请回答以下问题', '人机验证', '安全验证',
      '请输入验证码', '拼图验证'
    ];

    for (const kw of captchaKeywords) {
      if (text.includes(kw)) return true;
    }

    // 检查特殊类名
    const classNames = (el.className || '') + ' ' + (el.id || '');
    const captchaClasses = ['yidun', 'captcha', 'verification', 'verify', 'nc_wrapper', 'nocaptcha'];
    for (const cls of captchaClasses) {
      if (classNames.toLowerCase().includes(cls)) return true;
    }

    // 检查弹窗特征（高 z-index + 遮罩）
    if (el.nodeType === Node.ELEMENT_NODE) {
      try {
        const style = window.getComputedStyle(el);
        const zIndex = parseInt(style.zIndex);
        if (zIndex > 1000 && (style.position === 'fixed' || style.position === 'absolute')) {
          const overlay = el.querySelector('.yidun_modal, .captcha-modal, [class*="mask"], [class*="overlay"]');
          if (overlay) return true;
        }
      } catch (e) {}
    }

    return false;
  }

  function onCaptchaDetected(el) {
    if (captchaActive) return;
    captchaActive = true;
    log('检测到验证弹窗!');

    // 停止一切自动化
    stopAutoPlay();
    stopBehaviorSimulation();
    stopHeartbeat();

    sendToSW({ type: 'popup_detected' });
  }

  function checkCaptchaGone() {
    if (!captchaActive) return;

    const captchas = document.querySelectorAll('[class*="captcha"], [class*="yidun"], [class*="verification"], .nc_wrapper');
    let stillPresent = false;
    for (const c of captchas) {
      if (c.offsetParent !== null || c.offsetWidth > 0) {
        stillPresent = true;
        break;
      }
    }

    if (!stillPresent) {
      captchaActive = false;
      log('验证弹窗已消失，5秒后恢复自动化');
      sendToSW({ type: 'popup_gone' });

      setTimeout(() => {
        if (autoEnabled && videoElement && !captchaActive) {
          tryPlay();
          startBehaviorSimulation();
          startHeartbeat();
        }
      }, 5000);
    }
  }

  function stopAutoPlay() {
    // 暂停自动化但不改变开关状态
    isSwitching = false;
    // 取消所有待执行的切换定时器
  }

  // ======================== 拟人化行为仿真 ========================
  function startBehaviorSimulation() {
    stopBehaviorSimulation();
    behaviorRunning = true;

    // 随机鼠标移动
    scheduleMouseMove();

    // 随机无害点击
    scheduleClick();

    // 音量微调
    scheduleVolumeAdjust();

    // 键盘事件
    scheduleKeyEvent();

    // 模拟切出切回
    scheduleVisibilityToggle();

    sendToSW({
      type: 'status_report',
      disguiseActive: disguiseSetupDone,
      behaviorActive: true,
      hasVideo: !!videoElement,
      captchaActive,
      switchCount
    });
  }

  function stopBehaviorSimulation() {
    behaviorRunning = false;
    for (const key in behaviorTimers) {
      clearTimeout(behaviorTimers[key]);
      clearInterval(behaviorTimers[key]);
      delete behaviorTimers[key];
    }
    sendToSW({
      type: 'status_report',
      disguiseActive: disguiseSetupDone,
      behaviorActive: false,
      hasVideo: !!videoElement,
      captchaActive,
      switchCount
    });
  }

  function generateBezierPath(startX, startY, endX, endY, steps) {
    const points = [];
    const cp1x = startX + randFloat(-100, 100);
    const cp1y = startY + randFloat(-50, 50);
    const cp2x = endX + randFloat(-100, 100);
    const cp2y = endY + randFloat(-50, 50);

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = Math.pow(1 - t, 3) * startX + 3 * Math.pow(1 - t, 2) * t * cp1x + 3 * (1 - t) * Math.pow(t, 2) * cp2x + Math.pow(t, 3) * endX;
      const y = Math.pow(1 - t, 3) * startY + 3 * Math.pow(1 - t, 2) * t * cp1y + 3 * (1 - t) * Math.pow(t, 2) * cp2y + Math.pow(t, 3) * endY;
      points.push({ x, y });
    }
    return points;
  }

  function dispatchMouseMove(x, y) {
    document.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true,
      clientX: x,
      clientY: y,
      movementX: randFloat(-5, 5),
      movementY: randFloat(-5, 5)
    }));
  }

  async function performMouseMove() {
    const w = window.innerWidth;
    const h = window.innerHeight;

    const startX = randFloat(100, w - 100);
    const startY = randFloat(100, h - 150);
    const endX = randFloat(100, w - 100);
    const endY = randFloat(100, h - 150);

    const steps = rand(10, 25);
    const path = generateBezierPath(startX, startY, endX, endY, steps);

    for (let i = 0; i < path.length; i++) {
      dispatchMouseMove(path[i].x, path[i].y);
      await delay(rand(30, 80));
    }
  }

  function scheduleMouseMove() {
    const interval = rand(CONFIG.BEHAVIOR_MOUSE_MIN_INTERVAL, CONFIG.BEHAVIOR_MOUSE_MAX_INTERVAL);
    behaviorTimers.mouseMove = setTimeout(() => {
      performMouseMove().then(() => {
        if (videoElement && !captchaActive) {
          scheduleMouseMove();
        }
      });
    }, interval);
  }

  function scheduleClick() {
    const interval = rand(CONFIG.BEHAVIOR_CLICK_MIN_INTERVAL, CONFIG.BEHAVIOR_CLICK_MAX_INTERVAL);
    behaviorTimers.click = setTimeout(() => {
      if (!videoElement || captchaActive) return;

      const w = window.innerWidth;
      const h = window.innerHeight;
      const x = randFloat(100, w - 100);
      const y = randFloat(150, h - 200);

      // 在空白区域点击
      const el = document.elementFromPoint(x, y);
      if (el) {
        el.dispatchEvent(new MouseEvent('click', {
          bubbles: true,
          clientX: x,
          clientY: y
        }));
      }

      scheduleClick();
    }, interval);
  }

  function scheduleVolumeAdjust() {
    let pending = false;
    behaviorTimers.volumeAdjust = setInterval(() => {
      if (!videoElement || captchaActive || pending) return;

      try {
        pending = true;
        const origVol = videoElement.volume;
        const adjust = randFloat(-0.05, 0.05);
        videoElement.volume = Math.max(0, Math.min(1, origVol + adjust));

        // 200ms 后恢复
        setTimeout(() => {
          if (videoElement) {
            videoElement.volume = origVol;
          }
          pending = false;
        }, 200);
      } catch (e) {
        pending = false;
      }
    }, CONFIG.BEHAVIOR_VOLUME_INTERVAL_MS);
  }

  function scheduleKeyEvent() {
    const interval = rand(CONFIG.BEHAVIOR_KEY_MIN_INTERVAL, CONFIG.BEHAVIOR_KEY_MAX_INTERVAL);
    behaviorTimers.key = setTimeout(() => {
      if (!videoElement || captchaActive) return;

      const keys = ['ArrowRight', 'ArrowLeft', ' '];
      const key = keys[rand(0, keys.length - 1)];

      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: key,
        bubbles: true,
        cancelable: true
      }));

      scheduleKeyEvent();
    }, interval);
  }

  function scheduleVisibilityToggle() {
    const interval = rand(900000, 1800000);
    behaviorTimers.visibilityToggle = setTimeout(async () => {
      if (!videoElement || captchaActive) return;

      // 模拟切走
      document.dispatchEvent(new Event('visibilitychange'));
      await delay(rand(CONFIG.BEHAVIOR_VISIBILITY_MIN_IDLE, CONFIG.BEHAVIOR_VISIBILITY_MAX_IDLE));
      // 模拟切回
      document.dispatchEvent(new Event('visibilitychange'));
      await performMouseMove();

      scheduleVisibilityToggle();
    }, interval);
  }

  // ======================== 开关控制 ========================
  function enableAutoPlay() {
    if (autoEnabled) return;
    autoEnabled = true;
    log('自动播放已开启');

    if (videoElement && videoElement.paused && !videoElement.ended) {
      tryPlay();
    }

    if (videoElement) {
      startBehaviorSimulation();
      startHeartbeat();
    }
  }

  function disableAutoPlay() {
    if (!autoEnabled) return;
    autoEnabled = false;
    log('自动播放已暂停');

    stopBehaviorSimulation();
    stopHeartbeat();
    isSwitching = false;
  }

  function requestStatus() {
    sendToSW({ type: 'get_status' }).then((status) => {
      if (status) {
        if (status.autoEnabled) {
          enableAutoPlay();
        } else {
          disableAutoPlay();
        }
      }
    });
  }

  function listenForToggle() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      try {
        switch (message.type) {
          case 'toggle_auto':
            if (message.value) {
              enableAutoPlay();
            } else {
              disableAutoPlay();
            }
            sendResponse({ success: true });
            break;

          case 'request_status':
            sendResponse({
              hasVideo: !!videoElement,
              autoEnabled,
              captchaActive,
              videoInfo: getVideoInfo(),
              switchCount
            });
            break;

          default:
            break;
        }
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }

      return true;
    });
  }

  // ======================== 页面生命周期 ========================
  window.addEventListener('beforeunload', () => {
    if (videoPageObserver) {
      videoPageObserver.disconnect();
    }
    if (captchaObserver) {
      captchaObserver.disconnect();
    }
    if (videoObserver) {
      videoObserver.disconnect();
    }
    stopBehaviorSimulation();
    stopHeartbeat();
  });

  // ======================== 初始化 ========================
  function init() {
    // 非学习通页面不打日志
    setupVideoDetection();
    setupCaptchaDetection();
    setupDisguise();
    listenForToggle();
    requestStatus();

    log('内容脚本已初始化');
  }

  // 等待 DOM 就绪后初始化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
