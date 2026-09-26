// Racing audio: the supplied exterior recordings are one-shot event sounds.
// Engine RPM comes from a separate harmonic synthesizer, never a pass-by loop.
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
const finite=(n,fallback=0)=>Number.isFinite(n)?n:fallback;
const RATIOS=[3.05,2.15,1.62,1.29,1.05,.88];

export class StormAudio {
 constructor(){
  this.enabled=true;this.ctx=null;this.ready=false;this.buffers=[];this.master=null;
  this.gear=1;this.rpm=1150;this.paused=false;this.focused=true;this.voices=new Set();
  this.persistent=[];this._loadPromise=null;this._targets=new WeakMap();this._epoch=0;
  this._lastShift=-10;this._lastPass=-10;this._lastImpact=-10;this._lastThunder=-10;
  this._visibility=()=>{this.focused=!document.hidden;this._syncMaster();if(!this.focused)this._stopVoices();};
  this._blur=()=>{this.focused=false;this._syncMaster();this._stopVoices();};
  this._focus=()=>{this.focused=!document.hidden;this._syncMaster();};
  if(typeof window!=='undefined'){
   window.addEventListener('blur',this._blur);window.addEventListener('focus',this._focus);
   document.addEventListener('visibilitychange',this._visibility);
  }
 }

 async start(){
  if(!this.ctx||this.ctx.state==='closed')this._createGraph();
  this._epoch++;this._stopVoices();this.gear=1;this.rpm=1150;this.paused=false;
  this._lastShift=this.ctx.currentTime;this._shiftUntil=0;this._lastUpdate=this.ctx.currentTime;
  this.focused=typeof document==='undefined'||!document.hidden;
  await this.ctx.resume();this._syncMaster();
  if(!this._loadPromise){
   this._loadPromise=Promise.all(['engine.mp3','passby.mp3'].map(async(file)=>{
    try{
     const response=await fetch(new URL('./assets/'+file,import.meta.url));
     if(!response.ok)throw new Error('HTTP '+response.status);
     return await this.ctx.decodeAudioData(await response.arrayBuffer());
    }catch(error){console.warn('STORM 录音载入失败：'+file,error);return null;}
   })).then(buffers=>{this.buffers=buffers;this.ready=buffers.some(Boolean);this._clips=buffers.map(b=>b?this._findPass(b):null);});
  }
  await this._loadPromise;
 }

 _createGraph(){
  const Context=globalThis.AudioContext||globalThis.webkitAudioContext;
  if(!Context)throw new Error('当前浏览器不支持 Web Audio');
  this.ctx=new Context({latencyHint:'interactive'});const c=this.ctx;
  this.voices.clear();this.persistent=[];this._targets=new WeakMap();this._loadPromise=null;
  this.master=c.createGain();this.master.gain.value=0;
  this.compressor=c.createDynamicsCompressor();
  this.compressor.threshold.value=-17;this.compressor.knee.value=15;this.compressor.ratio.value=3;
  this.compressor.attack.value=.006;this.compressor.release.value=.2;
  this.master.connect(this.compressor);this.compressor.connect(c.destination);
  this.noise=c.createBuffer(2,Math.floor(c.sampleRate*6),c.sampleRate);
  for(let channel=0;channel<2;channel++){
   const d=this.noise.getChannelData(channel);let low=0;
   for(let i=0;i<d.length;i++){const white=Math.random()*2-1;low=low*.985+white*.015;d[i]=white*.45+low*1.4;}
   // Short seamless joins prevent an audible click in the procedural noise bed.
   const seam=Math.min(1024,Math.floor(d.length/8));
   for(let i=0;i<seam;i++){const t=i/seam;d[d.length-seam+i]=d[d.length-seam+i]*(1-t)+d[i]*t;}
  }
  this.engineGain=c.createGain();this.engineGain.gain.value=0;
  this.engineFilter=c.createBiquadFilter();this.engineFilter.type='lowpass';this.engineFilter.Q.value=.65;
  this.engineFilter.frequency.value=1200;this.engineFilter.connect(this.engineGain);this.engineGain.connect(this.master);
  const real=new Float32Array(17),imag=new Float32Array(17);
  for(let i=1;i<imag.length;i++)imag[i]=(i%2?.9:.53)/Math.pow(i,.85);
  this.tone=c.createOscillator();this.tone.setPeriodicWave(c.createPeriodicWave(real,imag));
  this.tone.frequency.value=57.5;this.tone.connect(this.engineFilter);this.tone.start();this.persistent.push(this.tone);
  this.bass=c.createOscillator();this.bass.type='triangle';this.bass.frequency.value=19.2;
  this.bassGain=c.createGain();this.bassGain.gain.value=.35;this.bass.connect(this.bassGain);this.bassGain.connect(this.engineFilter);
  this.bass.start();this.persistent.push(this.bass);
  this.rain=this._noiseBed(.13,[['highpass',850,.4],['lowpass',6500,.5]],0);
  this.wind=this._noiseBed(0,[['highpass',65,.45],['lowpass',600,.5]],1.43);
  this.rolling=this._noiseBed(0,[['bandpass',950,.5]],2.78);
  this.intake=this._noiseBed(0,[['bandpass',1050,.7]],4.11);
 }

