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
  octst:{ref:function(){return db.collection('household').doc('october');}},
  rreq:{ref:function(){return db.collection('household').doc('recipe_requests');}},
  /* Meal suggestions (MEAL-SUGGEST-SPEC.md, 2026-10-13): Keep / Try another / Not for us, one key
     per suggestion id with merge, read and cleared by the next morning's run. */
  mfb:{ref:function(){return db.collection('household').doc('meal_feedback');}},
  /* QFC cart (RECIPE-CART-SPEC.md §10). kroger: {linked, by, store, error}, written by the Mac's
     runner. cartreq: one entry per recipe key, written here as queued and rewritten by the runner
     as added or failed. Both household docs, so Amy and Sam read and write them alike. */
  kroger:{ref:function(){return db.collection('household').doc('kroger');}},
  cartreq:{ref:function(){return db.collection('household').doc('cart_requests');}},
  /* School tab (2026-11-09): items from feed_school.py, and each person's choices on them. */
  school:{ref:function(){return db.collection('family').doc('school');}},
  smarks:{ref:function(){return db.collection('household').doc('school');}}
};
/* Each source holds three separate facts: whether it has answered at all (ready), what it
   said (data, null when the doc does not exist), and whether it failed (err). "Not loaded",
   "loaded and empty" and "could not load" render three different ways, always. */
Object.keys(SRC).forEach(function(k){SRC[k].ready=false;SRC[k].data=null;SRC[k].err=null;SRC[k].live=false;});
var unsub=[];
/* Live Sheet read (Sam, 2026-10-15). The hub fetches the This Week tab itself when it opens,
   so a row Amy adds shows within a minute instead of at the next 4am feed. The feed still owns
   recipes, carts and suggestions; this only decides WHICH rows show: the Sheet always wins, a
   Sheet row hides the suggestion for its date and slot, and a feed row the Sheet no longer has
   is dropped. Needs the Sheet shared as anyone-with-the-link, view (set 2026-10-15). If the
   fetch fails the morning copy shows unchanged, with a note, never a blank. */
var SHEET_ID='1FXei9tocpk8aF7FTH5I6Nm53-pX7QfYl2UWmhSqETzc';
var SHEET={ready:false,rows:null,err:null,at:0,when:null};
var SLOTS=['Breakfast','Lunch','School lunch','Dinner','Snack'];
function csvParse(t){ var rows=[],row=[],f='',q=false,i,c;
  for(i=0;i<t.length;i++){ c=t[i];
    if(q){ if(c==='"'){ if(t[i+1]==='"'){f+='"';i++;} else q=false; } else f+=c; }
    else if(c==='"') q=true;
    else if(c===','){ row.push(f); f=''; }
    else if(c==='\n'||c==='\r'){ if(c==='\r'&&t[i+1]==='\n') i++; row.push(f); rows.push(row); row=[]; f=''; }
    else f+=c; }
  if(f.length||row.length){ row.push(f); rows.push(row); }
  return rows; }
function isoDate(s){ s=(s||'').trim(); var m;
  if(/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0,10);
  if((m=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/))) return m[3]+'-'+('0'+m[1]).slice(-2)+'-'+('0'+m[2]).slice(-2);
  return null; }
function slotKey(s){ var n=(s||'').trim().toLowerCase().replace(/\s+/g,' '); if(!n) return 'Dinner';
  for(var i=0;i<SLOTS.length;i++) if(SLOTS[i].toLowerCase()===n) return SLOTS[i]; return (s||'').trim(); }
function fetchSheet(force){
  if(STOPPED) return;
  if(!force && SHEET.at && Date.now()-SHEET.at<120000) return;
  SHEET.at=Date.now();
  if(typeof fetch!=='function'){ SHEET.ready=true; SHEET.err='no fetch'; return; }
  var u='https://docs.google.com/spreadsheets/d/'+SHEET_ID+'/gviz/tq?tqx=out:csv&sheet=This%20Week&_='+Date.now();
  fetch(u,{cache:'no-store'}).then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.text(); })
  .then(function(t){ var rows=csvParse(t); if(!rows.length) throw new Error('empty');
    var h=rows[0].map(function(x){return x.trim().toLowerCase();}), ix={};
    ['date','slot','dish','cook','notes'].forEach(function(k){ ix[k]=h.indexOf(k); });
    if(ix.date<0||ix.dish<0) throw new Error('header row changed');
    var out=[]; rows.slice(1).forEach(function(r){ var d=isoDate(r[ix.date]), dish=(r[ix.dish]||'').trim(); if(!d||!dish) return;
      out.push({date:d, slot_raw:(ix.slot<0?'':r[ix.slot]||'').trim(), dish:dish,
                cook:ix.cook<0?'':(r[ix.cook]||'').trim(), notes:ix.notes<0?'':(r[ix.notes]||'').trim()}); });
    SHEET.ready=true; SHEET.err=null; SHEET.rows=out; SHEET.when=new Date(); render(); })
  .catch(function(e){ SHEET.ready=true; SHEET.err=String((e&&e.message)||e); render(); }); }
document.addEventListener('visibilitychange',function(){ if(document.visibilityState==='visible') fetchSheet(false); });
/* The plan the hub shows: live Sheet rows over the morning feed, suggestions only for slots the
   Sheet leaves open. A Sheet row that matches a feed row (same date, slot and dish) keeps the
   feed row, and with it the recipe and cart; a new or changed row shows plain until the next
   feed writes its recipe. */
function livePlan(f){
  var m=(f&&f.meals)||{}, plan=(m.plan||[]).slice(), today=laDate(0);
  if(!SHEET.ready||SHEET.err||!SHEET.rows) return {plan:plan, live:false};
  var feedK={}, liveK={}, out=[];
  plan.forEach(function(x){ if(!x.suggested) feedK[x.date+'|'+slotKey(x.slot)]=x; });
  SHEET.rows.forEach(function(r){ if(r.date<today) return; var sk=slotKey(r.slot_raw), k=r.date+'|'+sk; if(liveK[k]) return; liveK[k]=true;
    var fx=feedK[k];
    if(fx && (fx.dish||'').trim().toLowerCase()===r.dish.toLowerCase()) out.push(fx);
    else out.push({date:r.date, slot:SLOTS.indexOf(sk)>=0?sk:'Other', dish:r.dish, cook:r.cook, notes:r.notes, live:true}); });
  plan.forEach(function(x){ if(x.suggested && !liveK[x.date+'|'+slotKey(x.slot)]) out.push(x); });
  var order={'Prep':0,'Breakfast':1,'Snack':2,'Lunch':3,'School lunch':4,'Dinner':5,'Other':6};
  out.sort(function(a,b){ return a.date<b.date?-1:a.date>b.date?1:(order[a.slot]==null?9:order[a.slot])-(order[b.slot]==null?9:order[b.slot]); });
  return {plan:out, live:true};
}
function sheetNote(){
  if(!SHEET.ready) return el('div','quiet','Checking the Sheet for changes since this morning…');
  if(SHEET.err) return el('div','quiet','Could not check the Sheet just now ('+esc(SHEET.err)+'); showing this morning’s copy.');
  var t=SHEET.when, hh=t.getHours(), mm=('0'+t.getMinutes()).slice(-2);
  return el('div','quiet','Sheet checked at '+((hh%12)||12)+':'+mm+(hh<12?'am':'pm')+'. Rows added there show here within a minute or two; recipes arrive with the morning feed.');
}
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
  /* 2026-11-08 (family overhaul): resolves to the saved array, or false when the save failed,
     so a caller can put a typed draft back instead of losing it. The flash still says why. */
  var ref=SRC[k].ref(), out=null;
  return db.runTransaction(function(tx){
    return tx.get(ref).then(function(s){
      var items=((s.exists&&s.data().items)||[]).slice();
      out=fn(items);
      tx.set(ref,{items:out,updated_at:iso(),updated_by:EMAIL},{merge:true});
    });
  }).then(function(){ return out||[]; })
    .catch(function(e){ flash('Could not save ('+((e&&e.code)||e)+'). Nothing was changed; try again.'); return false; });
}
var flashMsg='';
function flash(m){flashMsg=m;render();setTimeout(function(){flashMsg='';render();},6000);}


