# top CSV 格式

top 层 sysbase 所需的 subsys 信息表。首列 subsys name,后续列填该 subsys 下存在的 cpu 类型 master info。

## 格式

```
"Subsys_Name","Core_Name_1","Core_Name_2","Core_Name_3","Core_Name_4"
```

master 字符串格式: `core_name(amba_protocol)(data_width)`

## 示例(取自用户截图)

| Subsys_Name | Core_Name_1 | Core_Name_2 | Core_Name_3 | Core_Name_4 |
|---|---|---|---|---|
| aon_sys |  | "AON(AHB)" | "AON_CMC(AHB)" |  |
| aon_sys |  | "AON(AHB)" | "AON_CMC(AHB)" |  |
| ap_sys |  |  |  |  |
| apcpu_sys |  | "AP(AXI)(64)" | "AP_1(AXI)" |  |
| vdsp_sys |  | "VDSP(AXI)(128)" | "VDSP1(AXI)" |  |
| dpu_sys |  | "DPU(AXI)" |  |  |
| hdmi_sys |  |  |  |  |
| audio_sys |  | "HIFI0(AXI)(32)" | "HIFI1(AXI)" |  |
| pub_sys |  |  |  |  |
| pub2_sys |  |  |  |  |
| demod_sys |  |  |  |  |
| vpu_sys |  |  |  |  |
| dbg_sys |  |  |  |  |
| gpu_sys |  |  |  |  |

## 规则

- 首列 subsys name 必须用双引号包裹,且与 subsys 层 `-n` 一致
- 每个 master 一个双引号字段,无 master 的格子留空(双引号间无内容)
- 列数按需扩展(本示例为 4 个 Core_Name 列,实际可能有更多)
- amba_protocol 取值: AHB / AXI / APB / CHI 等
- data_width 可省(如 AHB),不写时省略括号
- 字符串内含逗号时整体用双引号包裹

## skill 行为

- 读取 csv 时只校验首列非空,其他列不解析(交给 sysbase_gen.py 内部处理)
- 列数不匹配时输出 warning,不阻断
