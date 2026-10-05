import { DEFAULT_SETTINGS, DEFAULT_DIALOGUE_PROMPT, DEFAULT_DIALOGUE_PROMPT_B, normalizeName, parseNames, isServerImage } from './core.js?v=1.2.3';
import { syncDialoguePrompt } from './prompt.js?v=1.2.3';
import { createRenderer, makeAvatar, applyCrop, decorateLine, resetQuotes } from './renderer.js?v=1.2.3';
import { createChatRenderer } from './chat-renderer.js?v=1.2.3';
import { sanitizeStore, getActiveScope, allProfiles, savePerson, removePerson } from './scopes.js?v=1.2.3';
import { bindCropDrag } from './crop.js?v=1.2.3';
import { FONT_OPTIONS, applyTypography } from './typography.js?v=1.2.3';
import {uploadPortrait,portableImage,portableSourceGif} from './server-images.js?v=1.2.3';

// Keep the v1 storage key and profile IDs so existing names and photos survive upgrades.
const KEY='speaker_portraits_v1';
const ctx=()=>SillyTavern.getContext();
const uid=()=>globalThis.crypto?.randomUUID?.()??`sp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
let store,storageId,panel,draft=null,original=null,activeScope=null,renderer,chatRenderer,observer,timer=null;
let needsReset=false,imagesReady=false,saveQueue=Promise.resolve();
let storedImageKey=null,librarySignature=null,libraryRows=[],sourcesCache=null;
let portraitsHidden=false;
// Keep edits for both prompt presets in memory while the drawer is open.
const promptDrafts=new Map();
let promptBusy=false;

const database=new Promise((resolve,reject)=>{
  const request=indexedDB.open('st-speaker-portraits',1);
  request.onupgradeneeded=()=>request.result.createObjectStore('images');
  request.onsuccess=()=>resolve(request.result);
  request.onerror=()=>reject(request.error);
});
database.catch(()=>{});
async function imageStore(value){
  const db=await database;
  return new Promise((resolve,reject)=>{
    const writing=value!==undefined;
    const transaction=db.transaction('images',writing?'readwrite':'readonly');
    const bucket=transaction.objectStore('images');
    const request=writing?bucket.put(value,storageId):bucket.get(storageId);
    transaction.oncomplete=()=>resolve(request.result??{});
    transaction.onerror=()=>reject(transaction.error);
    transaction.onabort=()=>reject(transaction.error??new Error('이미지 저장이 중단되었습니다.'));
  });
}
function profileImage(person){
  if(person?.photoSource)return ctx().getThumbnailUrl(person.photoSource.type,person.photoSource.file);
  return person?.image??'';
}
// ST keeps persona names in settings even after the avatar file is gone; hide those.
let userAvatars=null;
async function refreshUserAvatars(){
  try{
    const response=await fetch('/api/avatars/get',{method:'POST',credentials:'same-origin',
      headers:ctx().getRequestHeaders?.(),signal:AbortSignal.timeout(10000)});
    if(!response.ok)return;
    const list=await response.json();
    if(Array.isArray(list))userAvatars=new Set(list.map(item=>typeof item==='string'?item:item?.name??item?.avatar).filter(Boolean));
  }catch{/* Without the file list every persona stays visible, as before. */}
}
function personaList(){
  return Object.entries(ctx().powerUserSettings?.personas??{})
    .map(([file,value])=>({file,name:typeof value==='string'?value:value?.name??''}))
    .filter(entry=>entry.name&&(!userAvatars||userAvatars.has(entry.file)));
}
/** The photo a brand-new entry starts with: this chat's bot, else the current persona. */
function currentPhotoSource(){
  const context=ctx(),index=context.characterId;
  const character=index===undefined||index===null||index===''?null:(context.characters??[])[index];
  if(character?.avatar)return {type:'avatar',file:character.avatar};
  const persona=personaList().find(entry=>normalizeName(entry.name)===normalizeName(context.name1));
  return persona?{type:'persona',file:persona.file}:null;
}
function sourceValue(photoSource){
  if(!photoSource)return '';
  if(photoSource.type==='persona')return `persona:${photoSource.file}`;
  const index=(ctx().characters??[]).findIndex(character=>character?.avatar===photoSource.file);
  return index>=0?`character:${index}`:'';
}
function freshSources(){
  const active=getActiveScope(ctx());
  const local=store.scopes.find(scope=>scope.key===active?.key);
  return {scopedProfiles:local?.settings.profiles??[],profiles:store.profiles};
}
// renderChat is synchronous, so one lookup serves every message it touches.
function getSources(){return sourcesCache??freshSources();}
function message(text,error=false){
  const status=panel?.querySelector('.sp-message');
  if(status){status.textContent=text;status.dataset.error=String(error);}
}
function promptState(){
  const state=panel?.querySelector('[data-prompt-state]');
  if(!state)return;
  for(const button of panel.querySelectorAll('[data-prompt-preset]')){
    const preset=button.dataset.promptPreset,dirty=promptDrafts.has(preset);
    button.dataset.dirty=String(dirty);
    button.setAttribute('aria-label',`프롬 ${preset}${dirty?', 저장 전 변경 사항':''}`);
  }
  const cardState=panel.querySelector('[data-prompt-card-dirty]');
  cardState.hidden=promptDrafts.size===0;
  cardState.textContent=promptDrafts.size===2?'프롬 A/B 저장 전 수정':'저장 전 수정 있음';
  const preset=store.dialoguePromptPreset;
  const dirty=promptDrafts.has(preset);
  state.dataset.dirty=String(dirty);
  state.textContent=dirty?`프롬${preset} · 저장 전 변경 사항`:`프롬${preset} · 저장됨`;
}
function setPromptBusy(busy){
  promptBusy=busy;
  for(const control of panel.querySelectorAll('[data-prompt-text],[data-prompt-preset],[data-prompt-save],[data-prompt-reset]'))
    control.disabled=busy;
}
function recordPromptDraft(){
  const preset=store.dialoguePromptPreset;
  const value=panel.querySelector('[data-prompt-text]').value;
  if(value===store.dialoguePrompts[preset])promptDrafts.delete(preset);
  else promptDrafts.set(preset,value);
  promptState();
}
function refreshPortraitMask(){
  const checkbox=panel?.querySelector('[data-hide-portraits]');
  if(checkbox)checkbox.checked=portraitsHidden;
}
function withoutLocalImage(person){
  const copy={...person};
  if(!isServerImage(copy.image))delete copy.image;
  return copy;
}
/** Identifies a set of stored photos without comparing megabytes of base64 on every save. */
function imageKey(images){
  return Object.keys(images).sort().map(id=>`${id}:${images[id].length}:${images[id].slice(-24)}`).join('|');
}
/** Serialize mutations against the latest committed store, not a stale UI snapshot. */
function panelScrollPositions(){
  const positions=[];
  const drawerContent=panel?.querySelector('.inline-drawer-content');
  if(drawerContent?.scrollHeight>drawerContent.clientHeight+1)
    positions.push({node:drawerContent,top:drawerContent.scrollTop,left:drawerContent.scrollLeft});
  for(let node=panel?.parentElement;node;node=node.parentElement){
    if(node.scrollHeight>node.clientHeight+1)positions.push({node,top:node.scrollTop,left:node.scrollLeft});
  }
  const root=document.scrollingElement;
  if(root&&!positions.some(entry=>entry.node===root)&&root.scrollHeight>root.clientHeight+1)
    positions.push({node:root,top:root.scrollTop,left:root.scrollLeft});
  return positions;
}
function restorePanelScroll(positions){
  for(const {node,top,left} of positions){node.scrollTop=top;node.scrollLeft=left;}
}
function persist(update,uploadIds=[],reset=true,keepScroll=true){
  const operation=saveQueue.catch(()=>{}).then(async()=>{
    if(!imagesReady)throw new Error('사진 저장소를 읽지 못해 저장을 중단했어요. 브라우저 저장소를 확인한 뒤 새로고침해 주세요.');
    const clean=sanitizeStore(update(store));
    const previous=new Map(allProfiles(store).map(p=>[p.id,p.image]));
    for(const person of allProfiles(clean)){
      if(person.image?.startsWith('data:')&&(uploadIds.includes(person.id)||previous.get(person.id)!==person.image))
        person.image=await uploadPortrait(person.image,ctx().getRequestHeaders);
    }
    const images=Object.fromEntries(allProfiles(clean).filter(p=>p.image?.startsWith('data:')).map(p=>[p.id,p.image]));
    // Drop photo data before cloning: settings.json only ever stores server paths.
    const metadata=structuredClone({...clean,profiles:clean.profiles.map(withoutLocalImage),
      scopes:clean.scopes.map(scope=>({...scope,settings:{...scope.settings,profiles:scope.settings.profiles.map(withoutLocalImage)}}))});
    metadata.storageId=storageId;
    // Preserve legacy local copies. Server-only accounts do not require IndexedDB.
    const key=imageKey(images);
    if(Object.keys(images).length&&key!==storedImageKey)await imageStore({...await imageStore(),...images});
    storedImageKey=key;
    ctx().extensionSettings[KEY]=metadata;
    ctx().saveSettingsDebounced();
    const scroll=keepScroll?panelScrollPositions():null;
    store=clean;syncDialoguePrompt(ctx(),store);refreshUI();schedule(reset);
    if(scroll){
      restorePanelScroll(scroll);
      requestAnimationFrame(()=>{if(panel?.isConnected)restorePanelScroll(scroll);});
    }
  });
  saveQueue=operation;
  return operation;
}
function refreshUI(){
  if(!panel)return;
  refreshPortraitMask();
  panel.querySelector('[data-prompt-enabled]').checked=store.dialoguePromptEnabled;
  for(const button of panel.querySelectorAll('[data-prompt-preset]')){
    const selected=button.dataset.promptPreset===store.dialoguePromptPreset;
    button.setAttribute('aria-pressed',String(selected));button.classList.toggle('sp-primary',selected);
  }
  promptState();
  for(const [selector,key,boolean] of [
    ['[data-enabled]','enabled',true],
    ['[data-render-depth]','renderDepth'],
    ['[data-bubble-enabled]','bubbleColorEnabled',true],['[data-bubble-color]','bubbleColor'],['[data-bubble-opacity]','bubbleOpacity'],
    ['select[data-name-position]','namePosition'],['select[data-quote-style]','quoteStyle'],
    ['[data-font-mode]','fontMode'],['[data-name-font]','nameFont'],['[data-dialogue-font]','dialogueFont'],
    ['[data-color-enabled]','quoteColorEnabled',true],['[data-quote-color]','quoteColor'],
    ['[data-emphasis-enabled]','emphasisColorEnabled',true],['[data-emphasis-color]','emphasisColor'],
    ['[data-paren-enabled]','parenColorEnabled',true],['[data-paren-color]','parenColor'],
    ['[data-name-size]','nameFontSize'],['[data-dialogue-size]','dialogueFontSize'],
    ['select[data-design]','design'],['select[data-shape]','shape'],['[data-size]','size'],
    ['[data-border-enabled]','borderEnabled',true],['[data-border-color]','borderColor'],['[data-border-width]','borderWidth'],
  ])panel.querySelector(selector)[boolean?'checked':'value']=store[key];
  panel.querySelector('[data-size-output]').textContent=`${store.size}px`;
  panel.querySelector('[data-bubble-settings]').hidden=store.design!=='bubble';
  panel.querySelector('[data-bubble-fields]').hidden=!store.bubbleColorEnabled;
  panel.querySelector('[data-bubble-opacity-output]').textContent=store.bubbleOpacity+'%';
  panel.querySelector('[data-font-fields]').hidden=store.fontMode!=='custom';
  panel.querySelector('[data-border-fields]').hidden=!store.borderEnabled;
  panel.querySelector('[data-border-width-output]').textContent=store.borderWidth+'px';
  if(store.borderEnabled){
    panel.style.setProperty('--sp-avatar-border-color',store.borderColor);
    panel.style.setProperty('--sp-avatar-border-width',`${store.borderWidth}px`);
  }else{
    panel.style.removeProperty('--sp-avatar-border-color');panel.style.removeProperty('--sp-avatar-border-width');
  }
  panel.querySelector('[data-quote-color]').disabled=!store.quoteColorEnabled;
  panel.querySelector('[data-emphasis-color]').disabled=!store.emphasisColorEnabled;
  panel.querySelector('[data-paren-color]').disabled=!store.parenColorEnabled;
  panel.querySelector('[data-name-size-output]').textContent=store.nameFontSize+'px';
  panel.querySelector('[data-dialogue-size-output]').textContent=store.dialogueFontSize+'px';
  library();livePreview();if(draft)preview();
}
function changeContext(){
  const next=getActiveScope(ctx());
  const changed=(next?.key??'')!==(activeScope?.key??'');activeScope=next;
  if(changed&&draft){closeEditor();message('봇이 바뀌어 저장 전 편집을 닫았어요. 다시 이름을 선택해 주세요.');}
  if(!activeScope&&panel?.querySelector('[data-scope-filter="local"][aria-pressed="true"]'))
    selectScopeFilter('all');
  refreshUI();schedule(changed);
}
function observe(){
  const chat=document.getElementById('chat');
  if(chat)observer.observe(chat,{childList:true,subtree:true,characterData:true});
}
function schedule(reset=false){
  needsReset=needsReset||reset;
  if(timer===null)timer=requestAnimationFrame(renderChat);
}
function renderChat(){
  timer=null;
  chatRenderer.markMutations(observer.takeRecords());
  observer.disconnect();
  sourcesCache=freshSources();
  try{chatRenderer.render(document.getElementById('chat'),{
    depth:store.renderDepth,totalMessages:Array.isArray(ctx().chat)?ctx().chat.length:null,
    enabled:store.enabled,reset:needsReset,
  });}
  catch(error){console.error('[Name2Avatar] 표시 오류',error);}
  finally{needsReset=false;sourcesCache=null;observe();}
}
function syncCrop(){
  if(!draft)return;
  for(const key of ['x','y','zoom']){
    panel.querySelector(`[data-crop="${key}"]`).value=draft[key];
    panel.querySelector(`[data-output="${key}"]`).textContent=key==='zoom'?`${draft[key].toFixed(2)}×`:`${draft[key]}%`;
  }
  for(const img of panel.querySelectorAll('.sp-preview img,.sp-crop-stage img,.sp-live-preview img'))applyCrop(img,draft);
}
function previewLine(person,settings=store){
  const line=document.createElement('span');line.className='sp-line';decorateLine(line,settings);
  const body=document.createElement('span');body.className='sp-body';
  const name=document.createElement('span');name.className='sp-name';name.textContent=person.name||'예시 인물';
  const words=document.createElement('span');words.className='sp-words';
  const quote=document.createElement('q');quote.textContent='여기서 다시 만나네요.';
  const emphasis=document.createElement('em');emphasis.textContent='살짝 웃으며';
  words.append(quote,' ',emphasis,' (번역 미리보기)');
  if(settings.quoteStyle==='override')resetQuotes(words);
  body.append(name,words);line.append(makeAvatar(person.name||'예시 인물',profileImage(person),person),body);applyTypography(line,settings);
  return line;
}
function livePreview(settings=store,keepScroll=false){
  const target=panel?.querySelector('.sp-live-preview');
  if(!target)return;
  const scroll=keepScroll?panelScrollPositions():null;
  const sources=freshSources();
  const person=draft??[...sources.scopedProfiles,...sources.profiles].find(entry=>entry.enabled!==false)
    ??{name:'예시 인물',image:''};
  target.replaceChildren(previewLine(person,settings));
  if(scroll)restorePanelScroll(scroll);
}
function preview(){
  if(!draft)return;
  panel.querySelector('.sp-preview').replaceChildren(previewLine(draft));
  livePreview();
  const photo=makeAvatar(draft.name||'이름',profileImage(draft),draft);
  photo.classList.add('sp-crop-photo');photo.removeAttribute('aria-hidden');
  photo.tabIndex=0;photo.setAttribute('role','group');
  photo.setAttribute('aria-label','사진 위치 조절');photo.setAttribute('aria-describedby','sp-crop-help');
  panel.querySelector('.sp-crop-stage').replaceChildren(photo);
  const editing=draft;
  bindCropDrag(photo,{getCrop:()=>editing,onChange:crop=>{if(draft===editing){Object.assign(draft,crop);syncCrop();}}});
  syncCrop();
}
function profileRow({person,scope}){
  const row=document.createElement('div');row.className='sp-profile-row';
  row.dataset.enabled=String(person.enabled!==false);
  const info=document.createElement('span');info.className='sp-profile-info';
  const names=document.createElement('b');names.textContent=[person.name,...person.aliases].join(', ');names.title=names.textContent;
  const badge=document.createElement('small');badge.textContent=scope?`현재 ${scope.key.startsWith('group:')?'그룹':'봇'} 전용`:'모든 봇 공통 적용';
  if(person.hideWhenMasked)badge.textContent+=' · 가리기 대상';
  info.append(names,badge);
  const actions=document.createElement('span');actions.className='sp-row-actions';
  const toggle=document.createElement('button');toggle.type='button';toggle.className='sp-person-toggle';
  toggle.setAttribute('role','switch');toggle.setAttribute('aria-checked',String(person.enabled!==false));
  toggle.setAttribute('aria-label',`${person.name} ${scope?'전용':'공통'} 프로필 표시`);
  toggle.title='끄면 이 인물의 대사를 원래 텍스트로 표시합니다.';
  toggle.textContent=person.enabled===false?'OFF':'ON';
  toggle.onclick=async()=>{
    const enabled=person.enabled===false;toggle.disabled=true;
    try{
      await persist(current=>{
        const next=structuredClone(current);
        const settings=scope?next.scopes.find(entry=>entry.key===scope.key)?.settings:next;
        const profile=settings?.profiles.find(entry=>entry.id===person.id);
        if(profile)profile.enabled=enabled;
        return next;
      });
      message('');
    }catch(error){message(error.message,true);refreshUI();}
  };
  actions.append(toggle);
  const edit=document.createElement('button');edit.type='button';edit.textContent='편집';
  edit.setAttribute('aria-label',`${person.name} ${scope?'전용':'공통'} 편집`);edit.onclick=()=>editPerson(person,scope);actions.append(edit);
  row.append(makeAvatar(person.name,profileImage(person),person),info,actions);
  return row;
}
/** Photo data is never read here, so the signature stays cheap even with local images. */
function librarySignatureOf(entries,scopeKey){
  return `${scopeKey}\u0003`+entries.map(({person,scope})=>[person.id,scope?1:0,person.name,person.aliases.join('\u0001'),
    person.enabled===false?0:1,person.hideWhenMasked?1:0,
    person.photoSource?`s${person.photoSource.type}/${person.photoSource.file}`:`i${person.image.length}${person.image.slice(-16)}`].join('\u0002')).join('\u0003');
}
function selectScopeFilter(filter){
  for(const button of panel.querySelectorAll('[data-scope-filter]'))
    button.setAttribute('aria-pressed',String(button.dataset.scopeFilter===filter));
  library();
}
function library(){
  const list=panel.querySelector('.sp-library');
  const local=store.scopes.find(scope=>scope.key===activeScope?.key);
  const all=[...(local?.settings.profiles??[]).map(person=>({person,scope:activeScope})),
    ...store.profiles.map(person=>({person,scope:null}))];
  // Rows are rebuilt only when the people change; searching just hides the ones that do not match.
  const signature=librarySignatureOf(all,activeScope?.key??'');
  if(signature!==librarySignature){
    librarySignature=signature;
    libraryRows=all.map(entry=>({...entry,row:profileRow(entry)}));
    list.replaceChildren(...libraryRows.map(entry=>entry.row));
  }
  const query=normalizeName(panel.querySelector('[data-search]')?.value??'').toLowerCase();
  const filter=panel.querySelector('[data-scope-filter][aria-pressed="true"]')?.dataset.scopeFilter??'all';
  let shown=0;
  for(const {person,scope,row} of libraryRows){
    const matchesName=!query||[person.name,...person.aliases]
      .some(name=>normalizeName(name).toLowerCase().includes(query));
    const match=matchesName&&(filter==='all'||(filter==='local')===Boolean(scope));
    row.hidden=!match;if(match)shown++;
  }
  panel.querySelector('[data-count]').textContent=query||filter!=='all'?`${shown} / ${all.length}명`:`${all.length}명`;
  panel.querySelector('[data-total-count]').textContent=String(all.length);
  const localButton=panel.querySelector('[data-scope-filter="local"]');
  localButton.textContent=activeScope?.key.startsWith('group:')?'현재 그룹':'현재 봇';
  localButton.disabled=!activeScope;
  let empty=list.querySelector('.sp-empty');
  if(shown){empty?.remove();return;}
  if(!empty){empty=document.createElement('p');empty.className='sp-empty';list.append(empty);}
  empty.textContent=all.length?query?'검색과 일치하는 이름이 없어요.':'이 범위에 등록된 인물이 없어요.':'이름을 등록하고 사진을 연결해 주세요.';
}
function sourceOptions(){
  const select=panel.querySelector('[data-source]');select.replaceChildren(new Option('ST에 등록된 사진 선택',''));
  const entries=[
    ...(ctx().characters??[]).map((character,index)=>character?.avatar
      ? {kind:'캐릭터',name:character.name??character.data?.name??character.avatar,file:character.avatar,value:`character:${index}`} : null).filter(Boolean),
    ...personaList().map(entry=>({kind:'유저',name:entry.name,file:entry.file,value:`persona:${entry.file}`})),
  ];
  const seen=new Map();
  for(const entry of entries)seen.set(entry.name,(seen.get(entry.name)??0)+1);
  for(const entry of entries){
    // Several cards or personas can share one name; the file tells them apart.
    const stem=entry.file.replace(/\.[^.]+$/u,'').slice(0,24);
    select.add(new Option(seen.get(entry.name)>1?`${entry.kind} · ${entry.name} (${stem})`:`${entry.kind} · ${entry.name}`,entry.value));
  }
  select.value=sourceValue(draft?.photoSource);
}
/** The dropdown is built at once, then again if the avatar file list arrives late. */
function openSourceOptions(){
  sourceOptions();
  refreshUserAvatars().then(()=>{if(draft&&panel)sourceOptions();});
}
function editPerson(person,scope=null){
  if(draft&&!confirm('저장하지 않은 편집을 닫고 다른 인물을 열까요?'))return;
  original=person?{id:person.id,key:scope?.key??''}:null;
  draft=person?structuredClone(person):{id:uid(),name:'',aliases:[],image:'',zoom:1.25,x:50,y:35};
  if(!person){const source=currentPhotoSource();if(source)draft.photoSource=source;}
  const editor=panel.querySelector('.sp-editor');editor.hidden=false;
  panel.querySelector('[data-names]').value=[draft.name,...draft.aliases].filter(Boolean).join(', ');
  panel.querySelector('[data-mask-person]').checked=draft.hideWhenMasked===true;
  const select=panel.querySelector('[data-person-scope]');
  select.options[1].disabled=!activeScope;
  select.options[1].textContent=activeScope?`${activeScope.key.startsWith('group:')?'현재 그룹':'현재 봇'} 전용 · ${activeScope.label}`:'현재 봇 전용 (봇 선택 필요)';
  select.value=scope||(!person&&activeScope)?'local':'global';
  panel.querySelector('[data-delete]').hidden=!original;
  panel.querySelector('[data-editor-title]').textContent=person?'인물 편집':'새 인물';
  openSourceOptions();scopeHint();preview();
  message('');
  editor.scrollIntoView({block:'nearest'});
  panel.querySelector('[data-names]').focus();
}
function scopeHint(){
  const local=panel.querySelector('[data-person-scope]').value==='local';
  panel.querySelector('[data-person-scope-note]').textContent=local
    ? '현재 봇에만 적용 · 같은 이름의 공통 등록보다 우선'
    : '모든 봇에 적용 · 같은 이름의 전용 등록이 있으면 전용 우선';
}
function closeEditor(){draft=null;original=null;panel.querySelector('.sp-editor').hidden=true;livePreview();}
async function saveProfile(){
  if(!draft)return;
  const names=parseNames(panel.querySelector('[data-names]').value);
  if(!names.length){message('대사 앞에 나오는 이름을 입력해 주세요.',true);return;}
  const target=panel.querySelector('[data-person-scope]').value==='local'?activeScope:null;
  if(panel.querySelector('[data-person-scope]').value==='local'&&!target){message('먼저 봇 채팅을 열어 주세요.',true);return;}
  const savedDraft=draft,from=original;
  const person={...structuredClone(draft),name:names[0],aliases:names.slice(1)};
  try{
    await persist(current=>{
      // A list toggle may have changed while this editor was open.
      const latest=from?allProfiles(current).find(entry=>entry.id===from.id):null;
      return savePerson(current,{...person,enabled:latest?.enabled??person.enabled??true},target,from);
    },[person.id]);
    if(draft===savedDraft)closeEditor();message(`${target?target.label+' 전용으로':'모든 봇 공통 적용으로'} 저장했어요.`);
  }catch(error){message(`저장하지 못했어요: ${error.message}`,true);}
}
async function decodeImage(url){
  const image=new Image();image.src=url;await image.decode();
  if(!image.naturalWidth||!image.naturalHeight)throw new Error('이미지를 읽지 못했습니다.');
  const scale=Math.min(1,768/Math.max(image.naturalWidth,image.naturalHeight));
  const canvas=document.createElement('canvas');
  canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));
  canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);
  return canvas.toDataURL('image/webp',.85);
}
async function readImage(file){
  if(!file)return;
  const animated=file.type==='image/gif';
  if(!['image/png','image/jpeg','image/webp','image/gif'].includes(file.type))throw new Error('PNG, JPG, WebP, GIF 이미지를 선택해 주세요.');
  if(animated&&file.size>5_500_000)throw new Error('움직이는 GIF는 5.5MB 이하 파일을 선택해 주세요.');
  if(!animated&&file.size>15*1024*1024)throw new Error('15MB 이하 이미지를 선택해 주세요.');
  if(animated){
    const header=String.fromCharCode(...new Uint8Array(await file.slice(0,6).arrayBuffer()));
    if(header!=='GIF87a'&&header!=='GIF89a')throw new Error('올바른 GIF 파일이 아니에요.');
  }
  const url=URL.createObjectURL(file);
  try{
    if(!animated)return await decodeImage(url);
    const image=new Image();image.src=url;await image.decode();
    if(!image.naturalWidth||!image.naturalHeight)throw new Error('GIF 이미지를 읽지 못했어요.');
    return await new Promise((resolve,reject)=>{
      const reader=new FileReader();
      reader.onload=()=>typeof reader.result==='string'&&reader.result.startsWith('data:image/gif;base64,')
        ? resolve(reader.result):reject(new Error('GIF 파일을 읽지 못했어요.'));
      reader.onerror=()=>reject(reader.error??new Error('GIF 파일을 읽지 못했어요.'));
      reader.readAsDataURL(file);
    });
  }finally{URL.revokeObjectURL(url);}
}
async function downloadBackup(){
  await saveQueue.catch(()=>{});
  if(!imagesReady){message('사진 저장소를 읽지 못해 완전한 백업을 만들 수 없어요. 저장소 설정을 확인한 뒤 새로고침해 주세요.',true);return;}
  const portable=structuredClone(store);
  for(const person of allProfiles(portable)){
    person.image=person.photoSource
      ? (await portableSourceGif(person.photoSource,profileImage(person))||await decodeImage(profileImage(person)))
      : await portableImage(person.image);
    delete person.photoSource;
  }
  const blob=new Blob([JSON.stringify({format:'speaker-portraits',version:2,settings:portable},null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob),link=document.createElement('a');
  link.href=url;link.download='speaker-portraits-backup.json';link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);message('공통·모든 봇 전용 등록과 사진을 백업했어요.');
}
async function importBackup(file){
  if(!file)return;
  if(file.size>100*1024*1024)throw new Error('100MB 이하 백업 파일만 가져올 수 있어요.');
  const data=JSON.parse(await file.text());
  if(data.format!=='speaker-portraits'||![1,2].includes(data.version)||!Array.isArray(data.settings?.profiles))throw new Error('Name2Avatar 백업 파일이 아닙니다.');
  const imported=sanitizeStore(data.settings);let added=0,skipped=0;
  if(allProfiles(imported).some(p=>isServerImage(p.image)))throw new Error('사진 데이터가 아닌 서버 경로만 있는 백업입니다. 원래 서버에서 사진·이름 백업으로 다시 내보내 주세요.');
  await persist(current=>{
    const next=structuredClone(current);
    function merge(incoming,target){
      for(const person of incoming){
        const names=new Set([person.name,...person.aliases].map(normalizeName));
        const conflict=target.some(p=>[p.name,...p.aliases].some(n=>names.has(normalizeName(n))));
        if(conflict||target.length>=150){skipped++;continue;}
        target.push({...person,id:uid()});added++;
      }
    }
    merge(imported.profiles,next.profiles);
    for(const incoming of imported.scopes){
      let target=next.scopes.find(s=>s.key===incoming.key);
      if(!target){
        if(next.scopes.length>=200){skipped+=incoming.settings.profiles.length;continue;}
        target={...incoming,settings:{...incoming.settings,profiles:[]}};next.scopes.push(target);
      }
      merge(incoming.settings.profiles,target.settings.profiles);
    }
    return next;
  });
  message(`${added}명 추가${skipped?` · 같은 범위의 중복 이름 또는 한도 초과 ${skipped}명은 건너뛰었어요.`:'했어요.'}`);
}

// Each toolbar's 기본값 button restores exactly the keys that toolbar owns.
const RESET_GROUPS={
  bubble:['bubbleColorEnabled','bubbleColor','bubbleOpacity'],
  colors:['quoteColorEnabled','quoteColor','emphasisColorEnabled','emphasisColor','parenColorEnabled','parenColor'],
  border:['borderEnabled','borderColor','borderWidth'],
};
function mount(){
  if(panel)return;
  const container=document.querySelector('#extensions_settings2')??document.querySelector('#extensions_settings');
  if(!container)return;
  panel=document.createElement('div');panel.className='sp-settings';panel.id='speaker-portraits-settings';
  panel.innerHTML=`<div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header" role="button" tabindex="0" aria-expanded="false" aria-controls="sp-drawer-content"><b>이름 ▸ 프사</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down" aria-hidden="true"></div></div>
    <div class="inline-drawer-content" id="sp-drawer-content"><div class="sp-panel">
      <header class="sp-hero">
        <div class="sp-hero-copy"><h3>이름 ▸ 프사</h3></div>
        <div class="sp-hero-actions"><span class="sp-hero-status">현재 목록 <b data-total-count>0</b>명</span><label class="sp-check sp-hero-toggle"><input type="checkbox" data-enabled> 사용</label></div>
      </header>
      <p class="sp-message" role="status" aria-live="polite"></p>

      <section class="sp-card sp-people-card" aria-labelledby="sp-people-title">
        <div class="sp-card-head">
          <div class="sp-title-row"><h4 id="sp-people-title">인물 관리</h4><details class="sp-info"><summary aria-label="인물 관리 설명">!</summary><div class="sp-info-bubble" role="note">대사 앞의 이름을 등록한 사진에 연결합니다. 현재 봇 전용 등록은 같은 이름의 공통 등록보다 우선합니다.</div></details></div>
          <button type="button" data-add class="sp-primary">＋ 인물 추가</button>
        </div>
        <div class="sp-toolbar sp-people-controls">
          <input type="text" class="sp-search" data-search placeholder="이름 또는 별칭 검색" aria-label="등록된 인물 이름 검색">
          <div class="sp-filter-group" role="group" aria-label="인물 적용 범위 필터">
            <button type="button" data-scope-filter="all" aria-pressed="true">전체</button>
            <button type="button" data-scope-filter="local" aria-pressed="false">현재 봇</button>
            <button type="button" data-scope-filter="global" aria-pressed="false">공통</button>
          </div>
        </div>
        <section class="sp-editor" aria-label="인물 편집" hidden>
          <div class="sp-editor-head"><h4 data-editor-title>새 인물</h4><button type="button" data-cancel aria-label="인물 편집 취소">닫기</button></div>
          <label class="sp-field">이름<textarea data-names maxlength="3500" placeholder="예: 제이스, Jace, 제이스 윌슨" aria-describedby="sp-names-help"></textarea></label>
          <p class="sp-muted" id="sp-names-help">별칭은 쉼표로 구분 · 첫 이름이 대표 이름</p>
          <label class="sp-field">이 인물의 적용 범위<select data-person-scope><option value="global">모든 봇 공통 적용</option><option value="local">현재 봇 전용</option></select></label>
          <p class="sp-muted" data-person-scope-note></p>
          <label class="sp-check"><input type="checkbox" data-mask-person> '지정 인물 프사만 가리기' 적용 대상</label>
          <div class="sp-toolbar"><button type="button" data-upload>사진 넣기</button><button type="button" data-clear-image>사진 지우기</button><span class="sp-muted">PNG · JPG · WebP · GIF (5.5MB 이하)</span></div>
          <div class="sp-toolbar"><select data-source aria-label="ST 사진 선택"></select></div>
          <div class="sp-crop-stage"></div>
          <p class="sp-muted" id="sp-crop-help">드래그 또는 방향키로 사진 이동</p>
          <label class="sp-range">가로 위치<input type="range" min="0" max="100" step="1" data-crop="x" aria-label="사진 가로 위치"><output data-output="x"></output></label>
          <label class="sp-range">세로 위치<input type="range" min="0" max="100" step="1" data-crop="y" aria-label="사진 세로 위치"><output data-output="y"></output></label>
          <label class="sp-range">확대<input type="range" min="1" max="3" step="0.05" data-crop="zoom" aria-label="사진 확대"><output data-output="zoom"></output></label>
          <div class="sp-preview" aria-label="편집 중인 인물의 대사 미리보기"></div>
          <div class="sp-toolbar"><button type="button" data-save class="sp-primary">저장</button><button type="button" data-reset-crop>위치 초기화</button><button type="button" data-delete hidden>인물 삭제</button></div>
        </section>
        <div class="sp-library-head"><span>등록된 인물 <b data-count></b></span><div class="sp-mask-control"><label class="sp-check"><input type="checkbox" data-hide-portraits> 지정 인물 프사만 가리기</label><small class="sp-muted">새로고침하면 해제</small></div></div>
        <div class="sp-library"></div>
      </section>

      <section class="sp-card sp-appearance-card" aria-labelledby="sp-appearance-title">
        <div class="sp-card-head"><div class="sp-title-row"><h4 id="sp-appearance-title">대사 디자인</h4><details class="sp-info"><summary aria-label="대사 디자인 설명">!</summary><div class="sp-info-bubble" role="note">사진과 대사 모양을 아래 미리보기로 확인하며 조절할 수 있습니다.</div></details></div></div>
        <div class="sp-live-preview-wrap"><div class="sp-live-preview-label"><strong>실시간 미리보기</strong></div><div class="sp-live-preview" aria-label="대사 디자인 실시간 미리보기"></div></div>
        <div class="sp-card-body">
          <div class="sp-options"><label>대사 디자인<select data-design><option value="minimal">미니멀</option><option value="bubble">말풍선</option></select></label><label>사진 모양<select data-shape><option value="circle">원형</option><option value="rounded">둥근 사각형</option></select></label></div>
          <label class="sp-range">사진 크기<input type="range" min="32" max="88" step="2" data-size aria-label="사진 크기"><output data-size-output></output></label>
          <details class="sp-details"><summary>말풍선 · 테두리 조절</summary><div class="sp-details-body">
            <div class="sp-bubble-settings" data-bubble-settings hidden>
              <div class="sp-toolbar"><label class="sp-check"><input type="checkbox" data-bubble-enabled> 말풍선 배경 직접 설정</label><button type="button" class="sp-reset" data-reset="bubble">기본값으로</button></div>
              <div class="sp-bubble-settings" data-bubble-fields hidden>
                <label class="sp-check">배경 색상 <input type="color" data-bubble-color aria-label="말풍선 배경 색상"></label>
                <label class="sp-range">불투명도<input type="range" min="0" max="100" step="1" data-bubble-opacity aria-label="말풍선 배경 불투명도"><output data-bubble-opacity-output></output></label>
              </div>
            </div>
            <div class="sp-border-settings">
              <div class="sp-toolbar"><label class="sp-check"><input type="checkbox" data-border-enabled> 프사 테두리 직접 설정</label><button type="button" class="sp-reset" data-reset="border">기본값으로</button></div>
              <div class="sp-border-settings" data-border-fields hidden>
                <label class="sp-check">테두리 색상 <input type="color" data-border-color aria-label="프사 테두리 색상"></label>
                <label class="sp-range">테두리 굵기<input type="range" min="0" max="6" step="1" data-border-width aria-label="프사 테두리 굵기"><output data-border-width-output></output></label>
              </div>
            </div>
          </div></details>
          <details class="sp-details"><summary>이름 · 글자 스타일 조절</summary><div class="sp-details-body">
            <label class="sp-field">이름 위치<select data-name-position><option value="none">이름 표시 안하기</option><option value="above">대사 위 표시</option></select></label>
            <label class="sp-field">따옴표 스타일<select data-quote-style><option value="theme">현재 ST 테마 그대로</option><option value="override">덮어쓰기 · 확장 스타일 우선</option></select></label>
            <label class="sp-field">폰트 적용<select data-font-mode><option value="theme">ST 설정 따르기</option><option value="custom">직접 선택</option></select></label>
            <div class="sp-font-fields" data-font-fields hidden>
              <div class="sp-font-row">
                <label>이름 폰트<select data-name-font>${FONT_OPTIONS.map(([key,label])=>`<option value="${key}">${label}</option>`).join('')}</select></label>
                <label>대사 폰트<select data-dialogue-font>${FONT_OPTIONS.map(([key,label])=>`<option value="${key}">${label}</option>`).join('')}</select></label>
              </div>
              <div class="sp-font-row">
                <label class="sp-font-size">이름 크기<input type="range" data-name-size min="10" max="28" step="1" aria-label="이름 폰트 크기"><output data-name-size-output></output></label>
                <label class="sp-font-size">대사 크기<input type="range" data-dialogue-size min="12" max="36" step="1" aria-label="대사 폰트 크기"><output data-dialogue-size-output></output></label>
              </div>
            </div>
            <div class="sp-color-rows">
              <div class="sp-toolbar"><label class="sp-check"><input type="checkbox" data-color-enabled> 따옴표 “대사” 색상</label><input type="color" data-quote-color aria-label="따옴표 대사 색상 선택"></div>
              <div class="sp-toolbar"><label class="sp-check"><input type="checkbox" data-emphasis-enabled> 강조 *글* 색상</label><input type="color" data-emphasis-color aria-label="강조 글 색상 선택"></div>
              <div class="sp-toolbar"><label class="sp-check"><input type="checkbox" data-paren-enabled> 괄호 (글) 색상</label><input type="color" data-paren-color aria-label="괄호 글 색상 선택"></div>
              <div class="sp-toolbar"><button type="button" class="sp-reset" data-reset="colors">글자 색상 기본값으로</button></div>
            </div>
          </div></details>
        </div>
      </section>

      <section class="sp-card sp-prompt-card" aria-labelledby="sp-prompt-title">
        <div class="sp-card-head"><div class="sp-title-row"><h4 id="sp-prompt-title">AI 프롬프트</h4><details class="sp-info"><summary aria-label="AI 프롬프트 설명">!</summary><div class="sp-info-bubble" role="note">켜면 저장된 형식을 다음 AI 요청부터 전달합니다. 지원 표기: 이름 | “대사”, 일본어 성 | 「대사」, 이름 | 『대사』. 저장 전 수정은 A/B를 바꿔도 유지됩니다.</div></details></div><span class="sp-card-dirty" data-prompt-card-dirty hidden></span></div>
        <details class="sp-details"><summary>프롬프트 보기 · 편집</summary><div class="sp-details-body">
          <label class="sp-check"><input type="checkbox" data-prompt-enabled> 대사 형식 프롬 적용</label>
          <div class="sp-prompt-preset-row"><div class="sp-filter-group" role="group" aria-label="프롬프트 선택"><button type="button" data-prompt-preset="A" aria-pressed="true">프롬 A</button><button type="button" data-prompt-preset="B" aria-pressed="false">프롬 B</button></div><span class="sp-prompt-state" data-prompt-state role="status" aria-live="polite"></span></div>
          <p class="sp-preset-guide"><span><b>A</b> 이름 | "대사"</span><span><b>B</b> 이름 | "대사" (한국어 번역)</span></p>
          <label class="sp-field">프롬프트<textarea data-prompt-text rows="6" maxlength="8000" aria-label="대사 형식 프롬프트"></textarea></label>
          <div class="sp-toolbar"><button type="button" data-prompt-save class="sp-primary">이 프롬프트 저장</button><button type="button" data-prompt-reset>기본값으로</button></div>
        </div></details>
      </section>

      <section class="sp-card sp-advanced-card" aria-labelledby="sp-advanced-title">
        <div class="sp-card-head"><div class="sp-title-row"><h4 id="sp-advanced-title">렌더링 · 백업</h4><details class="sp-info"><summary aria-label="렌더링과 백업 설명">!</summary><div class="sp-info-bubble" role="note">렌더링 최대 깊이 0은 모든 메시지에 적용합니다. 백업 파일에는 공통·봇 전용 인물과 사진이 포함됩니다.</div></details></div></div>
        <details class="sp-details"><summary>고급 설정 보기</summary><div class="sp-details-body">
          <label class="sp-field">렌더링 최대 깊이 (0 = 전체)<input type="number" min="0" step="1" inputmode="numeric" data-render-depth></label>
          <div class="sp-footer"><div class="sp-toolbar"><button type="button" data-export>사진·이름 백업</button><button type="button" data-import>백업 파일 불러오기</button></div></div>
        </div></details>
      </section>
      <input type="file" data-image-file accept="image/png,image/jpeg,image/webp,image/gif" hidden><input type="file" data-backup-file accept="application/json,.json" hidden>
    </div></div></div>`;
  container.append(panel);
  panel.addEventListener('click',event=>{
    for(const info of panel.querySelectorAll('.sp-info[open]'))if(!info.contains(event.target))info.open=false;
  });
  panel.addEventListener('keydown',event=>{
    if(event.key!=='Escape')return;
    const info=panel.querySelector('.sp-info[open]');
    if(!info)return;
    info.open=false;info.querySelector('summary').focus({preventScroll:true});event.stopPropagation();
  });
  panel.querySelector('[data-hide-portraits]').onchange=event=>{
    portraitsHidden=event.target.checked;
    if(timer!==null)cancelAnimationFrame(timer);needsReset=true;renderChat();
  };
  panel.querySelector('[data-prompt-text]').value=store.dialoguePrompt;
  panel.querySelector('[data-prompt-text]').oninput=recordPromptDraft;
  panel.querySelector('[data-prompt-enabled]').onchange=async event=>{
    if(event.target.checked&&typeof ctx().setExtensionPrompt!=='function'){
      event.target.checked=false;message('이 ST 환경에서는 프롬프트 삽입 기능을 사용할 수 없어요.',true);return;
    }
    try{const enabled=event.target.checked;await persist(current=>({...current,dialoguePromptEnabled:enabled}),[],true,true);message('');}
    catch(error){message(error.message,true);refreshUI();}
  };
  for(const button of panel.querySelectorAll('[data-prompt-preset]'))button.onclick=async()=>{
    const preset=button.dataset.promptPreset;
    if(promptBusy||preset===store.dialoguePromptPreset)return;
    recordPromptDraft();
    setPromptBusy(true);
    try{
      await persist(current=>({...current,dialoguePromptPreset:preset}),[],true,true);
      panel.querySelector('[data-prompt-text]').value=promptDrafts.get(preset)??store.dialoguePrompt;
      promptState();message('');
    }catch(error){message(error.message,true);}
    finally{setPromptBusy(false);}
  };
  panel.querySelector('[data-prompt-save]').onclick=async()=>{
    if(promptBusy)return;
    recordPromptDraft();
    const value=panel.querySelector('[data-prompt-text]').value;
    const preset=store.dialoguePromptPreset;
    setPromptBusy(true);
    try{
      await persist(current=>({...current,dialoguePrompts:{...current.dialoguePrompts,[preset]:value}}),[],true,true);
      promptDrafts.delete(preset);promptState();message(`프롬${preset}에 저장했어요.`);
    }catch(error){message(error.message,true);}
    finally{setPromptBusy(false);}
  };
  panel.querySelector('[data-prompt-reset]').onclick=async()=>{
    if(promptBusy)return;
    recordPromptDraft();
    const preset=store.dialoguePromptPreset,value=preset==='B'?DEFAULT_DIALOGUE_PROMPT_B:DEFAULT_DIALOGUE_PROMPT;
    if(promptDrafts.has(preset)&&!confirm(`프롬${preset}의 저장 전 수정 내용을 버리고 기본값으로 되돌릴까요?`))return;
    setPromptBusy(true);
    try{
      await persist(current=>({...current,dialoguePrompts:{...current.dialoguePrompts,[preset]:value}}),[],true,true);
      promptDrafts.delete(preset);panel.querySelector('[data-prompt-text]').value=store.dialoguePrompt;
      promptState();message(`프롬${preset}을 기본값으로 되돌렸어요.`);
    }catch(error){message(error.message,true);}
    finally{setPromptBusy(false);}
  };
  const header=panel.querySelector('.inline-drawer-header'),content=panel.querySelector('.inline-drawer-content');
  header.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();header.click();}});
  new MutationObserver(()=>header.setAttribute('aria-expanded',String(getComputedStyle(content).display!=='none')))
    .observe(content,{attributes:true,attributeFilter:['style','class']});
  for(const [selector,key,isBoolean] of [
    ['[data-enabled]','enabled',true],
    ['[data-render-depth]','renderDepth'],
    ['[data-bubble-enabled]','bubbleColorEnabled',true],['[data-bubble-color]','bubbleColor'],['[data-bubble-opacity]','bubbleOpacity'],
    ['select[data-name-position]','namePosition'],['select[data-quote-style]','quoteStyle'],
    ['[data-font-mode]','fontMode'],['[data-name-font]','nameFont'],['[data-dialogue-font]','dialogueFont'],
    ['[data-color-enabled]','quoteColorEnabled',true],['[data-quote-color]','quoteColor'],
    ['[data-emphasis-enabled]','emphasisColorEnabled',true],['[data-emphasis-color]','emphasisColor'],
    ['[data-paren-enabled]','parenColorEnabled',true],['[data-paren-color]','parenColor'],
    ['[data-name-size]','nameFontSize'],['[data-dialogue-size]','dialogueFontSize'],
    ['[data-design]','design'],['[data-shape]','shape'],['[data-size]','size'],
    ['[data-border-enabled]','borderEnabled',true],['[data-border-color]','borderColor'],['[data-border-width]','borderWidth'],
  ])panel.querySelector(selector).addEventListener('change',async event=>{
    const value=isBoolean?event.target.checked:['size','nameFontSize','dialogueFontSize','renderDepth','bubbleOpacity','borderWidth'].includes(key)?Number(event.target.value):event.target.value;
    try{await persist(current=>({...current,[key]:value}),[],key!=='renderDepth',true);message('');}
    catch(error){message(error.message,true);refreshUI();}
  });
  panel.querySelector('[data-bubble-opacity]').oninput=event=>{
    panel.querySelector('[data-bubble-opacity-output]').textContent=event.target.value+'%';
    livePreview({...store,bubbleOpacity:Number(event.target.value)},true);
  };
  panel.querySelector('[data-border-width]').oninput=event=>{
    panel.querySelector('[data-border-width-output]').textContent=event.target.value+'px';
    livePreview({...store,borderWidth:Number(event.target.value)},true);
  };
  for(const button of panel.querySelectorAll('[data-reset]'))button.onclick=async()=>{
    const keys=RESET_GROUPS[button.dataset.reset];
    try{
      await persist(current=>({...current,...Object.fromEntries(keys.map(key=>[key,DEFAULT_SETTINGS[key]]))}),[],true,true);
      message('기본값으로 되돌렸어요.');
    }catch(error){message(error.message,true);refreshUI();}
  };
  panel.querySelector('[data-size]').oninput=event=>{
    panel.querySelector('[data-size-output]').textContent=`${event.target.value}px`;
    livePreview({...store,size:Number(event.target.value)},true);
  };
  for(const key of ['name','dialogue'])panel.querySelector(`[data-${key}-size]`).oninput=event=>{
    panel.querySelector(`[data-${key}-size-output]`).textContent=event.target.value+'px';
    livePreview({...store,[`${key}FontSize`]:Number(event.target.value)},true);
  };
  panel.querySelector('[data-search]').oninput=library;
  for(const button of panel.querySelectorAll('[data-scope-filter]'))button.onclick=()=>selectScopeFilter(button.dataset.scopeFilter);
  panel.querySelector('[data-add]').onclick=()=>editPerson();
  panel.querySelector('[data-cancel]').onclick=closeEditor;
  panel.querySelector('[data-person-scope]').onchange=scopeHint;
  panel.querySelector('[data-mask-person]').onchange=event=>{if(draft)draft.hideWhenMasked=event.target.checked;};
  panel.querySelector('[data-names]').oninput=event=>{if(draft){const names=parseNames(event.target.value);draft.name=names[0]??'';draft.aliases=names.slice(1);preview();}};
  panel.querySelector('[data-save]').onclick=saveProfile;
  for(const range of panel.querySelectorAll('[data-crop]'))range.oninput=()=>{if(draft){draft[range.dataset.crop]=Number(range.value);syncCrop();}};
  panel.querySelector('[data-reset-crop]').onclick=()=>{if(draft){Object.assign(draft,{x:50,y:35,zoom:1.25});syncCrop();}};
  panel.querySelector('[data-clear-image]').onclick=()=>{if(draft){draft.image='';delete draft.photoSource;preview();}};
  panel.querySelector('[data-upload]').onclick=()=>panel.querySelector('[data-image-file]').click();
  panel.querySelector('[data-image-file]').onchange=async event=>{
    const editing=draft;
    try{const image=await readImage(event.target.files[0]);if(image&&draft===editing){draft.image=image;delete draft.photoSource;preview();message('');}}
    catch(error){message(error.message,true);}finally{event.target.value='';}
  };
  panel.querySelector('[data-source]').onchange=()=>{
    if(!draft)return;
    const value=panel.querySelector('[data-source]').value;
    if(!value){delete draft.photoSource;draft.image='';preview();message('');return;}
    const colon=value.indexOf(':'),type=value.slice(0,colon),id=value.slice(colon+1);
    const source=type==='character'?ctx().characters[Number(id)]?.avatar:id;
    if(!source)return;
    draft.photoSource={type:type==='character'?'avatar':'persona',file:source};draft.image='';
    preview();message('');
  };
  panel.querySelector('[data-delete]').onclick=async()=>{
    if(!draft||!original||!confirm(`“${draft.name}”의 이 범위 등록을 삭제할까요?`))return;
    const editing=draft,from=original;
    try{await persist(current=>removePerson(current,from));if(draft===editing)closeEditor();message('선택한 범위에서 인물 등록을 삭제했어요.');}
    catch(error){message(error.message,true);}
  };
  panel.querySelector('[data-export]').onclick=()=>downloadBackup().catch(error=>message(error.message,true));
  panel.querySelector('[data-import]').onclick=()=>panel.querySelector('[data-backup-file]').click();
  panel.querySelector('[data-backup-file]').onchange=async event=>{try{await importBackup(event.target.files[0]);}catch(error){message(error.message,true);}finally{event.target.value='';}};
  refreshUI();
}
async function initialize(){
  if(!window.SillyTavern?.getContext){console.warn('[Name2Avatar] SillyTavern context not available');return;}
  const raw=ctx().extensionSettings[KEY]??DEFAULT_SETTINGS;
  storageId=typeof raw.storageId==='string'?raw.storageId:uid();
  store=sanitizeStore(raw);activeScope=getActiveScope(ctx());let storageError='';
  try{
    const images=await imageStore();
    for(const person of allProfiles(store))person.image=person.photoSource?'':isServerImage(person.image)?person.image:(images[person.id]??person.image??'');
    store=sanitizeStore(store);imagesReady=true;
    storedImageKey=imageKey(Object.fromEntries(allProfiles(store).filter(p=>p.image?.startsWith('data:')).map(p=>[p.id,p.image])));
  }
  catch{imagesReady=allProfiles(store).every(p=>isServerImage(p.image)||p.photoSource);if(!imagesReady)storageError='기존 브라우저 사진을 읽지 못했어요. 원래 브라우저의 저장소를 확인해 주세요.';}
  if(!ctx().extensionSettings[KEY]?.storageId){ctx().extensionSettings[KEY]={...store,storageId};ctx().saveSettingsDebounced();}
  renderer=createRenderer({getSettings:()=>store,getSources,getImage:result=>profileImage(result?.profile),getMaskState:()=>portraitsHidden});
  chatRenderer=createChatRenderer(renderer);
  observer=new MutationObserver(records=>{if(chatRenderer.markMutations(records))schedule();});
  if(document.readyState==='loading')await new Promise(resolve=>document.addEventListener('DOMContentLoaded',resolve,{once:true}));
  mount();if(storageError)message(storageError,true);
  const {eventSource}=ctx(),events=ctx().eventTypes??ctx().event_types??{};
  syncDialoguePrompt(ctx(),store);
  for(const key of ['CHAT_CHANGED','GENERATION_STARTED','APP_READY'])if(events[key])eventSource.on(events[key],()=>syncDialoguePrompt(ctx(),store));
  if(events.CHAT_CHANGED)eventSource.on(events.CHAT_CHANGED,changeContext);
  if(events.CHARACTER_EDITED)eventSource.on(events.CHARACTER_EDITED,()=>{changeContext();schedule(true);});
  for(const key of ['USER_MESSAGE_RENDERED','CHARACTER_MESSAGE_RENDERED','MESSAGE_EDITED','MESSAGE_SWIPED','MESSAGE_DELETED','GENERATION_ENDED']){
    if(events[key])eventSource.on(events[key],()=>schedule());
  }
  if(events.APP_READY)eventSource.on(events.APP_READY,()=>{mount();changeContext();});
  refreshUserAvatars().then(()=>{if(draft&&panel)sourceOptions();});
  observe();schedule(true);
}
initialize().catch(error=>console.error('[Name2Avatar] 초기화 오류',error));
