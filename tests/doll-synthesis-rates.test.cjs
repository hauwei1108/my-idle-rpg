const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('js/15-cards.js','utf8');
const match = source.match(/const DOLL_SYNTH_RATES = (\{[^;]+\});/);
assert.ok(match, 'rate table exists');
const actual = vm.runInNewContext('('+match[1]+')');
const original = { 1:{2:8,3:23,4:45}, 2:{2:7,3:20,4:40}, 3:{2:4,3:12,4:23}, 4:{2:2,3:6,4:12}, 5:{2:1,3:3,4:6} };
for (const [tier, options] of Object.entries(original)) {
  for (const [count, chance] of Object.entries(options)) {
    assert.equal(actual[tier][count], Math.min(100,chance*10), 'tier '+tier+' with '+count+' dolls');
  }
}
assert.match(source, /let rate = DOLL_SYNTH_RATES\[fromTier\]\[count\]/g);
assert.ok((source.match(/let rate = DOLL_SYNTH_RATES\[fromTier\]\[count\]/g)||[]).length>=2, 'single and batch synthesis share rates');
assert.match(source, /let guaranteed = \(count === 4 && pity >= 5\)/, 'original 4-input pity preserved');
assert.match(source, /if \(count === 4\) player\.dollPity\[fromTier\]/, 'failure pity preserved');
assert.match(source, /退還/, 'failure refund preserved');
console.log('Doll synthesis 10x rate tests passed');
