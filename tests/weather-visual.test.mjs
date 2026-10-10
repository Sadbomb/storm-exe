import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
const root=new URL('../public/',import.meta.url);
registerHooks({resolve(specifier,context,next){
 if(specifier==='three')return {url:new URL('vendor/three/build/three.module.js',root).href,shortCircuit:true};
 return next(specifier,context);
}});
const THREE=await import('three');
const {WeatherFX,CockpitGlass,VehicleVisual}=await import('../public/effects.js');
const {detailMaterial}=await import('../public/render-world.js');
function canvas(){
 const context={ellipses:0,clears:0,createRadialGradient:()=>({addColorStop(){}}),clearRect(){this.clears++;},ellipse(){this.ellipses++;},fillRect(){},save(){},restore(){},beginPath(){},moveTo(){},lineTo(){},closePath(){},clip(){},stroke(){}};
 return {width:1280,height:720,hidden:false,getContext:()=>context};
}
globalThis.document={createElement:()=>canvas()};globalThis.innerWidth=1280;globalThis.innerHeight=720;
const player={x:0,y:0,z:0,speed:30,vx:30,vz:0,yaw:0};

test('dry weather removes rain and spray immediately while collision sparks remain',()=>{
 const effects=new WeatherFX(new THREE.Scene());effects.setWetness(1);
 for(let i=0;i<60;i++)effects.update(1/60,player,[{state:player}]);
 assert.ok(effects.cursor>100);assert.ok(effects.rain.visible);assert.ok(effects.spray.visible);
 effects.setWetness(0);const before=effects.cursor;effects.update(1/60,player,[{state:player}]);
 assert.equal(effects.rain.geometry.drawRange.count,0);assert.equal(effects.rain.visible,false);assert.equal(effects.spray.visible,false);
 assert.equal(effects.cursor,before);assert.ok(effects.particles.every(p=>p.age>p.life));
 effects.impact(player,8);assert.ok(effects.sparkCursor>0,'weather does not disable impact sparks');
});

test('rain density follows weather and quality, shelter hides rain, and spray is frame-rate independent',()=>{
 const effects=new WeatherFX(new THREE.Scene());effects.setWetness(.4);const drizzle=effects.rain.geometry.drawRange.count;
 effects.setWetness(.85);const storm=effects.rain.geometry.drawRange.count;effects.setQuality('high');
 assert.ok(drizzle>0&&storm>drizzle*1.8);assert.ok(effects.rain.geometry.drawRange.count>storm);
 effects.update(1/60,player,[],true,true);assert.equal(effects.rain.visible,false);
 effects.update(1/60,player,[],true,false);assert.equal(effects.rain.visible,true);
 const counts=[30,60,120].map(hz=>{const e=new WeatherFX(new THREE.Scene());e.setWetness(.4);for(let i=0;i<hz;i++)e.update(1/hz,player,[{state:player}]);return e.cursor;});
 assert.ok(Math.max(...counts)-Math.min(...counts)<=1,JSON.stringify(counts));
});

test('dry cockpit clears drops and parks wipers without overriding the user wiper setting',()=>{
 const c=canvas(),glass=new CockpitGlass(c);glass.setWetness(.85);glass.update(.1,30,true);
 assert.equal(c.hidden,false);assert.ok(glass.phase>0);assert.ok(c.getContext().ellipses>0);
 glass.setWetness(0);assert.equal(c.hidden,true);const clears=c.getContext().clears;glass.update(.1,30,true);
 assert.equal(glass.phase,0);assert.equal(glass.enabled,true);assert.equal(c.getContext().clears,clears);
 glass.enabled=false;glass.setWetness(.4);glass.update(.1,30,true);assert.equal(glass.enabled,false);assert.equal(glass.phase,0);
 glass.enabled=true;glass.update(.1,30,true);assert.ok(glass.phase>0);
 for(let i=0;i<100;i++)glass.update(.1,20,true,true);
 assert.equal(glass.phase,0,'wipers park after residual drops clear under shelter');
});