/* Held repaints. A listener firing while someone is typing waits until they leave the field,
   then paints once. The 250ms is load-bearing: focusout fires on the press of the Save button,
   BEFORE its click, and repainting inside that gap would delete the button under the finger.
   focusout is a composed event, so this hears a field inside the Bridge's shadow root too. */
var PENDING=false;
function typing(){ var a=ROOT.activeElement;
  return !!(a && (a.tagName==='INPUT'||a.tagName==='TEXTAREA') && !a.readOnly && PANE.contains(a)); }
document.addEventListener('focusout',function(){
  setTimeout(function(){ if(!STOPPED && PENDING && !typing() && !PDOWN) render(); },250);
});
/* 2026-11-08: a repaint landing between a finger going down and the click firing replaced the
   button under it, so the tap went nowhere. Hold while a pointer is down on the pane, then
   paint once 250ms after it lifts (after the click). The 4s timer is a backstop for a
   pointerup that never arrives. */
var PDOWN=false, PD_T=null;
function pdClear(){ if(!PDOWN) return; PDOWN=false; clearTimeout(PD_T);
  setTimeout(function(){ if(!STOPPED && PENDING && !typing() && !PDOWN) render(); },250); }
document.addEventListener('pointerdown',function(e){
  var path=e.composedPath?e.composedPath():[];
  if(path.indexOf(PANE)<0) return;
  PDOWN=true; clearTimeout(PD_T); PD_T=setTimeout(pdClear,4000);
},true);
document.addEventListener('pointerup',pdClear,true);
document.addEventListener('pointercancel',pdClear,true);

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

    // Learning games (2026-11-08, Sam): the phone games that go with Lucy's printed home kit.
    // A plain link to games.html, a static page with no family data in it.
    var lg=el('a','games-link','<span class="gl-em" aria-hidden="true">🍿</span><span class="gl-t"><b>Learning games</b><span>Popcorn Pop · Dr. Clinic · Robot Words · Frog Hop</span></span><span class="gl-go" aria-hidden="true">›</span>');
    lg.href='games.html'; b.appendChild(lg);

    // Taekwondo (2026-11-07, Sam): Lucy's Basic classes as OPTIONS, "available if we want
    // to take her". Read from the academy schedule file by feed_family.py each morning.
    // Never a calendar event. Dashed, unfilled card so it reads as a choice, not a plan.
    b.appendChild(el('div','sec opt','Taekwondo<em>optional</em>'));
    var tk=(f.taekwondo||[]).filter(function(d){return d.date===today;})[0];
    if(!f.taekwondo) b.appendChild(el('div','quiet','Class times start with the next 4am run.'));
    else if(!tk) b.appendChild(el('div','quiet',(f.taekwondo_status&&f.taekwondo_status!=='ok')
      ? 'Class times unknown: '+esc(f.taekwondo_status) : 'No class times for today in the feed.'));
    else{
      var oc=el('div','card opt');
      var oh='<div class="optk">Available if we want to take her</div>';
      if(tk.status==='classes'&&(tk.classes||[]).length)
        oh+='<div class="optt">'+tk.classes.map(function(x){return '<span>'+esc(x.label)+'</span>';}).join('')+'</div>';
      if(tk.note) oh+='<div class="optn">'+esc(tk.note)+'</div>';
      (tk.events||[]).forEach(function(e){ oh+='<div class="optev">'+esc(e.title)+(e.time?' · '+esc(e.time):'')+'</div>'; });
      oc.innerHTML=oh; b.appendChild(oc);
    }

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
    var plan=livePlan(f).plan.filter(function(m){return m.date===today;});
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
var SAVING_NEW=false, NOTE_SAVING={}, TODO_SHOWN_LIVE=false, TODO_PIN={}, TODO_FRESH=true, OPEN_NOTES={}, LAST_TAB=null, NOTE_DRAFT={}, DRAFT_NEW='', OPEN_DONE=false;
function notesOf(i){ return (i.notes||[]).slice(); }
function todoRow(i){
  var r=el('div','row'+(i.done?' done':''));
  var t=el('button','tick'); t.setAttribute('aria-label',i.done?'Mark not done':'Mark done');
  t.onclick=function(){
    r.classList.toggle('done');                        /* feedback NOW, before the round trip */
    mutate('todo',function(items){ return items.map(function(x){
      if(x.id!==i.id) return x; var y=Object.assign({},x); y.done=!x.done; y.done_at=y.done?iso():null; y.done_by=y.done?EMAIL:null; return y; }); })
    .then(function(items){
      if(!items){ r.classList.toggle('done'); return; }   /* the save failed: undo the feedback */
      if(o.onTodo){ try{ o.onTodo(items,i.id); }catch(e){} }
    }); };
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
    inp.value=NOTE_DRAFT[i.id]||'';
    inp.addEventListener('input',function(){ NOTE_DRAFT[i.id]=inp.value; });
    var pb=ar.querySelector('button');
    if(NOTE_SAVING[i.id]){ inp.readOnly=true; pb.disabled=true; }
    var post=function(){ if(NOTE_SAVING[i.id]) return; var v=inp.value.trim(); if(!v) return;
      NOTE_SAVING[i.id]=true; inp.readOnly=true; pb.disabled=true;
      var n={id:uid('n'),by:EMAIL,at:iso(),text:v};
      mutate('todo',function(items){ return items.map(function(x){ if(x.id!==i.id) return x; var y=Object.assign({},x); y.notes=notesOf(x).concat([n]); return y; }); })
      .then(function(ok){ NOTE_SAVING[i.id]=false; NOTE_DRAFT[i.id]=ok?'':v; render(); }); };
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
  inp.value=DRAFT_NEW;
  inp.addEventListener('input',function(){ DRAFT_NEW=inp.value; });
  var addB=add.querySelector('#tAdd');
  if(SAVING_NEW){ inp.readOnly=true; addB.disabled=true; }
  function go(){
    if(SAVING_NEW) return;
    var v=inp.value.trim(); if(!v) return;
    var item={id:uid('h'),text:v,by:EMAIL,added_at:iso(),done:false,'for':NEWFOR};
    SAVING_NEW=true; inp.readOnly=true; addB.disabled=true;
    mutate('todo',function(items){items.push(item);return items;})
      .then(function(ok){ SAVING_NEW=false; DRAFT_NEW=ok?'':v; render(); });
  }
  add.querySelector('#tAdd').onclick=go;
  inp.addEventListener('keydown',function(e){if(e.key==='Enter')go();});

  if(!gate(b,'todo','the to-do list')) return;
  /* "New for you" clears only once the live list has been painted. Stamping before the gate
     (or off a cached copy) marked items seen that were never on screen. */
  if(SRC.todo.live){ SEEN_MEM=iso(); try{ localStorage.setItem('hub.todoSeen',SEEN_MEM); }catch(e){} TODO_SHOWN_LIVE=true; }
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
  if(open.length){ b.appendChild(el('div','sec want','Open<em>'+open.length+'</em>')); var c1=el('div','card list'); open.forEach(function(i){c1.appendChild(todoRow(i));}); b.appendChild(c1); }
  else b.appendChild(el('div','clear','Nothing open. All clear.'));
  if(o.todoNote){ var tn=''; try{ tn=o.todoNote()||''; }catch(e){} if(tn) b.appendChild(el('div','tnote',esc(tn))); }
  /* Done folds shut so a month of crossed-off items does not bury what is open. */
  if(done.length){
    var dd=el('details','fold'); dd.open=OPEN_DONE;
    dd.appendChild(el('summary','','<span>Done · '+done.length+'</span>'));
    dd.addEventListener('toggle',function(){ OPEN_DONE=dd.open; });
    var c2=el('div','foldb'); done.forEach(function(i){c2.appendChild(todoRow(i));}); dd.appendChild(c2); b.appendChild(dd);
  }
}

