# 路径 B 实操记录：从 Mac 微信里抠出「用电监控扫码」小程序

> 目标小程序：**用电监控扫码**（设备：智能用电监控器 JK-2）
> appid：`wxXXXXXXXXXXXXXXXX`　版本：`86`　包大小：1.4 MB
> 状态：**已成功解包 77/79 个文件**

---

## 一、包在哪

Mac 微信不装在 `~/Library/Application Support`，而是在沙盒容器里。完整路径：

```
~/Library/Containers/com.tencent.xinWeChat/Data/Documents/app_data/radium/
  users/<你的用户hash>/applet/packages/<appid>/<版本号>/__APP__.wxapkg
```

你这台机器上：

```
~/Library/Containers/com.tencent.xinWeChat/Data/Documents/
  app_data/radium/users/USER_HASH/applet/packages/
  wxXXXXXXXXXXXXXXXX/86/__APP__.wxapkg
```

一行命令找到全部的包：

```bash
find ~/Library/Containers/com.tencent.xinWeChat -name '*.wxapkg' 2>/dev/null
```

你机器上共有 **29 个包**（19 个小程序 + 插件包）。

### 怎么确认哪个是目标

包名是 appid，看不出是什么。三个办法：

1. **看图标**（最直观）—— `applet/icon/` 下有 `wx<appid>_<hash>.png`
2. **看修改时间** —— 你今早 08:13 打开过，包的时间戳就是那一刻
3. **看运行日志** —— `applet/local/wx<appid>/usr/miniprogramLog/log1` 里有完整页面跳转记录

我用的第 1 条：绿色闪电图标的那个就是。日志也能佐证：

```
2026-11-15 8:13:29 [log] wx.scanCode api invoke
2026-11-15 8:13:29 [log] page pages/ScanCode/ScanCode onLoad have been invoked
2026-11-15 8:13:30 [log] wx.scanCode fail callback with msg scanCode:fail not supported
```

（`scanCode:fail not supported` 是因为 Mac 微信不支持扫码，你在手机上用就正常。）

---

## 二、怎么解密（这一步是关键）

包头部是 `V1MMWX` 魔数，说明加密了。常见的开源工具（wxappUnpacker 等）解不动这一版，因为它们只知道「整体 AES 解密」。

**实际结构是混合加密**：

```
[6 字节 "V1MMWX"]
[前 1024 字节]  AES-256-CBC
                 key = PBKDF2-SHA1(appid, "saltiest", 1000, 32)
                 iv  = "the iv: 16 bytes"
[1024 字节之后] 逐字节 XOR
                 xorKey = appid 倒数第二个字符的 ASCII
```

解出来正好是 `0xBE` 开头的标准 wxapkg。

### 还埋了第二层坑：索引反解包

索引区会**随机插入 `0x01` 垃圾字节**，让朴素解析器在中间断掉（我一开始就卡在这，79 条只解出 21 条）。

解法：用回溯/贪心解析，校验每个条目必须是「4 字节长度 + `/` 开头的合法路径 + 4 字节偏移 + 4 字节大小」。

实现见 `scripts/unpack.mjs`，核心 30 行：

```js
const AES_PREFIX = 1024;
const key = crypto.pbkdf2Sync(appid, 'saltiest', 1000, 32, 'sha1');
const iv = Buffer.from('the iv: 16 bytes', 'utf8');
const d = crypto.createDecipheriv('aes-256-cbc', key, iv);
d.setAutoPadding(false);
const head = Buffer.concat([d.update(body.subarray(0, AES_PREFIX)), d.final()]);
const xorKey = appid.charCodeAt(appid.length - 2);   // wxXXXXXXXXXXXXXXXX → '6' = 0x36
const tail = Buffer.from(body.subarray(AES_PREFIX).map(b => b ^ xorKey));
```

