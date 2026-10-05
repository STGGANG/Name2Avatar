import {parseDialogueLine} from './core.js?v=1.2.3';

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

const HEX=/^#[0-9a-f]{6}$/i;
// Icon glyphs and code keep their own colors; only prose is recolored.
const SKIP='i[class*="fa"],svg,[class*="fa-"],code,pre';
const EMPHASIS=/\*[^*\n]+\*/gu;
const PARENS=/[(（][^()（）\n]*[)）]/gu;

function textNodes(content){
  const walker=document.createTreeWalker(content,NodeFilter.SHOW_TEXT);const nodes=[];
  while(walker.nextNode())nodes.push(walker.currentNode);
  return nodes;
}

// Split text nodes in place instead of moving q/em ancestors or their translation styles.
function paint(content,start,end,color,className){
  let offset=0;
  for(const node of textNodes(content)){
    const length=node.textContent.length,a=Math.max(0,start-offset),b=Math.min(length,end-offset);offset+=length;
    if(a>=b||node.parentElement?.closest(SKIP))continue;
    let selected=node;if(b<length)node.splitText(b);if(a>0)selected=node.splitText(a);
    const span=document.createElement('span');span.className=className;span.style.setProperty('color',color,'important');
    selected.before(span);span.append(selected);
  }
}

/** Each range is painted against the current DOM; splitting never changes the text offsets. */
function paintMatches(content,color,pattern,className){
  if(!HEX.test(color))return;
  const text=content.textContent;
  for(const match of [...text.matchAll(pattern)])paint(content,match.index,match.index+match[0].length,color,className);
}

export function colorSpeech(content,color){
  if(!HEX.test(color))return;
  const text=content.textContent;
  const parsed=parseDialogueLine(`Speaker | ${text.trim()}`);
  if(!parsed){
    // ST sometimes represents the quote marks only via q pseudo-elements.
    const quote=content.querySelector('q');if(!quote)return;
    for(const node of [quote,...quote.querySelectorAll('*')])node.style.setProperty('color',color,'important');
    return;
  }
  const start=text.length-text.trimStart().length;
  paint(content,start,start+parsed.speech.length+2,color,'sp-quoted');
}

/** Markdown italics arrive as em/i; literal asterisks survive when markdown is off. */
export function colorEmphasis(content,color){
  if(!HEX.test(color))return;
  for(const element of content.querySelectorAll('em,i')){
    if(element.matches(SKIP))continue;
    for(const node of [element,...element.querySelectorAll('*')]){
      if(!node.matches(SKIP))node.style.setProperty('color',color,'important');
    }
  }
  paintMatches(content,color,EMPHASIS,'sp-emphasis');
}

export function colorParens(content,color){
  paintMatches(content,color,PARENS,'sp-paren');
}

export function applyTypography(line,settings){
  const name=line.querySelector('.sp-name');
  name?.style.setProperty('font-weight','700','important');
  // Quotes first: emphasis and parentheses nest deeper, so their color wins inside a quote.
  for(const words of line.querySelectorAll('.sp-words')){
    if(settings.quoteColorEnabled)colorSpeech(words,settings.quoteColor);
    if(settings.emphasisColorEnabled)colorEmphasis(words,settings.emphasisColor);
    if(settings.parenColorEnabled)colorParens(words,settings.parenColor);
  }
  if(settings.fontMode==='custom'){
    ensureFonts(settings);if(name)family(name,settings.nameFont,settings.nameFontSize);
    for(const words of line.querySelectorAll('.sp-words'))family(words,settings.dialogueFont,settings.dialogueFontSize);
  }
}