/* ══ MEALS ═════════════════════════════════════════════════════════════════
   Read-only by design (Sam, 2026-09-23): Amy plans in the West Family Meals Sheet, usually
   through her own Claude, and this page reads and posts. The Sheet's URL rides in the feed,
   not in this file, so the public repo never carries it. */
/* ── Recipes on the Meals tab (RECIPE-CART-SPEC.md §5, 2026-10-09) ──────────────────────
   The 4am run attaches one recipe per meal row (`recipe`) or says why not (`recipe_skip`).
   Four facts render four ways and must stay distinct: not a meal (plain row), not generated
   yet (faint "arrives with the morning feed"), recipe with a live link (amber button), and a
   recipe whose link is expired or was never created (disabled button, or the reason and no
   button). The button opens Instacart's own page, where Amy picks the store and unticks what
   is in the pantry; nothing on this page calls Instacart and no key is anywhere near it.
   "Try another" writes ONE key into household/recipe_requests with merge, same pattern as
   the October picks; the next morning's run regenerates that dish. Not live, on purpose. */
function mealKey(x){
  var n=function(v){return String(v==null?'':v).replace(/\s+/g,' ').trim().toLowerCase();};
  return n(x.slot)+'|'+n(x.dish)+'|'+n(x.notes);
}
function requestAnother(x,link){
  var obj={}; obj[mealKey(x)]={requested_at:iso(),by:EMAIL,attempt:((x.recipe&&x.recipe.attempt)||1)+1};
  obj.updated_at=iso(); obj.updated_by=EMAIL;
  link.textContent='asking...';
  return SRC.rreq.ref().set(obj,{merge:true}).then(function(){ ASKED[mealKey(x)]=true; link.textContent='tomorrow morning'; link.classList.add('done'); })
    .catch(function(e){ link.textContent='try another'; flash('Could not request a new recipe ('+((e&&e.code)||e)+'). Nothing changed; try again.'); });
}
/* ── QFC (Kroger) cart, 2026-10-09 ──────────────────────────────────────────────────────
   Instacart closed its developer program the day the Instacart button shipped, so the cart
   half runs on Kroger's open API instead. The page never holds a Kroger secret: it builds the
   sign-in URL from the client id the feed carries (public by design), Kroger sends Amy back to
   kroger.html, which stashes the one-time code in localStorage, and the next load of this file
   writes it to household/kroger_auth for the Mac's runner to exchange. Adding to the cart is
   the same shape: write a request, the Mac answers within a minute, the page listens. */
var QFC_AUTH='https://api.kroger.com/v1/connect/oauth2/authorize';
/* cart.basic:write only. The app was registered with Cart, Locations and Products, not Profile,
   and Kroger refuses the whole sign-in on one unknown scope (invalid_scope, 2026-10-09 19:30). */
var QFC_SCOPE='cart.basic:write';
function qfcCfg(){ var f=SRC.fam.data||{}; return f.kroger||null; }
function qfcState(){ var k=SRC.kroger; if(!k.ready||k.err) return {linked:false,unknown:true,err:k.err}; return k.data||{linked:false}; }
function qfcLinkUrl(cfg){
  var st=Math.random().toString(36).slice(2)+Date.now().toString(36);
  try{ localStorage.setItem('qfc.state',st); localStorage.setItem('qfc.return',location.pathname); }catch(e){}
  return QFC_AUTH+'?response_type=code&client_id='+encodeURIComponent(cfg.client_id)+'&redirect_uri='+encodeURIComponent(cfg.redirect_uri)+
    '&scope='+encodeURIComponent(QFC_SCOPE)+'&state='+encodeURIComponent(st);
}
/* kroger.html left {code, at} in localStorage. Hand it to the Mac exactly once. Codes are short
   lived, so anything older than ten minutes is dropped with a flash rather than sent. */
function qfcHandoff(){
  var raw=null; try{ raw=localStorage.getItem('qfc.code'); }catch(e){}
  if(!raw) return;
  try{ localStorage.removeItem('qfc.code'); }catch(e){}
  var o; try{ o=JSON.parse(raw); }catch(e){ return; }
  if(!o||!o.code) return;
  if(Date.now()-(o.at||0)>10*60000){ flash('The QFC sign-in took too long to come back. Tap Link QFC again.'); return; }
  var cfg=qfcCfg()||{};
  SRC.kroger.ref().set({linked:false,pending:true,at:iso()},{merge:true}).catch(function(){});
  db.collection('household').doc('kroger_auth').set({code:o.code,redirect_uri:cfg.redirect_uri||'',by:EMAIL,at:iso()},{merge:true})
    .then(function(){ flash('Linking your QFC account. This takes about a minute.'); })
    .catch(function(e){ flash('Could not hand the QFC sign-in to the Mac ('+((e&&e.code)||e)+'). Tap Link QFC again.'); });
}
function qfcRequest(x,upcs,btn){
  var obj={}; obj[mealKey(x)]={upcs:upcs,status:'queued',requested_at:iso(),by:EMAIL};
  obj.updated_at=iso(); obj.updated_by=EMAIL;
  btn.disabled=true; btn.textContent='Adding...';
  return SRC.cartreq.ref().set(obj,{merge:true})
    .catch(function(e){ btn.disabled=false; btn.textContent='Add to QFC cart'; flash('Could not send the cart request ('+((e&&e.code)||e)+'). Nothing was added; try again.'); });
}
var QFC_STALE_MS=3*60000, staleTimer=null;
function qfcStatus(x){
  var c=SRC.cartreq; if(!c.ready||c.err||!c.data) return null;
  var r=c.data[mealKey(x)]; if(!r||typeof r!=='object') return null;
  var age=Date.now()-Date.parse(r.requested_at||r.at||0);
  if(r.status==='queued'){
    var stale=age>QFC_STALE_MS;
    /* Nothing else repaints the pane while a request sits unanswered, so the "may be asleep"
       wording would never appear on its own. One timer, armed for the moment it becomes true. */
    if(!stale){ clearTimeout(staleTimer); staleTimer=setTimeout(function(){ render(); }, QFC_STALE_MS-age+250); }
    return {cls:'wait',text:stale?'Still adding... the Mac may be asleep. It will catch up when it wakes, and you can keep using the hub.':'Adding to your QFC cart...',busy:!stale};
  }
  if(r.status==='added') return {cls:'ok',text:'In your QFC cart, '+(r.added||0)+(r.added===1?' item':' items')+'. Finish in the QFC app.'};
  if(r.status==='failed') return {cls:'bad',text:'Could not add: '+(r.error||'unknown')};
  return null;
}

/* What survives a repaint. The panes are rebuilt from scratch on every data change (that is
   how they stay live), which used to close an open recipe and re-tick every box the moment
   the cart request landed, because the request itself is a data change. Per-session memory,
   keyed by meal key: which recipes are open, which upcs are unticked. */