 _noiseBed(gain,filters,offset){
  const c=this.ctx,source=c.createBufferSource();source.buffer=this.noise;source.loop=true;
  let tail=source;const nodes=[];
  for(const [type,frequency,q]of filters){const f=c.createBiquadFilter();f.type=type;f.frequency.value=frequency;f.Q.value=q;tail.connect(f);tail=f;nodes.push(f);}
  const volume=c.createGain();volume.gain.value=gain;tail.connect(volume);volume.connect(this.master);
  source.start(c.currentTime,offset);this.persistent.push(source);
  return {source,volume,filters:nodes};
 }

 _smooth(param,value,seconds=.08){
  if(!param||!this.ctx||this.ctx.state==='closed')return;
  value=finite(value);if(Math.abs((this._targets.get(param)??Infinity)-value)<.0001)return;
  const t=this.ctx.currentTime;
  if(param.cancelAndHoldAtTime)param.cancelAndHoldAtTime(t);
  else{const held=param.value;param.cancelScheduledValues(t);param.setValueAtTime(held,t);}
  param.setTargetAtTime(value,t,Math.max(.005,seconds));this._targets.set(param,value);
 }

 _syncMaster(){this._smooth(this.master?.gain,this.enabled&&this.focused&&!this.paused?.58:0,.045);}

 setEnabled(value){
  this.enabled=Boolean(value);if(this.ctx)this._syncMaster();if(!this.enabled)this._stopVoices();
  const button=typeof document==='undefined'?null:document.getElementById('sound');
  if(button){button.textContent='声音 '+(this.enabled?'开':'关');button.setAttribute('aria-pressed',String(this.enabled));}
 }

 update(speed,throttle,paused){
  if(!this.ctx||this.ctx.state==='closed')return;
  speed=clamp(Math.abs(finite(speed)),0,110);throttle=clamp(finite(Number(throttle)),0,1);
  const c=this.ctx,t=c.currentTime,dt=clamp(t-(this._lastUpdate??t),1/240,.1);this._lastUpdate=t;
  if(this.paused!==Boolean(paused)){this.paused=Boolean(paused);this._syncMaster();if(this.paused)this._stopVoices();}
  const wheelRPM=speed/.34*60/(Math.PI*2),mechanicalRPM=wheelRPM*RATIOS[this.gear-1]*4.1;
  if(!this.paused&&t-this._lastShift>.36){
   if(mechanicalRPM>7100&&this.gear<6){this.gear++;this._lastShift=t;this._shiftUntil=t+.13;}
   else if(mechanicalRPM<3300&&this.gear>1){this.gear--;this._lastShift=t;this._shiftUntil=t+.105;}
  }
  const targetRPM=clamp(Math.max(1150+throttle*750,wheelRPM*RATIOS[this.gear-1]*4.1)+throttle*170,1100,8200);
  this.rpm+=(targetRPM-this.rpm)*(1-Math.exp(-dt*13));
  const shifted=t<(this._shiftUntil||0),load=.25+throttle*.75;
  // A six-cylinder, four-stroke firing order gives three combustion pulses/rev.
  this._smooth(this.tone.frequency,this.rpm/20,.035);this._smooth(this.bass.frequency,this.rpm/60,.035);
  this._smooth(this.engineFilter.frequency,750+this.rpm*.32+load*1400,.075);
  this._smooth(this.engineGain.gain,(.10+load*.17+this.rpm/8200*.08)*(shifted?.33:1),.026);
  this._smooth(this.intake.volume.gain,(.012+throttle*.05)*(shifted?.3:1),.055);
  this._smooth(this.intake.filters[0].frequency,700+this.rpm*.14,.1);
  this._smooth(this.wind.volume.gain,Math.pow(speed/85,1.65)*.21,.22);
  this._smooth(this.wind.filters[1].frequency,400+speed*14,.2);
  this._smooth(this.rolling.volume.gain,clamp(speed/65,0,1)*.075,.2);
  this._smooth(this.rolling.filters[0].frequency,700+speed*13,.16);
  this._smooth(this.rain.volume.gain,(.125+clamp(speed/85,0,1)*.04)*(this.sheltered?.23:1),.3);
 }

