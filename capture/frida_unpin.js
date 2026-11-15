/**
 * frida SSL Pinning 解除脚本 —— 微信 / 小程序强校验时用
 *
 * 前提：iPhone 已越狱 + 已安装 frida-server（Sileo/Cydia 源: https://build.frida.re）
 *
 * 用法：
 *   frida-ps -U | grep -i wechat          # 找进程名（WeChat / 微信）
 *   frida -U -f com.tencent.xin -l capture/frida_unpin.js --no-pause
 *   # 或 attach 已运行进程：
 *   frida -U WeChat -l capture/frida_unpin.js
 *
 * 作用：Hook 掉 iOS 上常见的证书校验入口，让 mitmproxy 的 CA 被接受。
 */
(function () {
  if (!ObjC.available) {
    console.log('[!] 非 Objective-C 环境，跳过');
    return;
  }

  const log = (m) => console.log('[unpin] ' + m);

  /* 1) NSURLSession / NSURLConnection 的 delegate 校验 */
  try {
    const NSURLSession = ObjC.classes.NSURLSession;
    const methods = [
      '- URLSession:didReceiveChallenge:completionHandler:',
      '- URLSession:task:didReceiveChallenge:completionHandler:',
      '- URLSession:task:didCompleteWithError:',
    ];
    for (const m of methods) {
      if (!NSURLSession[m]) continue;
      Interceptor.attach(NSURLSession[m].implementation, {
        onEnter(args) {
          log('hit ' + m);
          // completionHandler 通常会要求用 serverTrust 评估；直接给"接受"
          try {
            const block = new ObjC.Block(args[4] || args[3]);
            const orig = block.implementation;
            block.implementation = function (disposition, credential) {
              // NSURLSessionAuthChallengeUseCredential = 0, PerformDefaultHandling = 1
              log('  → force UseCredential(default handling)');
              orig(1, credential);
            };
          } catch (e) { log('  block patch fail: ' + e); }
        },
      });
      log('hooked ' + m);
    }
  } catch (e) { log('NSURLSession hook fail: ' + e); }

  /* 2) SecTrustEvaluate / SecTrustEvaluateWithError —— 底层信任评估 */
  for (const sym of ['SecTrustEvaluate', 'SecTrustEvaluateWithError']) {
    const p = Module.findExportByName(null, sym);
    if (!p) { log(sym + ' 未找到'); continue; }
    Interceptor.replace(p, new NativeCallback(function () {
      log(sym + ' → 强制 true');
      return 1; // errSecSuccess / true
    }, 'int', ['pointer', 'pointer']));
    log('replaced ' + sym);
  }

  /* 3) AFNetworking / 常见第三方库的 pinning 回调 */
  const suspects = [
    'AFSecurityPolicy', 'SecurityPolicy', 'SSLPinning', 'TrustKit',
    'NSURLSessionConfiguration', 'WKWebView',
  ];
  for (const cls of suspects) {
    if (!ObjC.classes[cls]) continue;
    const own = ObjC.classes[cls].$ownMethods || [];
    for (const m of own) {
      if (!/trust|evaluate|pinning|serverTrust|challenge/i.test(m)) continue;
      try {
        Interceptor.attach(ObjC.classes[cls][m].implementation, {
          onLeave(retval) {
            try { retval.replace(ptr(1)); } catch (e) { }
          },
        });
        log('hooked ' + cls + ' ' + m);
      } catch (e) { }
    }
  }

  /* 4) 微信自己的 pinning（若有）。这里只做"发现"，不硬编码偏移 */
  try {
    const mods = Process.enumerateModules().filter((m) => /wechat|WeChat|mqq/i.test(m.name));
    log('相关模块: ' + mods.map((m) => m.name).join(', '));
    for (const m of mods) {
      const hits = [];
      for (const sym of m.enumerateSymbols()) {
        if (/SecTrust|pinning|verifyCert|checkCert/i.test(sym.name)) hits.push(sym.name);
      }
      if (hits.length) log(m.name + ' 可疑符号: ' + hits.slice(0, 10).join(', '));
    }
  } catch (e) { }

  log('完成。若仍抓不到 https，多半是 Quic/HTTP3 直连 —— 在小程序里关掉 wifi 试 4G 或降级到 http。');
})();
