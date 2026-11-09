const TAB_KEY='name2avatar-settings-tab';

export function installTabs(root){
  const tabs=[...root.querySelectorAll('.sp-tab[data-tab]')];
  const panels=[...root.querySelectorAll('.sp-tab-panel[data-tab]')];
  if(!tabs.length)return {select(){}};
  function select(name,{focus=false}={}){
    if(!tabs.some(tab=>tab.dataset.tab===name))name=tabs[0].dataset.tab;
    for(const tab of tabs){
      const active=tab.dataset.tab===name;
      tab.setAttribute('aria-selected',String(active));
      tab.tabIndex=active?0:-1;
    }
    for(const panel of panels)panel.hidden=panel.dataset.tab!==name;
    if(focus)tabs.find(tab=>tab.dataset.tab===name)?.focus({preventScroll:true});
    try{localStorage.setItem(TAB_KEY,name);}catch{}
  }
  for(const tab of tabs){
    tab.addEventListener('click',()=>select(tab.dataset.tab));
    tab.addEventListener('keydown',event=>{
      const index=tabs.indexOf(tab);
      const next={ArrowRight:index+1,ArrowDown:index+1,ArrowLeft:index-1,ArrowUp:index-1,Home:0,End:tabs.length-1}[event.key];
      if(next===undefined)return;
      event.preventDefault();
      select(tabs[(next+tabs.length)%tabs.length].dataset.tab,{focus:true});
    });
  }
  let saved=null;
  try{saved=localStorage.getItem(TAB_KEY);}catch{}
  select(saved||tabs[0].dataset.tab);
  return {select};
}

// (i) popovers: one open at a time, closed by an outside press or Escape.
export function installHelp(root){
  const buttons=()=>root.querySelectorAll('button[data-help][aria-expanded="true"]');
  const close=()=>{
    for(const button of buttons()){
      button.setAttribute('aria-expanded','false');
      const content=root.querySelector(`#${button.dataset.help}`);
      if(content)content.hidden=true;
    }
  };
  document.addEventListener('pointerdown',event=>{
    if(!event.target.closest?.('button[data-help], .sp-help-content'))close();
  },true);
  root.addEventListener('keydown',event=>{
    if(event.key!=='Escape')return;
    const open=buttons()[0];
    if(!open)return;
    close();open.focus({preventScroll:true});event.stopPropagation();
  });
  root.addEventListener('click',event=>{
    const button=event.target.closest('button[data-help]');
    if(!button||!root.contains(button))return;
    const content=root.querySelector(`#${button.dataset.help}`);
    if(!content)return;
    const expand=button.getAttribute('aria-expanded')!=='true';
    close();
    button.setAttribute('aria-expanded',String(expand));
    content.hidden=!expand;
  });
}
