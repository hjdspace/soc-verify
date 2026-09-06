/**
 * 合成 SoC 级 write_json fixture 生成器（issue 08 性能验证用）。
 *
 * 生成几万 instance 的 uniquified write_json 文档，模拟真实 SoC 设计规模：
 *   - top → N 子系统（soc_subsys$）→ 每子系统 M 个 IP（spike_ip$...gen_ip[K]...）
 *   - 端口含 AXI4-Lite / APB / clk / rst（bundle 打标可消费）
 *   - netnames 带 hdlname（连线表提取可消费）
 *   - 每实例 uniquified 命名 <defName>$<完整实例路径>（--keep-hierarchy 语义）
 *
 * 用于验证：elaboration→提炼→入库全链路耗时、子树分页查询延迟、内存边界。
 */

import type { WriteJsonDoc } from '../../../src/main/rtl/extractor';

type WJPort = {
  direction: 'input' | 'output' | 'inout';
  bits: (number | string)[];
};

type WJCell = {
  type: string;
  parameters?: Record<string, unknown>;
  connections?: Record<string, (number | string)[]>;
};

type WJModule = {
  attributes?: Record<string, unknown>;
  ports?: Record<string, WJPort>;
  cells?: Record<string, WJCell>;
  netnames?: Record<string, { bits?: (number | string)[]; attributes?: Record<string, unknown> }>;
  parameter_default_values?: Record<string, unknown>;
};

/** spike_ip 端口集（AXI4-Lite 17 信号 + APB 7 信号 + clk + rst + irq_o） */
const SPIKE_IP_PORTS: Record<string, WJPort> = {
  clk_i: { direction: 'input', bits: [0] },
  rst_n_i: { direction: 'input', bits: [1] },
  s_axil_awvalid: { direction: 'input', bits: [2] },
  s_axil_awaddr: { direction: 'input', bits: [3, 4, 5, 6] },
  s_axil_awready: { direction: 'output', bits: [7] },
  s_axil_wdata: { direction: 'input', bits: [8, 9, 10, 11] },
  s_axil_wstrb: { direction: 'input', bits: [12, 13] },
  s_axil_wvalid: { direction: 'input', bits: [14] },
  s_axil_wready: { direction: 'output', bits: [15] },
  s_axil_bresp: { direction: 'output', bits: [16, 17] },
  s_axil_bvalid: { direction: 'output', bits: [18] },
  s_axil_bready: { direction: 'input', bits: [19] },
  s_axil_arvalid: { direction: 'input', bits: [20] },
  s_axil_araddr: { direction: 'input', bits: [21, 22, 23, 24] },
  s_axil_arready: { direction: 'output', bits: [25] },
  s_axil_rdata: { direction: 'output', bits: [26, 27, 28, 29] },
  s_axil_rresp: { direction: 'output', bits: [30, 31] },
  s_axil_rvalid: { direction: 'output', bits: [32] },
  s_axil_rready: { direction: 'input', bits: [33] },
  p_paddr: { direction: 'input', bits: [34, 35, 36, 37] },
  p_psel: { direction: 'input', bits: [38] },
  p_penable: { direction: 'input', bits: [39] },
  p_pwrite: { direction: 'input', bits: [40] },
  p_pwdata: { direction: 'input', bits: [41, 42, 43, 44] },
  p_prdata: { direction: 'output', bits: [45, 46, 47, 48] },
  p_pready: { direction: 'output', bits: [49] },
  irq_o: { direction: 'output', bits: [50, 51, 52, 53] },
};

/** soc_subsys 端口集（AHB + clk + rst + fab_irq_en + irq_o） */
const SOC_SUBSYS_PORTS: Record<string, WJPort> = {
  clk_i: { direction: 'input', bits: [0] },
  rst_n_i: { direction: 'input', bits: [1] },
  h_htrans: { direction: 'input', bits: [2, 3] },
  h_haddr: { direction: 'input', bits: [4, 5, 6, 7] },
  h_hwrite: { direction: 'input', bits: [8] },
  h_hburst: { direction: 'input', bits: [9, 10] },
  h_hwdata: { direction: 'input', bits: [11, 12, 13, 14] },
  h_hsel: { direction: 'input', bits: [15] },
  h_hrdata: { direction: 'output', bits: [16, 17, 18, 19] },
  h_hreadyout: { direction: 'output', bits: [20] },
  h_hresp: { direction: 'output', bits: [21] },
  fab_irq_en: { direction: 'input', bits: [22] },
  irq_o: { direction: 'output', bits: [23, 24, 25, 26] },
};

