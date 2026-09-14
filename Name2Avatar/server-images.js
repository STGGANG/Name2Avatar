import {isServerImage,normalizeServerImage} from './core.js';
export async function uploadPortrait(data,getHeaders,fetcher=fetch,baseURL=globalThis.location?.href){
  if(isServerImage(data)||!data)return data;
  const match=/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(data);
  if(!match)throw new Error('지원하지 않는 사진 형식입니다.');
  if(typeof getHeaders!=='function')throw new Error('ST 이미지 저장 API를 사용할 수 없어요. ST를 업데이트해 주세요.');
  const filename=`sp-${globalThis.crypto?.randomUUID?.()??`${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
  const response=await fetcher('/api/images/upload',{method:'POST',credentials:'same-origin',headers:getHeaders(),
    body:JSON.stringify({image:match[2],format:match[1],ch_name:'speaker-portraits',filename}),signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error(`ST 사진 저장 실패 (${response.status}). 기존 등록은 유지됩니다.`);
  const result=await response.json();
  const path=normalizeServerImage(typeof result==='string'?result:result.path,baseURL);
  if(!path)throw new Error('ST가 지원하지 않는 이미지 주소를 반환했습니다. 외부 주소·파일시스템 경로는 안전을 위해 연결하지 않았습니다.');
  return path;
}

export async function portableImage(value,fetcher=fetch){
  if(!isServerImage(value))return value;
  const response=await fetcher(value,{credentials:'same-origin',signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error(`백업 사진을 읽지 못했어요 (${response.status}).`);
  if(Number(response.headers.get('content-length'))>6000000)throw new Error('백업 사진이 너무 큽니다.');
  const bytes=new Uint8Array(await response.arrayBuffer());
  if(bytes.length>6000000)throw new Error('백업 사진이 너무 큽니다.');
  let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
  const format=value.split('.').at(-1);
  return `data:image/${format};base64,${btoa(binary)}`;
}