test('dry and wet detail shaders share the live uniform object and fallback keeps the atlas',()=>{
 const maps={asphalt:[new THREE.Texture(),new THREE.Texture(),new THREE.Texture()],rock:null},material=new THREE.MeshStandardMaterial({map:new THREE.Texture()});material.name='WetRoad';detailMaterial(material,maps);
 const shader={uniforms:{},vertexShader:'#include <common>\n#include <worldpos_vertex>',fragmentShader:'#include <common>\n#include <map_fragment>\n#include <normal_fragment_maps>\n#include <roughnessmap_fragment>'};
 material.onBeforeCompile(shader);
 assert.equal(shader.uniforms.stormWetness,material.userData.stormWetness);
 assert.match(shader.fragmentShader,/uniform float stormWetness/);assert.match(shader.fragmentShader,/mix\(dryRough,wetRough/);
 material.userData.stormWetness.value=0;const roughDry=material.roughness,reflectionDry=material.envMapIntensity;
 material.userData.stormWetness.value=.85;assert.ok(material.roughness<roughDry-.4);assert.ok(material.envMapIntensity>reflectionDry);
 assert.equal(shader.uniforms.stormWetness.value,.85);
 const fallback=new THREE.MeshStandardMaterial({map:new THREE.Texture()});fallback.name='WetRoad';const atlas=fallback.map,compile=fallback.onBeforeCompile;detailMaterial(fallback,{asphalt:null,rock:null});
 fallback.userData.stormWetness.value=0;assert.ok(fallback.roughness>.8);fallback.userData.stormWetness.value=1;assert.ok(fallback.roughness<.3);
 assert.equal(fallback.map,atlas);assert.equal(fallback.onBeforeCompile,compile);
});

test('visible steering, shift response, brake lights and body attitude use physical telemetry',()=>{
 const root=new THREE.Group(),wheel=new THREE.Object3D(),steering=new THREE.Object3D();wheel.name='Wheel_FL';steering.name='SteeringWheel';
 const light=new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshStandardMaterial({emissive:0x110000}));light.material.name='BrakeLight';root.add(wheel,steering,light);
 const visual=new VehicleVisual(root),state={speed:0,steer:.1,steerAngle:.3,gear:3,longitudinalG:-1,lateralG:1,brake:.8};
 visual.update(state,.1);
 assert.ok(Math.abs(new THREE.Euler().setFromQuaternion(wheel.quaternion).y+.3)<1e-8,'wheel uses actual corrective angle');
 assert.equal(visual.gear,3);assert.equal(visual.gearKick,0,'entering a state does not invent a shift');assert.ok(root.rotation.z<0&&root.rotation.x<0);
 assert.equal(light.material.emissiveIntensity,1.2);
 visual.update({...state,gear:4},.1);assert.ok(visual.gearKick<0,'real upshift unloads the nose briefly');
 visual.update({...state,gear:-1,brake:1},.1);assert.equal(light.material.emissiveIntensity,1,'reverse accelerator restores the original tail-light intensity');
});

test('minimal replay poses and missing telemetry keep every vehicle transform finite',()=>{
 const root=new THREE.Group(),wheel=new THREE.Object3D(),steering=new THREE.Object3D();wheel.name='Wheel_FL';steering.name='SteeringWheel';root.add(wheel,steering);
 const visual=new VehicleVisual(root,{wheels:{FL:{radius_cm:0}}});
 for(let i=0;i<120;i++)visual.update({x:i,y:0,z:0,yaw:.2,speed:25,t:i/60,p:i},1/60);
 const check=()=>{root.updateMatrixWorld(true);root.traverse(object=>assert.ok(object.matrixWorld.elements.every(Number.isFinite),object.name+' matrix must remain finite'));};
 check();assert.equal(visual.roll,0);assert.ok(wheel.quaternion.toArray().every(Number.isFinite));
 visual.update({speed:NaN,steer:Infinity,steerAngle:NaN,pitch:Infinity,roll:NaN,longitudinalG:NaN,lateralG:Infinity},NaN,NaN);check();
 visual.update();visual.update(null,1/60);visual.reset({speed:Infinity,pitch:NaN,roll:Infinity});check();
});

test('repeated cockpit updates do not invalidate materials, while view changes restore glass',()=>{
 const root=new THREE.Group(),material=new THREE.MeshStandardMaterial({opacity:.4,transparent:true,depthWrite:true});material.name='EXT_Windows';
 const glass=new THREE.Mesh(new THREE.BoxGeometry(),material),sunstrip=new THREE.Object3D();sunstrip.name='CockpitSunstrip';root.add(glass,sunstrip);
 const visual=new VehicleVisual(root);visual.cockpit(true);const cockpitVersion=material.version;
 assert.equal(material.opacity,.025);assert.equal(material.depthWrite,false);assert.equal(sunstrip.visible,false);
 for(let i=0;i<120;i++)visual.cockpit(true);
 assert.equal(material.version,cockpitVersion,'unchanged cockpit frames must not recompile glass');
 visual.cockpit(false);const exteriorVersion=material.version;
 assert.equal(exteriorVersion,cockpitVersion+1);assert.equal(material.opacity,.4);assert.equal(material.transparent,true);assert.equal(material.depthWrite,true);assert.equal(sunstrip.visible,true);
 for(let i=0;i<120;i++)visual.cockpit(false);
 assert.equal(material.version,exteriorVersion);
});
