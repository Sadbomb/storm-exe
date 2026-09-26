import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {readFileSync,existsSync} from 'node:fs';
const root=new URL('../public/',import.meta.url);
registerHooks({resolve(specifier,context,next){
 if(specifier==='three')return {url:new URL('vendor/three/build/three.module.js',root).href,shortCircuit:true};
 return next(specifier,context);
}});
const THREE=await import('three');
const {describeError,loadTexture}=await import('../public/asset-loading.js');
const {loadSurfaceMaps,detailMaterial}=await import('../public/render-world.js');

test('browser Events produce readable diagnostics, including the failed URL',()=>{
 assert.match(describeError({type:'error',target:{src:'https://example.test/assets/rock.jpg'}}),/rock.jpg/);
 assert.equal(describeError(new Error('HTTP 404')),'HTTP 404');
 assert.equal(describeError('Network offline'),'Network offline');
 assert.doesNotMatch(describeError(new Event('error')),/\[object Event\]/);
 assert.doesNotMatch(describeError(null),/null|undefined/);
});
test('transient image failure retries and returns the successful texture',async()=>{
 let calls=0;const texture={};
 const loader={load(url,ok,progress,fail){if(++calls===1)fail(new Event('error'));else ok(texture);}};
 assert.equal(await loadTexture(loader,'road.jpg'),texture);assert.equal(calls,2);
});
test('permanent image failure retains asset name and stops after two attempts',async()=>{
 let calls=0;const loader={load(url,ok,progress,fail){calls++;fail(new Event('error'));}};
 await assert.rejects(loadTexture(loader,'missing.jpg'),/missing.jpg.*error/);assert.equal(calls,2);
});
test('hung image requests time out; textures arriving later are disposed',async()=>{
 const callbacks=[];let disposed=0;
 const loader={load(url,ok){callbacks.push(ok);}};
 await assert.rejects(loadTexture(loader,'slow.jpg',{timeoutMs:5}),/slow.jpg.*超时/);
 assert.equal(callbacks.length,2);
 for(const ok of callbacks)ok({dispose(){disposed++;}});
 assert.equal(disposed,2);
});
test('partial surface failure disposes its group and preserves the base atlas',async()=>{
 const original=THREE.TextureLoader.prototype.load;const allocated=[];
 THREE.TextureLoader.prototype.load=function(url,ok,progress,fail){
  if(url.includes('asphalt-normal')){fail(new Event('error'));return;}
  const texture=new THREE.Texture();texture.userData.url=url;texture.userData.disposed=false;
  texture.addEventListener('dispose',()=>{texture.userData.disposed=true;});allocated.push(texture);ok(texture);
 };
 try{
  const maps=await loadSurfaceMaps({capabilities:{getMaxAnisotropy:()=>16}});
  assert.equal(maps.asphalt,null);assert.equal(maps.rock.length,3);
  assert.ok(allocated.filter(t=>t.userData.url.includes('asphalt')).every(t=>t.userData.disposed));
  assert.ok(maps.rock.every(t=>!t.userData.disposed&&t.anisotropy===8));
  assert.equal(maps.rock[0].colorSpace,THREE.SRGBColorSpace);
  const atlas=new THREE.Texture(),material=new THREE.MeshStandardMaterial({map:atlas});material.name='WetRoad';
  const shader=material.onBeforeCompile;detailMaterial(material,maps);
  assert.equal(material.map,atlas);assert.equal(material.onBeforeCompile,shader);
 }finally{THREE.TextureLoader.prototype.load=original;}
});
test('every active model reference exists and medium chunks form a complete GLB',()=>{
 const fleet=JSON.parse(readFileSync(new URL('assets/fleet.json',root)));
 for(const [id,car] of Object.entries(fleet.cars)){
  for(const name of [car.lod,car.spec,...(car.mediumParts||[])])assert.ok(existsSync(new URL('assets/'+name,root)),name);
  const files=car.mediumParts?.length?car.mediumParts:[car.lod];
  const model=Buffer.concat(files.map(name=>readFileSync(new URL('assets/'+name,root))));
  assert.equal(model.toString('ascii',0,4),'glTF',id);
  assert.equal(model.readUInt32LE(8),model.length,id+' must not be truncated');
 }
});
