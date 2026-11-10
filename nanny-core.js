/* nanny-core.js — the pure math behind the Nanny tab (NANNY-SPEC.md §10, 2026-11-09).
   No DOM, no Firebase, no data: pay periods and paid hours only, so the one place that decides
   what Ava is paid can be tested on its own (nanny-core.test.js). Loaded before family.js on
   both hosts; also require()-able from node for the tests.

   The agreement, as it bears on hours:
     * pay periods are 14 days starting Monday 2026-11-16; payday is the Friday after a period ends
     * each worked day pays at least 4 hours
     * time past the agreed end is paid, rounded UP to the next 15 minutes
     * a day the family cancels is unpaid
   Times are Seattle wall-clock "HH:MM" strings (24h). */
(function(root){
"use strict";
var ANCHOR='2026-11-16', MIN_DAY=240, RATE=28;
function ymdToUTC(ymd){ var p=ymd.split('-'); return Date.UTC(+p[0],+p[1]-1,+p[2]); }
function utcToYmd(t){ return new Date(t).toISOString().slice(0,10); }
function addDays(ymd,n){ return utcToYmd(ymdToUTC(ymd)+n*864e5); }
function periodStart(ymd){
  var d=Math.round((ymdToUTC(ymd)-ymdToUTC(ANCHOR))/864e5);
  return addDays(ANCHOR, Math.floor(d/14)*14);
}
function periodEnd(start){ return addDays(start,13); }
function payday(start){ return addDays(start,18); }
function periodDays(start){ var out=[]; for(var i=0;i<14;i++) out.push(addDays(start,i)); return out; }
function toMin(hm){ if(!hm||!/^\d{1,2}:\d{2}$/.test(hm)) return null; var a=hm.split(':'); return (+a[0])*60+(+a[1]); }
function hmOf(min){ var h=Math.floor(min/60), m=min%60; return (h<10?'0':'')+h+':'+(m<10?'0':'')+m; }
/* Minutes paid for one day, or null when the day is not complete (no start or no end) or makes
   no sense (end before start). A cancelled day is 0. */
function paidMinutes(day){
  if(!day) return null;
  if(day.cancelled) return 0;
  var i=toMin(day.in&&day.in.hm), o=toMin(day.out&&day.out.hm);
  if(i==null||o==null||o<=i) return null;
  var e=toMin(day.end_plan), worked;
  if(e==null||e<=i) worked=o-i;
  else{
    var within=Math.min(o,e)-i, over=Math.max(0,o-e);
    worked=within+Math.ceil(over/15)*15;
  }
  return Math.max(MIN_DAY,worked);
}
function periodTotals(days){
  var mins=0, open=0, n=0;
  Object.keys(days||{}).forEach(function(k){
    var m=paidMinutes(days[k]);
    if(m==null){ if(days[k]&&!days[k].cancelled&&days[k].in) open++; return; }
    mins+=m; if(m>0) n++;
  });
  return {minutes:mins, hours:mins/60, gross:Math.round(mins/60*RATE*100)/100, days:n, open:open};
}
var api={ANCHOR:ANCHOR,RATE:RATE,MIN_DAY:MIN_DAY,addDays:addDays,periodStart:periodStart,periodEnd:periodEnd,
  payday:payday,periodDays:periodDays,toMin:toMin,hmOf:hmOf,paidMinutes:paidMinutes,periodTotals:periodTotals};
if(typeof module!=='undefined'&&module.exports) module.exports=api; else root.NannyCore=api;
})(this);
