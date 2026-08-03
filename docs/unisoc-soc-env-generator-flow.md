# Auto Env Gen介绍

## subsys：自动生成subsys socv env（该脚本会生成systbase的ttb环境和systba环境，以来dut_spec excel和mini excel）
 脚本相关option如下：
  -rtl : subsys的顶层文件（build env的时候需要例化dut）
  -n : subsys的名字,一般与仓名字一样（保证所有环节的subsys name一致）
  -i : subsys在top上的例化名（用于例化dut时候进行命名）
  -x : 填写好的dut_spec（用于生成systba vip/sysbase bfm等组件相关环境）
  -mini : 填写好的​mini_excel（用于生成提供给ipsocv的相关环境）
  -mod_io : 由verdi里面apps抓出来module io文件（用于生成systba VIP conn相关文件和vip信号位宽检测功能）
  -ral : 由DE提供的所有reg目录所在的总目录,支持多个目录,用空格隔开或者单份由HLD工具生成的systba ral model文件（用于生成环境里面需要的systba/sysbase ral文件和例化ral model）
        * --ral（该option需要指定的路径）
        * -----reg（文件夹名字需要与内部文件的名字格式内容统一）
        * ---------for_de
        * ---------for_dv
        * ---------for_sw
  -clk : 由DE提供的clk_max cfg和set clk_freq task和clk_max sva三份文件所在的目录（用于link de提供的文件进行使用，必须为de的git目录）
  -clk2 : 与clk同理（区别在于：给存在多个clk core的subsys使用，参数传递上<de路径>,<自身的clk文件名字前缀>）（只有一个clk core的subsys不需要使用）
  -o : 生成环境的output目录（默认为./）（当前脚本有较多后处理，故只能支持在当前目录下生成）
  -pinlist（后续单独生成） : pin list用于生成ip pin cfg task/define（生成ip pin cfg/define内容）
  -dmalist（后续单独生成） : dma req excel用于生成get dma req id task（生成get dma id task）

示例如下：
```Makefile
SYSBASE := /pri/project/tools/sprd/dv/sysbase/r3p4/bin/sysbase_gen.py
RAL_GEN := ./scripts/sysbase_ral_gen.py
SUBSYS_NAME := apcpu_sys
INST_NAME := u_sys_apcpu
RTL := $(PROJ_RTL)/apcpu_sys/design/rtl/top/apcpu_top_pwr_wrap.v
DUT_SPEC := ./materials/apcpu_sys_dut_spec.xls
MINI_CASE_SPEC := ./materials/sysbase_mini_case_apcpu.xlsx
RAL_DIR := $(PROJ_RTL)/$(SUBSYS_NAME)/design/spec/autoreg $(PROJ_RTL)/apcpu_sys/design/rtl/slv_fw_apcpu $(PROJ_RTL)/common/rtl/TDC_sensor_ctrl/RegsBuilder $(PROJ_RTL)/common/rtl/hold_setup_voltage_sensor/RegsBuilder $(PROJ_RTL)/common/rtl/scd
CLK_DIR :=
MOD_IO := ./materials/getModIO.log
PINLIST := #./materials/pin_mux.xlsx

.PHONY: build
build:
    $(SYSBASE) build -n $(SUBSYS_NAME) -rtl $(RTL) -i $(INST_NAME)

.PHONY: ttb
ttb:
    $(SYSBASE) ttb -n $(SUBSYS_NAME) -x $(DUT_SPEC) -rtl $(RTL)

.PHONY: mini
mini:
    $(SYSBASE) mini -mini $(MINI_CASE_SPEC)
    mv -f ./test_$(SUBSYS_NAME)_mini.sv ./udtb/$(SUBSYS_NAME)/$(SUBSYS_NAME)_mini/tests
    mv -f ./ip_path_info.txt ./udtb/$(SUBSYS_NAME)/$(SUBSYS_NAME)_mini/tests
    mv -f ./output_$(SUBSYS_NAME)_ip_cfg.sv ./$(SUBSYS_NAME)/reuse/$(SUBSYS_NAME)_ip_cfg.sv
    cp -rf ./materials/sysbase_mini_case.xlsx ./udtb/$(SUBSYS_NAME)/$(SUBSYS_NAME)_mini/tests/sysbase_mini_case.xlsx

.PHONY: ral
ral:
    $(SYSBASE) ral -n $(SUBSYS_NAME) -ral $(RAL_DIR)
    $(RAL_GEN) -source $(RAL_DIR) -subsys $(SUBSYS_NAME)

.PHONY: connect
connect:
    $(SYSBASE) connect -n $(SUBSYS_NAME) -x $(DUT_SPEC) -mod_io $(MOD_IO)
    #mv -rf ./$(SUBSYS_NAME)/*sv* ./$(SUBSYS_NAME)/top/conn/$(SUBSYS_NAME)/

.PHONY: gen
gen:
    $(SYSBASE) gen \
        -rtl     $(RTL) \
        -n       $(SUBSYS_NAME) \
        -i       $(INST_NAME) \
        -x       $(DUT_SPEC) \
        -mini    $(MINI_CASE_SPEC) \
        -ral     $(RAL_DIR) \
        -mod_io  $(MOD_IO) \
        -o       ./
```

