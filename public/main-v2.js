import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import {RoadSurface,makeCar,drive,Lap,clamp,timeText} from './driving.js';
import {CollisionWorld,resolveCars} from './collision.js';
import {gateCollisionTriangles} from './gate-collision.js';
import {RaceRoute,RivalRace,CAR_IDS} from './ai.js';
import {prepareTrack,loadSurfaceMaps,detailMaterial,AdaptiveQuality} from './render-world.js';
import {WeatherFX,CockpitGlass,VehicleVisual} from './effects.js';
import {StormAudio} from './audio.js';
import {describeError} from './asset-loading.js';
import {RaceExperience} from './race-ui.js';

const $=id=>document.getElementById(id),canvas=$('game');
const ids=CAR_IDS,names=['992 GT3 R','W203 DTM','C-COUPE DTM','AMG GT3'];
const keys=new Set(),models=new Map(),specs=new Map(),rivalModels=new Map();
let scene,camera,renderer,pmrem,sun,player,hero,heroVisual,road,collision,route,rivals,lap,fleet,state,spawn,weather,glass,audio,adaptive;
let mode='loading',selected=ids[0],quality='balanced',camMode=0,ready=false,busy=false,countdown=3,last=performance.now(),accumulator=0,elapsed=0,uiTime=0,orbit=0,noticeTime=0,flash=0,flashTimer=10,impactTime=0,frameCount=0,frameSeconds=0,fps=60,finishRanks=null;
let demo=false,demoDriver,driveInput={},lastDraw=0,sheltered=false,shelterElapsed=0;
let savedSafe,cameraSnap=true,lighting=[],miniBounds,initialView=0,renderMeshes=[],lastStandings=[],surfaceMaps,physicsMs=0;
const loader=new GLTFLoader(),v=new THREE.Vector3(),targetCamera=new THREE.Vector3(),targetLook=new THREE.Vector3(),cameraLook=new THREE.Vector3(),normalUp=new THREE.Vector3(0,1,0),eye=new THREE.Vector3();
const cameraNames=['追尾镜头','驾驶舱','引擎盖'];
window.addEventListener('error',e=>{if(e.message)fail(new Error(e.message));});window.addEventListener('unhandledrejection',e=>fail(e.reason));
const experience=new RaceExperience({
 read:()=>({state,mode,selected,driveInput,lap,route,rivals,scene,renderer,camera,canvas,countdown,demo,road,racers:activeRacers()}),
 actions:{audio:()=>audio,pause,resume,camera:()=>setCamera(camMode+1),recover:resetToRoad,notice,snap:()=>{cameraSnap=true;}},
 onSettings:applyExperienceSettings
});
selected=experience.settings.carId;quality=experience.settings.quality;initialView=experience.settings.camera;$('car').value=selected;
function activeRacers(){return experience.settings.mode==='race'?(rivals?.racers||[]):[];}
function newPlayerState(pos,id=selected){return makeCar({...pos,dimensions:dimensions(id),carId:id,assist:experience.settings.assist,wetness:experience.settings.wetness});}
function applyExperienceSettings(settings,key){
 quality=settings.quality;initialView=settings.camera;adaptive?.set(quality);weather?.setQuality(quality);weather?.setWetness(settings.wetness);glass?.setWetness(settings.wetness);
 audio?.setVolume(settings.volume);audio?.setWetness(settings.wetness);rivals?.setDifficulty(settings.difficulty);rivals?.setWetness(settings.wetness);
 if(state){state.assist=settings.assist;state.wetness=settings.wetness;}
 if(scene){const dry=settings.wetness<.1;scene.background.setHex(dry?0x696c72:settings.wetness<.6?0x293a47:0x132332);scene.fog.color.copy(scene.background);scene.fog.density=dry?.0018:settings.wetness<.6?.0027:.0041;scene.environmentIntensity=dry?.66:.48;renderer.toneMappingExposure=dry?1.25:1.12;scene.traverse(o=>{for(const m of [].concat(o.material||[]))if(m.userData?.stormWetness)m.userData.stormWetness.value=settings.wetness;});}
 if((key==='camera'||key==='reset')&&ready)setCamera(settings.camera,false);
 if(ready&&!busy&&(key==='modelDetail'||key==='reset')){if(key==='reset')$('car').value=settings.carId;selectCar(settings.carId).catch(fail);}
}

