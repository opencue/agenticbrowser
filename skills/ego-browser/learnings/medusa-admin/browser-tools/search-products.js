async function(args) {
  if (!/^https?:$/.test(location.protocol)) {
    return { error: 'not on the admin origin — run open_admin first', status: 0 };
  }
  const query = String(args.query || '').trim();
  if (!query) return { error: 'query is required', status: 0 };
  const limit = Math.max(1, Math.min(100, Number(args.limit) || 20));
  const params = new URLSearchParams({
    q: query,
    limit: String(limit),
    fields: 'id,title,handle,status,*variants',
  });
  const res = await fetch(`/admin/products?${params}`, {
    credentials: 'include',
    headers: { accept: 'application/json' },
  });
  if (!res.ok) return { error: 'admin API rejected the request', status: res.status };
  const body = await res.json();
  const products = (body.products || []).map((p) => ({
    id: p.id,
    title: p.title,
    handle: p.handle,
    status: p.status,
    variants: Array.isArray(p.variants) ? p.variants.length : 0,
  }));
  return { count: body.count ?? products.length, products };
}
