async function(args) {
  if (!/^https?:$/.test(location.protocol)) {
    return { error: 'not on the admin origin — run open_admin first', status: 0 };
  }
  const limit = Math.max(1, Math.min(100, Number(args.limit) || 20));
  const offset = Math.max(0, Number(args.offset) || 0);
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
    order: '-created_at',
    fields: 'id,display_id,email,total,currency_code,payment_status,fulfillment_status,created_at',
  });
  const res = await fetch(`/admin/orders?${params}`, {
    credentials: 'include',
    headers: { accept: 'application/json' },
  });
  if (!res.ok) return { error: 'admin API rejected the request', status: res.status };
  const body = await res.json();
  const orders = (body.orders || []).map((o) => ({
    id: o.id,
    display_id: o.display_id,
    email: o.email,
    total: o.total,
    currency_code: o.currency_code,
    payment_status: o.payment_status,
    fulfillment_status: o.fulfillment_status,
    created_at: o.created_at,
  }));
  return { count: body.count ?? orders.length, orders };
}
