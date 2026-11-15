#!/usr/bin/env node
/**
 * 生成一个合成 wxapkg（本地自测用，模拟"宿舍复电"小程序结构）
 * 用于在拿到真包之前先跑通 解包 → 沙箱 → 调用 的全链路。
 * 用法: node scripts/make_test_pkg.mjs private/samples/__APP__.wxapkg
 */
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2] || 'private/samples/__APP__.wxapkg';

// 模拟真实小程序：webpack 风格 define + wx.request + md5 签名 + 蓝牙开关
const appService = String.raw`
var __defs = {};
function define(n, f){ __defs[n] = f; }
function require(n){
  var k = n.replace(/^\.\//,'');
  if (!__defs[k] && __defs[k + '.js']) k = k + '.js';
  var m = { exports: {} };
  if (__defs[k]) { __defs[k](require, m, m.exports); }
  return m.exports;
}

define("utils/sign.js", function(require, module, exports){
  var CryptoJS = require("utils/cryptojs.js");
  function sign(params, ts){
    var keys = Object.keys(params).sort();
    var s = keys.map(function(k){ return k + "=" + params[k]; }).join("&");
    return CryptoJS.MD5(s + "&ts=" + ts + "&k=" + "DORM9f2c").toString();
  }
  module.exports = { sign: sign };
});

define("utils/cryptojs.js", function(require, module, exports){
  // 仅自测用的伪摘要，用来模拟 32 位十六进制签名格式
  var md5 = function(str){
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
    return ("00000000" + h.toString(16)).slice(-8) + ("00000000" + ((h ^ 0x5bf03635) >>> 0).toString(16)).slice(-8)
      + ("00000000" + (h >>> 3).toString(16)).slice(-8) + ("00000000" + (h * 7 >>> 0).toString(16)).slice(-8);
  };
  module.exports = { MD5: function(v){ return { toString: function(){ return md5(String(v)); } }; } };
});

define("pages/index/index.js", function(require, module, exports){
  var signMod = require("utils/sign.js");
  Page({
    data: { room: "", power: true, status: "已断电" },
    onLoad: function(){
      this.queryRoom();
    },
    queryRoom: function(){
      var that = this;
      wx.request({
        url: getApp().globalData.host + "/api/dorm/room/info",
        method: "GET",
        header: { "Authorization": "Bearer " + wx.getStorageSync("token") },
        success: function(res){
          that.setData({ room: res.data.data.roomNo, power: res.data.data.power });
        }
      });
    },
    onScanCode: function(){
      var that = this;
      wx.scanCode({
        success: function(r){ that.doRecover(r.result); }
      });
    },
    doRecover: function(qrToken){
      var that = this;
      var ts = Date.now();
      var params = { roomNo: this.data.room, qrToken: qrToken, ts: ts };
      var header = {
        "content-type": "application/json",
        "Authorization": "Bearer " + wx.getStorageSync("token"),
        "X-Sign": signMod.sign(params, ts)
      };
      wx.request({
        url: getApp().globalData.host + "/api/dorm/power/recover",
        method: "POST",
        header: header,
        data: params,
        success: function(res){
          if (res.data.code === 0) { that.setData({ status: "已复电", power: true }); }
          else { wx.showToast({ title: res.data.msg || "复电失败" }); }
        }
      });
    },
    onShow: function(){}
  });
});

define("app.js", function(require, module, exports){
  App({
    globalData: { host: "https://dorm.example.com", appid: "wxTESTAPPID0000001" },
    onLaunch: function(){
      var that = this;
      wx.login({
        success: function(r){
          wx.request({
            url: that.globalData.host + "/api/dorm/auth/login",
            method: "POST",
            data: { code: r.code },
            success: function(res){
              if (res.data && res.data.data && res.data.data.token) {
                wx.setStorageSync("token", res.data.data.token);
              }
            }
          });
        }
      });
    }
  });
});
`;

const files = {
  'app-service.js': Buffer.from(appService, 'utf8'),
  'app.json': Buffer.from(JSON.stringify({
    pages: ['pages/index/index'], window: { navigationBarTitleText: '宿舍用电' },
  }, null, 2)),
  'app-config.json': Buffer.from(JSON.stringify({ pages: ['pages/index/index'] })),
  'pages/index/index.wxml': Buffer.from('<view>扫码复电</view>'),
  'pages/index/index.json': Buffer.from('{"usingComponents":{}}'),
};

const body = Buffer.concat(Object.values(files));
let indexLen = 0;
const idxParts = [];
let off = 0;
for (const [name, buf] of Object.entries(files)) {
  const nb = Buffer.from(name, 'utf8');
  const p = Buffer.alloc(4);
  p.writeUInt32BE(nb.length);
  const o = Buffer.alloc(4); o.writeUInt32BE(off);
  const s = Buffer.alloc(4); s.writeUInt32BE(buf.length);
  idxParts.push(p, nb, o, s);
  indexLen += 4 + nb.length + 4 + 4;
  off += buf.length;
}
const index = Buffer.concat(idxParts);
const head = Buffer.alloc(18);
head[0] = 0xbe;
head.writeUInt32BE(0x00000000, 1);
head.writeUInt32BE(indexLen, 5);
head.writeUInt32BE(body.length, 9);
head[13] = 0xed;
head.writeUInt32BE(Object.keys(files).length, 14);

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.concat([head, index, body]));
console.log(`已生成测试包 ${out}  (${Object.keys(files).length} 个文件, ${(head.length + index.length + body.length)} bytes)`);
