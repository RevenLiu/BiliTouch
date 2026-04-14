// ==UserScript==
// @name         BiliTouch
// @namespace    https://github.com/RevenLiu
// @version      1.1.4
// @description  一个为移动端打造的Web端B站网页播放器交互重构的篡改猴脚本。支持两侧滑动调节亮度与音量、横向滑动调节时间进度、单击显隐工具栏、双击播放/暂停、双指缩放位移、长按倍速。让网页版拥有原生 App 般的使用体验。
// @author       RevenLiu
// @license      MIT
// @icon         https://raw.githubusercontent.com/RevenLiu/BiliTouch/main/Icon.png
// @homepage     https://github.com/RevenLiu/BiliTouch
// @supportURL   https://github.com/RevenLiu/BiliTouch/issues
// @match        *://www.bilibili.com/video/*
// @match        *://www.bilibili.com/list/*
// @match        *://www.bilibili.com/bangumi/*
// @match        *://live.bilibili.com/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    const IS_LIVE = location.hostname === 'live.bilibili.com';
    const TARGET = IS_LIVE ? '.live-player-mounter' : '.bpx-player-video-perch';
    const AREA = IS_LIVE ? '.live-player-mounter' : '.bpx-player-video-area';

    // 样式与 UI 注入
    const style = document.createElement('style');
    style.innerHTML = `
        .my-force-show .bpx-player-control-entity, .my-force-show .bpx-player-pbp {
            opacity: 1 !important; visibility: visible !important; display: block !important;
        }
        .bpx-player-pbp:not(.show) { pointer-events: none !important; }
        ${TARGET} { touch-action: none !important; -webkit-tap-highlight-color: transparent !important; }
        #gesture-hud {
            position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
            background: rgba(0,0,0,0.75); color: #fff; padding: 12px 24px; border-radius: 10px;
            z-index: 999999; display: none; pointer-events: none; font-size: 20px; font-weight: bold; text-align: center;
        }
        #gesture-hud.top-style { top: 40px; transform: translate(-50%, 0); padding: 6px 16px; font-size: 14px; background: rgba(0,0,0,0.5); }
        #brightness-overlay {
            position: absolute; top: 0; left: 0; width: 100%; height: 100%;
            background: black; opacity: 0; pointer-events: none; z-index: 1000000;
        }
        .bpx-player-contextmenu.bpx-player-active { display: none !important; visibility: hidden !important; opacity: 0 !important; }
    `;
    document.head.appendChild(style);

    // 状态变量
    let clickTimer = null, longPressTimer = null, touchStartX = 0, touchStartY = 0;
    let baseTime = 0, targetTime = 0, baseVolume = 0, startOpacity = 0;
    let gestureMode = null, isGestureMoving = false, isLongPressing = false;
    let lastGestureTime = 0; 

    // 缩放状态
    let scale = 1, lastScale = 1, translateX = 0, translateY = 0, lastPosX = 0, lastPosY = 0;
    let startDistance = 0, startMidX = 0, startMidY = 0;

    // 工具函数
    const getEl = (id, parent, creator) => {
        let el = document.getElementById(id);
        if (!el) { el = creator(); (document.querySelector(parent) || document.body).appendChild(el); }
        return el;
    };

    const showHUD = (text, isTop = false) => {
        const hud = getEl('gesture-hud', AREA, () => {
            const d = document.createElement('div'); d.id = 'gesture-hud'; return d;
        });
        hud.innerText = text; 
        hud.classList.toggle('top-style', isTop);
        hud.style.display = 'block';
    };

    const formatTime = (s) => isNaN(s) ? "00:00" : `${Math.floor(s/60).toString().padStart(2,'0')}:${Math.floor(s%60).toString().padStart(2,'0')}`;

    const updateTransform = (v) => {
        if (!v) return;
        if (scale <= 1.01) { scale = 1; translateX = 0; translateY = 0; }
        v.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
    };

    const toggleControls = () => {
        if (IS_LIVE) return;
        const container = document.querySelector('.bpx-player-container');
        const entity = document.querySelector('.bpx-player-control-entity');
        const pbp = document.querySelector('.bpx-player-pbp');
        if (!container || !entity) return;
        const isLocked = container.classList.toggle('my-force-show');
        container.setAttribute('data-ctrl-hidden', !isLocked);
        entity.setAttribute('data-shadow-show', !isLocked);
        if (pbp) { pbp.classList.toggle('show', isLocked); window.dispatchEvent(new Event('resize')); }
    };

    // 手势逻辑
    document.addEventListener('touchstart', (e) => {
        const perch = e.target.closest(TARGET);
        const v = document.querySelector('video');
        if (!perch || !v) return;

        gestureMode = null;
        isGestureMoving = false;

        if (e.touches.length === 2) {
            gestureMode = 'zoom';
            startDistance = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
            startMidX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
            startMidY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
            lastScale = scale; lastPosX = translateX; lastPosY = translateY;
            clearTimeout(longPressTimer);
        } else if (e.touches.length === 1) {
            touchStartX = e.touches[0].clientX;
            touchStartY = e.touches[0].clientY;
            baseTime = v.currentTime;
            baseVolume = v.volume;
            const overlay = document.getElementById('brightness-overlay');
            startOpacity = overlay ? parseFloat(overlay.style.opacity) || 0 : 0;

            if (!IS_LIVE) {
                longPressTimer = setTimeout(() => {
                    if (!isGestureMoving && !gestureMode && (Date.now() - lastGestureTime > 200)) {
                        isLongPressing = true;
                        v.playbackRate = 2.0;
                        showHUD(">> 2.0X 倍速播放中", true);
                    }
                }, 300);
            }
        }
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
        const perch = e.target.closest(TARGET);
        const v = document.querySelector('video');
        if (!perch || !v) return;

        if (e.touches.length === 1 && (Date.now() - lastGestureTime < 200)) return;

        if (gestureMode === 'zoom' && e.touches.length === 2) {
            isGestureMoving = true;
            const curDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
            const curMidX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
            const curMidY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
            const zoomFactor = curDist / startDistance;
            scale = Math.max(1, Math.min(4, lastScale * zoomFactor));
            translateX = lastPosX + (curMidX - startMidX);
            translateY = lastPosY + (curMidY - startMidY);
            updateTransform(v);
            showHUD(`缩放: ${Math.round(scale * 100)}%`);
            if (e.cancelable) e.preventDefault();
        } 
        else if (e.touches.length === 1) {
            const deltaX = e.touches[0].clientX - touchStartX;
            const deltaY = touchStartY - e.touches[0].clientY;

            if (Math.abs(deltaX) > 10 || Math.abs(deltaY) > 10) clearTimeout(longPressTimer);

            if (!gestureMode && !isLongPressing) {
                if (scale > 1.01) {
                    gestureMode = 'drag';
                    lastPosX = translateX; lastPosY = translateY;
                } else {
                    if (!IS_LIVE && Math.abs(deltaX) > 20) gestureMode = 'progress';
                    else if (Math.abs(deltaY) > 20) gestureMode = touchStartX < (perch.offsetWidth / 2) ? 'brightness' : 'volume';
                }
            }

            if (gestureMode) {
                isGestureMoving = true;
                if (e.cancelable) e.preventDefault();
                if (gestureMode === 'drag') {
                    translateX = lastPosX + (e.touches[0].clientX - touchStartX);
                    translateY = lastPosY + (e.touches[0].clientY - touchStartY);
                    updateTransform(v);
                } else if (gestureMode === 'progress') {
                    const speed = 120 / (perch.offsetWidth || 500);
                    targetTime = Math.max(0, Math.min(v.duration, baseTime + deltaX * speed));
                    showHUD(`${deltaX > 0 ? '▶▶' : '◀◀'} ${formatTime(targetTime)} / ${formatTime(v.duration)}`);
                } else if (gestureMode === 'volume') {
                    v.volume = Math.max(0, Math.min(1, baseVolume + (deltaY / (perch.offsetHeight || 300))));
                    showHUD(`🔊 音量: ${Math.round(v.volume * 100)}%`);
                } else if (gestureMode === 'brightness') {
                    const currentOpacity = Math.max(0, Math.min(0.8, startOpacity - (deltaY / (perch.offsetHeight || 300)) * 0.5));
                    const overlay = getEl('brightness-overlay', AREA, () => {
                        const d = document.createElement('div'); d.id = 'brightness-overlay'; return d;
                    });
                    overlay.style.opacity = currentOpacity;
                    showHUD(`🔆 亮度: ${Math.round((1 - currentOpacity) * 100)}%`);
                }
            }
        }
    }, { passive: false });

    document.addEventListener('touchend', (e) => {
        clearTimeout(longPressTimer);
        const v = document.querySelector('video');
        
        if (gestureMode === 'zoom' || gestureMode === 'drag') {
            lastGestureTime = Date.now();
        }

        if (isLongPressing) {
            isLongPressing = false;
            if (v) v.playbackRate = 1.0;
        }

        if (isGestureMoving && gestureMode === 'progress') {
            if (v) v.currentTime = targetTime;
        }
        
        const hud = document.getElementById('gesture-hud');
        if (hud) {
            hud.style.display = 'none';
            hud.classList.remove('top-style');
        }
        
        if (e.touches.length === 0) {
            gestureMode = null;
        }
    }, { passive: true });

    // 点击与冲突拦截
    document.addEventListener('click', (e) => {
        const perch = e.target.closest(TARGET);
        if (!perch || IS_LIVE) return; // 直播页跳过单击拦截

        if (isGestureMoving || isLongPressing || (Date.now() - lastGestureTime < 200)) { 
            isGestureMoving = false; 
            e.stopImmediatePropagation(); e.preventDefault(); 
            return; 
        }
        e.stopImmediatePropagation(); e.preventDefault();
        if (clickTimer) {
            clearTimeout(clickTimer); clickTimer = null;
            const v = document.querySelector('video'); if (v) v.paused ? v.play() : v.pause();
        } else {
            clickTimer = setTimeout(() => { clickTimer = null; toggleControls(); }, 250);
        }
    }, true);

    // 屏蔽右键菜单
    document.addEventListener('contextmenu', (e) => {
        if (e.target.closest(TARGET)) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);

    // 处理直播页双击 (暂停/播放)
    document.addEventListener('dblclick', (e) => {
        if (e.target.closest(TARGET)) { 
            e.stopImmediatePropagation(); 
            e.preventDefault(); 
            if (IS_LIVE) {
                const v = document.querySelector('video');
                if (v) v.paused ? v.play() : v.pause();
            }
        }
    }, true);

    // 自动化宽屏
    if (!IS_LIVE) {
        const observer = new MutationObserver((_, obs) => {
            const btn = document.querySelector('.bpx-player-ctrl-wide-enter');
            if (btn) { btn.click(); obs.disconnect(); }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }
})();