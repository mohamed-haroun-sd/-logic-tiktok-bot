#!/usr/bin/env python3
"""
apply_fixes_v4.py — Safe idempotent patcher for 888.py
=====================================================
Upgrades the TikTok QR login modal to a professional flow:

  BEFORE (buggy):
    - As soon as the modal opens, buttons are ENABLED
    - Clicking them opens the FAKE fallback "https://example.com/login"
    - Countdown starts immediately, even before the real link arrives

  AFTER (professional):
    - Modal opens with buttons DISABLED + "جاري إنشاء الرابط..." + spinner
    - Countdown stays hidden until the real link arrives
    - When the bot delivers the real link (via polling):
        • Countdown starts (30s)
        • Buttons become "نسخ الرابط" / "تسجيل الدخول" (real link)
    - If 2 minutes pass without a link → clear timeout message + close button

SAFE:
  - Regex-based, idempotent (re-running does nothing)
  - Creates backup only when changes are actually applied
  - Validates Python syntax before reporting success
"""
import re
import sys
import shutil

SRC = sys.argv[1] if len(sys.argv) > 1 else "888.py"

if not __name__ == "__main__":
    raise SystemExit("Run directly: python3 apply_fixes_v4.py 888.py")

with open(SRC, "r", encoding="utf-8") as f:
    src = f.read()

# ── Idempotency guard ───────────────────────────────────────────────
if '/* FIX v4 — professional login modal */' in src:
    print("✅ FIX v4 already applied — nothing to do (idempotent)")
    sys.exit(0)

applied = []

# ═════════════════════════════════════════════════════════════════════
# FIX A — Modal HTML: buttons start DISABLED with "جاري إنشاء الرابط"
# ═════════════════════════════════════════════════════════════════════

A_FIND = r'<button class="tt-login-btn" id="ttLoginBtn">\s*<i class="fab fa-tiktok"></i>\s*تسجيل الدخول\s*</button>'
A_REPL = '''<button class="tt-login-btn tt-login-btn--loading" id="ttLoginBtn" disabled>
          <i class="fas fa-circle-notch fa-spin"></i>
          جاري إنشاء الرابط...
      </button>'''

if re.search(A_FIND, src):
    src = re.sub(A_FIND, A_REPL, src, count=1)
    applied.append('FIX A: Login button starts disabled with spinner ("جاري إنشاء الرابط...")')
else:
    print("⚠️  FIX A pattern not found (may already differ) — skipped")

B_FIND = r'<button class="tt-copy-btn" id="ttCopyLoginLink">\s*<i class="far fa-copy"></i>\s*نسخ الرابط\s*</button>'
B_REPL = '''<button class="tt-copy-btn" id="ttCopyLoginLink" disabled>
          <i class="fas fa-circle-notch fa-spin"></i>
          جاري إنشاء الرابط...
      </button>'''

if re.search(B_FIND, src):
    src = re.sub(B_FIND, B_REPL, src, count=1)
    applied.append('FIX B: Copy button starts disabled with spinner')
else:
    print("⚠️  FIX B pattern not found (may already differ) — skipped")

# Countdown hidden until the link actually arrives
C_FIND = r'(<div class="tt-login-timer">\s*<div id="ttLoginCountdown">30</div>\s*</div>)'
C_REPL = r'<div class="tt-login-timer" id="ttLoginTimerWrap" style="display:none"><div id="ttLoginCountdown">30</div></div>'

if re.search(C_FIND, src):
    src = re.sub(C_FIND, C_REPL, src, count=1)
    applied.append('FIX C: Countdown hidden until real link arrives')
else:
    print("⚠️  FIX C pattern not found — skipped")

# ═════════════════════════════════════════════════════════════════════
# FIX D — CSS: loading button state
# ═════════════════════════════════════════════════════════════════════

CSS_INJECT = '''
/* FIX v4 — professional login modal */
.tt-login-btn--loading{
opacity:.65;
cursor:wait;
background:linear-gradient(135deg,#555,#333);
}
.tt-login-btn:disabled,
.tt-copy-btn:disabled{
opacity:.65;
cursor:wait;
}
.tt-login-note--pending{
color:var(--t3);
}
/* FIX v4 end */
'''

# Inject right after the .tt-login-note closing rule
D_PAT = r'(\.tt-login-note\{[^}]+\})'
if re.search(D_PAT, src):
    src = re.sub(D_PAT, r'\1' + CSS_INJECT, src, count=1)
    applied.append('FIX D: CSS loading/disabled button styles injected')