 _findPass(buffer){
  // Locate the loudest 200 ms; retain the approach and the decay around it.
  // Do not normalize every excerpt: keep each supplied recording's dynamics.
  const samples=buffer.getChannelData(0),stride=Math.max(1,Math.floor(buffer.sampleRate*.2));
  let peak=0,best=0;
  for(let i=0;i<samples.length;i+=stride){let energy=0;for(let k=i;k<Math.min(i+stride,samples.length);k+=12)energy+=samples[k]*samples[k];if(energy>peak){peak=energy;best=i;}}
  const duration=Math.min(3.8,buffer.duration),offset=clamp(best/buffer.sampleRate-1.25,0,Math.max(0,buffer.duration-duration));
  return {offset,duration};
 }

 _canPlay(){return this.ctx&&this.ctx.state!=='closed'&&this.enabled&&this.focused&&!this.paused;}

 _voice(tag,duration,volume,pan=0){
  const c=this.ctx,t=c.currentTime;
  while(this.voices.size>=8)this._stopVoice(this.voices.values().next().value,0.015,true);
  const gain=c.createGain();gain.gain.setValueAtTime(0,t);
  gain.gain.linearRampToValueAtTime(volume,t+Math.min(.075,duration*.2));
  gain.gain.setValueAtTime(volume,t+Math.max(.08,duration*.6));gain.gain.linearRampToValueAtTime(0,t+duration);
  let panner=null;if(c.createStereoPanner){panner=c.createStereoPanner();panner.pan.value=clamp(pan,-1,1);gain.connect(panner);panner.connect(this.master);}else gain.connect(this.master);
  const voice={tag,gain,panner,sources:[],nodes:[],until:t+duration,stopping:false};this.voices.add(voice);return voice;
 }

 _attachSource(voice,source,offset=0,duration){
  voice.sources.push(source);source.onended=()=>{source.disconnect();voice.sources=voice.sources.filter(s=>s!==source);if(!voice.sources.length){voice.gain.disconnect();voice.panner?.disconnect();for(const n of voice.nodes)n.disconnect();this.voices.delete(voice);}};
  if(source.buffer)source.start(this.ctx.currentTime,offset,duration);else source.start(this.ctx.currentTime);
 }

 _stopVoice(voice,fade=.035,evict=false){
  if(!voice)return;if(evict)this.voices.delete(voice);if(voice.stopping)return;voice.stopping=true;
  this._smooth(voice.gain.gain,0,Math.max(.005,fade/3));
  for(const source of voice.sources){try{source.stop(this.ctx.currentTime+fade);}catch{}}
 }

 _stopVoices(){for(const v of [...this.voices])this._stopVoice(v);}

 play(index,gain=.18){
  if(!this._canPlay()||!this.buffers[index])return;
  for(const v of this.voices)if(v.tag==='recording-'+index)this._stopVoice(v,.025,true);
  const clip=this._clips[index],source=this.ctx.createBufferSource();source.buffer=this.buffers[index];
  const voice=this._voice('recording-'+index,clip.duration,clamp(finite(gain,.18),0,.45));
  source.connect(voice.gain);this._attachSource(voice,source,clip.offset,clip.duration);source.stop(voice.until+.01);
 }

