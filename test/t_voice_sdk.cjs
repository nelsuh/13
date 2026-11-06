// Optional online contract check against the actual published Usion SDK.
// The game and SDK are real; the native host response is simulated. No audio test.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { World } = require('./lib/world.cjs');

async function main() {
  const response = await fetch('https://usions.com/usion-sdk.js', { signal: AbortSignal.timeout(15000) });
  assert.ok(response.ok, 'published SDK can be fetched');
  const source = await response.text();
  for (const isPublic of [false, true]) {
    const w = new World();
    const c = w.add('actual-sdk', 'SDK check', { mode: isPublic ? 'single' : 'multiplayer', pick: 'online', roomId: w.roomId });
    const original = c.sandbox.Usion;
    vm.runInContext(source, c.ctx, { filename: 'published-usion-sdk.js' });
    const sdk = c.sandbox.Usion;
    const realCall = sdk.call;
    // Preserve the game-relay harness while retaining the real call API and its
    // internal state normalization, callbacks, validation and request payloads.
    Object.assign(sdk, original);
    sdk.call = realCall;
    sdk.config = { hostFeatures: { voice: true } };
    const requests = [];
    sdk._request = async (type, payload) => {
      requests.push({ type, payload });
      if (type === 'CALL_VOICE_ON') return { state: { on: true, micOn: true,
        status: 'connected', channel: payload.channel, scope: payload.scope,
        peers: [{ userId: 'actual-sdk', isMe: true, micOn: true, speaking: true }, { userId: 'peer', micOn: true }] } };
      if (type === 'CALL_VOICE_OFF') return { state: { on: false, status: 'idle', peers: [] } };
      throw new Error('Unexpected host request ' + type);
    };
    c.start({userId:'actual-sdk', userName:'SDK check', roomId:w.roomId, playerIds:[]});
    await w.advance(2000);
    assert.equal(c.el('voiceToggle').hidden, false);
    c.click('voiceToggle'); await w.advance(1);
    assert.equal(c.read('voiceOn'), true);
    assert.equal(c.el('voiceCount').textContent, '2');
    assert.equal(c.read("voiceSpeakers.has('actual-sdk')"), true, 'real SDK speaking state reaches the profile effect');
    assert.equal(requests[0].type, 'CALL_VOICE_ON');
    assert.equal(requests[0].payload.scope, isPublic ? 'game' : 'room');
    assert.equal(requests[0].payload.listen, false, 'microphone rather than listen-only');
    assert.match(requests[0].payload.channel, /^[a-z0-9][a-z0-9_-]{0,47}$/);
    c.click('voiceToggle'); await w.advance(1);
    assert.equal(c.read('voiceOn || voiceBusy'), false);
    assert.equal(c.read('voiceSpeakers.size'), 0);
    assert.equal(requests[1].type, 'CALL_VOICE_OFF');
    assert.deepEqual(w.errors(), []);
  }
  console.log('PASS: actual published Usion.call API — private/public scope, microphone request, state callbacks, peer count, shutdown');
  console.log('Native host and audible phone-to-phone audio are not exercised by this check.');
}
if (require.main === module) main().catch((e) => { console.error(e); process.exitCode = 1; });
module.exports = { main };