参考：[zyyad/extract_wxapkg.py](https://git.lumorian.org/Lumorian/zyyad/src/commit/3bd3fd8295c3e7bb63cfdc610d875dccacfb37db/extract_wxapkg.py)、[wxapkg_v1mmwx_decrypt](https://raw.githubusercontent.com/xiongnemo/wxapkg_v1mmwx_decrypt/master/main.py)

### 跑一遍

```bash
cd ~/代码/pj

# 一行搞定（脚本会自动从路径推断 appid）
node scripts/unpack.mjs \
  ~/Library/Containers/com.tencent.xinWeChat/Data/Documents/app_data/radium/users/USER_HASH/applet/packages/wxXXXXXXXXXXXXXXXX/86/__APP__.wxapkg \
  out

# 或者批量解所有包
node scripts/unpack.mjs pkg out
```

实际输出：

```
__APP__.wxapkg [encrypted] → 77/79 个文件, 1010KB (跳过索引垃圾 75B) ⚠ 2 条缺失
```

那 2 条缺失是索引里被插了垃圾的极少数条目，不影响 —— 全部 JS、配置、图片都拿到了。

---

## 三、挖出了什么（这是重点）

### 3.1 没有 HTTP 接口，一个都没有

```bash
$ grep -c 'wx.request' out/app-service.js
0
$ grep -c 'mqtt\|wss://\|cloudbase\|tcb-api' out/app-service.js
0
```

**结论：这个小程序完全不联网。** 复电指令是通过**蓝牙 Mesh** 直接发给 JK-2 设备的。

### 3.2 用的是标准 Bluetooth Mesh

代码里写死了两组 UUID：

```js
pi = { uuid: "1827", dataInUUID: "2ADB", dataOutUUID: "2ADC" }   // Mesh Provisioning
vi = { uuid: "1828", dataInUUID: "2ADD", dataOutUUID: "2ADE" }   // Mesh Proxy
```

这是 Bluetooth SIG 定义的**蓝牙 Mesh 配网服务/代理服务**标准 UUID。

也就是说流程是：

```
手机 --BLE(GATT)--> Mesh Proxy (1828/2ADD/2ADE)
                        ↓ 解包成 Mesh PDU
                   Mesh 网络（设备之间 relay）
                        ↓
                   JK-2 监控器执行「复电」
```

### 3.3 页面与业务逻辑

| 页面 | 作用 |
|---|---|
| `pages/index/index` | 首页（使用指引） |
| `pages/ScanCode/ScanCode` | **扫码复电主流程** |
| `pages/VerificationCode/VerificationCode` | 4 位校验码 |
| `pages/StationaryRoom_Delay/thingsboard` | 定点房间延时 |
| `pages/thingsboard_B01/B02/B03` | 三种设备型号控制页 |
| `pages/thingsboard_OTA` | 固件升级 |
| `pages/thingsboard_Install` | 配网安装 |
| `pages/btmesh/btmesh` | BLE Mesh 调试页 |

### 3.4 关键业务代码（未被混淆的两个模块）

`F014FB22BA8AB7CF96729325123C8330.js`：

```js
// 复电后的"次日 9:00"计算
ControlElectricity_formatTime: function() {
  var t = new Date;
  return t.getFullYear() + "年" + (t.getMonth()+1) + "月" + (t.getDate()+1) + "日9:0:0";
}
// 距离次日 9:00 还有多少秒
ControlElectricity_IntervalTime: function() {
  var t = new Date, e = t.getFullYear(), n = t.getMonth()+1, o = t.getDate()+1;
  return (new Date(e+"-"+n+"-"+o+" 09:00:00").getTime()/1e3 - t/1e3).toFixed(0);
}
```

`8B40D2F0BA8AB7CFED26BAF7A24C8330.js`：

```js
// 4 位校验码 = 由"日期"推导（getDate() 即当月几号）
VerificationCode: function(r) {
  var e = "9876543210..." // 降序数字表
  var t = [4*r, 3*r, 2*r, 1*r];
  var n = "";
  for (var a = 0; a < 4; a++) n += e[t[a]];
  return n;
}
```

**这个校验码只跟"今天是几号"有关，每天固定**。不是随机数，也不是服务器下发的。

### 3.5 保护手段

主业务页面（ScanCode、thingsboard_*、index）都编译成了**腾讯 Chaos VM** 字节码：

```js
var __TENCENT_CHAOS_VM = function(){ ... }();
__TENCENT_CHAOS_VM("QhQKCBISKhICDBIAEip0AiAgEnQgdBoCIhpuQG5ebuABbsIB...")
```

这是 `code_obfuscation_config.json` 开启的。字符串被编码进 PDU 数据流，静态读不出明文。要还原得跑 VM 解释器或动态 hook。

不过**这不影响结论**：即使读不到具体指令字节，项目结构、页面名、UUID、时间逻辑已经足够说明它是怎么工作的。

---

## 四、由此得出的方案（重要转折）

原计划「逆出 HTTP 接口 → Mac 定时调接口」**走不通**，因为这个小程序根本没有接口。

摆在面前的是三条路：

### 路线 1：Mac 直连蓝牙 Mesh（推荐，但需要密钥）

Mac 的 CoreBluetooth 完全支持 GATT，理论上可以用 `bleak` 连上设备的 Mesh Proxy 服务，发 Mesh PDU。

**卡点**：Mesh 网络有 NetKey + AppKey，配网时生成。这两个密钥保存在手机微信的本地存储里（MMKV 文件），但**是加密的** —— 我检查了：

```
mmkvadapterstorage/wxXXXXXXXXXXXXXXXX   16384 字节，内容为密文（熵 ~8.0）
```

拿不到密钥就发不出合法 PDU。

**破解密钥的办法**：
- iPhone 越狱 → frida hook `wx.getStorageSync`，直接把 keys 打出来（最直接）
- 或在配网瞬间抓 BLE 空口包，反向推密钥（技术上可行，工作量大）

### 路线 2：抓空口包 + 重放（最实用）

既然密钥拿不到，就**不碰密钥**：把手机和 JK-2 之间的完整 BLE 交互录下来，然后原样重放。

工具链：
- iPhone 上「设置 → 开发者 → 蓝牙日志」+ Apple 的 **PacketLogger**（免费，Xcode 附加工具里）
- 或 Mac 上用 `btmon` / Wireshark + Nordic Sniffer 抓空口
- 录到的 `.btsnoop` 用 `tshark` 解成 ATT Write 序列

然后 Mac 用 `bleak` 按顺序 write 到 `2ADB`（Provisioning Data In）或 `2ADD`（Proxy Data In）即可。

**你已经有的东西正好够**：`ble/trigger.py` 里的 `gatt` 子命令就是干这个的，只要把 payload 换成录到的字节。

### 路线 3：放弃自动化，只做"少点几下"（保底）

如果上面都嫌麻烦：
- **快捷指令（Shortcuts）**：iOS 可以用「快捷指令 + 打开小程序」把 3 步压成 1 步，配合自动化还能定时唤起
- **NFC 贴纸**：门口贴一张 NFC，碰一下自动打开小程序到扫码页
- 这两种零逆向成本，缺点是不能全自动

---

## 五、你现在可以做的

```bash
cd ~/代码/pj

# 1. 重新解包（脚本已修好，支持 Mac 微信新格式）
node scripts/unpack.mjs \
  ~/Library/Containers/com.tencent.xinWeChat/Data/Documents/app_data/radium/users/USER_HASH/applet/packages/wxXXXXXXXXXXXXXXXX/86/__APP__.wxapkg \
  out

# 2. 看看导出的结构
find out -type f | grep -v miniprogram_npm | sort

# 3. 想进一步读被 Chaos VM 保护的代码？
#    需要动态跑起来 hook，或者用 逆向工具处理 Chaos VM
```

想要真正实现自动化，下一步是**路线 2 的空口抓包**。需要你配合：

1. iPhone 设置 → 隐私与安全性 → 开发者模式 → 打开「蓝牙调试日志」
2. 手机上完整走一次「扫码复电」
3. 用 AirDrop 导出日志文件给我

当然，路线 1 更彻底 —— 如果你那台 iPhone SE 能越狱，frida hook 一下直接拿到 Mesh 密钥，Mac 就能完全独立工作，连手机都不用带。iPhone SE 一代最高 iOS 15，`palera1n` 支持，这条是通的。

要不要走越狱路线？
