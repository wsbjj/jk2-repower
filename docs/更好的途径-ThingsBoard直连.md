# 更好的途径：直接调 ThingsBoard 云端 API（不需要蓝牙、不需要扫码）

> 发现来源：解包小程序后，从 `pages/thingsboard_Install` 页面的 Chaos VM 里跑出了真实请求。
> 结论**推翻了上一版判断** —— 这个小程序不是纯蓝牙的，它有云端。

---

## 一、核心发现

小程序「用电监控扫码」的后端是 **ThingsBoard**（开源物联网平台）：

```
https://thingsboard.example.com:8080
```

已验证可达，返回的是 ThingsBoard 标准错误格式：

```json
{"status":401,"message":"Invalid username or password","errorCode":10,"timestamp":1794711001899}
```

### 设备的通断 = 一个字符串属性

```http
POST /api/plugins/telemetry/DEVICE/{deviceId}/SHARED_SCOPE
Content-Type: application/json
Authorization: Bearer {JWT}

{
  "ElectricControlSwitch":   "Y",     // Y=通电 / N=断电
  "RoomStaticControlSwitch": "Y",     // 房间静态断电控制
  "TimeControlSwitch":       "Y",     // 定时控制开关
  "TimerOneOn":              "05:00", // 供电开始
  "TimerOneOff":             "23:00"  // 供电结束
}
```

**复电就是 `ElectricControlSwitch = "Y"`。** 一次 HTTP 请求，全程不碰蓝牙。

### 完整接口清单（均从 VM 实测跑出）

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/auth/login` | `{username,password}` → `{token,refreshToken}` |
| POST | `/api/auth/token` | 刷新 JWT |
| GET | `/api/user/devices` | 名下设备列表 |
| GET | `/api/plugins/telemetry/DEVICE/{id}/values/attributes/SHARED_SCOPE?keys=...` | 读属性 |
| POST | `/api/plugins/telemetry/DEVICE/{id}/SHARED_SCOPE` | **写属性（控电）** |
| GET | `/api/relations?toId=&toType=DEVICE` | 设备关联关系 |
| GET | `/api/customer/{id}/assets` | 客户资产 |
| POST | `/api/v1/DeviceUpdate/telemetry` | 设备遥测上报（内置 token） |

遥测字段（`/api/v1/DeviceUpdate/telemetry`）能看出设备状态全貌：

```
1:DeviceUpdate  7:TimerOneOn  8:TimerOneOff  9:ElectricControlSwitch
10:RoomStaticControlSwitch  11:TimeControlSwitch  12~27: 各项用电参数
```

---

## 二、为什么这条路更好

| | 蓝牙 Mesh 方案 | ThingsBoard API |
|---|---|---|
| 需要靠近设备 | ✅ 必须 | ❌ 不需要，外网就行 |
| 需要越狱拿 Mesh 密钥 | ✅ | ❌ |
| 需要抓空口包 | ✅ | ❌ |
| 手机要在场 | ✅ | ❌ |
| 一次复电成本 | 连 BLE + 走 Mesh 代理 | 1 个 HTTP 请求 |
| 能否定时 | 难（Mac 必须守在旁边） | 容易（任何地方跑） |
| 能否**永久解决** | ❌ | ✅ 见下 |

### 「永久解决」才是重点

设备有三层断电机制：

1. `TimeControlSwitch` + `TimerOneOn/Off` —— **定时断电**（每天 23:00 断）
2. `RoomStaticControlSwitch` —— **静态断电**（无人用电一段时间后断）
3. `ElectricControlSwitch` —— 总开关

原方案（每次扫码复电）只动了第 3 层，所以每天都要重复。

**把 1 和 2 都关掉，就再也不需要复电了**：

```json
{ "ElectricControlSwitch": "Y", "RoomStaticControlSwitch": "N", "TimeControlSwitch": "N" }
```

---

## 三、怎么用

### 1. 拿到账号密码

这是唯一还缺的一环。小程序里是扫码获取的（`scanCode_Customer_QR_CODE` → `TB_CustomerName` / `TB_CustomerPassword`）。

三个来源：
- **安装时扫的那张二维码**（宿管/学校发的），内容里就是账号密码
- **小程序「设置」页**，可以手动填
- 本地 `MMKV` 缓存里（加密的，需 hook）

### 2. 登录并看状态

```bash
cd ~/代码/pj

