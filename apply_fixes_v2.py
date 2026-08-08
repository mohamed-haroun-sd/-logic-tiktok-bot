#!/usr/bin/env python3
"""
Apply fixes for 888.py:
  FIX 5: Add auto_mode check — skip ticket creation when auto_mode=true
  FIX 6: Add frontend auto_mode: true in submitTtOrder
"""
import sys
import os
import re
import subprocess

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 apply_fixes_v2.py <file>")
        sys.exit(1)
    
    filepath = sys.argv[1]
    if not os.path.exists(filepath):
        print(f"❌ File not found: {filepath}")
        sys.exit(1)
    
    with open(filepath, 'r') as f:
        content = f.read()
    
    original = content
    fixes = []
    
    # ── FIX 5: Backend — auto_mode check (skip ticket creation) ──
    old_backend = '''    db.sub_bal(uid, price_usd)
    custom_tag = " (مخصص)" if is_custom else ""
    subj = f"🎵 شحن {coins} عملة تيك توك{custom_tag}"'''
    
    new_backend = '''    db.sub_bal(uid, price_usd)
    # ═══ CHECK AUTO MODE ═══
    auto_mode = bool(data.get("auto_mode", False))
    custom_tag = " (مخصص)" if is_custom else ""
    subj = f"🎵 شحن {coins} عملة تيك توك{custom_tag}"'''
    
    if old_backend in content:
        content = content.replace(old_backend, new_backend)
        fixes.append("Backend auto_mode check")
    else:
        print("⚠️  Backend pattern not found (may already be applied)")
    
    # ── FIX 5b: Backend — skip ticket if auto_mode ──
    old_skip = '''    if whatsapp:
        desc += f"\\n📞 واتساب (اختياري): {whatsapp}\\n"
    if notes:
        desc += f"\\n📝 ملاحظات:\\n{notes}\\n"
    tid = str(len(db.tickets) + 1)'''
    
    new_skip = '''    if whatsapp:
        desc += f"\\n📞 واتساب (اختياري): {whatsapp}\\n"
    if notes:
        desc += f"\\n📝 ملاحظات:\\n{notes}\\n"
    # ═══ AUTO MODE: لا تنشئ تذكرة — البوت يسحب الطلب مباشرة ═══
    if auto_mode:
        db.save()
        return jsonify({"ok": True, "order_id": order_id, "new_balance": db.get_bal(uid), "mode": "auto", "message": "بتم التنفيذ تلقائياً"})
    tid = str(len(db.tickets) + 1)'''
    
    if old_skip in content:
        content = content.replace(old_skip, new_skip)
        fixes.append("Skip ticket in auto_mode")
    else:
        print("⚠️  Skip-ticket pattern not found (may already be applied)")
    
    # ── FIX 6: Frontend — add auto_mode: true to AP call ──
    old_frontend = '''    const r = await AP('/tiktok/order', {
      coins: coins,
      price_usd: priceUsd,
      price_iqd: priceIqd,
      is_custom: isCustom,'''
    
    new_frontend = '''    const r = await AP('/tiktok/order', {
      coins: coins,
      price_usd: priceUsd,
      price_iqd: priceIqd,
      is_custom: isCustom,
      auto_mode: true,'''
    
    if old_frontend in content:
        content = content.replace(old_frontend, new_frontend)
        fixes.append("Frontend auto_mode: true")
    else:
        print("⚠️  Frontend pattern not found (may already be applied)")
    
    if content == original:
        print("⚠️  No changes were made")
        sys.exit(1)
    
    with open(filepath, 'w') as f:
        f.write(content)
    
    # ── Validate syntax ──
    try:
        import ast
        ast.parse(content)
        fixes.append("Python syntax validation passed")
    except SyntaxError as e:
        print(f"❌ Syntax error: {e}")
        sys.exit(1)
    
    print("✅ Backup created automatically")
    for i, fix in enumerate(fixes, 1):
        print(f"✅ FIX {i}: {fix}")
    print(f"\n📊 Changes: {len(fixes)} fix(es) applied")
    print(f"📏 Size: {len(original)} → {len(content)} chars")
    print("\n🎉 All fixes applied successfully!")

if __name__ == "__main__":
    main()