var OPEN_RCP={}, UNTICKED={}, ASKED={}, OPEN_SEC={};
var VIEW_MEM=null;
function mealView(){ if(VIEW_MEM) return VIEW_MEM; var v=null; try{ v=localStorage.getItem('hub.mealView'); }catch(e){} return VIEW_MEM=(v==='day'?'day':'meal'); }
function setMealView(v){ VIEW_MEM=v; try{ localStorage.setItem('hub.mealView',v); }catch(e){} }
/* Suggested rows (MEAL-SUGGEST-SPEC.md §7). The Sheet always wins: Amy replaces a suggestion by
   planning that slot in the Sheet; nothing here writes the Sheet. Feedback is not live on
   purpose: the next morning's run reads it, logs it to the preference corpus, and refills. */
function fbOf(x){ var d=(SRC.mfb.ready&&!SRC.mfb.err&&SRC.mfb.data)||{}, f=d[x.sid]; return (f&&typeof f==='object'&&f.dish===x.dish)?f:null; }
function sendFb(x,action,box,reason){
  var obj={}, f={action:action,dish:x.dish,slot:x.slot,by:EMAIL,at:iso()};
  reason=String(reason||'').trim().slice(0,500); if(reason) f.reason=reason;
  obj[x.sid]=f; obj.updated_at=iso(); obj.updated_by=EMAIL;
  if(box) box.innerHTML='<span class="sgnote">saving...</span>';
  return SRC.mfb.ref().set(obj,{merge:true}).catch(function(e){ flash('Could not save that ('+((e&&e.code)||e)+'). Nothing changed; try again.'); render(); });
}
/* The note sheet (Sam, 2026-10-13): Try another and Not for us open a sheet where Amy can say
   why, "the kids haven't been eating bananas or raspberries lately". The note rides with the
   feedback into the preference corpus and steers every later suggestion, not just this slot.
   State lives here, not in the DOM, because panes rebuild on every data change; while she is
   typing, repaints are held (typing()), and the text survives one anyway. */
var SG_MODAL=null;
function openNote(x,action){ SG_MODAL={x:x,action:action,text:''}; render(); }
function noteSheet(){
  var m=SG_MODAL, x=m.x, dis=m.action==='dislike';
  var ov=el('div','sgov'); var card=el('div','sgsheet');
  card.setAttribute('role','dialog'); card.setAttribute('aria-modal','true');
  card.appendChild(el('div','sgh',dis?'Not for us':'Try another'));
  card.appendChild(el('div','sgdish',esc(x.dish)));
  card.appendChild(el('div','sgnote',dis?'It won\'t be suggested again. Anything to tell the planner?':'A different idea comes tomorrow morning. Anything to steer it?'));
  var ta=el('textarea','sgta'); ta.rows=4; ta.maxLength=500; ta.value=m.text;
  ta.placeholder='Optional. e.g. the kids haven\'t been eating bananas or raspberries lately';
  ta.addEventListener('input',function(){ m.text=ta.value; });
  card.appendChild(ta);
  var row=el('div','sgrow');
  var cancel=el('button','sgbtn','Cancel'); cancel.type='button';
  cancel.addEventListener('click',function(){ SG_MODAL=null; render(); });
  var send=el('button','sgbtn sgkeep',dis?'Send':'Ask for another'); send.type='button';
  send.addEventListener('click',function(){ var note=m.text; SG_MODAL=null; send.disabled=true; sendFb(x,m.action,null,note).then(function(){ render(); }); });
  row.appendChild(cancel); row.appendChild(send); card.appendChild(row);
  ov.addEventListener('click',function(ev){ if(ev.target===ov){ SG_MODAL=null; render(); } });
  ov.appendChild(card);
  setTimeout(function(){ try{ ta.focus(); }catch(e){} },30);
  return ov;
}
function suggestTag(x){
  if(x.kind==='bring_home') return '<span class="sg fixed">SAM BRINGS IT</span>';
  if(x.kind==='takeout') return '<span class="sg fixed">TAKEOUT</span>';
  var f=fbOf(x);
  if(x.status==='kept'||(f&&f.action==='like')) return '<span class="sg kept">KEPT</span>';
  return '<span class="sg">SUGGESTED</span>';
}
function suggestBar(x){
  var box=el('div','sgbar');
  if(x.kind!=='cook'&&x.kind!=='prep') return null;
  var f=fbOf(x);
  if(x.status==='kept'||(f&&f.action==='like')){ box.appendChild(el('span','sgnote','Kept. Put something else in the Sheet any time to replace it.')); return box; }
  if(f){ box.appendChild(el('span','sgnote done',(f.action==='dislike'?'Noted, won\'t suggest it again. New idea tomorrow morning.':'New idea tomorrow morning.')+(f.reason?' Your note: \u201c'+esc(f.reason)+'\u201d':''))); return box; }
  [['like','Keep'],['another','Try another'],['dislike','Not for us']].forEach(function(a){
    var b=el('button','sgbtn'+(a[0]==='like'?' sgkeep':''),a[1]); b.type='button';
    b.addEventListener('click',function(ev){ ev.preventDefault(); ev.stopPropagation(); if(a[0]==='like') sendFb(x,a[0],box); else openNote(x,a[0]); });
    box.appendChild(b);
  });
  if(x.why) box.appendChild(el('div','sgnote',esc(x.why)));
  return box;
}
function mealRow(x){
  var row=mealRow0(x);
  if(!x.suggested) return row;
  row.classList.add('sugg');
  var m=row.querySelector('.m'); if(m) m.insertAdjacentHTML('afterbegin',suggestTag(x));
  var bar=suggestBar(x);
  if(bar&&m) m.appendChild(bar);
  return row;
}
function mealRow0(x){
  var head='<div class="s">'+esc(x.slot)+'</div><div class="m">'+esc(x.dish)+
    ((x.cook||x.notes)?'<small>'+esc([x.cook,x.notes].filter(Boolean).join(' · '))+'</small>':'')+'</div>';
  var r=x.recipe;
  if(!r){
    var plain=el('div','meal',head);
    if(!x.recipe_skip) plain.querySelector('.m').appendChild(el('small','pend','recipe arrives with the morning feed'));
    return plain;
  }
  var d=el('details','meal rcp'), mk=mealKey(x);
  if(OPEN_RCP[mk]) d.open=true;
  d.addEventListener('toggle',function(){ OPEN_RCP[mk]=d.open; });
  d.appendChild(el('summary','',head+'<span class="tag">RECIPE</span>'));
  var body=el('div','rbody');
  body.appendChild(el('div','rtitle',esc(r.title)+'<small>'+r.servings+(r.servings===1?' serving':' servings')+' · '+esc(r.time_min)+' min</small>'));
  var cfg=qfcCfg(), st=qfcState(), linked=!!(cfg&&st.linked), boxes=[];
  var ul=el('div','ings');
  (r.ingredients||[]).forEach(function(g){
    var k=g.kroger, line=el('div','ing'+(linked?' pick':''));
    if(linked){
      var cb=el('input','qfcbox'); cb.type='checkbox'; cb.disabled=!k;
      cb.checked=!!k && !(UNTICKED[mk]||{})[k.upc];
      if(k){ cb.setAttribute('data-upc',k.upc); cb.addEventListener('change',function(){ UNTICKED[mk]=UNTICKED[mk]||{}; if(cb.checked) delete UNTICKED[mk][k.upc]; else UNTICKED[mk][k.upc]=true; }); }
      line.appendChild(cb); boxes.push(cb);
    }
    line.appendChild(el('span','q',esc(g.quantity)+' '+esc(g.unit)));
    var t=el('span','',esc(g.display_text||g.name));
    if(cfg){ t.appendChild(el('small','qfcp', k ? esc(k.description)+(k.size?' · '+esc(k.size):'')+(k.price!=null?' · $'+Number(k.price).toFixed(2):'')
                                                   : 'not found at QFC'+(linked?', add it yourself in the app':''))); }
    line.appendChild(t); ul.appendChild(line);
  });
  body.appendChild(ul);
  if(r.lucy_note) body.appendChild(el('div','lucy','Lucy: '+esc(r.lucy_note)));
  var ol=el('ol','steps'); (r.steps||[]).forEach(function(t){ ol.appendChild(el('li','',esc(t))); }); body.appendChild(ol);
  if(r.cart_status==='ok'&&r.cart_url){
    var a=el('a','cart','Shop this on Instacart ›'); a.href=r.cart_url; a.target='_blank'; a.rel='noopener'; body.appendChild(a);
  }else if(r.cart_status==='expired'){
    var dis=el('button','cart','Shopping link expired, refreshes tonight'); dis.setAttribute('disabled',''); body.appendChild(dis);
  }else if(cfg){
    /* QFC takes the amber slot while there is no Instacart link. */
    if(linked){
      var sts=qfcStatus(x);
      var add=el('button','cart qfcadd', sts&&sts.busy ? 'Adding...' : 'Add to QFC cart'); add.type='button';
      if(sts&&sts.busy) add.disabled=true;
      add.addEventListener('click',function(){
        var upcs=boxes.filter(function(b){return b.checked&&!b.disabled;}).map(function(b){return b.getAttribute('data-upc');});
        if(!upcs.length){ flash('Nothing ticked to add.'); return; }
        qfcRequest(x,upcs,add);
      });
      body.appendChild(add);
      if(sts) body.appendChild(el('div','qfcstat '+sts.cls,esc(sts.text)));
      else body.appendChild(el('div','why','Untick what you already have, then add. One of each goes to your QFC cart at '+esc(st.store||cfg.store||'QFC')+'; fix quantities in the QFC app.'));
    }else{
      /* A pending flag older than three minutes is a runner that did not answer (asleep Mac, or
         the 2026-10-09 bug where a failed exchange never cleared it). Show the button again. */
      var pendAge=st.pending?Date.now()-Date.parse(st.at||0):Infinity;
      if(st.pending&&pendAge<3*60000) body.appendChild(el('div','qfcstat wait','Linking your QFC account...'));
      else{
        if(st.pending) body.appendChild(el('div','why','The last link attempt did not finish. The Mac may have been asleep.'));
        if(st.error) body.appendChild(el('div','why',esc(st.error)));
        var l=el('a','cart qfclink','Link QFC to shop this ›'); l.href=qfcLinkUrl(cfg); body.appendChild(l);
        body.appendChild(el('div','why','One-time sign-in to your QFC account. After that every recipe gets an Add to QFC cart button.'));
      }
    }
  }else{
    body.appendChild(el('div','why','No shopping link yet: '+esc(String(r.cart_status||'').replace(/^not created: /,''))));
  }
  var again=el('a','again',ASKED[mk]?'tomorrow morning':'try another'); again.href='#'; if(ASKED[mk]) again.classList.add('done');
  again.addEventListener('click',function(ev){ ev.preventDefault(); if(again.classList.contains('done')) return; requestAnother(x,again); });
  body.appendChild(again);
  d.appendChild(body);
  return d;
}