/** spike_top 端口集（AXI4 + APB + clk + rst） */
const SPIKE_TOP_PORTS: Record<string, WJPort> = {
  clk_i: { direction: 'input', bits: [0] },
  rst_n_i: { direction: 'input', bits: [1] },
  axi0_awvalid: { direction: 'input', bits: [2] },
  axi0_awid: { direction: 'input', bits: [3, 4, 5, 6] },
  axi0_awaddr: { direction: 'input', bits: [7, 8, 9, 10] },
  axi0_awlen: { direction: 'input', bits: [11, 12, 13, 14] },
  axi0_awready: { direction: 'output', bits: [15] },
  axi0_wvalid: { direction: 'input', bits: [16] },
  axi0_wdata: { direction: 'input', bits: [17, 18, 19, 20] },
  axi0_wstrb: { direction: 'input', bits: [21, 22] },
  axi0_wlast: { direction: 'input', bits: [23] },
  axi0_wready: { direction: 'output', bits: [24] },
  axi0_bvalid: { direction: 'output', bits: [25] },
  axi0_bresp: { direction: 'output', bits: [26, 27] },
  axi0_bready: { direction: 'input', bits: [28] },
  axi0_arvalid: { direction: 'input', bits: [29] },
  axi0_arid: { direction: 'input', bits: [30, 31, 32, 33] },
  axi0_araddr: { direction: 'input', bits: [34, 35, 36, 37] },
  axi0_arlen: { direction: 'input', bits: [38, 39, 40, 41] },
  axi0_arready: { direction: 'output', bits: [42] },
  axi0_rvalid: { direction: 'output', bits: [43] },
  axi0_rdata: { direction: 'output', bits: [44, 45, 46, 47] },
  axi0_rresp: { direction: 'output', bits: [48, 49] },
  axi0_rlast: { direction: 'output', bits: [50] },
  axi0_rready: { direction: 'input', bits: [51] },
  apb0_paddr: { direction: 'input', bits: [52, 53, 54, 55] },
  apb0_psel: { direction: 'input', bits: [56] },
  apb0_penable: { direction: 'input', bits: [57] },
  apb0_pwrite: { direction: 'input', bits: [58] },
  apb0_pwdata: { direction: 'input', bits: [59, 60, 61, 62] },
  apb0_prdata: { direction: 'output', bits: [63, 64, 65, 66] },
  apb0_pready: { direction: 'output', bits: [67] },
};

export type SyntheticConfig = {
  /** 子系统数量（spike_top 下 u_subsys0..N-1） */
  subsysCount: number;
  /** 每个子系统的 IP 数量（generate gen_ip[0..M-1].u_ip） */
  ipsPerSubsys: number;
};

/**
 * 生成合成 SoC 级 write_json 文档。
 *
 * 结构：spike_top → subsysCount 个 soc_subsys → 每个 ipsPerSubsys 个 spike_ip
 * 总实例数 = 1 (top) + subsysCount (subsys) + subsysCount * ipsPerSubsys (ip)
 *
 * bit id 策略：每个 uniquified 模块内部独立 bit id 空间（避免跨模块位冲突），
 * top2i 边连接顶层端口到子系统端口，i2i 边在子系统内连接 IP 间信号。
 */
