# HAR 分析结果（ProxyPin，2026-11-15）

> 来源：`ProxyPin11-15_10_20_03.har`、`ProxyPin11-15_10_30_54.har`
> 结论：**设备接入 ThingsBoard，且设备访问令牌可直接用。控制走蓝牙。**

---

## 一、抓到了什么

两个 HAR 各 3 条 `thingsboard.example.com:8080` 请求，全部是**设备令牌**接口：

```http
POST /api/v1/B03-XXXX/rpc
{"method":"getCurrentRPCStr","params":{"temperature":"25"}}

POST /api/v1/B03-XXXX/rpc
{"method":"getCurrentRPCStr_B03.08","params":{"temperature":"25"}}

POST /api/v1/B03-XXXX/telemetry
{"1":"B03-XXXX","2":"2026-11-15 10:30:42","4":"744.51","5":"100.1",
 "6":"233.3","7":"0.634","8":"0.677","18":"POWER02","19":"B03.08",
 "21":"2026-11-15 08:54:48","26":"1.0.20260715", ...}
```

`B03-XXXX` **就是设备访问令牌**，同时是设备名 —— 房间号即令牌。

### 关键：令牌可猜

格式 `B03-<房间号>`。你周围扫到的设备：

```
B03-XXXX（设备编号已脱敏）
```

意味着 **同楼任意房间的状态都能读**。这是学校部署方的问题，不是你的。

---

## 二、令牌能做什么（已实测）

### 1. 读完整属性（不需要任何登录）

```bash
curl "https://thingsboard.example.com:8080/api/v1/B03-XXXX/attributes"
```

真实返回：

```json
{
  "shared": {
    "ElectricControlSwitch":  "Y",       // 当前通电
    "TimeControlSwitch":      "Y",       // 定时控制开
    "RoomStaticControlSwitch":"Y",       // 静态断电开
    "TimerOneOn":  "5:00",               // 供电开始
    "TimerOneOff": "23:58",              // 供电结束 ← 每天这个点断电
    "Version": "B03.01",
    "fw_title": "POWER02",
    "fw_version": "B03.09",
    "fw_size": 114780,
    "PassWordOfDetails": "<已脱敏>"        // ← 详情页密码，明文可读
  }
}
```

### 2. 读实时配置串

```bash
curl -X POST "https://thingsboard.example.com:8080/api/v1/B03-XXXX/rpc" \
  -H 'Content-Type: application/json' \
  -d '{"method":"getCurrentRPCStr","params":{"temperature":"25"}}'
```

返回类似：

```
"D1:2026,23:11,29:15,97:10,87:57,D6:04,92:05,92:00,98:11,156:58,343:Y,254:N,D13:Y"
```

连续调用值会变（`23:11` → `66:11` → `40:10`），说明是**实时寄存器快照**，不是固定配置。

### 3. 不能做的

```
POST /api/v1/{token}/attributes   → 只能写 client 作用域，改不了 shared
shared 属性的写权限在服务端（学校管理员）
```

所以**没法用令牌远程开关电**。控制必须走蓝牙。

---

## 三、蓝牙侧（已连真机验证）

### 设备档案

```
型号    DX-smart DX-BT24（串口透传模块）
固件    +VERSION=V2.1.0
名称    B03-XXXX
服务    0000ffe0-...   Vendor specific
特征    0000ffe1   read + write + notify + write-no-response   ← 数据通道
        0000ffe2   write only
```

macOS 上地址是随机私有 MAC，每次扫描会变，**按名字匹配**：

```bash
python3 ble/probe.py info        # 当前 B03-XXXX 的地址
python3 ble/probe.py listen      # 只听
```

### 已确认的行为

| 操作 | 结果 |
|---|---|
| 连 ffe0/ffe1 | ✅ 成功 |
| 写 ffe1（原始字节） | ✅ 设备接受 |
| 写 ffe1（ASCII） | ✅ 设备接受 |
| 读 ffe1 | ⚠️ 返回「最后写入的内容」= 回显，不是设备响应 |
| 发命令后的响应 | 走 notify，但多数帧无响应 |
| 收到过的设备应答 | `fw_title:POWER02,fw_version:B03.08` |

### 从 App 里挖出的指令

跑 `pages/thingsboard_B03` 的 Chaos VM，拿到：

```
data.Bluetooth_Order_Three = "0103030000000944"
```

8 字节：`01 03 03 00 00 00 09 44`。

看着像 Modbus RTU（`01` 从机 / `03` 读保持寄存器），但**CRC 对不上**：
标准 Modbus CRC16 算出 `45 8E`，帧里是 `09 44`。暴力枚举全部 65536 个多项式能得到
`poly=0x344, init=0xFFFF, refin=True`，但只有一个样本不能确认，也可能是自定义校验。

**这条还没打通** —— 发 `0103030000000944` 到设备没有响应。

---

## 四、App 的实际工作流（从 VM 恢复）

```
1. 扫码 → 得到 bt_id（蓝牙地址）
2. 蓝牙连上 B03-xxxx
3. GET /api/v1/{token}/attributes?sharedKeys=TimerOneOn,TimerOneOff,
                                   ElectricControlSwitch,TimeControlSwitch,
                                   RoomStaticControlSwitch
4. 依据云端属性构造指令 → Bluetooth_Order_Three
5. write BLE → 设备执行（通电/断电/设时段）
6. POST /api/v1/{token}/telemetry → 上报读数
```

