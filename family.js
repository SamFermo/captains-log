/* family.js — THE FAMILY TABS, shared by home.html and the Bridge. 2026-10-01.
   Today, To-do, Meals, Info and October, lifted out of home.html unchanged so the Bridge can
   carry them as tabs (Sam: "combine what I see in the family hub with how the bridge is built
   ... but dont lose the functionality of the bridge") while Amy's page stays exactly hers.
   One copy, two hosts: a fix here lands on both phones, which is the whole point of sharing it.

   This file owns the DATA and the PANES. It owns nothing else:
     * no Firebase init and no sign-in. Each host signs in on its own named 'bridge' app and
       hands over its Firestore handle.
     * no tab bar, no header, no tab state. The host asks for a pane and decides where it goes.
   The contract:
       var hub = FamilyHub.create({db, me:'sam'|'amy', email, pane:<element>, root:<document|shadowRoot>,
                                   onChange(anim), setTab(tab, persistAndScroll), signOut()});
       hub.start()            subscribe (call once a real ID token exists, same race as the Bridge)
       hub.hold(anim)         true = someone is typing in a pane field, do not repaint now
       hub.status()           {liveAll, denied}
       hub.paint(tab, anim)   paint one pane into `pane`
       hub.todoFresh()        the To-do badge count. Read AFTER paint: painting To-do marks it seen.
       hub.stop()             unsubscribe; a stopped hub never calls onChange again
   `root` is where focus lives. On home.html that is the document; inside the Bridge it is the
   shadow root, because document.activeElement only ever reports the shadow host.

   Every rule from home.html still holds and a change that breaks one is a regression:
   no data in this file (the repo is public), a read failure and an empty section look
   different, shared lists change by id inside a transaction, and nothing repaints under a
   thumb that is typing. */