 passBy(side,speed){
  if(!this._canPlay()||!this.ready)return;
  const t=this.ctx.currentTime;if(t-this._lastPass<.45)return;this._lastPass=t;
  const index=(this._passIndex=(this._passIndex??0)+1)%2,buffer=this.buffers[index]||this.buffers[1-index];if(!buffer)return;
  const clip=this._clips[index]||this._clips[1-index],duration=Math.min(3.2,clip.duration),pan=clamp(finite(side),-1,1);
  const relative=clamp(Math.abs(finite(speed)),0,80),voice=this._voice('pass',duration,.10+relative/80*.18,pan*.2);
  if(voice.panner){voice.panner.pan.setValueAtTime(pan*.2,t);voice.panner.pan.linearRampToValueAtTime(pan*.9,t+.65);voice.panner.pan.linearRampToValueAtTime(pan*.35,t+duration);}
  const source=this.ctx.createBufferSource();source.buffer=buffer;
  // The recording already contains Doppler motion, so avoid a second pitch sweep.
  source.connect(voice.gain);this._attachSource(voice,source,clip.offset,duration);source.stop(voice.until+.01);
 }

 impact(strength){
  if(!this._canPlay())return;strength=clamp(finite(strength),0,1);if(strength<.035)return;
  const t=this.ctx.currentTime;if(t-this._lastImpact<.09)return;this._lastImpact=t;
  const duration=.18+strength*.27,voice=this._voice('impact',duration,.12+strength*.42);
  voice.gain.gain.cancelScheduledValues(t);voice.gain.gain.setValueAtTime(.0001,t);
  voice.gain.gain.linearRampToValueAtTime(.12+strength*.42,t+.009);voice.gain.gain.exponentialRampToValueAtTime(.0001,t+duration);
  const osc=this.ctx.createOscillator();osc.type='sine';osc.frequency.setValueAtTime(115+strength*35,t);osc.frequency.exponentialRampToValueAtTime(38,t+duration);
  osc.connect(voice.gain);this._attachSource(voice,osc);osc.stop(voice.until+.01);
  const noise=this.ctx.createBufferSource();noise.buffer=this.noise;const filter=this.ctx.createBiquadFilter();filter.type='lowpass';filter.frequency.value=700+strength*1700;
  const level=this.ctx.createGain();level.gain.value=.34;noise.connect(filter);filter.connect(level);level.connect(voice.gain);voice.nodes.push(filter,level);
  this._attachSource(voice,noise,1.7,duration);noise.stop(voice.until+.01);
 }

 thunder(){
  if(!this._canPlay())return;const t=this.ctx.currentTime;if(t-this._lastThunder<4)return;this._lastThunder=t;
  const duration=3.3,voice=this._voice('thunder',duration,.31,(Math.random()-.5)*.55);
  voice.gain.gain.cancelScheduledValues(t);voice.gain.gain.setValueAtTime(.0001,t);
  voice.gain.gain.linearRampToValueAtTime(.31,t+.18);voice.gain.gain.exponentialRampToValueAtTime(.0001,t+duration);
  const noise=this.ctx.createBufferSource();noise.buffer=this.noise;const filter=this.ctx.createBiquadFilter();filter.type='lowpass';filter.frequency.value=310;filter.Q.value=.8;
  noise.connect(filter);filter.connect(voice.gain);voice.nodes.push(filter);this._attachSource(voice,noise,.4,duration);noise.stop(voice.until+.01);
  const osc=this.ctx.createOscillator();osc.type='sine';osc.frequency.setValueAtTime(48,t);osc.frequency.exponentialRampToValueAtTime(22,t+duration);
  const gain=this.ctx.createGain();gain.gain.value=.35;osc.connect(gain);gain.connect(voice.gain);voice.nodes.push(gain);this._attachSource(voice,osc);osc.stop(voice.until+.01);
 }

 async dispose(){
  this._stopVoices();for(const s of this.persistent){try{s.stop();s.disconnect();}catch{}}
  if(typeof window!=='undefined'){window.removeEventListener('blur',this._blur);window.removeEventListener('focus',this._focus);document.removeEventListener('visibilitychange',this._visibility);}
  if(this.ctx&&this.ctx.state!=='closed')await this.ctx.close();this.persistent=[];this.voices.clear();this.ready=false;
 }
}
