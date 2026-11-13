/* nanny-link.js — the second Firebase app, for Ava's hours, schedule and notes (NANNY-SPEC.md §13).
   They live in their own project (west-family-nanny) so Ava, a household employee, never signs
   into the restaurant's project. Shared by home.html, the Bridge and nanny.html. Holds no data
   and no private address; who may read what is decided by that project's rules.
   Named app 'nanny', never the default app (the Bridge's session-slot bug, 2026-10). */
(function(){
"use strict";
var CFG={apiKey:"AIzaSyAWWx2wsTjwgdSoAS0kc3RvCUJESKOwPts",authDomain:"west-family-nanny.firebaseapp.com",
  projectId:"west-family-nanny",storageBucket:"west-family-nanny.firebasestorage.app",
  messagingSenderId:"579541581280",appId:"1:579541581280:web:d6224212e7b47e61fe7f85"};
if(!window.firebase||!firebase.initializeApp){ window.NannyLink=null; return; }
var app; try{ app=firebase.app('nanny'); }catch(e){ app=firebase.initializeApp(CFG,'nanny'); }
var auth=app.auth(), db=app.firestore(), subs=[], ready=false, err='';
/* Test harness only (emulators on this machine). No page sets this; it cannot reach a real project. */
if(window.__NANNY_EMU){ auth.useEmulator('http://127.0.0.1:'+window.__NANNY_EMU.auth); db.useEmulator('127.0.0.1',window.__NANNY_EMU.fs); }
auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(function(){});
function fire(){ subs.slice().forEach(function(f){ try{ f(auth.currentUser); }catch(e){} }); }
auth.onAuthStateChanged(function(){ ready=true; fire(); });
auth.getRedirectResult().catch(function(e){ err=(e&&e.message)||String(e); fire(); });
window.NannyLink={
  db:db, auth:auth,
  ready:function(){ return ready; },
  user:function(){ var u=auth.currentUser; return u&&u.email?u:null; },
  email:function(){ var u=auth.currentUser; return u&&u.email?u.email.toLowerCase():''; },
  error:function(){ return err; },
  on:function(f){ subs.push(f); return function(){ subs=subs.filter(function(x){return x!==f;}); }; },
  /* hint: the address this person already uses, so Google offers it first. */
  connect:function(hint){
    err=''; var p=new firebase.auth.GoogleAuthProvider();
    var cp={prompt:'select_account'}; if(hint) cp.login_hint=hint; p.setCustomParameters(cp);
    return auth.signInWithPopup(p).catch(function(e){
      var c=(e&&e.code)||'';
      if(c==='auth/popup-blocked'||c==='auth/operation-not-supported-in-this-environment'||c==='auth/cancelled-popup-request')
        return auth.signInWithRedirect(p).catch(function(e2){ err=(e2&&e2.message)||String(e2); fire(); return null; });
      if(c==='auth/popup-closed-by-user') return null;
      err=(e&&e.message)||String(e); fire(); return null; });
  },
  disconnect:function(){ return auth.signOut(); }
};
})();
