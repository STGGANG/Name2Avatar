import {parseDialogueLine} from './core.js';

// Private family names avoid redefining fonts registered by other extensions.
export const FONT_OPTIONS=Object.freeze([
  ['theme','ST 설정 따르기',null,null],
  ['pretendard','프리텐다드','SPFontPretendard','https://cdn.jsdelivr.net/npm/pretendard@1.3.9/dist/web/static/woff2/Pretendard-Regular.woff2'],
  ['ridi','리디바탕','SPFontRidi','https://cdn.jsdelivr.net/gh/projectnoonnu/noonfonts_twelve@1.0/RIDIBatang.woff'],
  ['gowun','고운돋움','SPFontGowun','https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/gowundodum/GowunDodum-Regular.ttf'],
  ['paperlogy','페이퍼로지','SPFontPaperlogy','https://cdn.jsdelivr.net/gh/projectnoonnu/2408-3@1.0/Paperlogy-4Regular.woff2'],
  ['cafe24','카페24 써라운드 에어','SPFontCafe24','https://cdn.jsdelivr.net/gh/projectnoonnu/noonfonts_2105_2@1.0/Cafe24SsurroundAir.woff'],
]);

export function ensureFonts(settings){
  if(settings.fontMode!=='custom')return;
  for(const key of new Set([settings.nameFont,settings.dialogueFont])){
    const font=FONT_OPTIONS.find(item=>item[0]===key);if(!font?.[3]||document.getElementById(`sp-font-${key}`))continue;
    const style=document.createElement('style');style.id=`sp-font-${key}`;
    style.textContent=`@font-face{font-family:'${font[2]}';src:url('${font[3]}');font-weight:400;font-style:normal;font-display:swap}`;
    document.head.append(style);
  }
}

function family(element,key,size){
  const font=FONT_OPTIONS.find(item=>item[0]===key);if(!font)return;
  // Only this extension's rendered copies; never change global ST or Font-Manager rules.
  for(const node of [element,...element.querySelectorAll('*')]){
    if(node.matches('i[class*="fa"],svg,[class*="fa-"],code,pre'))continue;
    if(font[2])node.style.setProperty('font-family',`'${font[2]}', sans-serif`,'important');
    node.style.setProperty('font-size',`${size}px`,'important');
    node.style.setProperty('line-height',node===element?'1.6':'inherit','important');
  }
}

export function colorSpeech(content,color){
  if(!/^#[0-9a-f]{6}$/i.test(color))return;
  const text=content.textContent;
  const parsed=parseDialogueLine(`Speaker | ${text.trim()}`);
  let start=text.length-text.trimStart().length,end;
  if(parsed)end=start+parsed.speech.length+2;
  else {
    // ST sometimes represents the quote marks only via q pseudo-elements.
    const quote=content.querySelector('q');if(!quote)return;
    for(const node of [quote,...quote.querySelectorAll('*')])node.style.setProperty('color',color,'important');
    return;
  }
  const walker=document.createTreeWalker(content,NodeFilter.SHOW_TEXT);const nodes=[];
  while(walker.nextNode())nodes.push(walker.currentNode);
  let offset=0;
  // Split text nodes in place instead of moving q/em ancestors or their translation styles.
  for(const node of nodes){
    const length=node.textContent.length,a=Math.max(0,start-offset),b=Math.min(length,end-offset);offset+=length;
    if(a>=b)continue;
    let selected=node;if(b<length)node.splitText(b);if(a>0)selected=node.splitText(a);
    const span=document.createElement('span');span.className='sp-quoted';span.style.setProperty('color',color,'important');
    selected.before(span);span.append(selected);
  }
}

export function applyTypography(line,settings){
  const name=line.querySelector('.sp-name');
  name?.style.setProperty('font-weight','700','important');
  if(settings.quoteColorEnabled)for(const words of line.querySelectorAll('.sp-words'))colorSpeech(words,settings.quoteColor);
  if(settings.fontMode==='custom'){
    ensureFonts(settings);if(name)family(name,settings.nameFont,settings.nameFontSize);
    for(const words of line.querySelectorAll('.sp-words'))family(words,settings.dialogueFont,settings.dialogueFontSize);
  }
}