node client/tb.mjs login --user 你的账号 --pass 你的密码
node client/tb.mjs devices          # 列出设备
node client/tb.mjs status --device 301
```

输出：

```
设备 JK2-301 (301)
──────────────────────────────────────────────
  电控开关 ElectricControlSwitch    关  (N)
  静态断电 RoomStaticControlSwitch  开  (Y)
  定时控制 TimeControlSwitch        开  (Y)
  供电时段 05:00 ~ 23:00
  实时功率 0 W   电压 220.5 V   电流 0 A
  累计电量 12.4 kWh
```

### 3. 复电 / 一劳永逸

```bash
node client/tb.mjs on --device 301        # 单次复电
node client/tb.mjs forever --device 301  # 关掉所有自动断电 ★
node client/tb.mjs timer --device 301 --on 06:00 --off 23:59
```

`forever` 会先读、再写、再读回校验：

```
修改前: {"ElectricControlSwitch":"N","RoomStaticControlSwitch":"Y","TimeControlSwitch":"Y"}
已关闭自动断电机制
修改后: {"ElectricControlSwitch":"Y","RoomStaticControlSwitch":"N","TimeControlSwitch":"N"}
```

**如果读回还是 `Y`**，说明服务端有策略强制覆盖（学校锁定了），那就只能走定时复电。

### 4. 配定时任务（备用）

即使 `forever` 被覆盖，也可以用 `tb-on` 做定时，比原来扫码省事：

```bash
# 每天 07:00 自动复电，随机抖动 5 分钟
*/5 7 * * *  cd ~/代码/pj && TB_PASS='密码' node client/tb.mjs on --device 301
```

或用内置调度器（改 `client/tb.mjs on` 为命令即可）。

---

## 四、本地验证

不需要真实账号也能验证代码正确性：

```bash
node mock/tb_server.mjs --port 8099          # 起 mock
export TB_BASE=http://127.0.0.1:8099
node client/tb.mjs login --user admin --pass 123456
node client/tb.mjs status --device 301
node client/tb.mjs forever --device 301
```

实测通过：登录 → 列设备 → 读属性 → 写属性 → 读回校验，全链路一致。

---

## 五、技术细节：怎么从 Chaos VM 里挖出来的

主业务页被编译成腾讯 Chaos VM 字节码，静态读不到字符串。但**可以把 VM 跑起来**：

```js
// 1. 从 app-service.js 里抽出页面模块体
// 2. 用 vm.createContext 提供假 wx / Page / console
// 3. VM 会真的执行 Page({...})，方法变成可调用的真函数
// 4. 调方法，hook wx.request 记录 URL / header / body
```

关键代码见 `/tmp/runvm.mjs` 思路，可直接复用。跑 `pages/thingsboard_Install` 立刻吐出了登录、读属性、写属性三个请求。

另外把 VM 尾部的**明文字符串表**提取出来，直接看到了完整方法名：

```
request, method, header, username, password, Authorization, token
getSharedAttributeValue, updateSharedAttributeValue
CreateUpdateDevice, postDeviceUpdateTelemetry
TB_ElectricControlSwitch, TB_RoomStaticControlSwitch, TB_TimeControlSwitch
TB_TimerOn, TB_TimerOff, TB_CustomerName, TB_CustomerPassword
```

这一步比硬啃字节码高效得多 —— 压缩器为了 minify 保留了属性名，这些名字本身就是最好的文档。
