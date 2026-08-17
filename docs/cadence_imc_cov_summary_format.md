## IMC summary.txt格式
name                                        Overall Average    Overall Covered   Code Average      Code Covered       Fsm Average        Fsm Covered        Functional Average Functional Covered
-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
tb_top                                      n/a               n/a               n/a               n/a                n/a                n/a                n/a                n/a
|--dut                                      94.13%            94.13% (353/375)  94.13%            94.13% (353/375)   n/a                n/a                n/a                n/a
|   |--u_analog_bb_line_usb                 87.50%            86.67% (13/15)    87.50%            86.67% (13/15)     n/a                n/a                n/a                n/a
|   |--u_analog_bb_line_pciepll             87.50%            86.67% (13/15)    87.50%            86.67% (13/15)     n/a                n/a                n/a                n/a
|   |--u_block_wrap_0                       90.71%            90.71% (488/538)  90.71%            90.71% (488/538)   n/a                n/a                n/a                n/a
|   |--u_analog_mipi_2t2r                   71.03%            71.03% (586/825)  71.03%            71.03% (586/825)   n/a                n/a                n/a                n/a
|   |--u_g3_side_glue_wrap                  70.37%            70.37% (1235/1755) 70.37%            70.37% (1235/1755) n/a                n/a                n/a                n/a
|   |   |--analog_mipi_mphy_2t2r_glue        100.00%           100.00% (239/239)  100.00%           100.00% (239/239)  n/a                n/a                n/a                n/a
|   |   |--analog_mipi_mphy_2t2r_0_collar    90.36%            71.46% (1172/1640) 90.36%            71.46% (1172/1640) n/a                n/a                n/a                n/a
|   |   |--u_anlg_phy_g3_rf                  83.53%            82.07% (1620/1974) 83.53%            82.07% (1620/1974) n/a                n/a                n/a                n/a
|   |   |--u_req_dec                        98.76%            98.76% (159/161)  98.76%            98.76% (159/161)   n/a                n/a                n/a                n/a
|   |   |--u_analog_mipi_2t2r_glue_logic    92.90%            89.50% (810/905)  92.90%            89.50% (810/905)   n/a                n/a                n/a                n/a
|   |   |--u_cgm_mux2_mphy_cb_cfgclk        100.00%           100.00% (5/5)     100.00%           100.00% (5/5)      n/a                n/a                n/a                n/a
|   |   |--u_clk_gate_reg_read              100.00%           100.00% (4/4)     100.00%           100.00% (4/4)      n/a                n/a                n/a                n/a
|   |   |--u_cgm_mux2_mphy_symbolclk_for_aux 100.00%          100.00% (5/5)     100.00%           100.00% (5/5)      n/a                n/a                n/a                n/a
|   |   |--u_cgm_divn_mphy_symbolclk_div4   53.85%            53.85% (7/13)     53.85%            53.85% (7/13)      n/a                n/a                n/a                n/a
|   |   |--u_cgm_mux6_mphy_linkclk_for_aux  100.00%           100.00% (11/11)   100.00%           100.00% (11/11)    n/a                n/a                n/a                n/a
|   |   |--u_cgm_divn_mphy_linkclk_div4     53.85%            53.85% (7/13)     53.85%            53.85% (7/13)      n/a                n/a                n/a                n/a
|   |   |--u_rst_dvfs_top_n                 100.00%           100.00% (5/5)     100.00%           100.00% (5/5)      n/a                n/a                n/a                n/a
|   |   |--u_apb2rmmi_0                     94.03%            85.59% (87/101)   88.06%            84.47% (87/103)    100.00%            100.00% (8/8)      n/a                n/a

## IMC summary.txt Header
 - name：树状结构描述模块名
 - Overall Average：所有模块的覆盖率平均值
 - Overall Covered: 整体覆盖率
 - Code Average：代码覆盖率平均值
 - Code Covered: 代码覆盖率
 - Fsm Average：FSM覆盖率平均值
 - Fsm Covered: FSM覆盖率
 - Functional Average：功能覆盖率平均值
 - Functional Covered: 功能覆盖率
