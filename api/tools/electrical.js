// ── Electrical Quick Tools (NEC-based) ───────────────────────────────────────

// NEC Chapter 9 Table 1 — conduit fill percentages
const CONDUIT_AREA = {
  'emt': { '1/2': 0.304, '3/4': 0.533, '1': 0.864, '1-1/4': 1.496, '1-1/2': 2.036, '2': 3.356, '2-1/2': 5.858, '3': 8.846, '3-1/2': 11.545, '4': 14.753 },
  'pvc': { '1/2': 0.285, '3/4': 0.508, '1': 0.832, '1-1/4': 1.453, '1-1/2': 1.986, '2': 3.291, '2-1/2': 5.453, '3': 8.091, '3-1/2': 10.574, '4': 13.631 },
  'rigid': { '1/2': 0.314, '3/4': 0.549, '1': 0.887, '1-1/4': 1.526, '1-1/2': 2.071, '2': 3.408, '2-1/2': 5.858, '3': 8.846, '3-1/2': 11.545, '4': 14.753 },
};
const WIRE_AREA = {
  '14': 0.0097, '12': 0.0133, '10': 0.0211, '8': 0.0366, '6': 0.0507,
  '4': 0.0824, '3': 0.0973, '2': 0.1158, '1': 0.1562, '1/0': 0.1855,
  '2/0': 0.2223, '3/0': 0.2679, '4/0': 0.3237,
};
const WIRE_AMPACITY_SORTED = [
  ['14', 20], ['12', 25], ['10', 35], ['8', 50], ['6', 65], ['4', 85],
  ['3', 100], ['2', 115], ['1', 130], ['1/0', 150], ['2/0', 175], ['3/0', 200], ['4/0', 230],
];
const WIRE_RESISTANCE = {
  '14': 3.14, '12': 1.98, '10': 1.24, '8': 0.778, '6': 0.491, '4': 0.308,
  '3': 0.245, '2': 0.194, '1': 0.154, '1/0': 0.122, '2/0': 0.0967,
  '3/0': 0.0766, '4/0': 0.0608,
};

function calcConduitFill(conduitSize, conduitType, wireSize, wireCount) {
  const type = (conduitType || 'emt').toLowerCase();
  const area = CONDUIT_AREA[type]?.[conduitSize];
  const wireArea = WIRE_AREA[wireSize];
  if (!area || !wireArea) return null;
  const fillPct = wireCount === 1 ? 0.53 : wireCount === 2 ? 0.31 : 0.40;
  const maxArea = area * fillPct;
  const totalWireArea = wireArea * wireCount;
  const pctUsed = (totalWireArea / maxArea) * 100;
  const maxWires = Math.floor(maxArea / wireArea);
  return { pctUsed: pctUsed.toFixed(1), maxWires, pass: totalWireArea <= maxArea, conduitArea: area, fillPct: (fillPct * 100) };
}

function calcVoltageDrop(wireSize, lengthFt, amps, voltage) {
  const resistance = WIRE_RESISTANCE[wireSize];
  if (!resistance) return null;
  const vDrop = (2 * lengthFt * resistance * amps) / 1000;
  const pctDrop = (vDrop / voltage) * 100;
  return { vDrop: vDrop.toFixed(2), pctDrop: pctDrop.toFixed(2), pass: pctDrop <= 3 };
}

function calcWireSize(amps) {
  for (const [size, ampacity] of WIRE_AMPACITY_SORTED) {
    if (ampacity >= amps) return { size, ampacity };
  }
  return null;
}

function detectElectricalCalc(text) {
  const lower = text.toLowerCase();
  const fillMatch = lower.match(/(?:conduit\s+fill|fill\s+(?:calc|for))\s+(\d[\d\/\-]*)\s*(?:inch|in|")?\s*(emt|pvc|rigid)?\s*(?:with|for)?\s*(\d+)\s*(?:#|awg|gauge)?\s*(\d+(?:\/\d+)?)/i);
  if (fillMatch) {
    return { type: 'conduit_fill', size: fillMatch[1].replace('-', '-'), conduitType: fillMatch[2] || 'emt', wireSize: fillMatch[4], count: parseInt(fillMatch[3]) };
  }
  const vdMatch = lower.match(/(?:voltage\s+drop|vdrop|v\.?d\.?)\s+(\d+)\s*(?:ft|feet|foot)?\s*(?:#|awg)?\s*(\d+(?:\/\d+)?)\s*(?:awg)?\s*(\d+)\s*(?:a(?:mp)?s?)?\s*(\d+)\s*v(?:olts?)?/i)
    || lower.match(/(?:voltage\s+drop|vdrop|v\.?d\.?)\s+(\d+)\s*(?:ft|feet)?\s+(\d+(?:\/\d+)?)\s*(?:awg|#)?\s+(\d+)\s*a\s+(\d+)\s*v/i);
  if (vdMatch) {
    return { type: 'voltage_drop', length: parseInt(vdMatch[1]), wireSize: vdMatch[2], amps: parseInt(vdMatch[3]), voltage: parseInt(vdMatch[4]) };
  }
  const wireMatch = lower.match(/(?:what\s+(?:wire|size|gauge)|wire\s+(?:size|gauge|for)|size\s+wire)\s+(?:for|do i need for)?\s*(\d+)\s*(?:a(?:mp)?s?)/i);
  if (wireMatch) {
    return { type: 'wire_size', amps: parseInt(wireMatch[1]) };
  }
  return null;
}

function formatElectricalResult(calc) {
  if (calc.type === 'conduit_fill') {
    const r = calcConduitFill(calc.size, calc.conduitType, calc.wireSize, calc.count);
    if (!r) return null;
    return `\u{1F527} *Conduit Fill \u{2014} ${calc.size}" ${calc.conduitType.toUpperCase()}*\n\n` +
      `\u{2022} ${calc.count}x #${calc.wireSize} THHN\n` +
      `\u{2022} Fill: *${r.pctUsed}%* ${r.pass ? '\u{2705}' : '\u{274C} OVER FILL'}\n` +
      `\u{2022} Max allowed: ${r.maxWires} wires (NEC ${r.fillPct}% rule)\n` +
      `\u{2022} Conduit area: ${r.conduitArea} sq in`;
  }
  if (calc.type === 'voltage_drop') {
    const r = calcVoltageDrop(calc.wireSize, calc.length, calc.amps, calc.voltage);
    if (!r) return null;
    return `\u{26A1} *Voltage Drop \u{2014} #${calc.wireSize} AWG, ${calc.length}ft*\n\n` +
      `\u{2022} Load: ${calc.amps}A @ ${calc.voltage}V\n` +
      `\u{2022} Drop: *${r.vDrop}V (${r.pctDrop}%)* ${r.pass ? '\u{2705} Under 3%' : '\u{274C} Over 3% \u{2014} upsize wire'}\n` +
      `\u{2022} NEC recommends \u{2264}3% for branch circuits`;
  }
  if (calc.type === 'wire_size') {
    const r = calcWireSize(calc.amps);
    if (!r) return `\u{26A1} ${calc.amps}A exceeds standard wire tables \u{2014} need parallel runs or busbar.`;
    return `\u{26A1} *Wire Size for ${calc.amps}A*\n\n` +
      `\u{2022} Minimum: *#${r.size} AWG* (rated ${r.ampacity}A @ 75\u{00B0}C)\n` +
      `\u{2022} Per NEC Table 310.16 \u{2014} copper THHN/THWN`;
  }
  return null;
}

module.exports = { detectElectricalCalc, formatElectricalResult };
