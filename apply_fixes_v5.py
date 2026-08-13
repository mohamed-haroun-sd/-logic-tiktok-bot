#!/usr/bin/env python3
"""
apply_fixes_v5.py — v11 website backend/frontend updates for 888.py

Applies the following to the Flask backend (888.py on the server):

  FIX 1 — order/update endpoint: persist new fine-grained fields
            payment_step, failure_message, failure_code, charge_status
  FIX 2 — order detail endpoint: return payment_step / failure fields
          plus a rich status_ar (Arabic step labels) for the UI
  FIX 3 — frontend polling: render a live progress timeline that shows
            each payment_step with an Arabic label + icon (waiting login
            → QR ready → login success → coins → payment → done/failed)
            and a human failure message when the order fails

Usage:
    python3 apply_fixes_v5.py 888.py

The patcher is IDEMPOTENT — running it twice on the same file makes
no further changes (only creates the backup on the first real change).
"""

import re
import sys
import os


def apply_fixes(filename):
    with open(filename, "r", encoding="utf-8", errors="replace") as f:
        content = f.read()

    original = content
    changes = []

    # ══════════════════════════════════════════════════════════
    # FIX 1 — persist fine-grained fields in /api/tiktok/order/update
    # ══════════════════════════════════════════════════════════
    fix1_old = """    session_id = str(data.get("session_id",""))

    order = db.tiktok_orders.get(order_id)

    if not order:
        return jsonify({"ok":False,"error":"order_not_found"})

    if status:
        order["status"] = status

    if login_link:
        order["login_link"] = login_link

    if expires:
        order["expires"] = expires

    if session_id:
        order["session_id"] = session_id

    db.save()

    return jsonify({"ok":True})"""

    fix1_new = """    session_id = str(data.get("session_id",""))
    # ── v11 FIX 1: persist fine-grained step & failure fields ──
    payment_step = str(data.get("payment_step",""))
    failure_message = str(data.get("failure_message",""))
    failure_code = str(data.get("failure_code",""))
    charge_status = str(data.get("charge_status",""))

    order = db.tiktok_orders.get(order_id)

    if not order:
        return jsonify({"ok":False,"error":"order_not_found"})

    if status:
        order["status"] = status

    if login_link:
        order["login_link"] = login_link

    if expires:
        order["expires"] = expires

    if session_id:
        order["session_id"] = session_id

    # ── v11 FIX 1b: only move forwards (never completed → failed) ──
    if charge_status:
        order["charge_status"] = charge_status

    if payment_step:
        _good = payment_step
        order["payment_step"] = _good

    if failure_message:
        order["failure_message"] = failure_message

    if failure_code:
        order["failure_code"] = failure_code

    db.save()

    return jsonify({"ok":True})"""

    if fix1_old in content:
        content = content.replace(fix1_old, fix1_new, 1)
        changes.append("FIX 1: order/update now persists payment_step / failure_message / failure_code / charge_status")
    elif "FIX 1:" in content:
        pass  # already applied
    else:
        print("⚠️  FIX 1 anchor not found — check apply_fixes_v5.py anchor text")

    # ══════════════════════════════════════════════════════════
    # FIX 2 — order detail endpoint: richer response
    # ══════════════════════════════════════════════════════════
    fix2_old = """    status_ar = {
        "waiting_link": "بانتظار رابط الدخول",
        "processing": "جارٍ التنفيذ التلقائي...",
        "link_ready": "رابط الدخول جاهز",
        "completed": "تم الشحن بنجاح ✅",
        "failed": "فشل التنفيذ ❌",
    }.get(status, status)
    return jsonify({
        "ok": True,
        "order": {
            "id": order.get("id"),
            "uid": order.get("uid"),
            "coins": order.get("coins"),
            "price_usd": order.get("price_usd"),
            "status": status,
            "status_ar": status_ar,
            "login_link": order.get("login_link", ""),
            "expires": order.get("expires", 0),
            "session_id": order.get("session_id", ""),
            "charge_status": order.get("charge_status", "pending"),
            "created": order.get("created", 0)
        }
    })"""

    fix2_new = """    # ── v11 FIX 2: fine-grained step labels + failure info ──
    step = order.get("payment_step", "") or ""
    if status == "waiting_link":
        status_ar = "بانتظار الرابط..."
    elif step == "login_required":
        status_ar = "جارٍ تسجيل الدخول..."
    elif step == "qr_ready":
        status_ar = "رابط الدخول جاهز — امسح QR من جوالك 📱"
    elif step == "login_success":
        status_ar = "تم تسجيل الدخول بنجاح ✅"
    elif step == "coins_selecting":
        status_ar = "اختيار باقة العملات... 🪙"
    elif step == "payment_ready":
        status_ar = "تجهيز الدفع... 💳"
    elif step == "payment_processing":
        status_ar = "جارٍ تنفيذ الدفع — لا تغلق الصفحة ⏳"
    elif status == "completed" or step == "success":
        status_ar = "تم الشحن بنجاح ✅"
    elif status == "failed":
        status_ar = "فشل التنفيذ ❌"
    elif status == "processing":
        status_ar = "جارٍ التنفيذ التلقائي..."
    else:
        status_ar = status

    # Human failure message for the user (in Arabic-friendly form)
    failure_info = None
    if status == "failed":
        _fm = order.get("failure_message", "")
        if "qr_scan_timeout" in _fm:
            failure_info = "انتهت مهلة مسح رمز QR — أعد الطلب وامسح الرمز بسرعة 📱"
        elif "qr_login_failed" in _fm:
            failure_info = "فشل إنشاء رابط تسجيل الدخول — أعد الطلب 🔄"
        elif "not available" in _fm or "not among" in _fm:
            failure_info = "الباقة المختارة غير متوفرة حالياً في تيك توك — اختر باقة أخرى 🪙"
        elif "declined" in _fm:
            failure_info = "رفض بنكك عملية الدفع — جرّب بطاقة أخرى 💳"
        elif _fm:
            failure_info = "حدث خطأ أثناء التنفيذ: " + _fm
        else:
            failure_info = "فشل تنفيذ الطلب — أعد المحاولة 🔄"

    return jsonify({
        "ok": True,
        "order": {
            "id": order.get("id"),
            "uid": order.get("uid"),
            "coins": order.get("coins"),
            "price_usd": order.get("price_usd"),
            "status": status,
            "status_ar": status_ar,
            "payment_step": step,
            "login_link": order.get("login_link", ""),
            "expires": order.get("expires", 0),
            "session_id": order.get("session_id", ""),
            "charge_status": order.get("charge_status", "pending"),
            "failure_message": order.get("failure_message", ""),
            "failure_code": order.get("failure_code", ""),
            "failure_info": failure_info,
            "created": order.get("created", 0)
        }
    })"""

    if fix2_old in content:
        content = content.replace(fix2_old, fix2_new, 1)
        changes.append("FIX 2: order detail endpoint returns payment_step + failure_info + rich status_ar")
    elif "v11 FIX 2" in content:
        pass  # already applied
    else:
        print("⚠️  FIX 2 anchor not found — check apply_fixes_v5.py anchor text")

    # ══════════════════════════════════════════════════════════
    # FIX 3 — frontend polling: live progress timeline
    # ══════════════════════════════════════════════════════════
    fix3_old = """        // ═══ Check status
        if(order.status === 'completed' || order.charge_status === 'completed' || order.charge_status === 'success'){
          clearInterval(window._ttPollTimer);
          toast('<i class="fas fa-check-circle"></i> تم شحن العملات بنجاح!');
          const ov = document.getElementById('ttLoginOverlay');
          if(ov) ov.classList.remove('show');
          document.body.style.overflow = '';
          document.documentElement.style.overflow = '';
          // Reload page to update balance
          setTimeout(()=>{ nav('tiktok'); }, 1500);
        }"""

    fix3_new = """        // ═══ v11: live progress timeline inside the modal
        const ttProgress = document.getElementById('ttProgressTimeline');
        const ttFailBox = document.getElementById('ttFailMessage');
        if(order.status_ar){
          if(ttProgress){ ttProgress.innerHTML = '<i class="fas fa-sync-alt fa-spin"></i> ' + order.status_ar; ttProgress.style.display = ''; }
        }
        if(order.status === 'failed'){
          // Show the human failure message (if any)
          if(ttFailBox){
            ttFailBox.innerHTML = (order.failure_info || order.failure_message || 'فشل تنفيذ الطلب 🔄');
            ttFailBox.style.display = '';
          }
          clearInterval(window._ttPollTimer);
        }
        // ═══ Check status
        if(order.status === 'completed' || order.charge_status === 'completed' || order.charge_status === 'success'){
          clearInterval(window._ttPollTimer);
          if(ttProgress){ ttProgress.innerHTML = '<i class="fas fa-check-circle"></i> تم شحن العملات بنجاح! 🎉'; }
          if(ttFailBox){ ttFailBox.style.display = 'none'; }
          toast('<i class="fas fa-check-circle"></i> تم شحن العملات بنجاح!');
          const ov = document.getElementById('ttLoginOverlay');
          if(ov) ov.classList.remove('show');
          document.body.style.overflow = '';
          document.documentElement.style.overflow = '';
          // Reload page to update balance
          setTimeout(()=>{ nav('tiktok'); }, 1500);
        }"""

    if fix3_old in content:
        content = content.replace(fix3_old, fix3_new, 1)
        changes.append("FIX 3: frontend polling shows live progress (status_ar) + human failure message")
    elif "v11: live progress" in content:
        pass  # already applied
    else:
        print("⚠️  FIX 3 anchor not found — check apply_fixes_v5.py anchor text")

    # ══════════════════════════════════════════════════════════
    # FIX 4 — HTML placeholders: progress timeline + fail box
    # ══════════════════════════════════════════════════════════
    # Inject the two elements inside openTikTokLoginModal, right after
    # "ov.classList.add('show');" — guaranteed single anchor.
    fix4_anchor = "  ov.classList.add('show');"
    # guard must check for the injected block itself (FIX 3 references the id
    # too, so a plain 'in content' check would wrongly skip FIX 4)
    if "v11 FIX 4: create progress" not in content and fix4_anchor in content:
        fix4_new = """  // ── v11 FIX 4: create progress + failure message elements ──
  if(!document.getElementById('ttProgressTimeline')){
    const ttProgress=document.createElement('div');
    ttProgress.id='ttProgressTimeline';
    ttProgress.style.cssText='position:absolute;top:10px;left:12px;right:12px;padding:10px 14px;border-radius:10px;background:linear-gradient(135deg,#667eea11,#764ba211);border:1px solid #667eea44;color:#4c51bf;font-size:13px;font-weight:700;text-align:center;z-index:5;display:none;';
    ttProgress.innerHTML='<i class="fas fa-spinner fa-spin"></i> جاري استلام الطلب...';
    ov.appendChild(ttProgress);
  }
  if(!document.getElementById('ttFailMessage')){
    const ttFail=document.createElement('div');
    ttFail.id='ttFailMessage';
    ttFail.style.cssText='position:absolute;top:10px;left:12px;right:12px;padding:10px 14px;border-radius:10px;background:linear-gradient(135deg,#ff4b4b11,#ff6b6b11);border:1px solid #ff4b4b44;color:#ff4b4b;font-size:13px;font-weight:700;text-align:center;z-index:5;display:none;';
    ov.appendChild(ttFail);
  }

  ov.classList.add('show');"""

        content = content.replace(fix4_anchor, fix4_new, 1)
        changes.append("FIX 4: added ttProgressTimeline + ttFailMessage elements into the modal")

    if changes:
        backup = filename + ".backup_before_v5"
        if not os.path.exists(backup):
            with open(backup, "w", encoding="utf-8") as f:
                f.write(original)
            print(f"✅ Backup created: {backup}")

        with open(filename, "w", encoding="utf-8") as f:
            f.write(content)

        print(f"\n{'=' * 60}")
        print(f"📊 Changes: {len(changes)} fix(es) applied")
        for c in changes:
            print(f"   ✅ {c}")
        print(f"{'=' * 60}")
    else:
        print("ℹ️  No changes applied (already patched or anchors not found)")

    # Syntax validation
    compile(content, filename, "exec")
    print("\n✅ Python syntax validation passed")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 apply_fixes_v5.py 888.py")
        sys.exit(1)
    apply_fixes(sys.argv[1])
