/* ==========================================================================
   supabase-config.js — CRWD SRFR
   Creates one shared Supabase client for every page: window.srfr.supabase

   Load order on each page (in <head> or before your page scripts):
     <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
     <script src="/js/supabase-config.js"></script>
   ========================================================================== */
(function () {
  'use strict';

  // --- Project keys -------------------------------------------------------
  // Publishable keys are designed to be public (RLS protects the data).
  // NEVER put a secret / service_role key in this file.
  const PROJECTS = {
    staging: {
      url: 'https://kgixthcjojlkacnxtzeg.supabase.co',
      key: 'sb_publishable_9hn_OpemNeyrJINtqwwUOQ_gZbIfco-'
    },
    prod: {
      url: 'https://bkzklbyyhnotphpgnnei.supabase.co',
      key: 'sb_publishable_pDDAyzdIv0E2ZS2lE2HQLA_tR03y2Rx'
    }
  };

  // Only the live domain talks to prod; localhost, staging, anything else → staging
  const host = window.location.hostname;
  const ENV = (host === 'crwdsrfr.com' || host === 'www.crwdsrfr.com') ? 'prod' : 'staging';

  // --- "Keep me signed in for 30 days" --------------------------------------
  // Checked   → session saved in localStorage, expires 30 days after sign-in
  // Unchecked → session saved in sessionStorage, ends when the browser closes
  const REMEMBER_KEY = 'srfr-remember-until';
  const REMEMBER_DAYS = 30;

  // localStorage/sessionStorage can throw (private mode, blocked storage)
  function safe(fn, fallback) {
    try { return fn(); } catch (e) { return fallback; }
  }

  function rememberUntil() {
    return Number(safe(() => localStorage.getItem(REMEMBER_KEY), 0)) || 0;
  }

  function isRemembered() {
    return rememberUntil() > Date.now();
  }

  // Storage adapter handed to supabase-js; picks the store on every read/write
  const sessionStore = {
    getItem(key) {
      if (isRemembered()) return safe(() => localStorage.getItem(key), null);
      // Remember window ran out → wipe the long-lived copy so it can't be reused
      if (rememberUntil()) {
        safe(() => { localStorage.removeItem(key); localStorage.removeItem(REMEMBER_KEY); });
      }
      return safe(() => sessionStorage.getItem(key), null);
    },
    setItem(key, value) {
      const store = isRemembered() ? localStorage : sessionStorage;
      safe(() => store.setItem(key, value));
    },
    removeItem(key) {
      safe(() => localStorage.removeItem(key));
      safe(() => sessionStorage.removeItem(key));
    }
  };

  const client = window.supabase.createClient(PROJECTS[ENV].url, PROJECTS[ENV].key, {
    auth: {
      storage: sessionStore,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true // lets the magic link in the email sign the user in
    }
  });

  window.srfr = window.srfr || {};
  window.srfr.env = ENV;
  window.srfr.supabase = client;

  // Call BEFORE verifying the code / sending the link, so the new session
  // is written to the right place. Pass the checkbox value.
  window.srfr.setRememberMe = function (remember) {
    if (remember) {
      const until = Date.now() + REMEMBER_DAYS * 24 * 60 * 60 * 1000;
      safe(() => localStorage.setItem(REMEMBER_KEY, String(until)));
    } else {
      safe(() => localStorage.removeItem(REMEMBER_KEY));
    }
  };

  // Small visual cue so you never confuse staging with live
  if (ENV === 'staging') console.info('[srfr] Supabase: STAGING project');
})();
