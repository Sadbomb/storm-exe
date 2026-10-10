import test from 'node:test';
import assert from 'node:assert/strict';
import {StormAudio} from '../public/audio.js';

class Param {
 constructor(value=0){this.value=value;this.events=[];}
 set(value,time){assert.ok(Number.isFinite(value),'audio parameter must remain finite');assert.ok(Number.isFinite(time));this.value=value;this.events.push([value,time]);}
 setTargetAtTime(value,time){this.set(value,time);}
 setValueAtTime(value,time){this.set(value,time);}
 linearRampToValueAtTime(value,time){this.set(value,time);}
 exponentialRampToValueAtTime(value,time){assert.ok(value>0);this.set(value,time);}
 cancelAndHoldAtTime(){}
 cancelScheduledValues(){}
}
class Node {
 constructor(){for(const key of ['gain','frequency','Q','pan','threshold','knee','ratio','attack','release'])this[key]=new Param();}
 connect(target){(this.connections||=[]).push(target);}disconnect(){}start(){this.started=true;}stop(){this.stopped=true;}
 setPeriodicWave(wave){this.wave=wave;}
}
class Context {
 constructor(){this.currentTime=0;this.sampleRate=8000;this.state='running';this.destination={};}
 createGain(){return new Node();}createDynamicsCompressor(){return new Node();}createBiquadFilter(){return new Node();}createOscillator(){return new Node();}createBufferSource(){return new Node();}createStereoPanner(){return new Node();}
 createPeriodicWave(real,imag){return {real,imag};}
 createBuffer(channels,length,sampleRate){const data=Array.from({length:channels},()=>new Float32Array(length));return {getChannelData:i=>data[i],duration:length/sampleRate,sampleRate};}
 async close(){this.state='closed';}
}
function fixture(){
 const original=globalThis.AudioContext;globalThis.AudioContext=Context;
 try{const audio=new StormAudio();audio._createGraph();return audio;}finally{globalThis.AudioContext=original;}
}
function update(audio,telemetry={},speed=30,throttle=.7){audio.ctx.currentTime+=.1;audio.update(speed,throttle,false,telemetry);}

test('engine sound follows real physics RPM and gear without independent shifts',()=>{
 const audio=fixture();
 for(let i=0;i<20;i++)update(audio,{rpm:4200,gear:3});
 assert.equal(audio.gear,3);assert.ok(Math.abs(audio.rpm-4200)<1);
 assert.ok(Math.abs(audio.tone.frequency.value-210)<.1);
 update(audio,{rpm:2900,gear:4});assert.equal(audio.gear,4);assert.ok(audio._shiftUntil>audio.ctx.currentTime);
});

test('flat six and V8 profiles produce their own firing frequency and harmonics',()=>{
 const audio=fixture();for(let i=0;i<20;i++)update(audio,{rpm:3600,gear:3});
 const flatPitch=audio.tone.frequency.value,flatWave=audio.tone.wave.imag[2];
 audio.setCar('Mercedes2005');for(let i=0;i<20;i++)update(audio,{rpm:3600,gear:3});
 assert.ok(audio.tone.frequency.value>flatPitch*1.3);assert.notEqual(audio.tone.wave.imag[2],flatWave);
});

test('tyre feedback increases on saturation and fades away at a standstill',()=>{
 const audio=fixture();update(audio,{slip:0,brake:0});const quiet=audio.scrub.volume.gain.value;
 update(audio,{slip:.9,brake:1});assert.ok(audio.scrub.volume.gain.value>quiet);assert.ok(audio.squealGain.gain.value>0);
 update(audio,{slip:1,brake:1},0,0);assert.equal(audio.scrub.volume.gain.value,0);assert.equal(audio.squealGain.gain.value,0);
});

test('dry weather removes rain and shelter muffles the wet rain bed',()=>{
 const audio=fixture();audio.setWetness(0);update(audio);assert.equal(audio.rain.volume.gain.value,0);
 audio.setWetness(1);update(audio);const outside=audio.rain.volume.gain.value;
 audio.sheltered=true;update(audio);assert.ok(audio.rain.volume.gain.value<outside*.3);
});

test('volume and pause consistently mute both sustained sound and new cues',()=>{
 const audio=fixture();audio.setVolume(.5);assert.equal(audio.master.gain.value,.29);
 audio.setVolume(0);assert.equal(audio.master.gain.value,0);assert.equal(audio.cue('start'),false);
 audio.setVolume(1);audio.update(20,.5,true);assert.equal(audio.master.gain.value,0);assert.equal(audio.cue('finish'),false);
 update(audio);assert.equal(audio.master.gain.value,.58);
});

test('race cues work without recordings, reject unknown names and debounce duplicates',()=>{
 const audio=fixture();assert.equal(audio.ready,false);assert.equal(audio.cue('start'),true);assert.equal(audio.cue('start'),false);
 assert.equal(audio.cue('unknown'),false);assert.equal(audio.voices.size,1);
 audio.ctx.currentTime+=.2;assert.equal(audio.cue('checkpoint'),true);
});

test('finish cue plays through the results transition while the driving bus pauses',()=>{
 const audio=fixture();update(audio,{rpm:5000,gear:3});
 audio.cue('checkpoint');const checkpoint=[...audio.voices][0];
 assert.equal(audio.finish(),true);const finish=audio._finishVoice;
 assert.ok(finish.panner.connections.includes(audio.finishMaster));assert.ok(checkpoint.panner.connections.includes(audio.master));
 audio.update(35,.7,true,{rpm:5000,gear:3});
 assert.equal(audio.master.gain.value,0,'engine and road bus must mute');
 assert.ok(audio.finishMaster.gain.value>0,'results cue remains audible');
 assert.equal(finish.stopping,false);assert.equal(checkpoint.stopping,true);
 finish.sources[0].onended();assert.equal(audio._finishVoice,null);assert.equal(audio.finishMaster.gain.value,0);
});

test('ordinary pause mutes ordinary cues and explicit finish still respects mute and focus',()=>{
 const audio=fixture();audio.cue('start');const start=[...audio.voices][0];
 audio.update(20,.4,true);assert.equal(start.stopping,true);assert.equal(audio.master.gain.value,0);assert.equal(audio.finishMaster.gain.value,0);
 audio.setEnabled(false);assert.equal(audio.finish(),false);audio.setEnabled(true);
 audio.setVolume(0);assert.equal(audio.finish(),false);audio.setVolume(.65);
 audio.focused=false;assert.equal(audio.finish(),false);
 audio.focused=true;assert.equal(audio.finish(),true);audio._blur();
 assert.equal(audio._finishVoice.stopping,true);assert.equal(audio.finishMaster.gain.value,0);
});

test('legacy update and invalid telemetry stay finite, including reverse',()=>{
 const audio=fixture();audio.update(0,0,false);update(audio,{gear:-1,rpm:1500},5,.4);assert.equal(audio.gear,-1);
 audio.setCar('invalid');audio.setVolume(Infinity);audio.setWetness(NaN);
 update(audio,{rpm:NaN,slip:Infinity,wetness:NaN,brake:NaN},NaN,NaN);
 assert.ok(Number.isFinite(audio.rpm));assert.ok(Number.isFinite(audio.tone.frequency.value));
});

test('dispose stops all persistent generators and closes the audio context',async()=>{
 const audio=fixture(),sources=[...audio.persistent];assert.ok(sources.length>=8);
 await audio.dispose();assert.ok(sources.every(source=>source.stopped));assert.equal(audio.ctx.state,'closed');assert.equal(audio.persistent.length,0);
});