var SHOP_OPEN=null;
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
  var lp=livePlan(f), plan=lp.plan.filter(function(x){return x.date>=today;});
  b.appendChild(el('div','sec','The plan'+((!lp.live&&f.date!==today)?'<em>as of '+esc(dayLabel(f.date))+'</em>':'')));
  b.appendChild(sheetNote());
  if(!plan.length) b.appendChild(el('div','quiet','Nothing planned from today on. Amy adds the week in the Sheet; suggestions fill open days each morning.'));
  else{
    if(plan.some(function(x){return x.suggested;})) b.appendChild(el('div','why','Open days are filled with suggestions. Keep one, ask for another, or plan that meal in the Sheet and yours wins.'));
    /* Two lenses on one plan (Sam, 2026-10-13), a pill to swap: BY MEAL groups Prep day,
       Breakfast, Snacks, Lunch (with School lunch) and Dinner, each collapsed to start; BY DAY
       shows each day's whole plan, today open. The choice is remembered on this phone. */
    var view=mealView();
    var pill=el('div','mvpill'); pill.setAttribute('role','tablist');
    [['meal','By meal'],['day','By day']].forEach(function(v){
      var bt=el('button','mvopt'+(view===v[0]?' on':''),v[1]); bt.type='button'; bt.setAttribute('role','tab');
      bt.setAttribute('aria-selected',view===v[0]?'true':'false');
      bt.addEventListener('click',function(){ setMealView(v[0]); render(); });
      pill.appendChild(bt);
    });
    b.appendChild(pill);
    var toReview=function(rows){ return rows.filter(function(x){ return x.suggested&&(x.kind==='cook'||x.kind==='prep')&&x.status!=='kept'&&!fbOf(x); }).length; };
    var section=function(key,title,rows,open,oneslot,inner){
      var n=toReview(rows), sec=el('details','card mgrp'+(oneslot?' oneslot':''));
      if(OPEN_SEC[key]===undefined?open:OPEN_SEC[key]) sec.open=true;
      sec.addEventListener('toggle',function(){ OPEN_SEC[key]=sec.open; });
      sec.appendChild(el('summary','','<span class="mgt">'+esc(title)+'</span><span class="mgc">'+rows.length+(n?' · '+n+' to review':'')+'</span>'));
      inner(sec); b.appendChild(sec);
    };
    if(view==='day'){
      var SORD={'Prep':0,'Breakfast':1,'Snack':2,'Lunch':3,'School lunch':4,'Dinner':5,'Other':6};
      var byd={}, dord=[];
      plan.forEach(function(x){ if(!byd[x.date]){byd[x.date]=[];dord.push(x.date);} byd[x.date].push(x); });
      dord.forEach(function(d){
        var rows=byd[d].slice().sort(function(a,c){ return (SORD[a.slot]==null?9:SORD[a.slot])-(SORD[c.slot]==null?9:SORD[c.slot]); });
        section('day:'+d,dayLabel(d),rows,d===today,false,function(sec){
          var g=el('div','day'+(d===today?' now':'')); rows.forEach(function(x){ g.appendChild(mealRow(x)); }); sec.appendChild(g);
        });
      });
    }else{
      var GROUPS=[['Prep day',['Prep']],['Breakfast',['Breakfast']],['Snacks',['Snack']],['Lunch',['Lunch','School lunch']],['Dinner',['Dinner']],['Other',['Other']]];
      GROUPS.forEach(function(gp){
        var rows=plan.filter(function(x){ return gp[1].indexOf(x.slot)>=0; });
        if(!rows.length) return;
        section('meal:'+gp[0],gp[0],rows,false,gp[1].length===1,function(sec){
          var by={}, order=[];
          rows.forEach(function(x){ if(!by[x.date]){by[x.date]=[];order.push(x.date);} by[x.date].push(x); });
          order.forEach(function(d){
            var g=el('div','day'+(d===today?' now':'')); g.appendChild(el('h3','',esc(dayLabel(d))));
            by[d].forEach(function(x){ g.appendChild(mealRow(x)); });
            sec.appendChild(g);
          });
        });
      });
    }
  }
  var sh=m.shopping||[], toGet=sh.filter(function(x){return !x.got;}).length;
  var sd=el('details','fold'); sd.open=SHOP_OPEN!==null?SHOP_OPEN:toGet>0;
  sd.appendChild(el('summary','','<span>Shopping · '+toGet+' to get</span>'));
  sd.addEventListener('toggle',function(){ SHOP_OPEN=sd.open; });
  b.appendChild(sd);
  var sb=el('div','foldb'); sd.appendChild(sb);
  if(!sh.length) sb.appendChild(el('div','quiet','Shopping list is empty.'));
  else{
    var sc=el('div',''), secs={}, so=[];
    sh.forEach(function(x){var k=x.section||'Other'; if(!secs[k]){secs[k]=[];so.push(k);} secs[k].push(x);});
    so.forEach(function(k){
      sc.appendChild(el('div','day','<h3>'+esc(k)+'</h3>'));
      secs[k].sort(function(a,b){return a.got-b.got;}).forEach(function(x){
        sc.appendChild(el('div','shop'+(x.got?' got':''),'<span class="q">'+esc(x.qty)+'</span><span>'+esc(x.item)+
          (x['for']?' <span style="color:var(--ink-soft)">· '+esc(x['for'])+'</span>':'')+'</span>'));
      });
    });
    sb.appendChild(sc);
  }
  if((m.framework||[]).length){
    b.appendChild(el('div','sec','Amy\'s framework'));
    var d=el('details','card'); d.appendChild(el('summary','','How the week is planned'));
    m.framework.forEach(function(x){ d.appendChild(el('div','kv','<div class="k">'+esc(x.topic)+'</div><div class="v">'+esc(x.detail)+'</div>')); });
    b.appendChild(d);
  }
  if(SG_MODAL) b.appendChild(noteSheet());
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
  var go=el('button','lnk','Open October ›'); go.onclick=function(){OCT_OPEN=true; o.setTab('info',true);};
  c.appendChild(go); b.appendChild(c);
}
var OCT_SHOW_PAST=false, OCT_OPEN=false;
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
/* ══ SCHOOL ════════════════════════════════════════════════════════════════
   2026-11-09, Bridge phase 4 (canvas row 4). St. Catherine, sorted three ways: Needs us (a date
   and a consequence), Your call (optional), FYI (folded). The items come from feed_school.py,
   which reads the midday sweep's newsletter log into family/school. The choices live in
   household/school as marks[itemId][sam|amy] = {v, at}: each of you chooses separately (Sam,
   2026-11-09: "If I say pass on something it doesn't determine it for Amy, it just shows above
   her choices"). A card leaves YOUR list when YOU choose; the other person's choice is shown
   above your buttons. */
