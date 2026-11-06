const { World, startMatch } = require('./lib/world.cjs');
const { test, ok, eq, run } = require('./lib/tap.cjs');
function native(c) {
  c.run(`
    var voiceCalls = [], voiceListener = null, voiceSpeaking = null, voiceDeferred = null, voiceError = null, voiceOffDeferred = false, voiceOffResolve = null;
    Usion.call = {
      isAvailable: () => true,
      onChange: fn => { voiceListener = fn; },
      onSpeaking: fn => { voiceSpeaking = fn; },
      micOn: opts => {
        voiceCalls.push(['on', opts]);
        if (voiceError) return Promise.reject({code: voiceError});
        var st = { on: true, channel: opts.channel, scope: opts.scope, status: 'connected',
          peers: [{userId:'a'}, {userId:'b'}] };
        if (voiceDeferred) return new Promise(resolve => { voiceDeferred = () => { voiceListener(st); resolve(st); }; });
        voiceListener(st); return Promise.resolve(st);
      },
      micOff: () => {
        voiceCalls.push(['off']);
        if (voiceOffDeferred) return new Promise(resolve => { voiceOffResolve = () => { voiceListener({on:false, status:'idle'}); resolve(); }; });
        voiceListener({on:false, status:'idle'}); return Promise.resolve();
      }
    };
  `);
}
async function room(options = {}) {
  const w = new World();
  const c = w.add('voice-a', 'Alice', { mode: options.public ? 'single' : 'multiplayer', pick: 'online', roomId: w.roomId });
  native(c);
  c.start({userId:'voice-a', userName:'Alice', roomId:w.roomId, playerIds:[]});
  await w.advance(2000);
  return {w,c};
}
test('private room microphone is off until tapped, and uses native room scope', async () => {
  const {w,c} = await room();
  eq(c.read('voiceCalls.length'), 0);
  eq(c.el('voiceToggle').hidden, false);
  c.click('voiceToggle'); await w.advance(1);
  eq(c.read('voiceOn'), true);
  eq(c.read('voiceCalls[0][1].scope'), 'room');
  eq(c.read('voiceCalls[0][1].channel'), c.read("voiceChannelFor('room1')"));
  eq(c.el('voiceCount').textContent, '2');
  c.click('voiceToggle'); await w.advance(1);
  eq(c.read('voiceOn'), false);
  eq(c.read('voiceCalls[1][0]'), 'off');
});
test('public table uses its actual shared table id and game scope', async () => {
  const {w,c} = await room({public:true});
  c.click('voiceToggle'); await w.advance(1);
  eq(c.read('voiceCalls[0][1].scope'), 'game');
  eq(c.read('voiceCalls[0][1].channel'), c.read("voiceChannelFor('public-13-1')"));
  ok(c.read("voiceChannelFor('public-13-1') !== voiceChannelFor('public-13-2')"));
});
test('leaving for bots closes native capture and hides the microphone', async () => {
  const {w,c} = await room(); c.click('voiceToggle'); await w.advance(1);
  c.run('leaveForBots()'); await w.advance(1);
  eq(c.read('voiceOn'), false);
  eq(c.el('voiceToggle').hidden, true);
  eq(c.read("voiceCalls.filter(c => c[0] === 'off').length"), 1);
});
test('a denied permission clears the button and allows another attempt', async () => {
  const {w,c} = await room(); c.run("voiceError = 'VOICE_MIC_DENIED'");
  c.click('voiceToggle'); await w.advance(1);
  eq(c.read('voiceBusy || voiceOn || !!voiceWanted'), false);
  c.run('voiceError = null'); c.click('voiceToggle'); await w.advance(1);
  eq(c.read('voiceOn'), true);
});
test('cancelling a permission prompt closes even a late successful result', async () => {
  const {w,c} = await room(); c.run('voiceDeferred = true');
  c.click('voiceToggle'); c.click('voiceToggle');
  c.run('voiceDeferred()'); await w.advance(1);
  eq(c.read('voiceOn || voiceBusy || !!voiceWanted'), false);
  ok(c.read("voiceCalls.filter(c => c[0] === 'off').length >= 1"));
});
test('room changes and disconnects close voice without auto-reopening it', async () => {
  const {w,c} = await room({public:true}); c.click('voiceToggle'); await w.advance(1);
  c.run('resetRoomState()'); await w.advance(1);
  eq(c.read('voiceOn || voiceJoined || !!voiceRoomId'), false);
  const {w:otherWorld,c:d} = await room();
  d.click('voiceToggle'); await otherWorld.advance(1);
  d.netDrop(); await otherWorld.advance(1);
  eq(d.read('voiceOn'), false);
  eq(d.read("voiceCalls.filter(c => c[0] === 'off').length"), 1);
});
test('hosts without native voice keep the game working with no mic button', async () => {
  const w = new World(), c = w.add('old', 'Old', {mode:'multiplayer', roomId:w.roomId});
  c.start({userId:'old', roomId:w.roomId, playerIds:[]}); await w.advance(2000);
  eq(c.el('voiceToggle').hidden, true); eq(w.errors().length, 0);
});
test('a delayed micOff cannot close a newly started voice session', async () => {
  const {w,c} = await room(); c.click('voiceToggle'); await w.advance(1);
  c.run('voiceOffDeferred = true'); c.click('voiceToggle'); await w.advance(1);
  c.click('voiceToggle'); await w.advance(1);
  eq(c.read("voiceCalls.filter(c => c[0] === 'on').length"), 1, 'wait for native microphone shutdown before allowing a new session');
  c.run('voiceOffResolve()'); await w.advance(1);
  c.run('voiceOffDeferred = false'); c.click('voiceToggle'); await w.advance(1);
  eq(c.read('voiceOn'), true);
});
test('failed shutdown stays visible and can be retried after leaving for bots', async () => {
  const {w,c} = await room(); c.click('voiceToggle'); await w.advance(1);
  c.run("Usion.call.micOff = () => Promise.reject(new Error('host timeout'))");
  c.run('leaveForBots()'); await w.advance(1);
  eq(c.read('voiceOn'), true, 'do not claim native capture stopped without confirmation');
  eq(c.el('voiceToggle').hidden, false, 'keep the stop control available');
  c.run("Usion.call.micOff = () => { voiceListener({on:false,status:'idle'}); return Promise.resolve(); }");
  c.click('voiceToggle'); await w.advance(1);
  eq(c.read('voiceOn'), false); eq(c.el('voiceToggle').hidden, true);
});
test('speaking highlights the correct lobby/table portrait and survives a redraw', async () => {
  const {w,c} = await room();
  const guest = w.add('voice-b', 'Bob', {mode:'multiplayer', roomId:w.roomId});
  guest.start({userId:'voice-b', userName:'Bob', roomId:w.roomId, playerIds:[]});
  await w.advance(2000);
  eq(w.errors(), [], 'both participants initialize');
  c.click('voiceToggle'); await w.advance(1);
  c.run("voiceSpeaking(['voice-b'])");
  eq(c.read('Array.from(voiceSpeakers)'), ['voice-b']);
  eq(c.read("Array.from(document.querySelectorAll('.lobby-avatar')).map(el => el.dataset.voiceId)"), ['voice-a','voice-b']);
  const highlighted = () => c.read("Array.from(new Set(Array.from(document.querySelectorAll('.player-avatar')).filter(el => el.classList.contains('is-speaking')).map(el => el.dataset.voiceId)))");
  eq(highlighted(), ['voice-b'], 'only the speaking guest in the waiting room');
  await startMatch(w);
  c.run('render()');
  eq(highlighted(), ['voice-b'], 'speaker is preserved when seated and redrawn');
  ok(c.read("Array.from(document.querySelectorAll('.opp-avatar')).some(el => el.dataset.voiceId === 'voice-b' && el.classList.contains('is-speaking'))"));
  c.run("voiceSpeaking(['voice-a'])");
  eq(c.el('meAvatar').classList.contains('is-speaking'), true);
  c.run('voiceSpeaking([])');
  eq(highlighted(), [], 'silence removes the ring immediately');
  c.run("voiceSpeaking(['voice-a','voice-b'])");
  c.click('voiceToggle'); await w.advance(1);
  eq(highlighted(), [], 'leaving voice clears every ring');
});
module.exports.run = () => run('VOICE');
if (require.main === module) module.exports.run().then(r => process.exit(r.fails.length ? 1 : 0));