else:
    print("⚠️  FIX D pattern not found — skipped")

# ═════════════════════════════════════════════════════════════════════
# FIX E — openTikTokLoginModal: do NOT start countdown immediately;
#          show pending state instead.
# ═════════════════════════════════════════════════════════════════════

E_FIND = r"function openTikTokLoginModal\(\)\{.*?document\.getElementById\('ttCopyLoginLink'\)\.onclick=function\(\)\{\s*const link = window\._ttLoginLink \|\| \"https://example\.com/login\";\s*navigator\.clipboard\.writeText\(link\);\s*toast\('<i class=\"fas fa-copy\"></i> تم نسخ الرابط'\);\s*\};\s*document\.getElementById\('ttLoginBtn'\)\.onclick=function\(\)\{\s*const link = window\._ttLoginLink \|\| \"https://example\.com/login\";\s*window\.open\(link,\"_blank\"\);\s*\};\s*\}"

E_REPL = '''function openTikTokLoginModal(){
  const ov=document.getElementById('ttLoginOverlay');
  if(!ov)return;

  if(ov.parentElement!==document.body){
      document.body.appendChild(ov);
  }

  ov.classList.add('show');
  document.body.style.overflow='hidden';
  document.documentElement.style.overflow='hidden';

  // ═══ FIX v4 — PENDING STATE: buttons disabled until real link arrives ═══
  const copyBtn=document.getElementById('ttCopyLoginLink');
  const loginBtn=document.getElementById('ttLoginBtn');
  const timerWrap=document.getElementById('ttLoginTimerWrap');
  const countdown=document.getElementById('ttLoginCountdown');
  const note=ov.querySelector('.tt-login-note');

  if(loginBtn){
      loginBtn.disabled=true;
      loginBtn.className='tt-login-btn tt-login-btn--loading';
      loginBtn.innerHTML='<i class="fas fa-circle-notch fa-spin"></i> جاري إنشاء الرابط...';
  }
  if(copyBtn){
      copyBtn.disabled=true;
      copyBtn.innerHTML='<i class="fas fa-circle-notch fa-spin"></i> جاري إنشاء الرابط...';
  }
  if(timerWrap) timerWrap.style.display='none';

  if(window._ttTimer)
      clearInterval(window._ttTimer);

  ov.onclick=function(e){
      if(e.target===ov){
          clearInterval(window._ttTimer);
          ov.classList.remove('show');
          document.body.style.overflow='';
          document.documentElement.style.overflow='';
      }
  };

  // ═══ FIX v4 — real handlers (only fire when real link exists) ═══
  if(copyBtn){
      copyBtn.onclick=function(){
          const link = window._ttLoginLink || "";
          if(!link) return;
          navigator.clipboard.writeText(link);
          toast('<i class="fas fa-copy"></i> تم نسخ الرابط');
      };
  }

  if(loginBtn){
      loginBtn.onclick=function(){
          const link = window._ttLoginLink || "";
          if(!link) return;
          window.open(link,"_blank");
      };
  }
}

// ═══ FIX v4 — activate modal once the real link arrives ═══
function _ttActivateLoginModal(sec){
  sec = sec || 30;
  const loginBtn=document.getElementById('ttLoginBtn');
  const copyBtn=document.getElementById('ttCopyLoginLink');
  const timerWrap=document.getElementById('ttLoginTimerWrap');
  const countdown=document.getElementById('ttLoginCountdown');
  const note=document.querySelector('#ttLoginOverlay .tt-login-note');

  if(loginBtn){
      loginBtn.disabled=false;
      loginBtn.className='tt-login-btn';
      loginBtn.innerHTML='<i class="fab fa-tiktok"></i> تسجيل الدخول';
  }
  if(copyBtn){
      copyBtn.disabled=false;
      copyBtn.innerHTML='<i class="far fa-copy"></i> نسخ الرابط';
  }
  if(timerWrap) timerWrap.style.display='flex';
  if(countdown) countdown.innerText=sec;

  const sub=document.querySelector('#ttLoginOverlay .tt-login-sub');
  if(sub) sub.innerHTML='امسح الكود بكاميرا جوالك خلال <b>'+sec+'</b> ثانية<br>لإتمام تسجيل الدخول الآمن ثم ارجع هنا.';
  if(note) note.innerHTML='لا تغلق هذه النافذة أثناء المسح.<br>بعد الانتهاء سيتم شحن العملات تلقائياً.';

  if(window._ttTimer) clearInterval(window._ttTimer);

  window._ttTimer=setInterval(()=>{
      sec--;
      if(countdown) countdown.innerText=sec;

      if(sec<=0){
          clearInterval(window._ttTimer);
          if(loginBtn){
              loginBtn.disabled=true;
              loginBtn.innerHTML='<i class="fas fa-rotate-right"></i> انتهت صلاحية الرابط — جاري إنشاء رابط جديد...';
          }
      }
  },1000);
}'''