function setStatus(s,p){$('loading').textContent=s;if(p!==undefined)$('load-bar').style.width=p+'%';}
function fail(e){console.error(e);$('error').textContent='启动遇到问题：'+describeError(e)+'。请重新载入；若仍失败，保留此提示。';$('fatal').hidden=false;mode='error';}
async function json(path){const r=await fetch('./'+path);if(!r.ok)throw new Error(path+' 载入失败 ('+r.status+')');return r.json();}
async function loadPlayerModel(id){
 const files=fleet.cars[id].mediumParts;
 const fallback=()=>loader.loadAsync('./assets/'+fleet.cars[id].lod);
 if(experience.settings.modelDetail!=='full'||!files?.length)return fallback();
 try{
 const chunks=await Promise.all(files.map(async name=>{
  const response=await fetch('./assets/'+name);
  if(!response.ok)throw new Error(name+' 载入失败 ('+response.status+')');
  return new Uint8Array(await response.arrayBuffer());
 }));
 const total=chunks.reduce((size,chunk)=>size+chunk.byteLength,0),data=new Uint8Array(total);
 let offset=0;for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.byteLength;}
 return loader.parseAsync(data.buffer,'./assets/');
 }catch(e){console.warn('High-detail model unavailable, using race model',id,e);return fallback();}
}
function dimensions(id){const b=fleet.cars[id].bounds,w=specs.get(id)?.wheels;return {halfLength:Math.max(Math.abs(b.min[0]),b.max[0]),halfWidth:Math.max(Math.abs(b.min[2]),b.max[2]),height:b.max[1],bottom:.20,wheelbase:w?Math.abs(w.FL.center_m[0]-w.BL.center_m[0]):2.8,trackWidth:w?Math.abs(w.FL.center_m[1]-w.FR.center_m[1]):1.62};}
function configureMaterials(root){const seen=new Set();root.traverse(o=>{if(!o.isMesh)return;for(const m of [].concat(o.material||[])){if(seen.has(m))continue;seen.add(m);if(m.map)m.map.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());m.envMapIntensity=.8;if(m.transmission>0){m.transmission=0;m.transparent=true;m.opacity=.18;m.depthWrite=false;}if(/mirror/i.test(m.name)){m.color.setHex(0x526876);m.metalness=.85;m.roughness=.18;m.envMapIntensity=.45;}if(m.transparent){m.depthWrite=false;m.side=THREE.DoubleSide;}if(m.normalScale)m.normalScale.multiplyScalar(.7);}});}
function disposeModel(root){const textures=new Set(),materials=new Set(),geometries=new Set();root.traverse(o=>{if(o.geometry)geometries.add(o.geometry);for(const m of [].concat(o.material||[])){materials.add(m);for(const value of Object.values(m))if(value?.isTexture)textures.add(value);}});for(const g of geometries)g.dispose();for(const m of materials)m.dispose();for(const t of textures){t.dispose();t.image?.close?.();}}
function addShadow(root){const c=document.createElement('canvas');c.width=c.height=64;const ctx=c.getContext('2d'),g=ctx.createRadialGradient(32,32,4,32,32,32);g.addColorStop(0,'rgba(0,0,0,.62)');g.addColorStop(1,'rgba(0,0,0,0)');ctx.fillStyle=g;ctx.fillRect(0,0,64,64);const mesh=new THREE.Mesh(new THREE.PlaneGeometry(5.6,3.2),new THREE.MeshBasicMaterial({map:new THREE.CanvasTexture(c),transparent:true,depthWrite:false}));mesh.rotation.x=-Math.PI/2;mesh.position.y=.028;root.add(mesh);return mesh;}
function addLights(){for(const z of [-.68,.68]){const light=new THREE.SpotLight(0xc7e4fa,100,72,.50,.65,1.25);light.position.set(1.8,.58,z);light.target.position.set(37,-.25,z);player.add(light,light.target);lighting.push(light);}addShadow(player);}
function gateDecor(g){const arch=new THREE.Group(),metal=new THREE.MeshStandardMaterial({color:0x172530,metalness:.65,roughness:.3});for(const side of [-1,1]){const pole=new THREE.Mesh(new THREE.BoxGeometry(.25,6,.25),metal);pole.position.set(0,3,side*(g.width+.6));arch.add(pole);}const bar=new THREE.Mesh(new THREE.BoxGeometry(.3,.45,g.width*2+1.5),metal);bar.position.y=6;arch.add(bar);const c=document.createElement('canvas');c.width=1024;c.height=128;const ctx=c.getContext('2d');ctx.fillStyle='#14232c';ctx.fillRect(0,0,1024,128);ctx.fillStyle='#ddff72';ctx.font='italic 900 75px Arial';ctx.textAlign='center';ctx.fillText('STORM.EXE',512,90);const texture=new THREE.CanvasTexture(c);texture.colorSpace=THREE.SRGBColorSpace;const sign=new THREE.Mesh(new THREE.PlaneGeometry(5.2,.65),new THREE.MeshBasicMaterial({map:texture,side:THREE.DoubleSide}));sign.rotation.y=-Math.PI/2;sign.position.set(-.17,6,0);arch.add(sign);arch.position.set(g.x,g.y,g.z);arch.rotation.y=-Math.atan2(g.fz,g.fx);scene.add(arch);}
async function selectCar(id){if(busy)return;busy=true;ready=false;$('start').disabled=true;$('demo-start').disabled=true;$('car').disabled=true;$('model-detail').disabled=true;$('reset-settings').disabled=true;setStatus('正在准备 '+names[ids.indexOf(id)]+'…',25);
 try{const old=hero;const gltf=await loadPlayerModel(id);configureMaterials(gltf.scene);if(old){player.remove(old);disposeModel(old);}selected=id;experience.selected(id);audio.setCar(id);hero=gltf.scene;player.add(hero);heroVisual=new VehicleVisual(hero,specs.get(id));glass.setCar(id);setStatus('正在排列发车阵容…',70);
  rivals.reset(id);for(const racer of rivals.racers)racer.state.dimensions=dimensions(racer.id);
  for(const [carId,r] of rivalModels)r.group.visible=carId!==id;
  for(const racer of rivals.racers){if(!rivalModels.has(racer.id)){const data=await loader.loadAsync('./assets/'+fleet.cars[racer.id].lod),group=new THREE.Group();configureMaterials(data.scene);group.add(data.scene);addShadow(group);scene.add(group);rivalModels.set(racer.id,{group,visual:new VehicleVisual(data.scene,specs.get(racer.id)),root:data.scene,passSign:0});}}
  state=newPlayerState(spawn,id);savedSafe={...spawn};$('car-name').textContent=names[ids.indexOf(id)];cameraSnap=true;setStatus('正在预热车漆、玻璃与座舱…',90);heroVisual.cockpit(true);await renderer.compileAsync(scene,camera);heroVisual.cockpit(false);await renderer.compileAsync(scene,camera);setCamera(initialView,false);ready=true;setStatus('赛道就绪 · C 切换镜头 / B 向后看',100);$('start-label').textContent='进入比赛';
 }finally{busy=false;$('start').disabled=!ready;$('car').disabled=false;$('model-detail').disabled=false;$('reset-settings').disabled=false;$('demo-start').disabled=!ready;}}
