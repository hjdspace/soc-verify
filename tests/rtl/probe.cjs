// Temporary probe for expected values in tests (deleted after use).
const d = require('D:/AI/rtl-spike/out/spike_netlist_keep.json');
const m = d.modules['soc_subsys$spike_top.u_subsys0'];
const netOf = new Map();
for (const [nn, n] of Object.entries(m.netnames ?? {})) (n.bits ?? []).forEach((b) => { if (typeof b === 'number') netOf.set(b, nn); });
const perNet = new Map();
for (const [cn, cell] of Object.entries(m.cells ?? {})) {
  if (!cell.type.startsWith('spike_ip')) continue;
  for (const [pn, bits] of Object.entries(cell.connections ?? {})) {
    (bits ?? []).forEach((b) => {
      if (typeof b !== 'number') return;
      const net = netOf.get(b) ?? `bit${b}`;
      if (!perNet.has(net)) perNet.set(net, new Set());
      perNet.get(net).add(`${cn}.${pn}`);
    });
  }
}
for (const [net, eps] of perNet) console.log(net, '→', [...eps].join(' , '));
