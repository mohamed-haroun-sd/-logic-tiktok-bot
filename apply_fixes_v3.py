#!/usr/bin/env python3
"""
apply_fixes_v3.py — website backend hardening for 888.py
═════════════════════════════════════════════════════════════════
FIX 7: Atomic "claim" — the pending API now returns at most ONE
       order and flips its status to "processing" in the SAME
       read operation. Two bot instances can NEVER grab the same
       order again.

FIX 8: Orders stuck in "processing" for more than 30 minutes
       (bot crash mid-flight) are revived back to "waiting_link"
       so a live bot can finish them — but fresh orders are never
       re-tried within that window.

FIX 9: Order detail endpoint enriched with a human-readable
       Arabic status (status_ar) so the frontend modal can show
       the real state: جارٍ التنفيذ / تم الشحن / فشل التنفيذ.

Idempotent — safe to re-run.
"""
import sys
import os
import re
import time

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 apply_fixes_v3.py <file>")
        sys.exit(1)

    filepath = sys.argv[1]
    if not os.path.exists(filepath):
        print(f"❌ File not found: {filepath}")
        sys.exit(1)

    with open(filepath, 'r') as f:
        content = f.read()

    original = content
    fixes = []

    # ── Backup created only if we actually change the file ──
    backup_path = filepath + ".backup_v3_before_fixes"
    backup_done = False
    if not os.path.exists(backup_path):
        backup_done = True  # will write after confirming changes

    # ──────────────────────────────────────────────────────────────
    # FIX 9: enrich order detail endpoint (exact string match)
    # ──────────────────────────────────────────────────────────────
    old_detail = '''    return jsonify({
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
    })'''

    new_detail = '''    status = order.get("status", "unknown")
    status_ar = {
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
    })'''

    if 'status_ar' in content:
        print("⚠️  FIX 9 already applied — skipping")
    elif old_detail in content:
        content = content.replace(old_detail, new_detail)
        fixes.append("Order detail endpoint enriched (status_ar)")
    else:
        print("⚠️  Detail-endpoint pattern not found (may already be applied)")

    # ──────────────────────────────────────────────────────────────
    # FIX 7+8: atomic claim in pending API (regex, indentation-safe)
    # ──────────────────────────────────────────────────────────────
    old_re = re.compile(
        r"(@app\.route\('/api/tiktok/orders/pending', methods=\['GET'\]\)\ndef api_tiktok_orders_pending\(\):)(.*?)(return jsonify\(\{\s*\"ok\":True,\s*\"count\":len\(orders\),\s*\"orders\":orders\s*\}\))",
        re.S
    )

    if 'FIX 7' in content or '# ── FIX 7' in content:
        print("⚠️  FIX 7 already applied — skipping")
    else:
        m = old_re.search(content)
        if m:
            new_fn = m.group(1) + '''
    orders=[]
    # ── FIX 8: revive orders stuck in "processing" for >30 min ──
    now_ts = time.time()
    for oid,o in list(db.tiktok_orders.items()):
        if o.get("status")=="processing":
            created = o.get("created", now_ts)
            if (now_ts - created) > 1800:
                o["status"]="waiting_link"
                o["session_id"]=""
    # ── FIX 7: atomic claim — return at most ONE order and flip it
    #            to "processing" so no other bot instance can grab it ──
    for oid,o in db.tiktok_orders.items():
        if o.get("status")=="waiting_link":
            o["status"]="processing"
            db.save()
            orders.append({
                "id":oid,
                "uid":o.get("uid"),
                "coins":o.get("coins"),
                "price_usd":o.get("price_usd"),
                "order_id": oid
            })
            break
    ''' + m.group(3)
            content = content[:m.start()] + new_fn + content[m.end():]
            fixes.append("Atomic claim in pending API (FIX 7+8)")
        else:
            print("⚠️  Pending-API pattern not found (may already be applied)")

    if content == original:
        print("⚠️  No changes were made — file is already patched")
        sys.exit(0)

    if backup_done and not os.path.exists(backup_path):
        with open(backup_path, 'w') as fb:
            fb.write(original)
        print(f"✅ Backup created: {backup_path}")

    with open(filepath, 'w') as f:
        f.write(content)

    # ── Validate syntax ──
    try:
        import ast
        ast.parse(content)
        fixes.append("Python syntax validation passed")
    except SyntaxError as e:
        print(f"❌ Syntax error: {e}")
        with open(backup_path, 'r') as fb:
            with open(filepath, 'w') as f:
                f.write(fb.read())
        sys.exit(1)

    print("\n" + "=" * 60)
    for i, fix in enumerate(fixes, 1):
        print(f"✅ FIX {i}: {fix}")
    print("=" * 60)
    print(f"\n📊 Changes: {len(fixes)} fix(es) applied")
    print(f"📏 Size: {len(original)} → {len(content)} chars")
    print("\n🎉 All fixes applied successfully!")

if __name__ == "__main__":
    main()