export function generateSyntheticSoC(config: SyntheticConfig): { doc: WriteJsonDoc; totalInsts: number } {
  const { subsysCount, ipsPerSubsys } = config;
  const modules: Record<string, WJModule> = {};

  // spike_top：顶层模块（plain 命名，无 $ 后缀）
  const topCells: Record<string, WJCell> = {};
  const topNetnames: Record<string, { bits: number[]; attributes: Record<string, unknown> }> = {};
  let topBitId = 100; // 顶层 bit id 从 100 开始

  for (let s = 0; s < subsysCount; s++) {
    const cellName = `u_subsys${s}`;
    const subsysType = `soc_subsys$spike_top.${cellName}`;

    // top → subsys 连线（top2i）：apb0_paddr → h_haddr
    const apbBits: number[] = [];
    for (let b = 0; b < 4; b++) {
      const bit = topBitId++;
      apbBits.push(bit);
      topNetnames[`apb0_paddr_bit${b}`] = { bits: [bit], attributes: { src: `rtl/spike_top.sv:${10 + s}.${b + 1}` } };
    }
    const irqBits: number[] = [];
    for (let b = 0; b < 4; b++) {
      const bit = topBitId++;
      irqBits.push(bit);
      topNetnames[`irq_link_${s}_bit${b}`] = { bits: [bit], attributes: { src: `rtl/spike_top.sv:${20 + s}.${b + 1}` } };
    }

    topCells[cellName] = {
      type: subsysType,
      parameters: { N_IP: ipsPerSubsys },
      connections: {
        clk_i: [0],
        rst_n_i: [1],
        h_haddr: apbBits,
        irq_o: irqBits,
      },
    };
  }

  // 顶层端口连接 bit id（axi0/apb0 等）
  const topPortBits: Record<string, (number | string)[]> = {};
  let topPortBitId = 200;
  for (const [pname, port] of Object.entries(SPIKE_TOP_PORTS)) {
    topPortBits[pname] = port.bits.map((b) => (typeof b === 'number' ? topPortBitId++ : b));
  }

  modules['spike_top'] = {
    attributes: { src: 'rtl/spike_top.sv:3.8' },
    ports: Object.fromEntries(
      Object.entries(SPIKE_TOP_PORTS).map(([name, p]) => [name, { direction: p.direction, bits: topPortBits[name] }]),
    ),
    cells: topCells,
    netnames: topNetnames,
  };

  // 每个子系统的 uniquified 模块
  for (let s = 0; s < subsysCount; s++) {
    const subsysName = `soc_subsys$spike_top.u_subsys${s}`;
    const cells: Record<string, WJCell> = {};
    const netnames: Record<string, { bits: number[]; attributes: Record<string, unknown> }> = {};
    let bitId = 300; // 每个子系统独立 bit 空间

    for (let i = 0; i < ipsPerSubsys; i++) {
      const ipCellName = `gen_ip[${i}].u_ip`;
      const ipType = `spike_ip$spike_top.u_subsys${s}.${ipCellName}`;

      // 子系统 → IP 连线（top2i from subsys perspective）
      const paddrBits: number[] = [];
      for (let b = 0; b < 4; b++) {
        const bit = bitId++;
        paddrBits.push(bit);
        netnames[`paddr_${i}_bit${b}`] = { bits: [bit], attributes: { src: `rtl/soc_subsys.sv:${10 + i}.${b + 1}` } };
      }

      cells[ipCellName] = {
        type: ipType,
        parameters: {},
        connections: {
          clk_i: [0],
          rst_n_i: [1],
          p_paddr: paddrBits,
          irq_o: [bitId++],
        },
      };
    }

    // i2i 边：相邻 IP 的 irq_o 互连
    for (let i = 0; i < ipsPerSubsys - 1; i++) {
      const netName = `irq_chain_${i}`;
      const bits: number[] = [];
      for (let b = 0; b < 4; b++) {
        const bit = bitId++;
        bits.push(bit);
      }
      netnames[netName] = { bits, attributes: { src: `rtl/soc_subsys.sv:${30 + i}.1` } };
    }

    modules[subsysName] = {
      attributes: { src: 'rtl/soc_subsys.sv:5.1' },
      ports: Object.fromEntries(
        Object.entries(SOC_SUBSYS_PORTS).map(([name, p]) => [
          name,
          { direction: p.direction, bits: p.bits.map((b) => (typeof b === 'number' ? b + 400 : b)) },
        ]),
      ),
      cells,
      netnames,
    };
  }

  // 每个实例的 uniquified spike_ip 模块
  for (let s = 0; s < subsysCount; s++) {
    for (let i = 0; i < ipsPerSubsys; i++) {
      const ipName = `spike_ip$spike_top.u_subsys${s}.gen_ip[${i}].u_ip`;
      modules[ipName] = {
        attributes: { src: 'rtl/spike_ip.sv:2.1' },
        ports: SPIKE_IP_PORTS,
        cells: {},
        netnames: {},
      };
    }
  }

  // spike_ip 定义代表（首个 plain 或 uniquified 实例）
  modules['spike_ip'] = {
    attributes: { src: 'rtl/spike_ip.sv:2.1' },
    ports: SPIKE_IP_PORTS,
    cells: {},
    netnames: {},
  };

  // soc_subsys 定义代表
  modules['soc_subsys'] = {
    attributes: { src: 'rtl/soc_subsys.sv:5.1' },
    ports: SOC_SUBSYS_PORTS,
    cells: {},
    netnames: {},
  };

  const totalInsts = 1 + subsysCount + subsysCount * ipsPerSubsys;
  return { doc: { modules }, totalInsts };
}