function resetRace(asDemo=false){
 demo=asDemo;driveInput={};adaptive.resetStats();lap.reset();rivals.reset(selected);rivals.setDifficulty(experience.settings.difficulty);rivals.setWetness(experience.settings.wetness);
 for(const racer of rivals.racers)racer.state.dimensions=dimensions(racer.id);
 state=newPlayerState(spawn);savedSafe={...spawn};demoDriver={id:selected,state,lap,index:1,routeS:-44,lane:0,desiredLane:0,topSpeed:65,cornerGrip:11.5};heroVisual?.reset(state);
 for(const racer of rivals.racers)rivalModels.get(racer.id)?.visual.reset(racer.state);
 countdown=3;mode='countdown';finishRanks=null;accumulator=0;keys.clear();experience.clearTouch();experience.begin(asDemo);
 $('menu').hidden=true;$('pause').hidden=true;$('finish').hidden=true;$('hud').hidden=false;setCamera(initialView,false);cameraSnap=true;$('demo-label').hidden=!demo;canvas.focus();
 audio.start().then(()=>{if(mode==='countdown')audio.cue('countdown');}).catch(console.warn);
}
function resetToRoad(){
 experience.recover();const next=lap.next,previous=next===0?lap.gates.length-1:next-1,progress=lap.started?route.gateDistances[previous]+5:-44,p=route.at(progress),h=road.sample(p.x,p.z,p.y);
 const pos=h===null?savedSafe:{x:p.x,y:h,z:p.z,yaw:Math.atan2(p.fz,p.fx)};state=newPlayerState(pos);savedSafe={...pos};
 if(demoDriver)Object.assign(demoDriver,{state,routeS:progress,lane:0,desiredLane:0});cameraSnap=true;notice('已回到道路 · 本圈不计成绩',1.5);
}
function notice(text,duration=1){$('callout').textContent=text;$('callout').style.fontSize=text.length>5?'clamp(16px,3vw,25px)':'clamp(36px,6vw,70px)';noticeTime=duration;}
function pause(){if(!['race','countdown'].includes(mode))return;$('pause').dataset.resume=mode;mode='paused';$('pause').hidden=false;keys.clear();experience.clearTouch();$('callout').textContent='';}
function resume(){if(mode!=='paused')return;experience.closeReplay(false);mode=$('pause').dataset.resume||'race';$('pause').hidden=true;keys.clear();last=performance.now();accumulator=0;canvas.focus();audio.ctx?.resume();}
function garage(){experience.closeReplay(false);experience.clearTouch();mode='menu';$('menu').hidden=false;$('hud').hidden=true;$('pause').hidden=true;$('finish').hidden=true;$('callout').textContent='';state=newPlayerState(spawn);keys.clear();heroVisual?.reset(state);heroVisual?.cockpit(false);document.body.classList.remove('cockpit');cameraSnap=true;}
function complete(){finishRanks=experience.settings.mode==='race'?rivals.standings(state,lap):[{id:selected,rank:1,player:true,finished:true,progress:route.length}];mode='finish';$('finish').hidden=false;$('finish-time').textContent=timeText(lap.time);const rank=finishRanks.find(r=>r.player).rank;$('finish-place').textContent=experience.settings.mode==='race'?'第 '+rank+' 名 / 4':'个人计时赛 · 完赛';experience.finish();keys.clear();experience.clearTouch();}
function input(){return experience.input(keys);}
function setCamera(value,notify=true){camMode=Number(value)%3;if(notify){initialView=camMode;experience.save('camera',camMode);}cameraSnap=true;heroVisual?.cockpit(camMode===1&&mode!=='menu');document.body.classList.toggle('cockpit',camMode===1&&mode!=='menu');$('camera-btn').textContent=cameraNames[(camMode+1)%3]+' [C]';if(notify)notice(cameraNames[camMode],.8);}
function simulate(dt){
 if(mode==='countdown'){countdown-=dt;notice(countdown>0?String(Math.ceil(countdown)):'GO',.5);if(countdown<=0)mode='race';return;}if(mode!=='race')return;
 const start=performance.now(),before={x:state.x,y:state.y,z:state.z},racers=activeRacers();
 if(demo){demoDriver.state=state;driveInput=rivals.controls(demoDriver,[...racers.map(r=>r.state),state],dt);driveInput.wetness=experience.settings.wetness;driveInput.assist=experience.settings.assist;}else driveInput=input();
 drive(state,driveInput,dt,road,collision);
 if(racers.length){rivals.step(dt,state,lap,{deferGates:true});resolveCars([state,...racers.map(r=>r.state)],collision);rivals.finalizeStep();}
 if(state.offroad>1.3){resetToRoad();return;}if(!state.offroad&&!state.contact&&Math.abs(state.speed)<35)savedSafe={x:state.x,y:state.y,z:state.z,yaw:state.yaw};
 if(state.contact?.impact>2&&elapsed-impactTime>.25){impactTime=elapsed;experience.hit();weather.impact(state,state.contact.impact);audio.impact?.(clamp(state.contact.impact/20,0,1));}
 const passed=lap.step(before,state,dt);experience.record(dt);
 if(passed&&lap.finished)complete();else if(passed){if(lap.next===1)notice('FLYING LAP',.65);audio.cue('checkpoint');}
 physicsMs+=(performance.now()-start-physicsMs)*.01;
}
function updateCars(dt){
 if(mode!=='race'&&!experience.replaying)dt=0;
 const shown=experience.replayPose||state;player.position.set(shown.x,shown.y+.035,shown.z);player.rotation.y=-shown.yaw;heroVisual?.update(shown,dt,shown.brake||0,road);
 for(const object of rivalModels.values())object.group.visible=false;
 for(const racer of activeRacers()){
  const object=rivalModels.get(racer.id);if(!object)continue;const s=experience.replaying?(experience.rivalReplays.get(racer.id)?.sample(experience.replayAgo)||racer.state):racer.state;
  object.group.position.set(s.x,s.y+.035,s.z);object.group.rotation.y=-s.yaw;object.group.visible=mode==='menu'||Math.hypot(s.x-shown.x,s.z-shown.z)<380;object.visual.update(s,dt,s.brake||0,road);
  if(mode==='race'){const dx=s.x-state.x,dz=s.z-state.z,ahead=dx*Math.cos(state.yaw)+dz*Math.sin(state.yaw);if(object.passSign*ahead<0&&Math.hypot(dx,dz)<9&&Math.abs(s.speed-state.speed)>4)audio.passBy?.((-dx*Math.sin(state.yaw)+dz*Math.cos(state.yaw))>0?1:-1,Math.abs(s.speed-state.speed));object.passSign=ahead;}
 }
}
function updateCamera(dt){
 const pose=experience.replayPose||state,co=Math.cos(pose.yaw),si=Math.sin(pose.yaw),speed=Math.abs(pose.speed),prefs=experience.settings,motion=prefs.reducedMotion?0:prefs.motion,view=experience.replaying?0:camMode,behind=experience.lookBack&&!experience.replaying;
 camera.up.set(0,1,0);heroVisual?.cockpit(view===1&&!behind&&mode!=='menu'&&mode!=='loading');document.body.classList.toggle('cockpit',view===1&&!behind&&mode!=='menu'&&mode!=='loading');
 if(mode==='menu'||mode==='loading'){
  orbit+=dt*.04*motion;const a=pose.yaw-2.45+Math.sin(orbit)*.1;targetCamera.set(pose.x+Math.cos(a)*7.8,pose.y+2.5,pose.z+Math.sin(a)*7.8);targetLook.set(pose.x,pose.y+.7,pose.z);camera.fov=48;camera.near=.08;camera.setViewOffset(innerWidth,innerHeight,-innerWidth*(innerWidth>750?.17:0),innerWidth<750?-innerHeight*.12:0,innerWidth,innerHeight);
 }else{
  camera.clearViewOffset();
  if(view===1&&hero&&!behind){const cabin=fleet.cars[selected].cockpit;hero.updateWorldMatrix(true,false);targetCamera.fromArray(cabin.eye).applyMatrix4(hero.matrixWorld);targetLook.fromArray(cabin.lookTarget).applyMatrix4(hero.matrixWorld);camera.up.set(0,1,0).transformDirection(hero.matrixWorld);camera.fov=cabin.fov+Math.min(speed/80,1)*3*motion;camera.near=.025;targetCamera.y+=Math.sin(elapsed*29)*Math.min(.007,speed*.0001)*motion;targetLook.x+=-si*(pose.lateralG||0)*.25*motion;targetLook.z+=co*(pose.lateralG||0)*.25*motion;}
  else if(view===2&&!behind){targetCamera.set(pose.x+co*1.05,pose.y+.97,pose.z+si*1.05);targetLook.set(pose.x+co*30,pose.y+1+(pose.pitch||0)*30,pose.z+si*30);camera.fov=75;camera.near=.04;}
  else{const dist=7.7+Math.min(speed/35,1.3),direction=behind?-1:1,lean=clamp(pose.lateralG||0,-1.6,1.6)*motion*.45;targetCamera.set(pose.x-co*dist*direction-si*lean,pose.y+3.05+(pose.longitudinalG||0)*motion*.12,pose.z-si*dist*direction+co*lean);targetLook.set(pose.x+co*(6+speed*.1)*direction,pose.y+.85+(pose.pitch||0)*6,pose.z+si*(6+speed*.1)*direction);const safe=collision.constrainCamera({x:pose.x,y:pose.y+1.2,z:pose.z},targetCamera,.25);targetCamera.set(safe.x,safe.y,safe.z);camera.fov+=(prefs.fov+Math.min(speed/70,1)*5*motion-camera.fov)*(1-Math.exp(-3*dt));camera.near=.08;}
 }
 if(cameraSnap||view===1&&mode!=='menu'||behind){camera.position.copy(targetCamera);cameraLook.copy(targetLook);cameraSnap=false;}
 else{camera.position.lerp(targetCamera,1-Math.exp(-9*dt));cameraLook.lerp(targetLook,1-Math.exp(-11*dt));if(view===0&&mode!=='menu'){const safe=collision.constrainCamera({x:pose.x,y:pose.y+1.2,z:pose.z},camera.position,.2);camera.position.set(safe.x,safe.y,safe.z);}}
 camera.lookAt(cameraLook);camera.updateProjectionMatrix();glass.update(dt,speed,view===1&&!behind&&mode!=='menu'&&mode!=='loading',sheltered);
}
function mini(){
 const c=$('minimap').getContext('2d'),{minx,minz,scale}=miniBounds,p=g=>[20+(g.x-minx)*scale,20+(g.z-minz)*scale];c.clearRect(0,0,220,220);c.lineWidth=3;c.strokeStyle='#7892a088';c.lineJoin='round';c.beginPath();route.points.forEach((g,i)=>{const [x,z]=p(g);i?c.lineTo(x,z):c.moveTo(x,z);});c.closePath();c.stroke();
 for(const r of activeRacers()){const [x,z]=p(r.state);c.fillStyle='#ffbc78';c.beginPath();c.arc(x,z,2.3,0,Math.PI*2);c.fill();}
 const [gx,gz]=p(lap.gates[lap.next]);c.strokeStyle='#a4f3ff';c.lineWidth=2;c.beginPath();c.arc(gx,gz,5,0,Math.PI*2);c.stroke();
 const [x,z]=p(experience.replayPose||state);c.save();c.translate(x,z);c.rotate((experience.replayPose||state).yaw);c.fillStyle='#ddff72';c.beginPath();c.moveTo(6,0);c.lineTo(-4,-4);c.lineTo(-2,0);c.lineTo(-4,4);c.closePath();c.fill();c.restore();
}
function hud(){
 $('speed').textContent=String(Math.round(Math.abs(state.speed)*3.6)).padStart(3,'0');$('timer').textContent=timeText(lap.time);$('gate').innerHTML=String(lap.passed).padStart(2,'0')+' <span>/ '+lap.gates.length+'</span>';
 const solo=experience.settings.mode==='time-trial';lastStandings=finishRanks||(solo?[{id:selected,rank:1,player:true,progress:route.legalProgress(state,lap)}]:rivals.standings(state,lap));const entry=lastStandings.find(r=>r.player);
 $('position').innerHTML=solo?'— <span>/ SOLO</span>':entry.rank+' <span>/ 4</span>';$('leaderboard').hidden=solo;$('radar').hidden=solo;
 $('leaderboard').innerHTML=lastStandings.map(r=>'<li class="'+(r.player?'player':'')+'"><b>'+r.rank+'</b>'+names[ids.indexOf(r.id)]+'<span>'+(r.player?'YOU':r.finished?'FINISH':(r.progress-entry.progress>=0?'+':'−')+Math.round(Math.abs(r.progress-entry.progress))+'m')+'</span></li>').join('');
 $('progress').textContent=Math.round(clamp(entry.progress/route.length,0,1)*100)+'%';$('fps').textContent=Math.round(fps)+' FPS';mini();experience.hud();
 const stats=adaptive.stats();canvas.dataset.fps=fps.toFixed(1);canvas.dataset.p95=stats.p95.toFixed(1);canvas.dataset.drawCalls=String(stats.drawCalls);canvas.dataset.triangles=String(stats.triangles);canvas.dataset.renderScale=stats.scale.toFixed(2);canvas.dataset.physicsMs=physicsMs.toFixed(2);canvas.dataset.stutters=String(stats.stutters);canvas.dataset.worstMs=stats.worst.toFixed(1);canvas.dataset.demo=String(demo);canvas.dataset.sheltered=String(sheltered);canvas.dataset.averageFps=stats.averageFps.toFixed(1);canvas.dataset.raceSeconds=stats.seconds.toFixed(1);canvas.dataset.camera=cameraNames[camMode];canvas.dataset.mode=mode;
}
function updateShelter(dt){shelterElapsed+=dt;if(shelterElapsed<.2)return;shelterElapsed=0;const view=experience.replayPose||state,from={x:view.x,y:view.y+1.7,z:view.z},to={x:view.x,y:view.y+30,z:view.z};sheltered=collision.constrainCamera(from,to,.05).y<view.y+29;audio.sheltered=sheltered;}
function animate(now){requestAnimationFrame(animate);if(!state||mode==='error')return;const interval=mode==='paused'||mode==='finish'?100:mode==='menu'?32:0;if(now-lastDraw<(experience.replaying?0:interval))return;lastDraw=now;const raw=(now-last)/1000;last=now;if(document.hidden){accumulator=0;return;}const dt=Math.min(raw,.0667);elapsed+=dt;frameCount++;frameSeconds+=Math.max(0,raw);if(frameSeconds>.7){fps=frameCount/frameSeconds;frameCount=frameSeconds=0;}if(mode==='race')adaptive.update(raw);experience.tick(dt);accumulator+=dt;let steps=0;while(accumulator>=1/120&&steps<8){simulate(1/120);accumulator-=1/120;steps++;}if(steps===8)accumulator=0;updateCars(dt);updateShelter(dt);updateCamera(dt);weather.update(dt,experience.replayPose||state,[{state,wheels:specs.get(selected)?.wheels},...activeRacers().map(r=>({state:r.state,wheels:specs.get(r.id)?.wheels}))],mode==='race',sheltered);audio.update(Math.abs(state.speed),state.throttle||0,!['race','countdown'].includes(mode),state);
 flashTimer-=dt;if(experience.settings.reducedMotion||experience.settings.wetness<.6)flash=0;if(flashTimer<0&&!experience.settings.reducedMotion&&experience.settings.wetness>=.6){flash=.21;flashTimer=14+Math.random()*13;if(mode==='race')audio.thunder();}flash=Math.max(0,flash-dt);sun.intensity=(experience.settings.wetness<.1?3.1:2.25)+(flash>.14?4:flash>.07?0:flash>0?2.5:0);noticeTime-=dt;if(noticeTime<=0&&mode!=='countdown')$('callout').textContent='';uiTime+=dt;if(uiTime>.15){hud();uiTime=0;}renderer.render(scene,camera);
}
async function init(){renderer=new THREE.WebGLRenderer({canvas,antialias:true,powerPreference:'high-performance'});renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.12;scene=new THREE.Scene();scene.background=new THREE.Color(0x132332);scene.fog=new THREE.FogExp2(0x132332,.0041);camera=new THREE.PerspectiveCamera(62,innerWidth/innerHeight,.08,1300);adaptive=new AdaptiveQuality(renderer);adaptive.set(quality);pmrem=new THREE.PMREMGenerator(renderer);const room=new RoomEnvironment();scene.environment=pmrem.fromScene(room,.025).texture;room.dispose();scene.environmentIntensity=.48;scene.add(new THREE.HemisphereLight(0xb5d8f3,0x172636,1.9));sun=new THREE.DirectionalLight(0xc1d9f0,2.25);sun.position.set(-60,180,80);scene.add(sun);audio=new StormAudio();glass=new CockpitGlass($('glass-fx'));setStatus('准备道路碰撞与竞速路线…',8);
 const [track,triangles,race,routeData,fleetData,colliderData]=await Promise.all([loader.loadAsync('./assets/RockyPass.glb'),json('assets/road.json'),json('assets/race.json'),json('assets/ai-route.json'),json('assets/fleet.json'),json('assets/collision.json')]);fleet=fleetData;for(const id of ids)specs.set(id,await json('assets/'+fleet.cars[id].spec));surfaceMaps={asphalt:null,rock:null};const seen=new Set();track.scene.traverse(o=>{if(o.isMesh)for(const m of [].concat(o.material||[])){if(!seen.has(m)){seen.add(m);detailMaterial(m,surfaceMaps);if(m.map)m.map.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());}}});const preparedTrack=prepareTrack(track.scene,scene);renderMeshes=preparedTrack.renderMeshes;canvas.dataset.correctedRoadTriangles=String(preparedTrack.correctedTriangles);
 road=new RoadSurface(triangles);route=new RaceRoute(routeData);const gates=race.gates.map(g=>({x:g.location_cm[0]/100,y:g.location_cm[2]/100,z:g.location_cm[1]/100,fx:g.forward[0],fz:g.forward[1],width:g.pavement_width_m/2}));collision=new CollisionWorld([...(Array.isArray(colliderData)?colliderData:colliderData.triangles),...gateCollisionTriangles(gates[0])]);lap=new Lap(gates);const p=route.at(-44),y=road.sample(p.x,p.z,p.y);if(y===null)throw new Error('发车点没有有效地面');spawn={x:p.x,y,z:p.z,yaw:Math.atan2(p.fz,p.fx)};state=newPlayerState(spawn);savedSafe={...spawn};rivals=new RivalRace({route,gates,road,playerId:selected,spawn,collision,carDimensions:Object.fromEntries(ids.map(id=>[id,dimensions(id)]))});
 const xs=route.points.map(p=>p.x),zs=route.points.map(p=>p.z);miniBounds={minx:Math.min(...xs),minz:Math.min(...zs),scale:180/Math.max(Math.max(...xs)-Math.min(...xs),Math.max(...zs)-Math.min(...zs))};player=new THREE.Group();scene.add(player);addLights();gateDecor(gates[0]);weather=new WeatherFX(scene);experience.attach(scene);applyExperienceSettings(experience.settings,'init');camera.position.set(state.x-7,state.y+3,state.z+5);cameraLook.set(state.x,state.y+.7,state.z);requestAnimationFrame(animate);await selectCar(selected);mode='menu';canvas.dataset.surfaceDetails='loading';
 // Optional 19 MB surface maps stream after the cars are ready, so a slow
 // connection never delays the start button or permanently loses late detail.
 loadSurfaceMaps(renderer,{timeoutMs:45000,attempts:2}).then(maps=>{surfaceMaps=maps;for(const material of seen){detailMaterial(material,maps);material.needsUpdate=true;}canvas.dataset.surfaceDetails=maps.asphalt&&maps.rock?'full':maps.asphalt||maps.rock?'partial':'base';}).catch(error=>{canvas.dataset.surfaceDetails='base';console.warn('Optional surface detail unavailable',error);});
}
$('demo-start').onclick=()=>{if(ready&&!busy)resetRace(true);};$('start').onclick=()=>{if(ready&&!busy)resetRace();};$('car').onchange=e=>selectCar(e.target.value).catch(fail);$('sound').onclick=()=>audio.setEnabled(!audio.enabled);$('camera-btn').onclick=()=>setCamera(camMode+1);$('pause-btn').onclick=pause;$('resume').onclick=resume;$('restart').onclick=()=>resetRace(demo);$('again').onclick=()=>resetRace(demo);$('garage').onclick=garage;$('finish-garage').onclick=garage;$('fullscreen-btn').onclick=()=>{if(document.fullscreenElement)document.exitFullscreen();else document.documentElement.requestFullscreen().catch(()=>notice('可使用浏览器全屏按钮',1));};
document.querySelector('.brand').onclick=e=>{e.preventDefault();if(ready)garage();};window.addEventListener('resize',()=>{if(!renderer)return;adaptive.resize();camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();glass.resize();});
window.addEventListener('keydown',e=>{if(e.code==='Escape'){if(experience.replaying)experience.closeReplay();else mode==='paused'?resume():pause();return;}if(['INPUT','SELECT','TEXTAREA','BUTTON'].includes(e.target.tagName))return;if(['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code))e.preventDefault();if(e.repeat)return;if(e.code==='KeyR'&&mode==='race')resetToRoad();if(e.code==='KeyC'&&['race','countdown','paused'].includes(mode))setCamera(camMode+1);if(e.code==='KeyV'){glass.enabled=!glass.enabled;notice('雨刷 '+(glass.enabled?'开启':'关闭'),.7);}keys.add(e.code);});window.addEventListener('keyup',e=>keys.delete(e.code));window.addEventListener('blur',()=>{keys.clear();pause();});document.addEventListener('visibilitychange',()=>{if(document.hidden){keys.clear();pause();}});for(const b of document.querySelectorAll('[data-key]')){b.addEventListener('pointerdown',e=>{e.preventDefault();b.setPointerCapture(e.pointerId);keys.add(b.dataset.key);});for(const ev of ['pointerup','pointercancel','lostpointercapture'])b.addEventListener(ev,()=>keys.delete(b.dataset.key));}
canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();pause();fail(new Error('图形资源暂时不足，请关闭其他游戏页面后重试。'));});init().catch(fail);