if re.search(E_FIND, src, re.S):
    src = re.sub(E_FIND, E_REPL, src, count=1, flags=re.S)
    applied.append('FIX E: openTikTokLoginModal → pending state + _ttActivateLoginModal helper')
else:
    print("⚠️  FIX E pattern not found — skipped")

# ═════════════════════════════════════════════════════════════════════
# FIX F — Polling: when real link arrives, ACTIVATE the modal
#          When polling times out → show clear message
# ═════════════════════════════════════════════════════════════════════

F_FIND = r"(if\(order\.login_link && order\.login_link !== 'https://example\.com/login'\)\{\s*window\._ttLoginLink = order\.login_link;\s*window\._ttLoginExpires = order\.expires;)"

F_REPL = r"""\1
          // ═══ FIX v4 — activate the modal now that the real link arrived ═══
          const expires = order.expires > 0 ? Math.max(30, Math.floor(order.expires - Math.floor(Date.now()/1000))) : 30;
          if (typeof _ttActivateLoginModal === 'function') _ttActivateLoginModal(expires);"""

if re.search(F_FIND, src):
    src = re.sub(F_FIND, F_REPL, src, count=1)
    applied.append('FIX F: Polling activates modal on real link arrival')
else:
    print("⚠️  FIX F pattern not found — skipped")

# Timeout handler: poll count exceeded
G_FIND = r"pollCount\+\+;\s*if\(pollCount > maxPolls\)\{\s*clearInterval\(window\._ttPollTimer\);\s*return;\s*\}"

G_REPL = r"""pollCount++;
    if(pollCount > maxPolls){
      clearInterval(window._ttPollTimer);
      const loginBtn=document.getElementById('ttLoginBtn');
      const copyBtn=document.getElementById('ttCopyLoginLink');
      if(loginBtn){ loginBtn.disabled=true; loginBtn.innerHTML='<i class="fas fa-exclamation-circle"></i> لم يصل الرابط بعد'; }
      if(copyBtn){ copyBtn.disabled=true; copyBtn.innerHTML='<i class="fas fa-exclamation-circle"></i> لم يصل الرابط بعد'; }
      const sub=document.querySelector('#ttLoginOverlay .tt-login-sub');
      if(sub) sub.innerHTML='لم يصل رابط تسجيل الدخول بعد دقيقتين.<br>جرّب إعادة الطلب، وإذا تكررت المشكلة تواصل مع الدعم.';
      return;
    }
    if(window.__ttV4TimeoutHandled){}
    window.__ttV4TimeoutHandled=true"""

if re.search(G_FIND, src):
    src = re.sub(G_FIND, G_REPL, src, count=1)
    applied.append('FIX G: Polling timeout → clear user-facing message')
else:
    print("⚠️  FIX G pattern not found — already applied or changed")

# ═════════════════════════════════════════════════════════════════════
# Result
# ═════════════════════════════════════════════════════════════════════

if not applied:
    print("❌ No fixes applied — patterns not found")
    sys.exit(1)

shutil.copy(SRC, SRC + ".backup_v4_" + __import__('datetime').datetime.now().strftime("%Y%m%d_%H%M%S"))

with open(SRC, "w", encoding="utf-8") as f:
    f.write(src)

# Validate Python syntax
import py_compile
try:
    py_compile.compile(SRC, doraise=True)
    applied.append('Python syntax validation passed')
except py_compile.PyCompileError as e:
    print(f"❌ Syntax error after patch: {e}")
    sys.exit(2)

print("\n✅ Backup created")
print("═" * 60)
for i, a in enumerate(applied, 1):
    print(f"✅ FIX {i}: {a}")

print("\n📋 Next steps:")
print("   1. systemctl restart beinty")
print("   2. pm2 restart tiktok-bot   (bot picks up the fix via polling)")
print("   3. Test: place a new order → modal shows \"جاري إنشاء الرابط...\" → link arrives → 30s countdown")