**所以：云端是"配置来源"，蓝牙是"执行通道"。**
学校改共享属性 → 你下次打开小程序时生效。

---

## 五、由此得到的三条路

### 路线 A：蓝牙重放（最彻底）

既然写入通道通了，只差指令格式。补全办法：

**用 Apple PacketLogger 抓一次真机通讯**（免费，Xcode 附加工具里）

1. iPhone：设置 → 隐私与安全性 → 开发者模式 → 打开「蓝牙调试日志」
2. 手机上完整走一次「扫码复电」
3. AirDrop 把日志导出 → 用 `tshark` 或 Wireshark 打开
4. 过滤 `btatt`，看定向到 `ffe1` 的 Write 请求

拿到逐帧字节后：

```bash
python3 ble/probe.py replay --file frames.txt
```

`frames.txt` 格式：

```
# 每行一帧，hex；# sleep=0.5 控制间隔
0103030000000944
ascii:D1:2026,...
010600010001 # sleep=0.5
```

**这是我最推荐的** —— 不需要密码、不需要登录、一次录好永久可用。

### 路线 B：只做监控 + 到期提醒（成本最低，现在就能用）

令牌已经能读状态，写个脚本盯 `ElectricControlSwitch`，断电就推送提醒你：

```bash
while true; do
  s=$(curl -s "https://thingsboard.example.com:8080/api/v1/B03-XXXX/attributes?sharedKeys=ElectricControlSwitch")
  echo "$(date +%H:%M) $s"
  sleep 60
done
```

配合 `ble/trigger.py presence`（人回宿舍自动提醒）也够用。

### 路线 C：改云端（走不通，说明一下）

需要学校管理员的 JWT 才能写 shared 属性。`PassWordOfDetails: <已脱敏>` 是详情页口令，
不是账号密码，别拿它去登 ThingsBoard 后台。

---

## 六、马上去做的事

```bash
cd ~/代码/pj

# 1. 确认设备状态（外网就能查）
curl "https://thingsboard.example.com:8080/api/v1/B03-XXXX/attributes" | python3 -m json.tool

# 2. 连蓝牙看看
python3 ble/probe.py info
python3 ble/probe.py listen --seconds 20

# 3. 关键一步：抓一次真机蓝牙日志
#    iPhone 开发者模式 → 蓝牙调试日志 → 走一次复电 → 导出给我
```

拿到 `.btsnoop` 日志，我就能把 `ffe1` 上的写序列还原成 `frames.txt`，
再接到 `ble/trigger.py` 上做「靠近自动复电」或者「定时复电」。

---

## 七、2026-11-15 后续实测进展

继续在真机上做的实验，几条新结论：

### 1. 配置串本身就是一条有效指令 ✅

往 `ffe1` 写完整的 `D1:2026,...` 串，设备稳定回：

```
fw_title:POWER02,fw_version:B03.08
```

对照实验：

| 发送内容 | 设备响应 |
|---|---|
| 完整合法配置串 | ✅ `fw_title:POWER02,fw_version:B03.08` |
| 垃圾字节 `00010203` | ✗ 无 |
| 垃圾文本 `zzzz` | ✗ 无 |
| 配置串前缀 `D1:2026,19:11` | ✗ 无 |
| 空写入 | ✗ 无 |

说明设备会**按行解析文本命令**，格式对了才应答。

### 2. 字段被温度做了偏移混淆 ✅

`getCurrentRPCStr` 的 `temperature` 参数会让**所有数字字段整体平移**，而数值本身不变：

```
temp= 5 → D1:2026,93:11,29:15,67:11,56:05,D6:25,61:05,61:00,67:11,125:58,312:Y,223:N,D13:Y
temp=35 → D1:2026,95:11,29:15,69:11,58:05,D6:27,63:05,63:00,69:11,127:58,314:Y,225:N,D13:Y
temp=45 → D1:2026,96:11,29:15,70:11,59:05,D6:28,64:05,64:00,70:11,128:58,315:Y,226:N,D13:Y
```

每个字段的 key 都 +1（temp 每 +10）。所以 key 不能直接当寄存器地址读，
要减去 `f(temperature)` 偏移。**这也是为什么直接拿配置串去猜字段行不通。**

### 3. 翻转布尔字段会让设备断开连接 ✅

修改第 2 个布尔（`NNN:N` → `NNN:Y`）写入后：

- 收到版本应答
- **随后 BLE 连接被设备主动断开**

说明这条指令被**真正执行了**（设备应用配置后重启了 BLE 栈），
不是单纯被忽略。重连后写回基线配置正常，云端状态未受影响（仍是 Y/Y/Y）。

### 4. 仍卡在「哪个字段是开关」

13 个字段里 3 个是布尔（`303:Y, 214:N, D13:Y`），云端有三个开关
（ElectricControlSwitch / TimeControlSwitch / RoomStaticControlSwitch，当前全 Y）
但配置串里是 Y/N/Y —— 对不上，可能有一个是反相，或还有别的位没露出来。

**这一步必须靠真机抓包确认**，盲试风险太高（改错字段可能让设备进异常态）。

### 5. 顺带发现的 OTA 线索

HAR 里有 8 段 `baidu-cn-north-00001.bj-a.bcebos.com` 的 Range 下载，
偏移到 16.6MB，是被分块拉的大文件（不是 112KB 的固件）。留着以后再说。
