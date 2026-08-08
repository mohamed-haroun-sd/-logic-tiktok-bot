#!/usr/bin/env python3
"""
Safe patcher for 888.py (Logic website - 38K lines)
Applies ONLY the necessary fixes without touching anything else.
Creates a backup before modifying.
"""
import sys
import shutil
import os
import re

def apply_fixes(filepath):
    """Read file, apply all fixes, write back."""
    
    if not os.path.exists(filepath):
        print(f"❌ File not found: {filepath}")
        return False
    
    # Create backup
    backup_path = filepath + '.backup_before_fixes'
    if not os.path.exists(backup_path):
        shutil.copy2(filepath, backup_path)
        print(f"✅ Backup created: {backup_path}")
    else:
        print(f"ℹ️  Backup already exists: {backup_path}")
    
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()
    
    original_length = len(content)
    fixes_applied = 0
    
    # ═══════════════════════════════════════════════════
    # FIX 1: Add order_id to POST /api/tiktok/order response
    # ═══════════════════════════════════════════════════
    fix1_old = 'return jsonify({"ok": True, "ticket_id": tid, "new_balance": db.get_bal(uid)})'
    fix1_new = 'return jsonify({"ok": True, "ticket_id": tid, "order_id": order_id, "new_balance": db.get_bal(uid)})'
    
    if fix1_old in content:
        content = content.replace(fix1_old, fix1_new, 1)
        fixes_applied += 1
        print("✅ FIX 1: Added order_id to POST /api/tiktok/order response")
    else:
        print("⚠️  FIX 1: Pattern not found (might already be applied)")
    
    # ═══════════════════════════════════════════════════
    # FIX 2: Add GET /api/tiktok/order/<order_id> endpoint
    # Find the line before @app.route('/api/tiktok/orders/pending'
    # ═══════════════════════════════════════════════════
    fix2_marker = "@app.route('/api/tiktok/orders/pending', methods=['GET'])"
    fix2_new_endpoint = '''# ═══ Get order details (used by frontend polling) ═══
@app.route('/api/tiktok/order/<order_id>', methods=['GET'])
def api_tiktok_order_detail(order_id):

    order = db.tiktok_orders.get(str(order_id))
    if not order:
        return jsonify({"ok": False, "error": "order_not_found"})

    return jsonify({
        "ok": True,
        "order": {
            "id": order.get("id"),
            "uid": order.get("uid"),
            "coins": order.get("coins"),
            "price_usd": order.get("price_usd"),
            "status": order.get("status"),
            "login_link": order.get("login_link", ""),
            "expires": order.get("expires", 0),
            "session_id": order.get("session_id", ""),
            "charge_status": order.get("charge_status", "pending"),
            "created": order.get("created", 0)
        }
    })


'''
    
    if fix2_marker in content and "def api_tiktok_order_detail" not in content:
        content = content.replace(fix2_marker, fix2_new_endpoint + fix2_marker, 1)
        fixes_applied += 1
        print("✅ FIX 2: Added GET /api/tiktok/order/<order_id> endpoint")
    else:
        print("⚠️  FIX 2: Already applied or marker not found")
    
    # ═══════════════════════════════════════════════════
    # FIX 3: Fix openTikTokLoginModal - replace example.com with dynamic link
    # ═══════════════════════════════════════════════════
    fix3_old_copy = 'navigator.clipboard.writeText("https://example.com/login");'
    fix3_new_copy = 'navigator.clipboard.writeText(window._ttLoginLink || "https://example.com/login");'
    
    fix3_old_open = 'window.open("https://example.com/login","_blank");'
    fix3_new_open = 'window.open(window._ttLoginLink || "https://example.com/login","_blank");'
    
    fix3_changed = False
    if fix3_old_copy in content:
        content = content.replace(fix3_old_copy, fix3_new_copy)
        fix3_changed = True
    if fix3_old_open in content:
        content = content.replace(fix3_old_open, fix3_new_open)
        fix3_changed = True
    
    if fix3_changed:
        fixes_applied += 1
        print("✅ FIX 3: Fixed QR link to use dynamic window._ttLoginLink")
    else:
        print("⚠️  FIX 3: Pattern not found (might already be applied)")
    
    # ═══════════════════════════════════════════════════
    # FIX 4: Fix submitTtOrder - remove early return and add API call + polling
    # ═══════════════════════════════════════════════════
    fix4_old = '''  // ═══ افتح نافذة تسجيل الدخول الجديدة
  openTikTokLoginModal();
  return;

  const btn = document.querySelector('.tt-submit');
  if(btn){btn.disabled=true;btn.innerHTML='<i class="fas fa-spinner fa-spin"></i> جاري إنشاء الطلب...'}
  try {
    const r = await AP('/tiktok/order', {
      coins: coins,
      price_usd: priceUsd,
      price_iqd: priceIqd,
      is_custom: isCustom,
      notes: notes.trim(),
      whatsapp: wa
    });
    const d = await r.json();
    if(d.ok){
      // ═══ Update local balance immediately so UI reflects the deduction
      try{
        if(typeof ME!=='undefined' && ME && typeof d.new_balance==='number'){
          ME.balance = d.new_balance;
          var _bv=document.getElementById('wBal'); if(_bv) _bv.textContent = fmtP(ME.balance);
          var _bv2=document.getElementById('ttCurBalVal'); if(_bv2) _bv2.textContent = fmtP(ME.balance);
        }
      }catch(e){}
      toast('<i class="fas fa-check-circle"></i> تم إنشاء الطلب بنجاح');
      setTimeout(()=>{nav('tickets');setTimeout(()=>{if(typeof openTicket==='function' && d.ticket_id)openTicket(d.ticket_id)},400)},800);
    } else {
      // ═══ Show insufficient-balance message clearly with shortcut to recharge
      if(d.code === 'insufficient_balance'){
        toast('<i class="fas fa-wallet"></i> '+(d.error||'رصيدك غير كافٍ'));
        setTimeout(()=>{ if(confirm('هل تريد الذهاب لشحن الرصيد الآن؟')) nav('recharge'); }, 600);
      } else {
        toast('<i class="fas fa-times-circle"></i> '+(d.error||'فشل الإرسال'));
      }
      if(btn){btn.disabled=false;btn.innerHTML='<i class="fas fa-lock"></i> تأكيد الطلب'}
    }
  } catch(e) {
    toast('<i class="fas fa-times-circle"></i> خطأ بالاتصال');
    if(btn){btn.disabled=false;btn.innerHTML='<i class="fas fa-lock"></i> تأكيد الطلب'}
  }
}'''
    
    fix4_new = '''  const btn = document.querySelector('.tt-submit');
  if(btn){btn.disabled=true;btn.innerHTML='<i class="fas fa-spinner fa-spin"></i> جاري إنشاء الطلب...'}
  try {
    const r = await AP('/tiktok/order', {
      coins: coins,
      price_usd: priceUsd,
      price_iqd: priceIqd,
      is_custom: isCustom,
      notes: notes.trim(),
      whatsapp: wa
    });
    const d = await r.json();
    if(d.ok){
      // ═══ Update local balance immediately so UI reflects the deduction
      try{
        if(typeof ME!=='undefined' && ME && typeof d.new_balance==='number'){
          ME.balance = d.new_balance;
          var _bv=document.getElementById('wBal'); if(_bv) _bv.textContent = fmtP(ME.balance);
          var _bv2=document.getElementById('ttCurBalVal'); if(_bv2) _bv2.textContent = fmtP(ME.balance);
        }
      }catch(e){}
      toast('<i class="fas fa-check-circle"></i> تم إنشاء الطلب بنجاح — جاري التحضير...');
      
      // ═══ Save order id for polling
      window._ttLastOrderId = d.order_id || d.ticket_id || '';
      
      // ═══ Start polling for login link
      _ttStartLoginLinkPolling();
      
      // ═══ Open QR login modal
      setTimeout(()=>{ openTikTokLoginModal(); }, 500);
      
      if(btn){btn.disabled=false;btn.innerHTML='<i class="fas fa-lock"></i> تأكيد الطلب'}
    } else {
      // ═══ Show insufficient-balance message clearly with shortcut to recharge
      if(d.code === 'insufficient_balance'){
        toast('<i class="fas fa-wallet"></i> '+(d.error||'رصيدك غير كافٍ'));
        setTimeout(()=>{ if(confirm('هل تريد الذهاب لشحن الرصيد الآن؟')) nav('recharge'); }, 600);
      } else {
        toast('<i class="fas fa-times-circle"></i> '+(d.error||'فشل الإرسال'));
      }
      if(btn){btn.disabled=false;btn.innerHTML='<i class="fas fa-lock"></i> تأكيد الطلب'}
    }
  } catch(e) {
    toast('<i class="fas fa-times-circle"></i> خطأ بالاتصال');
    if(btn){btn.disabled=false;btn.innerHTML='<i class="fas fa-lock"></i> تأكيد الطلب'}
  }
}

// ═══ Poll for login link every 2 seconds ═══
function _ttStartLoginLinkPolling(){
  if(window._ttPollTimer) clearInterval(window._ttPollTimer);
  let pollCount = 0;
  const maxPolls = 60; // 2 minutes max
  
  window._ttPollTimer = setInterval(async ()=>{
    pollCount++;
    if(pollCount > maxPolls){
      clearInterval(window._ttPollTimer);
      return;
    }
    
    try {
      const oid = window._ttLastOrderId;
      if(!oid) return;
      const r = await fetch(API+'/tiktok/order/'+oid, {method:'GET'});
      const d = await r.json();
      if(d.ok && d.order){
        const order = d.order;
        // ═══ Update login link if available
        if(order.login_link && order.login_link !== 'https://example.com/login'){
          window._ttLoginLink = order.login_link;
          window._ttLoginExpires = order.expires;
          // ═══ Update the modal buttons
          const copyBtn = document.getElementById('ttCopyLoginLink');
          const loginBtn = document.getElementById('ttLoginBtn');
          const countdown = document.getElementById('ttLoginCountdown');
          
          if(copyBtn){
            copyBtn.onclick = function(){
              navigator.clipboard.writeText(order.login_link);
              toast('<i class="fas fa-copy"></i> تم نسخ الرابط');
            };
            copyBtn.disabled = false;
            copyBtn.innerHTML = '<i class="far fa-copy"></i> نسخ الرابط';
          }
          if(loginBtn){
            loginBtn.onclick = function(){
              window.open(order.login_link, '_blank');
            };
            loginBtn.disabled = false;
            loginBtn.innerHTML = '<i class="fab fa-tiktok"></i> تسجيل الدخول';
          }
          if(countdown){
            // Reset countdown if expires set
            if(order.expires > 0){
              const remaining = Math.max(0, order.expires - Math.floor(Date.now()/1000));
              countdown.innerText = remaining;
            }
          }
        }
        // ═══ Check status
        if(order.status === 'completed' || order.charge_status === 'completed' || order.charge_status === 'success'){
          clearInterval(window._ttPollTimer);
          toast('<i class="fas fa-check-circle"></i> تم شحن العملات بنجاح!');
          const ov = document.getElementById('ttLoginOverlay');
          if(ov) ov.classList.remove('show');
          document.body.style.overflow = '';
          document.documentElement.style.overflow = '';
          // Reload page to update balance
          setTimeout(()=>{ nav('tiktok'); }, 1500);
        }
      }
    } catch(e){}
  }, 2000);
}'''
    
    if fix4_old in content:
        content = content.replace(fix4_old, fix4_new, 1)
        fixes_applied += 1
        print("✅ FIX 4: Fixed submitTtOrder + added _ttStartLoginLinkPolling")
    else:
        print("⚠️  FIX 4: Pattern not found (might already be applied or slightly different)")
    
    # ═══════════════════════════════════════════════════
    # VALIDATE Python syntax
    # ═══════════════════════════════════════════════════
    try:
        compile(content, filepath, 'exec')
        print("✅ Python syntax validation passed")
    except SyntaxError as e:
        print(f"❌ Python syntax error after patching: {e}")
        print("🔄 Restoring from backup...")
        shutil.copy2(backup_path, filepath)
        return False
    
    # Write back
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)
    
    new_length = len(content)
    print(f"\n{'='*60}")
    print(f"📊 Changes: {fixes_applied} fix(es) applied")
    print(f"📏 Size: {original_length} → {new_length} chars")
    print(f"{'='*60}")
    
    return True


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python3 apply_fixes.py /path/to/888.py")
        sys.exit(1)
    
    filepath = sys.argv[1]
    success = apply_fixes(filepath)
    
    if success:
        print("\n🎉 All fixes applied successfully!")
        print("\n📋 Next steps:")
        print("   1. Restart your server:")
        print("      systemctl restart 888   (or however you restart it)")
        print("   2. Update bot files:")
        print("      cd /path/to/bot")
        print("      git pull origin main")
        print("   3. Restart bot:")
        print("      node login.js")
    else:
        print("\n❌ Fix failed - backup restored")
        sys.exit(1)
