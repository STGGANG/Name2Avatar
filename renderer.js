import { parseDialogueLine, resolveSpeaker, dialoguePrefix } from './core.js';
import { applyTypography } from './typography.js';

const EXCLUDED='pre,code,style,script,textarea,iframe,svg,table,details,.mg-status,.speakers,.sp-line,[data-sp-skip]';
const INLINE=new Set(['A','ABBR','B','BDI','BDO','CITE','DEL','EM','I','MARK','Q','S','SMALL','SPAN','STRONG','SUB','SUP','U']);

export function makeAvatar(name, image, crop={}) {
  const avatar=document.createElement('span');
  avatar.className='sp-avatar';
  avatar.setAttribute('aria-hidden','true');
  avatar.textContent=Array.from(name).slice(0,2).join('');
  if(image){
    const img=document.createElement('img');
    img.alt=''; img.src=image; img.draggable=false;
    applyCrop(img,crop);
    img.addEventListener('error',()=>img.remove(),{once:true});
    avatar.append(img);
  }
  return avatar;
}

export function applyCrop(img,crop={}) {
  img.style.objectPosition=`${crop.x??50}% ${crop.y??35}%`;
  img.style.transform=`scale(${crop.zoom??1.25})`;
  img.style.transformOrigin=`${crop.x??50}% ${crop.y??35}%`;
}

export function decorateLine(line,settings) {
  line.dataset.design=settings.design;line.dataset.shape=settings.shape;
  line.dataset.namePosition=settings.namePosition;
  line.dataset.quoteStyle=settings.quoteStyle;
  line.style.setProperty('--sp-size',`${settings.size}px`);
}

