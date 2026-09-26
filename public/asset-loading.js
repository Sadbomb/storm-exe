// Browser image loaders reject with an Event, which has no useful message.
export function describeError(error){
 if(error?.message)return error.message;
 if(typeof error==='string')return error;
 const source=error?.target?.currentSrc||error?.target?.src;
 if(source)return '资源加载失败：'+source;
 if(error?.type)return '浏览器资源事件：'+error.type;
 return '未知错误，请检查网络连接或浏览器控制台';
}

export function loadTexture(loader,url,{timeoutMs=8000,attempts=2}={}){
 const attempt=()=>new Promise((resolve,reject)=>{
  let settled=false;
  const timer=setTimeout(()=>finish(new Error(url+' 加载超时')),timeoutMs);
  function finish(error,texture){
   if(settled){texture?.dispose();return;}
   settled=true;clearTimeout(timer);
   if(error)reject(new Error(url+'：'+describeError(error),{cause:error}));
   else resolve(texture);
  }
  try{loader.load(url,texture=>finish(null,texture),undefined,error=>finish(error));}
  catch(error){finish(error);}
 });
 return (async()=>{
  for(let i=0;i<attempts;i++){
   try{return await attempt();}catch(error){if(i===attempts-1)throw error;}
  }
 })();
}