(function(){
"use strict";
function $(s){return document.querySelector(s);}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function el(tag,cls,html){var e=document.createElement(tag);if(cls)e.className=cls;if(html!=null)e.innerHTML=html;return e;}
function iso(){return new Date().toISOString();}
function uid(p){return p+Date.now().toString(36)+Math.floor(Math.random()*1e4).toString(36);}

/* Today in Seattle, from the device clock, never UTC. The Bridge once stamped a whole evening
   a day into the future because a clock had already rolled to UTC tomorrow. */
function laDate(off){
  var d=new Date(Date.now()+(off||0)*864e5);
  return new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles'}).format(d);
}
var WD=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
function wdOf(ymd){var p=ymd.split('-');return WD[new Date(+p[0],+p[1]-1,+p[2]).getDay()];}
function dayLabel(ymd){
  if(ymd===laDate(0)) return 'Today';
  if(ymd===laDate(1)) return 'Tomorrow';
  var p=ymd.split('-');
  return wdOf(ymd)+' '+(+p[2])+' '+['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+p[1]-1];
}
function cap(w){ return String(w||'').replace(/^./,function(x){return x.toUpperCase();}); }
function h12(hm){ if(!hm||!/^\d{1,2}:\d{2}$/.test(hm)) return hm||'';
  var a=hm.split(':'),h=+a[0];return (h%12||12)+':'+a[1]+(h<12?'am':'pm'); }

window.FamilyHub={
  util:{esc:esc,el:el,laDate:laDate,dayLabel:dayLabel,wdOf:wdOf},
  create:function(o){
var db=o.db, ME=o.me, EMAIL=o.email, PANE=o.pane, ROOT=o.root||document, STOPPED=false;
function render(anim){ if(!STOPPED) o.onChange(anim); }
var SRC={
  fam:{ref:function(){return db.collection('family').doc('latest');}},
  todo:{ref:function(){return db.collection('home_list').doc('items');}},
  info:{ref:function(){return db.collection('household').doc('info');}},
  acts:{ref:function(){return db.collection('household').doc('activities');}},
  oct:{ref:function(){return db.collection('family').doc('october');}},
  octst:{ref:function(){return db.collection('household').doc('october');}}
};
/* Each source holds three separate facts: whether it has answered at all (ready), what it
   said (data, null when the doc does not exist), and whether it failed (err). "Not loaded",
   "loaded and empty" and "could not load" render three different ways, always. */
Object.keys(SRC).forEach(function(k){SRC[k].ready=false;SRC[k].data=null;SRC[k].err=null;SRC[k].live=false;});
var unsub=[];

function subscribe(){
  Object.keys(SRC).forEach(function(k){
    var s=SRC[k];
    unsub.push(s.ref().onSnapshot({includeMetadataChanges:true},function(snap){
      s.ready=true; s.err=null; s.data=snap.exists?snap.data():null; s.live=!snap.metadata.fromCache;
      render();
    },function(e){ s.ready=true; s.err=(e&&e.code)||String(e); render(); }));
  });
}

/* Writes to shared docs go through a transaction that re-reads the server copy and applies
   ONE change by id. Two people edit these lists from two phones; writing a local copy of the
   whole array back would silently erase whatever the other person added in between, which is
   the one thing a shared list must never do. */
function mutate(k,fn){
  var ref=SRC[k].ref();
  return db.runTransaction(function(tx){
    return tx.get(ref).then(function(s){
      var items=((s.exists&&s.data().items)||[]).slice();
      tx.set(ref,{items:fn(items),updated_at:iso(),updated_by:EMAIL},{merge:true});
    });
  }).catch(function(e){ flash('Could not save ('+((e&&e.code)||e)+'). Nothing was changed; try again.'); });
}
var flashMsg='';
function flash(m){flashMsg=m;render();setTimeout(function(){flashMsg='';render();},6000);}


/* Held repaints. A listener firing while someone is typing waits until they leave the field,
   then paints once. The 250ms is load-bearing: focusout fires on the press of the Save button,
   BEFORE its click, and repainting inside that gap would delete the button under the finger.
   focusout is a composed event, so this hears a field inside the Bridge's shadow root too. */
var PENDING=false;
function typing(){ var a=ROOT.activeElement;
  return !!(a && (a.tagName==='INPUT'||a.tagName==='TEXTAREA') && PANE.contains(a)); }
document.addEventListener('focusout',function(){
  setTimeout(function(){ if(!STOPPED && PENDING && !typing()) render(); },250);
});

/* A section's three states, in one place so every section says them the same way. */
function gate(b,k,what){
  var s=SRC[k];
  if(!s.ready){ b.appendChild(el('div','quiet','Loading '+what+'…')); return false; }
  // permission-denied and a dropped connection are different facts too: one is a rule that
  // is not published (retrying never helps), the other clears itself.
  if(s.err==='permission-denied'){ b.appendChild(el('div','miss','<b>No permission to read '+esc(what)+'.</b> '+
      'The Firestore rule for it is not published yet, or this Google account is not on it. Retrying will not help.')); return false; }
  if(s.err){ b.appendChild(el('div','miss','<b>Could not load '+esc(what)+'</b> ('+esc(s.err)+
      '). This is a read failure, not an empty list. It retries on its own when the connection is back.')); return false; }
  return true;
}
function who(w){
  if(!w) return '';
  if(/sam or amy/i.test(w)) return '<span class="you">Either of you</span>';
  if(w.toLowerCase()===ME) return '<span class="you">You</span>';
  return esc(w);
}

/* "Wear: …" and "Bring: …" lines get a cyan label so the morning read finds them first. */
function lineHtml(l){
  var m=/^(Wear|Bring): (.*)$/.exec(l);
  return m?'<div class="line pk"><b>'+m[1]+'</b>'+esc(m[2])+'</div>':'<div class="line">'+esc(l)+'</div>';
}
/* ══ TODAY ═════════════════════════════════════════════════════════════════ */
function famFeed(b){
  if(!gate(b,'fam','the school feed')) return null;
  var f=SRC.fam.data;
  if(!f){ b.appendChild(el('div','miss','<b>The school feed has never been written.</b> The 4am run posts it; until it has run once there is nothing to show.')); return null; }
  return f;
}
function paintToday(b){
  var f=famFeed(b); var today=laDate(0);
  if(f){
    if(f.date!==today){
      var inRange=(f.school||[]).some(function(d){return d.date===today;});
      b.appendChild(el('div','bar warn', inRange
        ? 'Last updated '+esc(dayLabel(f.date))+'. School times come from the school rules, so they still hold; calendar and meals may be behind.'
        : 'The school feed is more than a week old (last '+esc(f.date)+'). The 4am run has not posted it.'));
    }
    var sd=(f.school||[]).filter(function(d){return d.date===today;})[0];
    var tm=(f.school||[]).filter(function(d){return d.date===laDate(1);})[0];
    b.appendChild(el('div','sec','Lucy · '+esc((f.school_facts&&f.school_facts.school)||'school')));
    var c=el('div','card');
    if(!sd){ c.appendChild(el('div','quiet','No school entry for today in the feed.')); }
    else if(!sd.school){ c.appendChild(el('div','big',esc(sd.lines[0]||'No school'))); }
    else{
      c.innerHTML='<div class="times">'+
        '<div><span class="k">Drop-off</span><b>'+esc(sd.dropoff.time)+'</b><span class="w">'+who(sd.dropoff.who)+'</span></div>'+
        '<div><span class="k">Pick-up</span><b>'+esc(sd.pickup.time)+'</b><span class="w">'+who(sd.pickup.who)+'</span>'+
          (sd.pickup.why?'<em>'+esc(sd.pickup.why)+'</em>':'')+'</div></div>'+
        sd.lines.slice(2).map(lineHtml).join('');
    }
    if(sd) (sd.flags||[]).forEach(function(x){c.appendChild(el('div','flag',esc(x)));});
    if(tm){
      var tl=!tm.school?(tm.lines[0]||'No school')
        :'Drop-off '+tm.dropoff.time+' '+tm.dropoff.who+' · pick-up '+tm.pickup.time+' '+tm.pickup.who+(tm.pickup.why?' ('+tm.pickup.why+')':'');
      if(tm.school&&tm.wear) tl+=' · wear: '+tm.wear;
      if(tm.school&&tm.bring) tl+=' · bring: '+tm.bring;
      c.appendChild(el('div','tmr','<span>Tomorrow</span>'+esc(tl)));
    }
    b.appendChild(c);

    // The week at a glance: who drives, and the days that break the pattern.
    var wk=el('div','week');
    (f.school||[]).forEach(function(d){
      var cell=el('div',(d.date===today?'now ':'')+(d.school?'':'off'));
      cell.innerHTML='<div class="d">'+esc(wdOf(d.date))+'</div>'+
        (d.school?'<div class="t">'+esc(d.pickup.time.replace(/:00|m$/g,''))+'</div><div class="x">'+esc(short(d.pickup.who))+'</div>'
                 :'<div class="x">off</div>');
      wk.appendChild(cell);
    });
    octToday(b);
    b.appendChild(el('div','sec','This week · pick-up<em>who drives</em>'));
    b.appendChild(wk);

    // Dinner tonight, if the Sheet has it.
    var plan=((f.meals||{}).plan||[]).filter(function(m){return m.date===today;});
    if(plan.length){
      b.appendChild(el('div','sec','Eating today'));
      var mc=el('div','card');
      plan.forEach(function(m){mc.appendChild(el('div','meal','<div class="s">'+esc(m.slot)+'</div><div class="m">'+esc(m.dish)+
        (m.cook?'<small>'+esc(m.cook)+(m.notes?' · '+esc(m.notes):'')+'</small>':'')+'</div>'));});
      b.appendChild(mc);
    }

    b.appendChild(el('div','sec','Family calendar<em>next 7 days</em>'));
    if(f.family_cal_status!=='ok') b.appendChild(el('div','miss','<b>Not in this morning\'s feed:</b> '+esc(f.family_cal_status)+'. Unknown, not empty.'));
    else if(!(f.family_cal||[]).length) b.appendChild(el('div','quiet','Nothing on the family calendar this week.'));
    else b.appendChild(evList(f.family_cal));

    b.appendChild(el('div','sec','At school<em>next 30 days</em>'));
    if(!/^ok/.test(f.stc_status||'')) b.appendChild(el('div','miss','<b>School calendar missing:</b> '+esc(f.stc_status)));
    else if(!(f.stc_events||[]).length) b.appendChild(el('div','quiet','Nothing on the school calendar for the next month.'));
    else b.appendChild(evList(f.stc_events));
  }
  // Open to-dos for me, so Today is the one screen that answers "what do I owe today".
  if(SRC.todo.ready&&!SRC.todo.err){
    var mine=todoItems().filter(function(i){return !i.done&&(forOf(i)===ME||forOf(i)==='both');});
    if(mine.length){
      b.appendChild(el('div','sec','On your list<em>'+mine.length+' open</em>'));
      var tc=el('div','card'); mine.slice(0,5).forEach(function(i){tc.appendChild(todoRow(i));});
      if(mine.length>5){var mo=el('button','lnk','See all '+mine.length+' ›');mo.onclick=function(){o.setTab('todo',false);};tc.appendChild(mo);}
      b.appendChild(tc);
    }
  }
}
function short(w){ if(!w) return ''; if(/sam or amy/i.test(w)) return 'either'; return w.toLowerCase()===ME?'you':w; }
function evList(list){
  var c=el('div','card');
  list.forEach(function(e){
    c.appendChild(el('div','ev','<div class="when">'+esc(dayLabel(e.date))+'<br>'+esc(e.time||'')+'</div>'+
      '<div class="what">'+esc(e.title)+(e.where?'<small>'+esc(e.where)+'</small>':'')+'</div>'));
  });
  return c;
}

/* ══ TO-DO ═════════════════════════════════════════════════════════════════
   The house list, opened up both ways. Same doc the Bridge reads (home_list/items), same ids,
   so Sam's crossings-off and his XP bank keep working. New field `for`: sam, amy or both.
   Items from before 2026-09-23 have no `for`; every one of them was Amy asking Sam, so a
   missing `for` means sam. The Bridge shows Sam everything not for Amy alone, and only
   those count toward clearing his list. */
function todoItems(){ return (SRC.todo.data&&SRC.todo.data.items)||[]; }
function forOf(i){ return i['for']||'sam'; }
function byName(e){ e=String(e||'').toLowerCase(); return window.BRIDGE_ALLOWED.indexOf(e)>=0?'Sam':(e?'Amy':''); }
/* "New for you": open, assigned to me or both, added by the other person, after I last opened
   the tab. Per device, in localStorage, because it is a convenience, not a record. */
var SEEN_MEM='';
function seenAt(){ var v=''; try{v=localStorage.getItem('hub.todoSeen')||'';}catch(e){} return v>SEEN_MEM?v:SEEN_MEM; }
function todoFresh(){
  if(!SRC.todo.ready||SRC.todo.err) return 0;
  var s=seenAt();
  var me=ME==='sam'?'Sam':'Amy';
  return todoItems().filter(function(i){
    var f=forOf(i);
    if(!i.done&&(f===ME||f==='both')&&byName(i.by).toLowerCase()!==ME&&(i.added_at||'')>s) return true;
    return notesOf(i).some(function(n){ return byName(n.by)!==me&&(n.at||'')>s; });
  }).length;
}
var FILTER='mine', NEWFOR=null;
/* Two things Sam asked for on 2026-10-06:
   1. Ticking an item crosses it off IN PLACE. It does not jump to the Done section until the
      tab is next opened fresh (tab switch or page refresh). TODO_PIN remembers which section
      each id was painted in; a fresh paint (anim=true, or a new tab) rebuilds it.
   2. Comments. item.notes = [{id, by, at, text}]. Tap the text to open the thread. Posting goes
      through mutate() like every other write, so two phones never clobber each other.
      A comment from the other person after you last opened the tab counts as "new for you". */
var TODO_PIN={}, TODO_FRESH=true, OPEN_NOTES={}, LAST_TAB=null;
function notesOf(i){ return (i.notes||[]).slice(); }
function todoRow(i){
  var r=el('div','row'+(i.done?' done':''));
  var t=el('button','tick'); t.setAttribute('aria-label',i.done?'Mark not done':'Mark done');
  t.onclick=function(){
    r.classList.toggle('done');                        /* feedback NOW, before the round trip */
    mutate('todo',function(items){ return items.map(function(x){
      if(x.id!==i.id) return x; var y=Object.assign({},x); y.done=!x.done; y.done_at=y.done?iso():null; y.done_by=y.done?EMAIL:null; return y; }); }); };
  r.appendChild(t);
  var f=forOf(i), label=f==='both'?'Both':(f===ME?'You':(f==='sam'?'Sam':'Amy'));
  var notes=notesOf(i), open=!!OPEN_NOTES[i.id];
  var moved=TODO_PIN[i.id]==='open'&&i.done;
  var bd=el('div','body','<div class="t">'+esc(i.text)+'</div><div class="meta"><span class="tag'+((f===ME||f==='both')?' me':'')+'">'+
    esc(label)+'</span>added by '+esc(byName(i.by)===(ME==='sam'?'Sam':'Amy')?'you':byName(i.by))+
    (moved?' · <span class="just">done ✓ moves down on refresh</span>':'')+
    ' · <button class="nlnk" aria-expanded="'+(open?'true':'false')+'">'+(notes.length?notes.length+(notes.length===1?' comment':' comments'):'comment')+'</button></div>');
  var toggle=function(){ OPEN_NOTES[i.id]=!OPEN_NOTES[i.id]; render(); };
  bd.querySelector('.t').onclick=toggle; bd.querySelector('.nlnk').onclick=toggle;
  if(open){
    var th=el('div','thread');
    notes.forEach(function(n){ th.appendChild(el('div','note','<span class="nby">'+esc(stamp({by:n.by,at:n.at}))+'</span>'+esc(n.text))); });
    var ar=el('div','addrow'); ar.innerHTML='<input type="text" placeholder="Say something…" autocomplete="off" autocapitalize="sentences" aria-label="Comment"><button class="btn">Post</button>';
    var inp=ar.querySelector('input');
    var post=function(){ var v=inp.value.trim(); if(!v) return; inp.value='';
      var n={id:uid('n'),by:EMAIL,at:iso(),text:v};
      mutate('todo',function(items){ return items.map(function(x){ if(x.id!==i.id) return x; var y=Object.assign({},x); y.notes=notesOf(x).concat([n]); return y; }); }).then(function(){render();}); };
    ar.querySelector('button').onclick=post; inp.addEventListener('keydown',function(e){if(e.key==='Enter')post();});
    th.appendChild(ar); bd.appendChild(th);
  }
  r.appendChild(bd);
  var x=el('button','x','×'); x.setAttribute('aria-label','Delete');
  x.onclick=function(){ mutate('todo',function(items){return items.filter(function(y){return y.id!==i.id;});}); };
  r.appendChild(x);
  return r;
}
function paintTodo(b){
  SEEN_MEM=iso(); try{ localStorage.setItem('hub.todoSeen',SEEN_MEM); }catch(e){}
  var other=ME==='sam'?'amy':'sam';
  if(NEWFOR===null) NEWFOR=other;
  var add=el('div','add card');
  add.innerHTML='<div class="addrow"><input id="tIn" type="text" placeholder="Add something…" autocomplete="off" autocapitalize="sentences" aria-label="New to-do"><button class="btn pri" id="tAdd">Add</button></div>'+
    '<div class="chips" id="tFor"></div>';
  b.appendChild(add);
  var ch=add.querySelector('#tFor');
  [['sam',ME==='sam'?'Me':'Sam'],['amy',ME==='amy'?'Me':'Amy'],['both','Both']].forEach(function(o){
    var c=el('button','chip'+(NEWFOR===o[0]?' on':''),'For '+esc(o[1]));
    c.onclick=function(){NEWFOR=o[0];ch.querySelectorAll('.chip').forEach(function(z){z.classList.remove('on');});c.classList.add('on');};
    ch.appendChild(c);
  });
  var inp=add.querySelector('#tIn');
  function go(){
    var v=inp.value.trim(); if(!v) return;
    var item={id:uid('h'),text:v,by:EMAIL,added_at:iso(),done:false,'for':NEWFOR};
    inp.value=''; mutate('todo',function(items){items.push(item);return items;}).then(function(){render();});
  }
  add.querySelector('#tAdd').onclick=go;
  inp.addEventListener('keydown',function(e){if(e.key==='Enter')go();});

  if(!gate(b,'todo','the to-do list')) return;
  var fl=el('div','chips'); fl.style.marginTop='14px';
  [['mine','Mine'],['all','Everything']].forEach(function(o){
    var c=el('button','chip'+(FILTER===o[0]?' on':''),o[1]); c.onclick=function(){FILTER=o[0];render();}; fl.appendChild(c);
  });
  b.appendChild(fl);
  var items=todoItems().filter(function(i){ return FILTER==='all'||forOf(i)===ME||forOf(i)==='both'; });
  if(TODO_FRESH){ TODO_PIN={}; TODO_FRESH=false; }
  items.forEach(function(i){ if(!TODO_PIN[i.id]) TODO_PIN[i.id]=i.done?'done':'open'; });
  var open=items.filter(function(i){return TODO_PIN[i.id]==='open';}), done=items.filter(function(i){return TODO_PIN[i.id]==='done';});
  if(!items.length){ b.appendChild(el('div','quiet',FILTER==='mine'?'Nothing on your list.':'The list is empty.')); return; }
  if(open.length){ b.appendChild(el('div','sec','Open · '+open.length)); var c1=el('div'); open.forEach(function(i){c1.appendChild(todoRow(i));}); b.appendChild(c1); }
  if(done.length){ b.appendChild(el('div','sec','Done · '+done.length)); var c2=el('div'); done.forEach(function(i){c2.appendChild(todoRow(i));}); b.appendChild(c2); }
}

/* ══ MEALS ═════════════════════════════════════════════════════════════════
   Read-only by design (Sam, 2026-09-23): Amy plans in the West Family Meals Sheet, usually
   through her own Claude, and this page reads and posts. The Sheet's URL rides in the feed,
   not in this file, so the public repo never carries it. */
function paintMeals(b){
  var f=famFeed(b); if(!f) return;
  var m=f.meals||{}, today=laDate(0);
  if(m.sheet_url){ var a=el('a','btn','Open the meal plan Sheet ›'); a.href=m.sheet_url; a.target='_blank'; a.rel='noopener';
    a.style.cssText='display:block;text-align:center;text-decoration:none;margin-bottom:6px;line-height:20px'; b.appendChild(a); }
  if(!/^ok/.test(f.meals_status||'')){
    b.appendChild(el('div','miss','<b>Meals were not in this morning\'s feed:</b> '+esc(f.meals_status||'unknown')+'. Unknown, not empty. The Sheet itself is unaffected.'));
    return;
  }
  if(f.meals_status!=='ok') b.appendChild(el('div','bar warn',esc(f.meals_status)+'. A header on This Week was renamed; that column is not showing.'));
  var plan=(m.plan||[]).filter(function(x){return x.date>=today;});
  b.appendChild(el('div','sec','The plan'+(f.date!==today?'<em>as of '+esc(dayLabel(f.date))+'</em>':'')));
  if(!plan.length) b.appendChild(el('div','quiet','Nothing planned from today on. Amy adds the week in the Sheet.'));
  else{
    var by={}, order=[];
    plan.forEach(function(x){ if(!by[x.date]){by[x.date]=[];order.push(x.date);} by[x.date].push(x); });
    var c=el('div','card');
    order.forEach(function(d){
      var g=el('div','day'+(d===today?' now':'')); g.appendChild(el('h3','',esc(dayLabel(d))));
      by[d].forEach(function(x){ g.appendChild(el('div','meal','<div class="s">'+esc(x.slot)+'</div><div class="m">'+esc(x.dish)+
        ((x.cook||x.notes)?'<small>'+esc([x.cook,x.notes].filter(Boolean).join(' · '))+'</small>':'')+'</div>')); });
      c.appendChild(g);
    });
    b.appendChild(c);
  }
  var sh=m.shopping||[];
  b.appendChild(el('div','sec','Shopping<em>'+sh.filter(function(x){return !x.got;}).length+' to get</em>'));
  if(!sh.length) b.appendChild(el('div','quiet','Shopping list is empty.'));
  else{
    var sc=el('div','card'), secs={}, so=[];
    sh.forEach(function(x){var k=x.section||'Other'; if(!secs[k]){secs[k]=[];so.push(k);} secs[k].push(x);});
    so.forEach(function(k){
      sc.appendChild(el('div','day','<h3>'+esc(k)+'</h3>'));
      secs[k].sort(function(a,b){return a.got-b.got;}).forEach(function(x){
        sc.appendChild(el('div','shop'+(x.got?' got':''),'<span class="q">'+esc(x.qty)+'</span><span>'+esc(x.item)+
          (x['for']?' <span style="color:var(--ink-faint)">· '+esc(x['for'])+'</span>':'')+'</span>'));
      });
    });
    b.appendChild(sc);
  }
  if((m.framework||[]).length){
    b.appendChild(el('div','sec','Amy\'s framework'));
    var d=el('details','card'); d.appendChild(el('summary','','How the week is planned'));
    m.framework.forEach(function(x){ d.appendChild(el('div','kv','<div class="k">'+esc(x.topic)+'</div><div class="v">'+esc(x.detail)+'</div>')); });
    b.appendChild(d);
  }
}


/* ══ OCTOBER ═══════════════════════════════════════════════════════════════
   Seasonal tab, added 2026-10-01 at Sam's call: share the October plan with Amy "in a way that
   allows her to determine if she wants to have her claude push the items into a shopping cart
   and start planning the events."
   Content is family/october (seed_october.py, read-only here). Every choice either of you makes
   is household/october, written as the signed-in person. Each write touches ONE key with
   set(...,{merge:true}), so two phones choosing at once cannot erase each other's picks.
   The plan file Amy's Claude reads is Family/Shared with Amy/october-plan.md (Drive mirror);
   the Copy button hands her Claude the choices, because her Claude cannot read Firestore. */
function octSt(){ return (SRC.octst.ready&&!SRC.octst.err&&SRC.octst.data)||{}; }
function octSet(obj){
  obj.updated_at=iso(); obj.updated_by=EMAIL;
  return SRC.octst.ref().set(obj,{merge:true})
    .catch(function(e){ flash('Could not save ('+((e&&e.code)||e)+'). Nothing was changed; try again.'); });
}
function stamp(o){ if(!o||!o.by) return ''; var n=byName(o.by); return (n===(ME==='sam'?'Sam':'Amy')?'you':n)+(o.at?' · '+dayLabel(o.at.slice(0,10)):''); }
function money(n){ return '$'+(+n).toFixed(2); }
function evWhen(e){ return dayLabel(e.date)+' · '+e.time; }
function octToday(b){
  if(!SRC.oct.ready||SRC.oct.err||!SRC.oct.data) return;
  var d=(SRC.oct.data.days||[]).filter(function(x){return x.date===laDate(0);})[0]; if(!d) return;
  var st=(octSt().days||{})[d.n]||{};
  b.appendChild(el('div','sec','October · day '+d.n+'<em>'+(st.done?'done':'tonight')+'</em>'));
  var c=el('div','card'); c.style.borderLeftColor='var(--lcars5)';
  c.innerHTML='<b>'+esc(d.title)+'</b><div class="line">'+esc(d.how)+'</div>'+(d.event?'<div class="line pk"><b>Event</b>'+esc(d.event)+'</div>':'');
  var go=el('button','lnk','Open October ›'); go.onclick=function(){o.setTab('oct',true);};
  c.appendChild(go); b.appendChild(c);
}
var OCT_SHOW_PAST=false;
var CART_URL='https://www.amazon.com/gp/cart/view.html';
function paintOct(b){
  if(!gate(b,'oct','the October plan')) return;
  var f=SRC.oct.data;
  if(!f){ b.appendChild(el('div','miss','<b>The October plan has not been posted.</b> seed_october.py writes it; it has not run yet.')); return; }
  var st=octSt(), stOk=SRC.octst.ready&&!SRC.octst.err;
  b.appendChild(el('div','bar','A cozy-house and Halloween plan for the month: a small cart, free events, and one thing to do each day. Choices made here show on both phones right away.'));
  if(SRC.octst.err) b.appendChild(el('div','miss','<b>Could not load your choices</b> ('+esc(SRC.octst.err)+'). The plan below is fine; picks will not save until this clears.'));

  /* ── 2. the cart ── */
  var skip=st.skip||{}, cart=f.cart||[];
  var kept=cart.filter(function(c){return !(skip[c.asin]&&skip[c.asin].on);});
  var tot=kept.reduce(function(a,c){return a+(+c.price);},0);
  var ordered=(st.order||{}).v==='ordered';
  b.appendChild(el('div','sec','The cart<em>'+kept.length+' of '+cart.length+' kept</em>'));
  var cc=el('div','card');
  var lead=el('div','',ordered
    ? '<b style="color:var(--mint)">Ordered.</b> <span class="n" style="color:var(--ink-mute)">Marked by '+esc(stamp(st.order))+'.</span>'
    : '<b>All '+cart.length+' items are in our shared Amazon cart now.</b> Nothing is ordered. Untick anything to drop, take the drops out of the cart, and check out when you\'re happy.');
  lead.style.cssText='font-size:14px;line-height:1.45;color:var(--ink-soft);margin-bottom:6px';
  cc.appendChild(lead);
  var la=el('a','lnk','Open the Amazon cart ›'); la.href=CART_URL; la.target='_blank'; la.rel='noopener'; la.style.display='inline-block'; la.style.textDecoration='none';
  cc.appendChild(la);
  [['house','For the house'],['kids','For the activities']].forEach(function(g){
    cc.appendChild(el('div','day','<h3>'+g[1]+'</h3>'));
    cart.filter(function(c){return c.role===g[0];}).forEach(function(c){
      var sk=skip[c.asin]&&skip[c.asin].on;
      var r=el('div','oc-it'+(sk?' skip':''));
      var k=el('button','keep'+(sk?'':' on')); k.setAttribute('aria-label',sk?'Keep this item':'Drop this item');
      k.onclick=function(){ if(!stOk) return; var o={}; o[c.asin]={on:!sk,by:EMAIL,at:iso()}; octSet({skip:o}); };
      r.appendChild(k);
      r.appendChild(el('div','body','<div class="t">'+esc(c.name)+'</div><div class="n">'+esc(c.note)+(sk?' · dropped by '+esc(stamp(skip[c.asin])):'')+'</div>'));
      var p=el('div','p',esc(money(c.price))); var a=el('a','','View ›'); a.href=c.url; a.target='_blank'; a.rel='noopener'; p.appendChild(a);
      r.appendChild(p); cc.appendChild(r);
    });
  });
  cc.appendChild(el('div','oc-tot','<span>Kept, before tax</span><b>'+esc(money(tot))+'</b>'));
  var ob=el('button','btn'+(ordered?'':' pri'),ordered?'Undo: not ordered yet':'Mark as ordered'); ob.style.cssText='width:100%;margin-top:12px';
  ob.onclick=function(){ if(!stOk) return; octSet({order:{v:ordered?'':'ordered',by:EMAIL,at:iso()}}); };
  cc.appendChild(ob);
  b.appendChild(cc);

  /* ── 3. events ── */
  var rs=st.rsvp||{}, evs=(f.events||[]).filter(function(e){return e.date>=laDate(0);});
  b.appendChild(el('div','sec','Free events<em>'+evs.filter(function(e){return (rs[e.id]||{}).v==='go';}).length+' going</em>'));
  var ec=el('div','card');
  if(!evs.length) ec.appendChild(el('div','quiet','No events left this month.'));
  evs.forEach(function(e){
    var cur=(rs[e.id]||{}).v||'';
    var r=el('div','oc-ev');
    r.innerHTML='<div class="when">'+esc(evWhen(e))+(e.fits?'':' · <span style="color:var(--amber)">bonus</span>')+'</div>'+
      '<div class="what">'+esc(e.title)+'<small>'+esc(e.where)+' · '+esc(e.cost)+'</small><small>'+esc(e.note)+'</small></div>';
    var ch=el('div','chips');
    [['go','Going'],['mb','Maybe'],['no','Pass']].forEach(function(o){
      var c=el('button','chip '+o[0]+(cur===o[0]?' on':''),o[1]);
      c.onclick=function(){ if(!stOk) return; var x={}; x[e.id]={v:cur===o[0]?'':o[0],by:EMAIL,at:iso()}; octSet({rsvp:x}); };
      ch.appendChild(c);
    });
    r.appendChild(ch);
    if(cur) r.appendChild(el('div','by','set by '+esc(stamp(rs[e.id]))));
    ec.appendChild(r);
  });
  b.appendChild(ec);

  /* ── 4. hand it to Claude ── */
  b.appendChild(el('div','sec','Hand it to your Claude'));
  var hc=el('div','card');
  hc.appendChild(el('div','line','Copies a message with your picks. Paste it to your Claude and it can take the dropped items out of the shared cart (it never checks out) and put the Going events on the family calendar. The full plan is in your Drive, in <b>Shared with Amy</b> → october-plan.md.'));
  var cp=el('button','btn pri','Copy for my Claude'); cp.style.cssText='width:100%;margin-top:12px';
  var ta=el('textarea','oc-pr'); ta.readOnly=true; ta.value=octPrompt(f,st,kept,tot); ta.setAttribute('aria-label','Message for Claude');
  cp.onclick=function(){
    var done=function(){ cp.textContent='Copied ✓'; setTimeout(function(){cp.textContent='Copy for my Claude';},2500); };
    var fall=function(){ ta.focus(); ta.select(); cp.textContent='Selected: tap Copy'; };
    try{ navigator.clipboard.writeText(ta.value).then(done,fall); }catch(e){ fall(); }
  };
  hc.appendChild(cp);
  var dt=el('details',''); dt.appendChild(el('summary','lnk','Show the message')); dt.appendChild(ta); dt.style.marginTop='8px';
  hc.appendChild(dt);
  b.appendChild(hc);

  /* ── 5. one thing a day ── */
  var ds=st.days||{}, today=laDate(0), all=f.days||[];
  var nDone=all.filter(function(d){return (ds[d.n]||{}).done;}).length;
  b.appendChild(el('div','sec','One thing a day<em>'+nDone+' of '+all.length+' done</em>'));
  var past=all.filter(function(d){return d.date<today;}), rest=all.filter(function(d){return d.date>=today;});
  var dc=el('div','card');
  function dayRow(d){
    var s=ds[d.n]||{};
    var r=el('div','row oc-day'+(s.done?' done':'')+(d.date===today?' now':''));
    var t=el('button','tick'); t.setAttribute('aria-label',s.done?'Mark not done':'Mark done');
    t.onclick=function(){ if(!stOk) return; var o={}; o[d.n]={done:!s.done,by:EMAIL,at:iso()}; octSet({days:o}); };
    r.appendChild(t);
    r.appendChild(el('div','body','<div class="t">'+esc(d.title)+'</div><div class="meta"><b>'+esc(d.wd+' '+d.n)+'</b> · '+esc(d.how)+
      (d.event?' <span style="color:var(--cyan)">'+esc(d.event)+'</span>':'')+(s.done&&s.by?' · ticked by '+esc(stamp(s)):'')+'</div>'));
    return r;
  }
  if(past.length){
    var tg=el('button','lnk',OCT_SHOW_PAST?'Hide earlier days':'Show '+past.length+' earlier day'+(past.length>1?'s':''));
    tg.onclick=function(){OCT_SHOW_PAST=!OCT_SHOW_PAST;render();}; dc.appendChild(tg);
    if(OCT_SHOW_PAST) past.forEach(function(d){dc.appendChild(dayRow(d));});
  }
  rest.forEach(function(d){dc.appendChild(dayRow(d));});
  b.appendChild(dc);

  if((f.notes||[]).length){
    b.appendChild(el('div','sec','Good to know'));
    var nc=el('div','card'); f.notes.forEach(function(n){nc.appendChild(el('div','line',esc(n)));}); b.appendChild(nc);
  }
}
function octPrompt(f,st,kept,tot){
  var rs=st.rsvp||{}, skip=st.skip||{};
  var go=(f.events||[]).filter(function(e){return (rs[e.id]||{}).v==='go';});
  var mb=(f.events||[]).filter(function(e){return (rs[e.id]||{}).v==='mb';});
  var sk=(f.cart||[]).filter(function(c){return skip[c.asin]&&skip[c.asin].on;});
  var L=[];
  L.push('Sam put together an October plan for the house and the kids. The full plan is in my Google Drive, in the folder "Shared with Amy", file october-plan.md. Read it first, including the "For Amy\'s Claude" section.');
  L.push('');
  L.push('Here is what I picked on the family hub:');
  L.push('');
  L.push('1. Sam and I share one Amazon cart, and all '+(f.cart||[]).length+' items are already in it. Do not add anything.');
  if(sk.length){
    L.push('   Open the cart in Chrome (https://www.amazon.com/gp/cart/view.html) and delete only these items:');
    sk.forEach(function(c){ L.push('   - '+c.name+' ('+money(c.price)+')'); });
    L.push('   That leaves '+kept.length+' items, about '+money(tot)+' before tax.');
  } else {
    L.push('   I\'m keeping all of them ('+money(tot)+' before tax), so leave the cart as it is.');
  }
  L.push('   Do not check out. I\'ll order myself.');
  L.push('');
  if(go.length){
    L.push('2. Add these events to the West Family Calendar (title, time and address as listed):');
    go.forEach(function(e){ L.push('   - '+evWhen(e)+': '+e.title+', '+e.where+' ('+e.cost+')'); });
  } else {
    L.push('2. I haven\'t marked any events as Going yet, so don\'t add anything to the calendar.');
  }
  if(mb.length){ L.push('   Maybes, don\'t add yet: '+mb.map(function(e){return evWhen(e)+' '+e.title;}).join('; ')+'.'); }
  L.push('');
  L.push('3. Add a short line under "Log" at the bottom of october-plan.md saying what you did, using the Starfleet edit bridge described in "README - for Amy\'s Claude.md" in the same folder. Read the file first and send the whole file back with replace. Never make a copy.');
  return L.join('\n');
}
/* ══ INFO ══════════════════════════════════════════════════════════════════
   Two kinds of thing, kept visibly apart: facts from the school rules file (read-only, change
   them there and the 4am run carries them) and notes either of you writes here. */
var EDIT=null;
function paintInfo(b){
  var f=SRC.fam.ready&&!SRC.fam.err?SRC.fam.data:null;
  b.appendChild(el('div','sec','School day<em>from the school file</em>'));
  if(!SRC.fam.ready) b.appendChild(el('div','quiet','Loading…'));
  else if(!f||!f.school_facts) b.appendChild(el('div','miss',SRC.fam.err?'<b>Could not load</b> ('+esc(SRC.fam.err)+').':'Not in the feed yet.'));
  else{
    var sf=f.school_facts, bl=sf.bell||{}, c=el('div','card');
    [['Arrive from',h12(bl.arrive_no_earlier)],['First bell',h12(bl.first_bell)],['Tardy after',h12(bl.tardy)],
     ['Dismissal',h12(bl.dismissal)],['Wednesdays',h12(bl.wednesday_dismissal)],['Noon days',h12(bl.noon_dismissal)],
     ['Late pick-up',bl.late_pickup_note]].forEach(function(r){ if(r[1]) c.appendChild(el('div','kv','<div class="k">'+esc(r[0])+'</div><div class="v">'+esc(r[1])+'</div>')); });
    var ps=sf.pickup_spots||{};
    Object.keys(ps).forEach(function(k){ c.appendChild(el('div','kv','<div class="k">Pick-up, '+esc(k.replace(/_/g,' '))+'</div><div class="v">'+esc(ps[k])+'</div>')); });
    if(sf.mass&&sf.mass.weekday) c.appendChild(el('div','kv','<div class="k">Mass</div><div class="v">'+esc(sf.mass.weekday.replace(/^./,function(x){return x.toUpperCase();}))+' '+esc(h12(sf.mass.time))+', '+esc(sf.mass.note||'')+'</div>'));
    b.appendChild(c);
    (sf.activities||[]).forEach(function(a){
      var ac=el('div','card'); ac.appendChild(el('div','','<b>'+esc(a.name)+'</b>'+(a.status==='pending'?' <span class="tag">undecided</span>':'')));
      if(a.practice) ac.appendChild(el('div','line','Practice '+esc(cap(a.practice.weekday))+' '+esc(h12(a.practice.time))+', '+esc(a.practice.where||'')+(a.practice.note?' ('+esc(a.practice.note)+')':'')));
      if(a.games) ac.appendChild(el('div','line','Games '+esc(cap(a.games.weekday))+', '+esc(a.games.time||'')+(a.games.note?' ('+esc(a.games.note)+')':'')));
      b.appendChild(ac);
    });
    // Reference cards from the rules file's "info" list (Curriculum Night packet, handbook,
    // front-office email). Read-only here; change them in the school file.
    (sf.info||[]).forEach(function(sec,ix){
      var d=el('details','card'); if(ix===0) d.open=true;
      d.appendChild(el('summary','',esc(sec.title||'')));
      (sec.rows||[]).forEach(function(r){ d.appendChild(el('div','kv','<div class="k">'+esc(r.k)+'</div><div class="v">'+esc(r.v)+'</div>')); });
      b.appendChild(d);
    });
  }
  listSection(b,'acts','Activities','An activity',[['name','Activity (swim, soccer…)'],['when','When (Tue 4:30pm)'],['where','Where'],['notes','Notes, gear, contacts']],
    function(x){ return '<b>'+esc(x.name)+'</b>'+(x.when?'<div class="line">'+esc(x.when)+(x.where?' · '+esc(x.where):'')+'</div>':'')+(x.notes?'<div class="note-b">'+esc(x.notes)+'</div>':''); });
  listSection(b,'info','House notes','A note',[['title','Title (door code, sitter, pediatrician…)'],['body','Details']],
    function(x){ return '<b>'+esc(x.title)+'</b>'+(x.body?'<div class="note-b">'+esc(x.body)+'</div>':''); });
  var so=el('button','lnk','Sign out'); so.style.marginTop='26px'; so.onclick=function(){o.signOut();}; b.appendChild(so);
}
/* One editable list, used twice. Every write is a transaction by id (see mutate). */
function listSection(b,k,title,noun,fields,show){
  b.appendChild(el('div','sec',esc(title)));
  if(!gate(b,k,title.toLowerCase())) return;
  var items=(SRC[k].data&&SRC[k].data.items)||[];
  items.forEach(function(x){
    if(EDIT===k+':'+x.id){ b.appendChild(form(k,fields,x)); return; }
    var c=el('div','card'); c.innerHTML=show(x)+'<div class="meta" style="font-size:11.5px;color:var(--ink-faint);margin-top:8px">'+esc(byName(x.by||''))+(x.updated_at?' · '+esc(x.updated_at.slice(0,10)):'')+'</div>';
    var e=el('button','lnk','Edit'); e.onclick=function(){EDIT=k+':'+x.id;render();};
    var d=el('button','lnk','Delete'); d.style.cssText='color:var(--mag);margin-left:16px';
    d.onclick=function(){ if(d.textContent==='Delete'){d.textContent='Tap again to delete';return;}
      mutate(k,function(a){return a.filter(function(y){return y.id!==x.id;});}); };
    c.appendChild(e); c.appendChild(d); b.appendChild(c);
  });
  if(!items.length&&EDIT!==k+':new') b.appendChild(el('div','quiet','None yet.'));
  if(EDIT===k+':new') b.appendChild(form(k,fields,null));
  else{ var a=el('button','btn','+ '+esc(noun)); a.style.cssText='width:100%;margin-top:10px'; a.onclick=function(){EDIT=k+':new';render();}; b.appendChild(a); }
}
function form(k,fields,x){
  var f=el('div','add card');
  fields.forEach(function(fd,ix){
    var multi=(fd[0]==='body'||fd[0]==='notes');
    var i=el(multi?'textarea':'input','fld'); i.placeholder=fd[1]; i.value=(x&&x[fd[0]])||''; i.setAttribute('data-f',fd[0]);
    if(!multi) i.type='text'; f.appendChild(i);
  });
  var r=el('div','addrow'); var s=el('button','btn pri','Save'), c=el('button','btn','Cancel');
  c.onclick=function(){EDIT=null;render();};
  s.onclick=function(){
    var v={}; f.querySelectorAll('[data-f]').forEach(function(i){v[i.getAttribute('data-f')]=i.value.trim();});
    if(!v[fields[0][0]]) return;
    var id=x?x.id:uid(k[0]); EDIT=null;
    // Blur first so render() is not held off by a focused, non-empty field.
    var ae=ROOT.activeElement||document.activeElement; if(ae&&ae.blur) ae.blur();
    mutate(k,function(a){
      var o=Object.assign({},v,{id:id,by:x?(x.by||EMAIL):EMAIL,updated_at:iso()});
      var hit=false; a=a.map(function(y){ if(y.id===id){hit=true;return Object.assign({},y,o);} return y; });
      if(!hit) a.push(o); return a;
    }).then(function(){render();});
  };
  r.appendChild(s); r.appendChild(c); f.appendChild(r);
  setTimeout(function(){var q=f.querySelector('[data-f]'); if(q&&!x) q.focus();},30);
  return f;
}

return {
  start:function(){ if(!STOPPED) subscribe(); },
  stop:function(){ STOPPED=true; unsub.forEach(function(f){try{f();}catch(e){}}); unsub=[]; },
  hold:function(anim){ if(!anim && typing()){ PENDING=true; return true; } PENDING=false; return false; },
  status:function(){
    return {
      liveAll:Object.keys(SRC).every(function(k){return SRC[k].ready&&(SRC[k].live||SRC[k].err);}),
      denied:Object.keys(SRC).every(function(k){return SRC[k].err==='permission-denied';})
    };
  },
  paint:function(tab,anim){
    if(anim||tab!==LAST_TAB){ TODO_FRESH=true; LAST_TAB=tab; }
    var p=PANE; p.innerHTML=''; var box=el('div',anim?'pane':'');
    if(flashMsg) box.appendChild(el('div','bar warn',esc(flashMsg)));
    (({today:paintToday,todo:paintTodo,meals:paintMeals,info:paintInfo,oct:paintOct})[tab]||paintToday)(box);
    p.appendChild(box);
  },
  todoFresh:function(){ return todoFresh(); }
};
  }
};
})();