// Inline !important beats ordinary theme rules, even theme q rules using !important.
// Only the cloned quote wrapper is reset; translation and emphasis children survive.
function resetQuotes(content) {
  const reset={display:'inline',position:'static',float:'none',width:'auto',height:'auto',
    'min-width':'0','max-width':'none',margin:'0',padding:'0',border:'0',outline:'0',
    'border-radius':'0',background:'none','box-shadow':'none','text-shadow':'none',
    'letter-spacing':'inherit',
    'text-decoration':'inherit','text-indent':'0','white-space':'normal',
    transform:'none',filter:'none',opacity:'1',animation:'none',quotes:'none'};
  for(const quote of content.querySelectorAll('q')){
    // When ST uses CSS-generated quote marks, provide real marks for reset mode.
    if(!/^[\s]*["“‘'「『«]/u.test(quote.textContent)){
      quote.prepend(document.createTextNode('“'));quote.append(document.createTextNode('”'));
    }
    for(const [key,value] of Object.entries(reset))quote.style.setProperty(key,value,'important');
  }
}

function afterPrefix(fragment) {
  const walker=document.createTreeWalker(fragment,NodeFilter.SHOW_TEXT);
  const nodes=[]; let text='';
  while(walker.nextNode()){nodes.push(walker.currentNode);text+=walker.currentNode.textContent;}
  let cut=dialoguePrefix(text)?.[0].length??0;
  while(cut<text.length&&/\s/.test(text[cut]))cut++;
  let remaining=cut;
  for(const node of nodes){
    if(remaining<=node.textContent.length){
      const range=document.createRange();
      range.setStart(fragment,0);range.setEnd(node,remaining);range.deleteContents();
      break;
    }
    remaining-=node.textContent.length;
  }
  return fragment;
}

/** Only changes rendered DOM; original nodes stay available for exact restoration. */
export function createRenderer({getSettings,getSources,getImage}) {
  const originals=new WeakMap();
  const grouped=new WeakMap();
  function ungroup(root){
    for(const group of root.querySelectorAll('.sp-group')){
      const original=grouped.get(group);if(original)group.replaceWith(original);
    }
  }
  function restore(root){
    ungroup(root);
    for(const line of root.querySelectorAll('.sp-line')){
      const original=originals.get(line);
      if(original)line.replaceWith(original);
    }
  }
  function groupRuns(parent){
    const unit=node=>{
      if(node.nodeType!==Node.ELEMENT_NODE)return null;
      if(node.matches('.sp-line'))return node;
      if(!['P','DIV'].includes(node.tagName))return null;
      const significant=Array.from(node.childNodes).filter(n=>n.nodeType!==Node.TEXT_NODE||n.textContent.trim());
      return significant.length===1&&significant[0].nodeType===Node.ELEMENT_NODE&&significant[0].matches('.sp-line')?significant[0]:null;
    };
    const blank=node=>node.nodeType===Node.TEXT_NODE?!node.textContent.trim():node.nodeType===Node.ELEMENT_NODE
      &&(node.tagName==='BR'||(['P','DIV'].includes(node.tagName)&&Array.from(node.childNodes).every(n=>n.nodeType===Node.TEXT_NODE?!n.textContent.trim():n.nodeType===Node.ELEMENT_NODE&&n.tagName==='BR')));
    let run=[];
    function flush(){
      if(run.length>1){
        const group=document.createElement('div');group.className='sp-group';
        const first=run[0].line.cloneNode(true),body=first.querySelector('.sp-body');
        const speech=document.createElement('span');speech.className='sp-speeches';
        speech.append(first.querySelector('.sp-words'));
        for(const entry of run.slice(1))speech.append(entry.line.querySelector('.sp-words').cloneNode(true));
        body.append(speech);group.append(first);
        for(const img of first.querySelectorAll('img'))img.addEventListener('error',()=>img.remove(),{once:true});
        const original=document.createDocumentFragment();
        const end=run.at(-1).node.nextSibling;
        let current=run[0].node;current.before(group);
        while(current!==end){const next=current.nextSibling;original.append(current);current=next;}
        grouped.set(group,original);
      }
      run=[];
    }
    for(const node of Array.from(parent.childNodes)){
      const line=unit(node);
      if(line){
        if(run.length&&run[0].line.dataset.person!==line.dataset.person)flush();
        run.push({node,line});
      }else if(!blank(node)){
        flush();
        if(node.nodeType===Node.ELEMENT_NODE&&!node.matches(EXCLUDED))groupRuns(node);
      }
    }
    flush();
  }
  function processRun(nodes,settings,sources){
    if(!nodes.length)return;
    const plain=nodes.map(n=>n.textContent).join('');
    let parsed=parseDialogueLine(plain.trim());
    if(!parsed){
      // ST may render quotes as <q> without literal quote characters.
      const quoteText=node=>{
        if(node.nodeType===Node.TEXT_NODE)return node.textContent;
        const value=Array.from(node.childNodes).map(quoteText).join('');
        return node.nodeName==='Q'&&!/^["“‘'「『]/.test(value)?`"${value}"`:value;
      };
      parsed=parseDialogueLine(nodes.map(quoteText).join('').trim());
    }
    if(!parsed)return;
    const result=resolveSpeaker(parsed.name,sources);
    // Unregistered/ambiguous speakers retain their original text and theme.
    if(result?.kind!=='profile')return;
    const crop=result.profile;
    const image=getImage(result);
    const wrapper=document.createElement('span');
    wrapper.className='sp-line';decorateLine(wrapper,settings);
    wrapper.dataset.speaker=parsed.name;wrapper.dataset.person=result.profile.id;
    if(!image)wrapper.title='등록된 이미지 없음';
    const body=document.createElement('span');body.className='sp-body';
    const name=document.createElement('span');name.className='sp-name';name.textContent=parsed.name;
    const content=document.createElement('span');content.className='sp-words';
    const copy=document.createDocumentFragment();
    for(const node of nodes)copy.append(node.cloneNode(true));
    content.append(afterPrefix(copy));
    if(settings.quoteStyle==='override')resetQuotes(content);
    body.append(name,content);wrapper.append(makeAvatar(parsed.name,image,crop),body);
    applyTypography(wrapper,settings);
    nodes[0].before(wrapper);
    const original=document.createDocumentFragment();
    for(const node of nodes)original.append(node);
    originals.set(wrapper,original);
  }
  function visit(parent,settings,sources){
    if(parent.nodeType!==Node.ELEMENT_NODE||parent.matches(EXCLUDED))return;
    let run=[];
    const flush=()=>{processRun(run,settings,sources);run=[];};
    for(const node of Array.from(parent.childNodes)){
      if(node.nodeType===Node.TEXT_NODE){run.push(node);continue;}
      if(node.nodeType!==Node.ELEMENT_NODE){flush();continue;}
      if(node.tagName==='BR'){flush();continue;}
      if(node.matches(EXCLUDED)){flush();continue;}
      if(INLINE.has(node.tagName)&&!node.querySelector('br,'+EXCLUDED))run.push(node);
      else{flush();visit(node,settings,sources);}
    }
    flush();
  }
  function render(root,{reset=false}={}){
    if(!root)return;
    ungroup(root);
    const settings=getSettings();
    if(reset||!settings.enabled)restore(root);
    if(settings.enabled){visit(root,settings,getSources());groupRuns(root);}
  }
  return {render,restore};
}
