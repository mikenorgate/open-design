// Dev server proxy: forward requests to a running Vite/Next/Remix/Astro
// dev server and inject OD bridges into HTML responses.
//
// Layer 2 of the React component development integration
// (specs/current/react-component-dev-integration.md).

import type { Express, Request, Response } from 'express';
import { request as httpRequest, IncomingMessage, type RequestOptions } from 'node:http';
import type { Socket } from 'node:net';
import { createWebSocketProxy, proxyWebSocketUpgrade } from './ws-proxy.js';
import { getDevServerRunner } from './runner.js';

function rewriteRootRelativeReferences(content: string, proxyBasePath: string): string {
  let rewritten = content
    // HTML attributes such as src="/src/main.tsx" or href="/_next/...".
    .replace(
      /\b(src|href|action|poster)=(["'])\/(?!\/|api\/projects\/)/g,
      (_match, attr: string, quote: string) => `${attr}=${quote}${proxyBasePath}/`,
    )
    // CSS references such as url(/assets/logo.svg).
    .replace(
      /url\(\s*(["']?)\/(?!\/|api\/projects\/)/g,
      (_match, quote: string) => `url(${quote}${proxyBasePath}/`,
    );

  // Vite and Next dev responses commonly contain absolute module specifiers
  // in JavaScript. Keep those requests under the project-scoped proxy.
  rewritten = rewritten.replace(
    /(["'`])\/(?!\/|api\/projects\/)(@vite|@react-refresh|\.storybook\/|src\/|node_modules\/|assets\/|_next\/|@fs\/|@id\/)/g,
    (_match, quote: string, prefix: string) => `${quote}${proxyBasePath}/${prefix}`,
  );

  rewritten = rewritten
    .replace(/(["'`])\/storybook-server-channel/g, (_match, quote: string) => `${quote}${proxyBasePath}/storybook-server-channel`)
    .replace(
      'const socketHost = `${null || importMetaUrl.hostname}:${hmrPort || importMetaUrl.port}${"/"}`;',
      'const socketHost = window.__OD_DEV_PROXY_WS_BASE__ ? window.__OD_DEV_PROXY_WS_BASE__.replace(/^wss?:\\/\\//, "") : `${null || importMetaUrl.hostname}:${hmrPort || importMetaUrl.port}${' + JSON.stringify(proxyBasePath + '/') + '}`;',
    );

  return rewritten;
}

function injectBridges(
  html: string,
  _devServerUrl: string,
  proxyWsBase: string,
  routeName: 'proxy' | 'app-proxy' = 'proxy',
  proxyBasePath = '',
): string {
  const appPreviewRootShim = routeName === 'app-proxy'
    ? `<script data-od-app-preview-runtime>(function(){
  var prefix = ${JSON.stringify(proxyBasePath)};
  var wsPrefix = ${JSON.stringify(proxyWsBase)};
  function appVisiblePathFromLocation(){
    try {
      var path = window.location.pathname;
      if (path === prefix) path = '/';
      else if (path.indexOf(prefix + '/') === 0) path = '/' + path.slice(prefix.length + 1);
      var params = new URLSearchParams(window.location.search || '');
      params.delete('odReload');
      var query = params.toString();
      return path + (query ? '?' + query : '') + window.location.hash;
    } catch (_) { return null; }
  }
  try {
    var visibleAppPath = appVisiblePathFromLocation();
    if (visibleAppPath && window.location.pathname.indexOf(prefix) === 0) history.replaceState(history.state, '', visibleAppPath);
  } catch (_) {}
  function isExternalProtocol(url){ return /^(?:[a-z][a-z0-9+.-]*:)?\\/\\//i.test(String(url || '')); }
  function appPath(path){ return prefix + '/' + String(path || '').replace(/^\\/+/, ''); }
  function toAppHttpUrl(input){
    if (typeof input !== 'string') input = String(input || '');
    if (!input || isExternalProtocol(input) && !(function(){ try { return new URL(input, window.location.href).origin === window.location.origin; } catch (_) { return false; } })()) return input;
    try {
      var url = new URL(input, window.location.href);
      if (url.origin !== window.location.origin) return input;
      if (url.pathname.indexOf(prefix + '/') === 0 || url.pathname === prefix) return url.pathname + url.search + url.hash;
      return appPath(url.pathname) + url.search + url.hash;
    } catch (_) {
      if (input.charAt(0) === '/' && input.indexOf(prefix + '/') !== 0 && input !== prefix) return appPath(input);
      return input;
    }
  }
  function toAppWsUrl(input){
    try {
      var url = new URL(String(input || ''), window.location.href);
      if (url.origin !== window.location.origin && url.protocol !== 'ws:' && url.protocol !== 'wss:') return input;
      if (url.pathname.indexOf(prefix + '/') === 0 || url.pathname === prefix) return input;
      return wsPrefix.replace(/\\/$/, '') + '/' + url.pathname.replace(/^\\/+/, '') + url.search + url.hash;
    } catch (_) { return input; }
  }
  try {
    var nativeFetch = window.fetch;
    window.fetch = function(input, init){
      if (typeof Request !== 'undefined' && input instanceof Request) {
        return nativeFetch.call(this, new Request(toAppHttpUrl(input.url), input), init);
      }
      return nativeFetch.call(this, toAppHttpUrl(input), init);
    };
  } catch (_) {}
  try {
    var nativeOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url){
      arguments[1] = toAppHttpUrl(url);
      return nativeOpen.apply(this, arguments);
    };
  } catch (_) {}
  try {
    var NativeEventSource = window.EventSource;
    if (NativeEventSource) window.EventSource = function(url, config){ return new NativeEventSource(toAppHttpUrl(url), config); };
  } catch (_) {}
  try {
    var NativeWebSocket = window.WebSocket;
    if (NativeWebSocket) window.WebSocket = function(url, protocols){ return protocols === undefined ? new NativeWebSocket(toAppWsUrl(url)) : new NativeWebSocket(toAppWsUrl(url), protocols); };
  } catch (_) {}
  try {
    var nativeBeacon = navigator.sendBeacon && navigator.sendBeacon.bind(navigator);
    if (nativeBeacon) navigator.sendBeacon = function(url, data){ return nativeBeacon(toAppHttpUrl(url), data); };
  } catch (_) {}

  var reactRoots = [];
  var reactRenderers = Object.create(null);
  var reactRendererSeq = 0;
  var refreshComponents = Object.create(null);
  var publishTimer = null;
  var lastReactContext = { route: '', title: '', components: [] };
  function sourceForFiber(fiber){
    var source = fiber && fiber._debugSource;
    if (!source || !source.fileName) return null;
    return { file: String(source.fileName), line: Number(source.lineNumber || 0), column: Number(source.columnNumber || 0) };
  }
  function componentNameForType(type){
    if (!type) return '';
    if (typeof type === 'string') return '';
    if (typeof type === 'function') return type.displayName || type.name || '';
    if (typeof type === 'object') {
      if (type.displayName) return String(type.displayName);
      if (type.render) return type.render.displayName || type.render.name || '';
      if (type.type) return componentNameForType(type.type);
    }
    return '';
  }
  function componentNameForFiber(fiber){ return componentNameForType(fiber && (fiber.elementType || fiber.type)); }
  function addComponent(summary, fiber, depth){
    var name = componentNameForFiber(fiber);
    if (!name) return;
    var source = sourceForFiber(fiber);
    var key = name + '|' + (source ? source.file + ':' + source.line : '');
    var existing = summary[key];
    if (existing) { existing.count += 1; existing.minDepth = Math.min(existing.minDepth, depth); return; }
    summary[key] = { name: name, count: 1, minDepth: depth, source: source };
  }
  function walkFiber(fiber, depth, summary, budget){
    for (var node = fiber; node && budget.count < 500; node = node.sibling) {
      budget.count += 1;
      addComponent(summary, node, depth);
      if (node.child) walkFiber(node.child, depth + 1, summary, budget);
    }
  }
  function sourceFromRefreshId(id){
    var raw = String(id || '');
    var match = raw.match(/([^\s]+\.[jt]sx?)(?:\s+|$)/i);
    if (!match) return null;
    return { file: match[1], line: 0, column: 0 };
  }
  function nameFromRefreshId(id, type){
    if (type) {
      var byType = componentNameForType(type);
      if (byType) return byType;
    }
    var raw = String(id || '').trim();
    if (!raw) return '';
    var parts = raw.split(/\s+/);
    return parts[parts.length - 1] || raw;
  }
  function noteRefreshComponent(type, id){
    var name = nameFromRefreshId(id, type);
    if (!name) return;
    var source = sourceFromRefreshId(id);
    var key = name + '|' + (source ? source.file : String(id || ''));
    var existing = refreshComponents[key];
    if (existing) { existing.count += 1; return; }
    refreshComponents[key] = { name: name, count: 1, minDepth: 50, source: source };
    scheduleReactContext();
  }
  function buildReactContext(){
    var summary = Object.create(null);
    for (var i = 0; i < reactRoots.length; i++) {
      var root = reactRoots[i];
      if (root && root.child) walkFiber(root.child, 0, summary, { count: 0 });
    }
    if (Object.keys(summary).length === 0) {
      for (var refreshKey in refreshComponents) summary[refreshKey] = refreshComponents[refreshKey];
    }
    var components = Object.keys(summary).map(function(key){ return summary[key]; }).sort(function(a, b){
      if (a.minDepth !== b.minDepth) return a.minDepth - b.minDepth;
      if (b.count !== a.count) return b.count - a.count;
      return a.name.localeCompare(b.name);
    }).slice(0, 120);
    lastReactContext = { route: window.location.pathname + window.location.search + window.location.hash, title: document.title || '', components: components };
    return lastReactContext;
  }
  function publishReactContext(){
    publishTimer = null;
    var context = buildReactContext();
    try { window.__OD_REACT_PAGE_CONTEXT__ = context; } catch (_) {}
    try { if (window.parent && window.parent !== window) window.parent.postMessage({ type: 'od:react-page-context', context: context }, '*'); } catch (_) {}
  }
  function scheduleReactContext(){
    if (publishTimer) return;
    publishTimer = setTimeout(publishReactContext, 80);
  }
  function findFiberForStateNode(fiber, domNode, budget){
    for (var node = fiber; node && budget.count < 3000; node = node.sibling) {
      budget.count += 1;
      if (node.stateNode === domNode) return node;
      if (node.child) {
        var found = findFiberForStateNode(node.child, domNode, budget);
        if (found) return found;
      }
    }
    return null;
  }
  function fiberForDomNode(node){
    for (var current = node; current && current !== document; current = current.parentNode) {
      var keys = Object.keys(current);
      for (var i = 0; i < keys.length; i++) {
        if (keys[i].indexOf('__reactFiber$') === 0 || keys[i].indexOf('__reactInternalInstance$') === 0) return current[keys[i]];
      }
    }
    for (var rootIndex = 0; rootIndex < reactRoots.length; rootIndex++) {
      var root = reactRoots[rootIndex];
      if (!root || !root.child) continue;
      for (var scanNode = node; scanNode && scanNode !== document; scanNode = scanNode.parentNode) {
        var found = findFiberForStateNode(root.child, scanNode, { count: 0 });
        if (found) return found;
      }
    }
    return null;
  }
  function componentStackForNode(node){
    var fiber = fiberForDomNode(node);
    var out = [];
    for (var current = fiber; current && out.length < 12; current = current.return) {
      var name = componentNameForFiber(current);
      if (!name) continue;
      var source = sourceForFiber(current);
      out.push({ name: name, source: source });
    }
    return out;
  }
  try { window.__OD_REACT_COMPONENT_STACK_FOR_NODE__ = componentStackForNode; } catch (_) {}
  try {
    var previousHook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    var odHook = previousHook && typeof previousHook === 'object' ? previousHook : {};
    if (!odHook.renderers || typeof odHook.renderers.set !== 'function') odHook.renderers = new Map();
    var previousInject = odHook.inject;
    var previousCommit = odHook.onCommitFiberRoot;
    odHook.supportsFiber = true;
    odHook.inject = function(renderer){
      var id = 0;
      try { if (typeof previousInject === 'function') id = previousInject.call(this, renderer) || 0; } catch (_) {}
      if (!id) id = ++reactRendererSeq;
      reactRenderers[id] = renderer;
      try { odHook.renderers.set(id, renderer); } catch (_) {}
      scheduleReactContext();
      return id;
    };
    odHook.onCommitFiberRoot = function(id, root){
      try { if (typeof previousCommit === 'function') previousCommit.apply(this, arguments); } catch (_) {}
      if (root && root.current && reactRoots.indexOf(root.current) < 0) reactRoots.push(root.current);
      scheduleReactContext();
    };
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = odHook;
  } catch (_) {}
  try {
    var currentRefreshReg = window.$RefreshReg$;
    Object.defineProperty(window, '$RefreshReg$', {
      configurable: true,
      get: function(){ return currentRefreshReg; },
      set: function(next){
        if (typeof next !== 'function') { currentRefreshReg = next; return; }
        currentRefreshReg = function(type, id){
          try { noteRefreshComponent(type, id); } catch (_) {}
          return next.apply(this, arguments);
        };
      }
    });
  } catch (_) {}
  ['pushState','replaceState'].forEach(function(method){
    try {
      var original = history[method];
      history[method] = function(){ var result = original.apply(this, arguments); scheduleReactContext(); return result; };
    } catch (_) {}
  });
  window.addEventListener('popstate', scheduleReactContext);
  window.addEventListener('load', scheduleReactContext);
})();</scr` + `ipt>`
    : '';
  const config = `${appPreviewRootShim}<script data-od-dev-proxy-config>window.__OD_DEV_PROXY_WS_BASE__=${JSON.stringify(proxyWsBase)};</scr` + `ipt>`;
  const annotationBridge = `<script data-od-annotation-bridge>(function(){
  var SKIP = ['script','style','template','noscript','iframe','object','embed','svg','path'];
  var PICKABLE = 'section,article,header,footer,nav,main,aside,h1,h2,h3,h4,h5,h6,button,a,[id],body>div[class],body>div[id],section>div[class],section>div[id],article>div[class],article>div[id],main>div[class],main>div[id],header>div[class],header>div[id],footer>div[class],footer>div[id],nav>div[class],nav>div[id],aside>div[class],aside>div[id],[id]>div[class],[id]>div[id]'.split(',');
  var seq = 0;
  var commentMode = false;
  var commentTool = 'inspect';
  var inspectMode = false;
  var inspectOriginalStyles = Object.create(null);
  var INSPECT_STYLE_PROPS = ['color','backgroundColor','fontSize','fontWeight','padding','borderRadius','textAlign','fontFamily'];
  function post(payload){
    try { if (window.parent && window.parent !== window) window.parent.postMessage(payload, '*'); } catch (_) {}
    try { if (window.top && window.top !== window) window.top.postMessage(payload, '*'); } catch (_) {}
  }
  function relay(payload){
    try {
      var frames = document.querySelectorAll('iframe');
      for (var i = 0; i < frames.length; i++) {
        if (frames[i].contentWindow) frames[i].contentWindow.postMessage(payload, '*');
      }
    } catch (_) {}
  }
  function cssEscape(value){
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(String(value || ''));
    return String(value || '').split(String.fromCharCode(92)).join(String.fromCharCode(92) + String.fromCharCode(92)).replace(/"/g, String.fromCharCode(92) + '"');
  }
  function pathId(node){
    var parts = [];
    for (var current = node; current && current !== document.body; current = current.parentElement) {
      var parent = current.parentElement;
      if (!parent) break;
      parts.unshift(Array.prototype.indexOf.call(parent.children, current));
    }
    return parts.length ? 'path-' + parts.join('-') : '';
  }
  function annotate(){
    if (!document.body) return;
    document.querySelectorAll(PICKABLE.join(',')).forEach(function(node){
      if (!node || !node.tagName || node.hasAttribute('data-od-id') || node.hasAttribute('data-screen-label')) return;
      var tag = node.tagName.toLowerCase();
      if (SKIP.indexOf(tag) >= 0) return;
      node.setAttribute('data-od-id', pathId(node) || ('od-' + tag + '-' + (seq++)));
    });
    postTargets();
  }
  function pick(start){
    for (var node = start; node && node !== document; node = node.parentElement) {
      if (node.getAttribute && (node.hasAttribute('data-od-id') || node.hasAttribute('data-screen-label'))) return node;
    }
    return null;
  }
  function payloadFor(el, type, event){
    var id = el.getAttribute('data-od-id') || el.getAttribute('data-screen-label') || '';
    var attr = el.hasAttribute('data-od-id') ? 'data-od-id' : 'data-screen-label';
    var rect = el.getBoundingClientRect();
    var style = window.getComputedStyle(el);
    var reactStack = [];
    var reactPageContext = null;
    try { if (typeof window.__OD_REACT_COMPONENT_STACK_FOR_NODE__ === 'function') reactStack = window.__OD_REACT_COMPONENT_STACK_FOR_NODE__(el) || []; } catch (_) {}
    try { reactPageContext = window.__OD_REACT_PAGE_CONTEXT__ || null; } catch (_) {}
    return {
      type: type,
      filePath: new URLSearchParams(window.location.search).get('odFile') || '',
      elementId: id,
      selector: '[' + attr + '="' + cssEscape(id) + '"]',
      label: el.getAttribute('aria-label') || el.getAttribute('title') || el.id || id,
      tagName: (el.tagName || '').toLowerCase(),
      text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 220),
      htmlHint: (el.outerHTML || '').slice(0, 500),
      position: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      hoverPoint: event ? { x: event.clientX, y: event.clientY } : undefined,
      style: {
        color: style.color,
        backgroundColor: style.backgroundColor,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        borderRadius: style.borderRadius,
        padding: style.padding
      },
      react: {
        route: reactPageContext && reactPageContext.route || window.location.pathname + window.location.search + window.location.hash,
        title: reactPageContext && reactPageContext.title || document.title || '',
        componentStack: reactStack,
        pageComponents: reactPageContext && reactPageContext.components || []
      },
      selectionKind: 'element'
    };
  }
  function allTargets(){
    var nodes = document.querySelectorAll('[data-od-id],[data-screen-label]');
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      var rect = nodes[i].getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      out.push(payloadFor(nodes[i], 'od:comment-targets'));
    }
    return out;
  }
  function postTargets(){ post({ type: 'od:comment-targets', targets: allTargets() }); }
  function modeActive(){ return inspectMode || commentMode; }
  function inspectTargetByPayload(data){
    if (data.selector) {
      try { var selected = document.querySelector(String(data.selector)); if (selected) return selected; } catch (_) {}
    }
    if (!data.elementId) return null;
    try { return document.querySelector('[data-od-id="' + cssEscape(data.elementId) + '"],[data-screen-label="' + cssEscape(data.elementId) + '"]'); } catch (_) { return null; }
  }
  function applyInspectStyle(data){
    var el = inspectTargetByPayload(data);
    var prop = String(data.prop || '');
    if (!el || INSPECT_STYLE_PROPS.indexOf(prop) < 0) return;
    var id = el.getAttribute('data-od-id') || el.getAttribute('data-screen-label') || String(data.elementId || '');
    if (!inspectOriginalStyles[id]) inspectOriginalStyles[id] = el.getAttribute('style') || '';
    var value = String(data.value || '').trim();
    if (value) el.style[prop] = value;
    else el.style[prop] = '';
  }
  function resetInspectStyle(data){
    var el = inspectTargetByPayload(data);
    if (!el) return;
    var id = el.getAttribute('data-od-id') || el.getAttribute('data-screen-label') || String(data.elementId || '');
    if (Object.prototype.hasOwnProperty.call(inspectOriginalStyles, id)) {
      var original = inspectOriginalStyles[id];
      if (original) el.setAttribute('style', original);
      else el.removeAttribute('style');
      delete inspectOriginalStyles[id];
    }
  }
  window.addEventListener('message', function(ev){
    var data = ev && ev.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'od:inspect-mode') {
      inspectMode = !!data.enabled;
      document.documentElement.toggleAttribute('data-od-inspect-mode', inspectMode);
      relay(data);
      if (inspectMode) postTargets();
    }
    if (data.type === 'od:comment-mode') {
      commentMode = !!data.enabled;
      commentTool = data.mode || 'inspect';
      document.documentElement.toggleAttribute('data-od-comment-mode', commentMode);
      relay(data);
      if (commentMode) postTargets();
    }
    if (data.type === 'od:inspect-set') applyInspectStyle(data);
    if (data.type === 'od:inspect-reset') resetInspectStyle(data);
    if (data.type === 'od:snapshot' && data.id) {
      var storyFrame = document.getElementById('storybook-preview-iframe');
      if (storyFrame && storyFrame.contentWindow) {
        var snapshotId = String(data.id);
        var done = false;
        var timer = setTimeout(function(){ if (!done) renderSnapshot(snapshotId); }, 1200);
        var relaySnapshot = function(childEvent){
          var childData = childEvent && childEvent.data;
          if (!childData || childData.type !== 'od:snapshot:result' || childData.id !== snapshotId) return;
          done = true;
          clearTimeout(timer);
          window.removeEventListener('message', relaySnapshot);
          post(childData);
        };
        window.addEventListener('message', relaySnapshot);
        storyFrame.contentWindow.postMessage(data, '*');
        return;
      }
      renderSnapshot(String(data.id));
    }
  });
  document.addEventListener('mousemove', function(ev){
    if (!modeActive()) return;
    var el = pick(ev.target);
    if (!el) { post({ type: 'od:comment-leave' }); return; }
    if (commentMode) post(payloadFor(el, 'od:comment-hover', ev));
  }, true);
  document.addEventListener('click', function(ev){
    if (!modeActive()) return;
    var el = pick(ev.target);
    if (!el) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (inspectMode) post(payloadFor(el, 'od:inspect-target', ev));
    if (commentMode && commentTool !== 'pod') post(payloadFor(el, 'od:comment-target', ev));
  }, true);
  function copyComputed(source, target){
    if (!source || !target || source.nodeType !== 1 || target.nodeType !== 1) return;
    var computed = window.getComputedStyle(source);
    var props = ['display','position','box-sizing','width','height','margin','padding','border','border-radius','font','font-family','font-size','font-weight','line-height','letter-spacing','color','background','background-color','opacity','transform','overflow','white-space','text-align','object-fit','flex','grid','gap','align-items','justify-content','inset','top','right','bottom','left','z-index','box-shadow','text-shadow'];
    var style = target.getAttribute('style') || '';
    for (var i = 0; i < props.length; i++) {
      var value = computed.getPropertyValue(props[i]);
      if (value) style += props[i] + ':' + value + ';';
    }
    target.setAttribute('style', style);
  }
  function inlineSnapshotStyles(originalRoot, cloneRoot){
    copyComputed(originalRoot, cloneRoot);
    var originals = originalRoot.querySelectorAll('*');
    var clones = cloneRoot.querySelectorAll('*');
    var count = Math.min(originals.length, clones.length, 3500);
    for (var i = 0; i < count; i++) copyComputed(originals[i], clones[i]);
    cloneRoot.querySelectorAll('script').forEach(function(node){ node.remove(); });
    cloneRoot.querySelectorAll('link[rel~="stylesheet"],link[rel~="preload"],link[rel~="preconnect"]').forEach(function(node){ node.remove(); });
  }
  function renderSnapshot(id){
    try {
      var w = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1);
      var h = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
      var dpr = window.devicePixelRatio || 1;
      var clone = document.documentElement.cloneNode(true);
      clone.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
      inlineSnapshotStyles(document.documentElement, clone);
      var body = clone.querySelector('body');
      var html = '<div xmlns="http://www.w3.org/1999/xhtml" style="margin:0;width:' + w + 'px;height:' + h + 'px;overflow:hidden;">' + (body ? body.innerHTML : clone.innerHTML) + '</div>';
      var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '"><foreignObject x="0" y="0" width="' + w + '" height="' + h + '">' + html + '</foreignObject></svg>';
      var img = new Image();
      img.onload = function(){
        try {
          var canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.floor(w * dpr));
          canvas.height = Math.max(1, Math.floor(h * dpr));
          var ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('no 2d context');
          ctx.scale(dpr, dpr);
          ctx.drawImage(img, 0, 0, w, h);
          post({ type: 'od:snapshot:result', id: id, dataUrl: canvas.toDataURL('image/png'), w: canvas.width, h: canvas.height });
        } catch (err) { post({ type: 'od:snapshot:result', id: id, error: String(err && err.message || err) }); }
      };
      img.onerror = function(){ post({ type: 'od:snapshot:result', id: id, error: 'snapshot image failed' }); };
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    } catch (err) { post({ type: 'od:snapshot:result', id: id, error: String(err && err.message || err) }); }
  }
  function startAnnotationBridge(){
    annotate();
    var mo = new MutationObserver(function(){ mo.disconnect(); annotate(); if (document.body) mo.observe(document.body, { childList: true, subtree: true }); });
    if (document.body) mo.observe(document.body, { childList: true, subtree: true });
  }
  if (document.body) startAnnotationBridge();
  else window.addEventListener('DOMContentLoaded', startAnnotationBridge, { once: true });
})();</scr` + `ipt>`;
  const injection = [config, annotationBridge].join('\n');
  const lower = html.toLowerCase();
  const headEnd = lower.indexOf('</head>');
  if (headEnd >= 0) return html.slice(0, headEnd) + '\n' + injection + '\n' + html.slice(headEnd);
  const bodyEnd = lower.lastIndexOf('</body>');
  if (bodyEnd >= 0) return html.slice(0, bodyEnd) + '\n' + injection + '\n' + html.slice(bodyEnd);
  return injection + '\n' + html;
}

// --- Proxy route registration -------------------------------------

import type { RouteDeps } from '../server-context.js';

export interface RegisterDevServerProxyDeps
  extends RouteDeps<'db' | 'http' | 'paths' | 'projectStore' | 'projectFiles'> {}

export function registerDevServerProxyRoutes(app: Express, ctx: RegisterDevServerProxyDeps) {
  const makeProxyHandler = (routeName: 'proxy' | 'app-proxy') => async (req: Request, res: Response) => {
    try {
      const projectId = String(req.params.id ?? '').trim();
      const runner = getDevServerRunner();
      const primaryHandle = runner.get(projectId);
      const appHandle = routeName === 'app-proxy'
        ? runner.get(`${projectId}:app`) ?? (primaryHandle?.framework === 'storybook' ? undefined : primaryHandle)
        : primaryHandle;
      const handle = routeName === 'app-proxy' ? appHandle : primaryHandle;

      if (!handle || handle.status !== 'running') {
        return res.status(503).json({
          error: 'Dev server is not running. Start it from the workspace Dev server control.',
          projectId,
        });
      }

      // Handle WebSocket upgrade for Vite HMR
      if (
        req.headers.upgrade &&
        req.headers.upgrade.toLowerCase() === 'websocket'
      ) {
        await handleWebSocketProxy(req, handle.port, projectId, res);
        return;
      }

      // Forward the HTTP request to the dev server
      await proxyHttpRequest(req, handle.port, handle.url, projectId, res, routeName);
    } catch (err: any) {
      console.error(`[dev-server:proxy] error for project ${req.params.id}:`, err.message);
      if (!res.headersSent) {
        res.status(502).json({ error: 'Proxy error', detail: err.message });
      }
    }
  };

  const proxyHandler = makeProxyHandler('proxy');
  const appProxyHandler = makeProxyHandler('app-proxy');

  // Express 5/path-to-regexp requires named wildcards. Redirect the no-slash
  // root to `/proxy/` so Storybook's `./sb-manager/...` relative asset URLs
  // resolve under the proxy prefix instead of escaping to `/dev-server/...`.
  app.all('/api/projects/:id/dev-server/proxy', (req, res) => {
    if (req.path.endsWith('/proxy')) {
      const query = req.originalUrl.includes('?')
        ? req.originalUrl.slice(req.originalUrl.indexOf('?'))
        : '';
      res.redirect(307, `/api/projects/${encodeURIComponent(String(req.params.id ?? ''))}/dev-server/proxy/${query}`);
      return;
    }
    void proxyHandler(req, res);
  });
  app.all('/api/projects/:id/dev-server/proxy/', proxyHandler);
  app.all('/api/projects/:id/dev-server/proxy/*splat', proxyHandler);

  app.all('/api/projects/:id/dev-server/app-proxy', (req, res) => {
    if (req.path.endsWith('/app-proxy')) {
      const query = req.originalUrl.includes('?')
        ? req.originalUrl.slice(req.originalUrl.indexOf('?'))
        : '';
      res.redirect(307, `/api/projects/${encodeURIComponent(String(req.params.id ?? ''))}/dev-server/app-proxy/${query}`);
      return;
    }
    void appProxyHandler(req, res);
  });
  app.all('/api/projects/:id/dev-server/app-proxy/', appProxyHandler);
  app.all('/api/projects/:id/dev-server/app-proxy/*splat', appProxyHandler);
}

export function handleDevServerProxyUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): boolean {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const match = url.pathname.match(/^\/api\/projects\/([^/]+)\/dev-server\/(proxy|app-proxy)\/?(.*)$/);
  if (!match) return false;

  const projectId = decodeURIComponent(match[1] ?? '');
  const routeName = match[2] === 'app-proxy' ? 'app-proxy' : 'proxy';
  const runner = getDevServerRunner();
  const primaryHandle = runner.get(projectId);
  const appHandle = routeName === 'app-proxy'
    ? runner.get(`${projectId}:app`) ?? (primaryHandle?.framework === 'storybook' ? undefined : primaryHandle)
    : primaryHandle;
  const handle = routeName === 'app-proxy' ? appHandle : primaryHandle;
  if (!handle || handle.status !== 'running') {
    socket.write('HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nDev server is not running.');
    socket.end();
    return true;
  }

  const rest = match[3] ?? '';
  const targetPath = `/${rest}${url.search}`;
  proxyWebSocketUpgrade(req, socket, head, {
    hostname: 'localhost',
    port: handle.port,
    path: targetPath,
    headers: {},
  });
  return true;
}

// --- HTTP proxy ---------------------------------------------------

async function proxyHttpRequest(
  req: Request,
  devPort: number,
  devUrl: string,
  projectId: string,
  res: Response,
  routeName: 'proxy' | 'app-proxy' = 'proxy',
): Promise<void> {
  const proxyBasePath = `/api/projects/${encodeURIComponent(projectId)}/dev-server/${routeName}`;
  const path = req.path.replace(proxyBasePath, '') || '/';

  const serializedBody = serializeParsedRequestBody(req);
  const forwardedHeaders = filterProxyHeaders(req.headers, { dropContentLength: serializedBody !== null });
  if (serializedBody !== null) {
    forwardedHeaders['content-length'] = String(serializedBody.length);
  }

  const options: RequestOptions = {
    hostname: 'localhost',
    port: devPort,
    path: path + (req.url?.includes('?') ? '?' + req.url.split('?')[1] : ''),
    method: req.method,
    headers: {
      ...forwardedHeaders,
      host: `localhost:${devPort}`,
    },
  };

  const proxyReq = httpRequest(options, (proxyRes: IncomingMessage) => {
    const contentType = String(proxyRes.headers['content-type'] || '');
    const isHtml = contentType.includes('text/html');
    const isRewriteableText =
      isHtml ||
      contentType.includes('javascript') ||
      contentType.includes('application/x-javascript') ||
      contentType.includes('text/css');

    // Copy response headers (skip hop-by-hop)
    for (const [key, value] of Object.entries(proxyRes.headers)) {
      if (isHopByHopHeader(key)) continue;
      if (value !== undefined) {
        // For HTML, we modify so we can't use Content-Length from upstream
        if (isRewriteableText && key.toLowerCase() === 'content-length') continue;
        if (isRewriteableText && key.toLowerCase() === 'content-encoding') continue;
        if (Array.isArray(value)) {
          res.setHeader(key, value.map(String));
        } else {
          res.setHeader(key, String(value));
        }
      }
    }

    res.statusCode = proxyRes.statusCode ?? 200;

    // Rewrite Location headers on 3xx redirects so the browser stays within
    // the proxy prefix instead of navigating to a bare path on the OD daemon.
    const statusCode = proxyRes.statusCode ?? 200;
    if (statusCode >= 300 && statusCode < 400) {
      const location = res.getHeader('location');
      if (typeof location === 'string' && location.startsWith('/') && !location.startsWith(proxyBasePath)) {
        res.setHeader('location', proxyBasePath + location);
      }
    }

    if (isRewriteableText && proxyRes.statusCode && proxyRes.statusCode < 400) {
      const chunks: Buffer[] = [];
      proxyRes.on('data', (chunk: Buffer) => chunks.push(chunk));
      proxyRes.on('end', () => {
        const source = Buffer.concat(chunks).toString('utf8');
        const withRewrittenUrls = rewriteRootRelativeReferences(source, proxyBasePath);
        const localPort = req.socket.localPort ?? devPort;
        const proxyWsBase = `ws://127.0.0.1:${localPort}${proxyBasePath}/`;
        const modified = isHtml ? injectBridges(withRewrittenUrls, devUrl, proxyWsBase, routeName, proxyBasePath) : withRewrittenUrls;
        res.removeHeader('content-encoding');
        if (isHtml) res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(modified);
      });
    } else {
      // Pass through non-HTML responses.
      proxyRes.pipe(res);
    }
  });

  proxyReq.on('error', (err) => {
    console.error(`[dev-server:proxy] upstream error (${devPort}${path}):`, err.message);
    if (!res.headersSent) {
      res.status(502).json({ error: 'Dev server unreachable', detail: err.message });
    }
  });

  // Forward request body if present. The daemon installs express.json()
  // globally before these routes, so JSON request bodies may already be
  // consumed by the time the proxy route runs. In that case req.pipe() would
  // forward zero bytes while the original Content-Length asks the upstream
  // dev server to wait for a body, commonly surfacing as a 502. Re-serialize
  // parsed bodies and set a fresh length; only stream untouched requests.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (serializedBody !== null) proxyReq.end(serializedBody);
    else req.pipe(proxyReq);
  } else {
    proxyReq.end();
  }
}

// --- WebSocket proxy ----------------------------------------------

async function handleWebSocketProxy(
  req: Request,
  devPort: number,
  projectId: string,
  res: Response,
): Promise<void> {
  const socket = (req as any).socket as Socket;

  try {
    createWebSocketProxy(socket, {
      hostname: 'localhost',
      port: devPort,
      path: req.url?.replace(
        `/api/projects/${encodeURIComponent(projectId)}/dev-server/proxy`,
        '',
      ) || '/',
      headers: filterProxyHeaders(req.headers),
    });
    // The WebSocket proxy handles the socket directly — Express won't
    // send a response. Just ensure we don't close the socket.
  } catch (err: any) {
    console.error('[dev-server:ws-proxy] error:', err.message);
    if (!res.headersSent) {
      res.status(502).json({ error: 'WebSocket proxy error', detail: err.message });
    }
  }
}

// --- Helpers ------------------------------------------------------

/** Headers to strip when forwarding (hop-by-hop). */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
]);

function isHopByHopHeader(name: string): boolean {
  return HOP_BY_HOP_HEADERS.has(name.toLowerCase());
}

/** Filter out headers that shouldn't be forwarded to the dev server. */
function filterProxyHeaders(
  headers: Record<string, string | string[] | undefined>,
  options: { dropContentLength?: boolean } = {},
): Record<string, string | string[] | undefined> {
  const filtered: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (isHopByHopHeader(key)) continue;
    if (lower === 'host') continue; // Set from target
    if (lower === 'origin') continue; // Dev server may reject cross-origin
    if (lower === 'accept-encoding') continue; // We rewrite text bodies; request plain text.
    if (options.dropContentLength && lower === 'content-length') continue;
    if (value !== undefined) {
      filtered[key] = value;
    }
  }
  return filtered;
}

function serializeParsedRequestBody(req: Request): Buffer | null {
  const body = (req as Request & { body?: unknown }).body;
  if (body === undefined) return null;
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body);
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (body === null) return Buffer.from('null');
  if (contentType.includes('application/x-www-form-urlencoded') && typeof body === 'object') {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        for (const item of value) params.append(key, String(item));
      } else if (value !== undefined) {
        params.set(key, String(value));
      }
    }
    return Buffer.from(params.toString());
  }
  return Buffer.from(JSON.stringify(body));
}