### dut_spec格式


## top：生成top socv env（同步生成sysbase和systba环境）
  -rtl : chip的顶层文件（build env的时候需要例化dut）
  -n : chip的名字,一般与仓名字一样（一般为top）
  -i : chip在top上的例化名（用于例化dut时候进行命名）
  -c : chip下所有subsys domain的名字和core name信息（用于生成subsys2top的相关环境，名字需要保证与subsys环境一致）
  -ral : 由DE提供的所有reg目录所在的总目录,支持多个目录（每个reg独立目录下为for_de/for_dv/for_sw）或者单份由HLD工具生成的systba ral model文件（用于生成环境里面需要的systba/sysbase ral文件和例化ral model）
  -o : 生成环境的output目录

示例如下：
```Makefile
TOP_RTL          := $(PROJ_RTL)/top/design/rtl/top/kunlunn02_top.v
TOP_NAME         := top
TOP_INST_NAME    := dut
TOP_RAL_DIR      := $(PROJ_RTL)/top/design/rtl/lp_sys/dvfs $(PROJ_RTL)/top/design/rtl/lp_sys/pmu/reg $(PROJ_RTL)/top/design/rtl/lp_sys/clk_top $(PROJ_RTL)/top/design/rtl/io/for_dv/reg $(PROJ_RTL)/top/design/rtl/ad_if/regs_rtl
CSV_DIR          := ./materials/top.csv
TOP_DUT_SPEC     := ./spec/top_dut_spec.xls

.PHONY: top
top:
    $(SYSBASE) gen \
        -rtl   $(TOP_RTL) \
        -n     $(TOP_NAME) \
        -i     $(TOP_INST_NAME) \
        -c     $(CSV_DIR) \
        -ral   $(TOP_RAL_DIR) \
        -o     ./
```

### sysbase需要的csv文件内容为
 - 首列为整个full chip下所有分仓验证的subsys name
 - 后续用逗号隔开，双引号包含，填写该subsys下存在的cpu类型的master info（格式为core_name(amba protocol)(data width)）
示例：
```csv
"Subsys_Name","Core_Name_1","Core_Name_2","Core_Name_3","Core_Name_4","Core_Name_5"
"aon_sys","SP_CMSTAR_C(AHB)","AON_SP(AHB)",,,
"ap_sys","DMA(AXI)","UFS(AXI)","CE(APB)",,,
"apcpu_sys","APCPU(AXI)","APCPU_1(AXI)",,,,
"camera_sys","CMCU_AXI(AXI)",,,,,
"dpu_sys","DPU0_CORE0(AXI)","DPU0_CORE1(AXI)","DPU_LITE0(AXI)","DPU_LITE1(AXI)",,
"vpu_sys","VPU_CODECO(AXI)","VPU_CODEC1(AXI)",,,,,
"gpu_sys","KRAKE(AXI)",,,,,
"lpach_sys","HIFI4(AXI)","HIFI4_I(AXI)","CM55(AXI)",,,
"dbg_sys","DAP(AXI)",,,,,
"ai_sys","POWERVR(AXI)","VDSP_MST(AXI)",,,,,
"pub_sys",,,,,,
"pcie_sys","PCIE0(AXI)","PCIE1(AXI)",,,,
```