var SC_PEND={}, SC_OK={}, OPEN_HANDLED=false;
var SC_WORDS={done:'did it',skip:'is not doing it',yes:'is in',no:'passed'};
var SC_MINE={done:'Done',skip:'Not doing it',yes:"We're in",no:'Passed'};
function scMarks(){ return (SRC.smarks.data&&SRC.smarks.data.marks)||{}; }
function scMine(id){
  if(id in SC_PEND) return SC_PEND[id];
  var m=scMarks()[id], v=(m&&m[ME]&&m[ME].v)||null;
  /* A save that landed before its snapshot arrived: show what was saved until the snapshot agrees. */
  if(id in SC_OK){ if(SC_OK[id]===v) delete SC_OK[id]; else return SC_OK[id]; }
  return v; }
function scTheirs(id){ var m=scMarks()[id], o=ME==='sam'?'amy':'sam'; return (m&&m[o])||null; }
function laOf(ts){ try{ return new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles'}).format(new Date(ts)); }catch(e){ return String(ts).slice(0,10); } }
function scItems(){ return (SRC.school.data&&SRC.school.data.items)||[]; }
function scDays(due){ if(!due) return null;
  var a=due.split('-'), t=laDate(0).split('-');
  return Math.round((Date.UTC(+a[0],+a[1]-1,+a[2])-Date.UTC(+t[0],+t[1]-1,+t[2]))/864e5); }
function scWhen(i){
  var w=String(i.when||'').toUpperCase(), d=scDays(i.due);
  if(d===null) return {t:w||'NO DATE GIVEN',c:''};
  if(d<0) return {t:'OVERDUE · WAS '+w,c:'late'};
  return {t:w+' · '+(d===0?'TODAY':d===1?'TOMORROW':d+' DAYS'),c:d<=3&&i.kind==='need'?'soon':''};
}
function scMark(id,v){
  if(id in SC_PEND) return;
  SC_PEND[id]=v; render();
  var ref=SRC.smarks.ref();
  db.runTransaction(function(tx){
    return tx.get(ref).then(function(s){
      var all=(s.exists&&s.data().marks)||{}, out={};
      Object.keys(all).forEach(function(k){ out[k]=Object.assign({},all[k]); });
      var e=out[id]||{};
      if(v) e[ME]={v:v,at:iso()}; else delete e[ME];
      out[id]=e;
      tx.set(ref,{marks:out,updated_at:iso(),updated_by:EMAIL});
    });
  }).then(function(){ delete SC_PEND[id]; SC_OK[id]=v||null; render(); })
    .catch(function(e){ delete SC_PEND[id]; flash('Could not save ('+((e&&e.code)||e)+'). Nothing was changed; try again.'); });
}
function scCard(i){
  var c=el('div','sc-card'+(i.kind==='need'?' need':'')), w=scWhen(i);
  c.appendChild(el('div','sc-when '+w.c,esc(w.t)));
  c.appendChild(el('div','sc-ttl',esc(i.title)));
  if(i.why) c.appendChild(el('div','sc-why',esc(i.why)));
  var src=el('div','sc-src',esc(String(i.src||'').toUpperCase()));
  if(i.link){ var a=el('a','lnk','Read it ›'); a.href=i.link; a.target='_blank'; a.rel='noopener'; src.appendChild(a); }
  c.appendChild(src);
  var th=scTheirs(i.id);
  if(th&&th.v){ var nm=ME==='sam'?'Amy':'Sam';
    c.appendChild(el('div','sc-other'+(th.v==='done'||th.v==='yes'?' ok':''),
      esc(nm+' '+(SC_WORDS[th.v]||th.v))+(th.at?' · '+esc(dayLabel(laOf(th.at))):''))); }
  var bt=el('div','sc-btns'), pend=(i.id in SC_PEND);
  var pair=i.kind==='need'?[['done','Done','go'],['skip','Not doing it','']]:[['yes',"We're in",'yes'],['no','Pass','']];
  pair.forEach(function(p){ var b=el('button','btn sc-b '+p[2],p[1]); b.disabled=pend;
    b.onclick=function(){ scMark(i.id,p[0]); }; bt.appendChild(b); });
  c.appendChild(bt);
  return c;
}
function paintSchool(b){
  if(!gate(b,'school','the school feed')) return;
  var d=SRC.school.data;
  if(!d){ b.appendChild(el('div','miss','<b>The school feed has not been written yet.</b> The midday sweep and the 4am run post it.')); return; }
  if(d.date && d.date<laDate(-7)) b.appendChild(el('div','miss','<b>The school feed is from '+esc(dayLabel(d.date))+'.</b> Newer newsletters may not be here yet.'));
  if(d.status && d.status!=='ok') b.appendChild(el('div','miss','<b>The school feed says: '+esc(d.status)+'.</b> What shows below may be incomplete.'));
  /* Without the choices loaded, every card would look open, including ones already handled. */
  /* A cached "no doc" is not "no choices": wait for the server unless a cached copy exists. */
  if(!SRC.smarks.ready||(!SRC.smarks.live&&!SRC.smarks.data&&!SRC.smarks.err)){ b.appendChild(el('div','quiet','Loading your choices…')); return; }
  if(!SRC.smarks.live&&!SRC.smarks.err) b.appendChild(el('div','quiet','Showing your saved choices while it reconnects.'));
  var marksOk=!SRC.smarks.err;
  if(!marksOk) b.appendChild(el('div','miss','<b>Your choices could not load</b> ('+esc(SRC.smarks.err)+'), so every card shows as open. Tapping still saves.'));
  var items=scItems(), open={need:[],opt:[]}, handled=[];
  items.forEach(function(i){ (scMine(i.id)?handled:open[i.kind]||open.opt).push(i); });

  b.appendChild(el('div','sec want','Needs us<em>'+open.need.length+'</em>'));
  if(!open.need.length) b.appendChild(el('div','clear','Nothing needs you right now.'));
  open.need.forEach(function(i){ b.appendChild(scCard(i)); });

  b.appendChild(el('div','sec','Your call<em>'+open.opt.length+'</em>'));
  if(!open.opt.length) b.appendChild(el('div','quiet','No optional sign-ups or events waiting on you.'));
  else b.appendChild(el('div','quiet','Optional. Ignore these and nothing happens.'));
  open.opt.forEach(function(i){ b.appendChild(scCard(i)); });

  /* This week at school: the school rules file's days plus the school calendar's events. */
  var f=SRC.fam.ready&&!SRC.fam.err?SRC.fam.data:null;
  b.appendChild(el('div','sec','This week at school'));
  if(!f) b.appendChild(el('div',SRC.fam.ready?'miss':'quiet',
    !SRC.fam.ready?'Loading…':SRC.fam.err?'<b>Could not load the school days</b> ('+esc(SRC.fam.err)+').':'<b>The school-day feed has not been written yet.</b> The 4am run posts it.'));
  else{
    var calOk=/^ok/.test(f.stc_status||''), today=laDate(0);
    if(f.date&&f.date<today) b.appendChild(el('div','miss','<b>School days last updated '+esc(dayLabel(f.date))+'.</b> The morning run has not posted since; past days are hidden.'));
    if(!calOk) b.appendChild(el('div','miss','<b>School calendar unavailable</b> ('+esc(f.stc_status||'not in the feed')+'). Days below come from the school rules only; events may be missing.'));
    var wk=el('div','card list'), ev=calOk?(f.stc_events||[]):[], n=0;
    (f.school||[]).forEach(function(sd){
      var wd=wdOf(sd.date); if(wd==='Sat'||wd==='Sun'||sd.date<today) return;
      var es=ev.filter(function(e){return e.date===sd.date;}).map(function(e){return e.title+(e.time&&e.time!=='all day'?' '+e.time:'');});
      var ms=f.school_facts&&f.school_facts.mass;
      if(sd.school&&ms&&ms.weekday&&ms.weekday.slice(0,3)===wd.toLowerCase()) es.push(ms.note||'Mass');
      var txt=!sd.school?(es.length?es.join(' · '):(sd.lines&&sd.lines[0]||'No school')):(es.length?es.join(' · '):(calOk?'Normal day':'School day'));
      n++; wk.appendChild(el('div','sc-wk'+(sd.school?'':' off')+(sd.date===laDate(0)?' now':''),
        '<span class="k">'+esc(wd.toUpperCase()+' '+(+sd.date.slice(5,7))+'/'+(+sd.date.slice(8,10)))+'</span><span>'+esc(txt)+'</span>'));
    });
    if(n) b.appendChild(wk); else b.appendChild(el('div','quiet','No school days in the next week.'));
  }

  if(handled.length){
    var hd=el('details','fold'); hd.open=OPEN_HANDLED;
    hd.appendChild(el('summary','','<span>Handled by you · '+handled.length+'</span>'));
    hd.addEventListener('toggle',function(){ OPEN_HANDLED=hd.open; });
    var hb=el('div','foldb');
    handled.forEach(function(i){ var v=scMine(i.id), th=scTheirs(i.id), r=el('div','sc-hd');
      r.appendChild(el('span','sc-ck'+(v==='done'||v==='yes'?' ok':''),v==='done'||v==='yes'?'✓':'–'));
      r.appendChild(el('span','sc-ht',esc(i.title)+'<small>You: '+esc(SC_MINE[v]||v)+
        (th&&th.v?' · '+esc((ME==='sam'?'Amy':'Sam')+' '+(SC_WORDS[th.v]||th.v)):'')+'</small>'));
      var u=el('button','btn sc-undo','Undo'); u.disabled=(i.id in SC_PEND); u.onclick=function(){ scMark(i.id,null); };
      r.appendChild(u); hb.appendChild(r); });
    hd.appendChild(hb); b.appendChild(hd);
  }

  var fy=d.fyi||[], nf=fy.reduce(function(s,x){return s+(x.lines||[]).length;},0);
  if(nf){
    var fd=el('details','fold'); fd.appendChild(el('summary','','<span>FYI · '+nf+' things you can skip</span>'));
    var fb=el('div','foldb');
    fy.forEach(function(x){
      var h=el('div','sc-fh',esc(x.title)+' · '+esc(dayLabel(x.date)));
      if(x.link){ var a=el('a','lnk','Open ›'); a.href=x.link; a.target='_blank'; a.rel='noopener'; h.appendChild(a); }
      fb.appendChild(h);
      (x.lines||[]).forEach(function(t){ fb.appendChild(el('div','sc-fl',esc(t))); });
    });
    fd.appendChild(fb); b.appendChild(fd);
  }
  var is=d.issues||[];
  if(is.length){
    var nd=el('details','fold'); nd.appendChild(el('summary','','<span>Newsletters · '+is.length+' in the last 30 days</span>'));
    var nb=el('div','foldb');
    is.forEach(function(x){
      var r=el(x.link?'a':'div','sc-nl','<span>'+esc(x.title)+'</span><small>'+esc(dayLabel(x.date))+(x.link?'':' · email only')+'</small>');
      if(x.link){ r.href=x.link; r.target='_blank'; r.rel='noopener'; }
      nb.appendChild(r);
    });
    nd.appendChild(nb); b.appendChild(nd);
  }
  var ct=d.contacts||[];
  if(d.contacts_status && d.contacts_status!=='ok') b.appendChild(el('div','miss','<b>Who to call is missing:</b> '+esc(d.contacts_status)));
  if(ct.length){
    var cd=el('details','fold'); cd.appendChild(el('summary','','<span>Who to call</span>'));
    var cb=el('div','foldb');
    ct.forEach(function(x){
      var links=String(x.contact||'').split(/,\s*/).map(function(p){
        if(/@/.test(p)) return '<a class="lnk" href="mailto:'+esc(p)+'">'+esc(p)+'</a>';
        var ph=/^[\d\s().-]{10,}/.exec(p); if(ph) return '<a class="lnk" href="tel:'+esc(ph[0].replace(/[^\d]/g,''))+'">'+esc(p)+'</a>';
        return esc(p); }).join('<br>');
      cb.appendChild(el('div','sc-ct','<b>'+esc(x.name)+'</b><small>'+esc(x.role||'')+'</small><div>'+links+'</div>'));
    });
    cd.appendChild(cb); b.appendChild(cd);
  }
}
/* For the Bridge's landing pill: my open needs due within 3 days or overdue. null = not loaded. */
function schoolSoon(){
  if(!SRC.school.ready||SRC.school.err||!SRC.school.data) return null;
  if(!SRC.smarks.ready||!SRC.smarks.live||SRC.smarks.err) return null;      /* unknown is not "needs you" */
  return scItems().filter(function(i){ var d=scDays(i.due);
    return i.kind==='need' && !scMine(i.id) && d!==null && d<=3; }).length;
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
  /* 2026-11-08: the October tab, retired from the bar now the month is over. Everything it
     held is here, one tap in, painted only when opened. */
  b.appendChild(el('div','sec','Past months'));
  var od=el('details','fold'); od.open=OCT_OPEN;
  od.appendChild(el('summary','','<span>October · the Halloween plan and cart</span>'));
  var ob=el('div','foldb'); od.appendChild(ob);
  if(OCT_OPEN) paintOct(ob);
  od.addEventListener('toggle',function(){ OCT_OPEN=od.open; if(od.open&&!ob.childNodes.length) paintOct(ob); });
  b.appendChild(od);
  var so=el('button','lnk','Sign out'); so.style.marginTop='26px'; so.onclick=function(){o.signOut();}; b.appendChild(so);
}
/* One editable list, used twice. Every write is a transaction by id (see mutate). */
function listSection(b,k,title,noun,fields,show){
  b.appendChild(el('div','sec',esc(title)));
  if(!gate(b,k,title.toLowerCase())) return;
  var items=(SRC[k].data&&SRC[k].data.items)||[];
  items.forEach(function(x){
    if(EDIT===k+':'+x.id){ b.appendChild(form(k,fields,x)); return; }
    var c=el('div','card'); c.innerHTML=show(x)+'<div class="meta" style="font-size:13px;color:var(--ink-soft);margin-top:8px">'+esc(byName(x.by||''))+(x.updated_at?' · '+esc(x.updated_at.slice(0,10)):'')+'</div>';
    var e=el('button','lnk','Edit'); e.onclick=function(){EDIT=k+':'+x.id;FORM_DRAFT=null;render();};
    var d=el('button','lnk','Delete'); d.style.cssText='color:var(--mag);margin-left:16px';
    d.onclick=function(){ if(d.textContent==='Delete'){d.textContent='Tap again to delete';return;}
      mutate(k,function(a){return a.filter(function(y){return y.id!==x.id;});}); };
    c.appendChild(e); c.appendChild(d); b.appendChild(c);
  });
  if(!items.length&&EDIT!==k+':new') b.appendChild(el('div','quiet','None yet.'));
  if(EDIT===k+':new') b.appendChild(form(k,fields,null));
  else{ var a=el('button','btn','+ '+esc(noun)); a.style.cssText='width:100%;margin-top:10px'; a.onclick=function(){EDIT=k+':new';FORM_DRAFT=null;render();}; b.appendChild(a); }
}
var FORM_DRAFT=null;   /* {key, id, v:{field:value}}: what is typed in the open form, kept across repaints */
function form(k,fields,x){
  var f=el('div','add card');
  if(!FORM_DRAFT||FORM_DRAFT.key!==EDIT) FORM_DRAFT={key:EDIT, id:x?x.id:uid(k[0]), v:{}};
  var dv=FORM_DRAFT.v;
  fields.forEach(function(fd,ix){
    var multi=(fd[0]==='body'||fd[0]==='notes');
    var i=el(multi?'textarea':'input','fld'); i.placeholder=fd[1];
    i.value=(fd[0] in dv)?dv[fd[0]]:((x&&x[fd[0]])||''); i.setAttribute('data-f',fd[0]);
    i.addEventListener('input',function(){ dv[fd[0]]=i.value; });
    if(!multi) i.type='text'; f.appendChild(i);
  });
  var r=el('div','addrow'); var s=el('button','btn pri',FORM_DRAFT.saving?'Saving…':'Save'), c=el('button','btn','Cancel');
  if(FORM_DRAFT.saving){ s.disabled=true; c.disabled=true; f.querySelectorAll('[data-f]').forEach(function(i){ i.readOnly=true; }); }
  c.onclick=function(){EDIT=null;FORM_DRAFT=null;render();};
  s.onclick=function(){
    if(s.disabled||FORM_DRAFT.saving) return;
    var v={}; f.querySelectorAll('[data-f]').forEach(function(i){v[i.getAttribute('data-f')]=i.value.trim();});
    if(!v[fields[0][0]]) return;
    var key=EDIT, id=x?x.id:FORM_DRAFT.id, mine=FORM_DRAFT;
    mine.saving=true; s.disabled=true; c.disabled=true; s.textContent='Saving…';
    f.querySelectorAll('[data-f]').forEach(function(i){ i.readOnly=true; });
    // Blur first so render() is not held off by a focused, non-empty field.
    var ae=ROOT.activeElement||document.activeElement; if(ae&&ae.blur) ae.blur();
    mutate(k,function(a){
      var o=Object.assign({},v,{id:id,by:x?(x.by||EMAIL):EMAIL,updated_at:iso()});
      var hit=false; a=a.map(function(y){ if(y.id===id){hit=true;return Object.assign({},y,o);} return y; });
      if(!hit) a.push(o); return a;
    }).then(function(ok){
      /* Only a save that landed closes the form. A failed one leaves it open with what was typed. */
      mine.saving=false;
      if(ok && EDIT===key && FORM_DRAFT===mine){ EDIT=null; FORM_DRAFT=null; }
      render();
    });
  };
  r.appendChild(s); r.appendChild(c); f.appendChild(r);
  if(!x && !FORM_DRAFT.saving) setTimeout(function(){var q=f.querySelector('[data-f]'); if(q&&!q.readOnly) q.focus();},30);
  return f;
}

return {
  start:function(){ if(!STOPPED){ subscribe(); fetchSheet(true); setTimeout(qfcHandoff,1500); } },
  stop:function(){ STOPPED=true; unsub.forEach(function(f){try{f();}catch(e){}}); unsub=[]; },
  hold:function(anim){ if(!anim && (typing()||PDOWN)){ PENDING=true; return true; } PENDING=false; return false; },
  status:function(){
    return {
      liveAll:Object.keys(SRC).every(function(k){return SRC[k].ready&&SRC[k].live&&!SRC[k].err;}),
      partial:Object.keys(SRC).some(function(k){return !!SRC[k].err;}) &&
              !Object.keys(SRC).every(function(k){return SRC[k].err==='permission-denied';}),
      denied:Object.keys(SRC).every(function(k){return SRC[k].err==='permission-denied';})
    };
  },
  paint:function(tab,anim){
    if(anim||tab!==LAST_TAB){ TODO_FRESH=true; LAST_TAB=tab; }
    TODO_SHOWN_LIVE=false;
    var p=PANE; p.innerHTML=''; var box=el('div',anim?'pane':'');
    if(flashMsg) box.appendChild(el('div','bar warn',esc(flashMsg)));
    if(tab==='oct'){ OCT_OPEN=true; tab='info'; }   /* an old saved tab or link lands on Info, October open */
    (({today:paintToday,school:paintSchool,todo:paintTodo,meals:paintMeals,info:paintInfo})[tab]||paintToday)(box);
    p.appendChild(box);
  },
  todoFresh:function(){ return todoFresh(); },
  /* The live to-do array, or null when it is not loaded or failed. The Bridge's house-list
     pill and clearing award read this so they agree with the To-do tab. */
  todoItems:function(){ return SRC.todo.ready&&!SRC.todo.err&&SRC.todo.data ? todoItems().slice() : null; },
  todoErr:function(){ return SRC.todo.err||null; },
  schoolSoon:function(){ return schoolSoon(); },
  /* True only when the last paint put the LIVE To-do list on screen (gate passed, not cache).
     The Bridge marks Amy's items seen off this, never off a tab switch alone. */
  todoShownLive:function(){ return TODO_SHOWN_LIVE; },
  /* Harness only. Lets _render_meals_test.js hand the hub a feed without Firestore and read
     the flash. Not used by either host. */
  __test:{setSheet:function(rows,err){ SHEET.ready=true; SHEET.err=err||null; SHEET.rows=rows||null; SHEET.when=new Date(); },
          setFam:function(f){ SRC.fam.ready=true; SRC.fam.err=null; SRC.fam.data=f; SRC.fam.live=true; },
          setDoc:function(k,d){ SRC[k].ready=true; SRC[k].err=null; SRC[k].data=d; SRC[k].live=true; },
          flashMsg:function(){ return flashMsg; }}
};
  }
};
})();
